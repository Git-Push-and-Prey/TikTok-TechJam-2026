import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AppConfig } from "./config.js";
import { isOpenRouterConfigured } from "./config.js";
import { assertOwned, HttpError, RunCancelledError } from "./errors.js";
import { SessionLogger, type SessionLogContext } from "./session-logger.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { USER_PARTY } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export interface SendMessageOptions {
  /** Run against this directory instead of the Agent's own workspacePath (used by Session turns). */
  workspaceOverride?: string;
  /** Tags the created Message/AgentRun so it doesn't show up in the Agent's own Playground history. */
  sessionId?: string;
  /**
   * When present, read/write the Codex thread id from here instead of the
   * Agent's own `codexThreadId` — keeps a Session's conversation with an
   * Agent separate from that Agent's solo Playground conversation.
   */
  session?: { threadId: string | null; onThreadId: (threadId: string | null) => void };
  /** Who is sending this turn's prompt — USER_PARTY, SYSTEM_PARTY, or an Agent id. Defaults to USER_PARTY. */
  sender?: string;
  /** Who the reply is addressed to. Defaults to `sender` (a plain reply-to-sender exchange). */
  recipient?: string;
}

export class AgentService extends EventEmitter {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly sessionLogger: SessionLogger,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.sessionLogger.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(ownerId: string): Agent[] {
    return this.store
      .snapshot()
      .agents.filter((agent) => agent.kind !== "orchestrator" && agent.ownerId === ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string, ownerId?: string | null): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    assertOwned(agent.ownerId, ownerId, "Agent not found");
    return agent;
  }

  async createAgent(input: CreateAgentInput, ownerId: string | null): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      kind: input.kind ?? "user",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      ownerId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  /**
   * Shares an Agent by cloning its definition (name/description/instructions)
   * into a brand-new Agent owned by `targetUserId` — a fresh workspace and
   * thread, no shared conversation history with the source.
   */
  async shareAgent(id: string, ownerId: string, targetUserId: string): Promise<Agent> {
    const source = this.getAgent(id, ownerId);
    if (source.kind === "orchestrator") {
      throw new HttpError(400, "An orchestrator Agent cannot be shared");
    }
    return this.createAgent(
      {
        name: source.name,
        description: source.description,
        instructions: source.instructions,
      },
      targetUserId,
    );
  }

  async updateAgent(
    id: string,
    input: UpdateAgentInput,
    ownerId?: string | null,
  ): Promise<Agent> {
    const current = this.getAgent(id, ownerId);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(
    id: string,
    ownerId?: string | null,
  ): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id, ownerId);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string, ownerId?: string | null): Promise<Agent> {
    return this.setStatus(id, "ready", ownerId);
  }

  async stopAgent(id: string, ownerId?: string | null): Promise<Agent> {
    this.getAgent(id, ownerId);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped", ownerId);
  }

  getMessages(agentId: string, ownerId?: string | null): Message[] {
    this.getAgent(agentId, ownerId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId && message.sessionId === null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string, ownerId?: string | null): AgentRun {
    const database = this.store.snapshot();
    const run = database.runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    const agent = database.agents.find((item) => item.id === run.agentId);
    assertOwned(agent?.ownerId ?? null, ownerId, "Run not found");
    return run;
  }

  getRuns(agentId: string, ownerId?: string | null): AgentRun[] {
    this.getAgent(agentId, ownerId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId && run.sessionId === null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    ownerId?: string | null,
    options?: SendMessageOptions,
  ): Promise<{ run: AgentRun; message: Message }> {
    this.getAgent(agentId, ownerId);
    if (!isOpenRouterConfigured(this.config)) {
      throw new HttpError(
        503,
        "OpenRouter is not configured. Set OPENROUTER_API_KEY, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const sessionId = options?.sessionId ?? null;
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      sessionId,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const senderId = options?.sender ?? USER_PARTY;
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      sessionId,
      senderId,
      recipientId: agentId,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    void this.sessionLogger.logUserMessage(
      { agentId, agentName: agentAtStart.name, runId, ownerId: agentAtStart.ownerId },
      prompt,
    );
    const execution = this.executeRun(agentAtStart, run, options);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      openrouterConfigured: isOpenRouterConfigured(this.config),
      openrouterBaseUrl: this.config.openrouterBaseUrl,
      openrouterModel: this.config.openrouterModel || "openrouter/free",
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    options?: SendMessageOptions,
  ): Promise<void> {
    const logContext: SessionLogContext = {
      agentId: agentAtStart.id,
      agentName: agentAtStart.name,
      runId: run.id,
      ownerId: agentAtStart.ownerId,
    };
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: options?.workspaceOverride ?? agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: options?.session ? options.session.threadId : agentAtStart.codexThreadId,
        onEvent: (event) => {
          if (event.kind === "tool_call") {
            void this.sessionLogger.logToolCall(logContext, event);
          } else {
            void this.sessionLogger.logError(logContext, event.message);
          }
        },
      });
      void this.sessionLogger.logAgentResponse(logContext, result.output, result.usage);
      const completedAt = now();
      const finalRun = await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return null;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          sessionId: run.sessionId,
          senderId: agent.id,
          recipientId: options?.recipient ?? options?.sender ?? USER_PARTY,
          createdAt: completedAt,
        });
        agent.status = "ready";
        if (options?.session) {
          options.session.onThreadId(result.threadId);
        } else {
          agent.codexThreadId = result.threadId;
        }
        agent.lastError = null;
        agent.updatedAt = completedAt;
        return structuredClone(storedRun);
      });
      if (finalRun) this.emit("run:settled", { agentId: agentAtStart.id, run: finalRun });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      void this.sessionLogger.logError(
        logContext,
        cancelled ? "Run cancelled by user" : message,
      );
      const finalRun = await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
        return storedRun ? structuredClone(storedRun) : null;
      });
      if (finalRun) this.emit("run:settled", { agentId: agentAtStart.id, run: finalRun });
    }
  }

  private async setStatus(
    id: string,
    status: Agent["status"],
    ownerId?: string | null,
  ): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      assertOwned(agent.ownerId, ownerId, "Agent not found");
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
