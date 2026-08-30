import { randomUUID } from "node:crypto";
import type { AgentService } from "./agent-service.js";
import { HttpError } from "./errors.js";
import type { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  CreateSessionInput,
  Message,
  PendingSubtask,
  Session,
  SessionStage,
} from "./types.js";
import { SYSTEM_PARTY, USER_PARTY } from "./types.js";
import type { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();
const MAX_FORMAT_RETRIES = 2;

export const ORCHESTRATOR_INSTRUCTIONS = [
  "You are a lightweight task-routing orchestrator, not a coding agent.",
  "Each turn you either: (a) break the user's request into subtasks and assign",
  "each subtask to one member Agent by id, using ONLY the ids you are given",
  "that turn, or (b) if no delegation is needed, answer directly in plain text.",
  "When a turn gives you the results of subtasks you previously assigned,",
  "combine them into one clear final answer for the user in plain text — do",
  "not emit a json block on a synthesis turn.",
].join(" ");

interface DecomposedSubtask {
  agentId: string;
  task: string;
}

type DecomposeOutcome =
  | { kind: "direct"; answer: string }
  | { kind: "subtasks"; subtasks: DecomposedSubtask[] }
  | { kind: "invalid" };

interface RoundResult {
  agentId: string;
  task: string;
  output: string;
}

/** `callerId === undefined` means an internal/trusted call — always allowed. */
function hasSessionAccess(session: Session, callerId: string | null | undefined): boolean {
  if (callerId === undefined) return true;
  return session.ownerId === callerId || (session.collaboratorIds ?? []).includes(callerId ?? "");
}

function assertIsOwner(session: Session, callerId: string | null | undefined): void {
  if (callerId !== undefined && session.ownerId !== callerId) {
    throw new HttpError(403, "Only the Session owner can do this");
  }
}

function summarizePlan(subtasks: DecomposedSubtask[], members: Agent[]): string {
  const lines = subtasks.map((subtask) => {
    const name = members.find((agent) => agent.id === subtask.agentId)?.name ?? "an Agent";
    return `- **${name}**: ${subtask.task}`;
  });
  return ["I'll delegate this:", ...lines].join("\n");
}

function extractJsonBlock(output: string): string | null {
  const match = output.match(/```json\s*([\s\S]*?)```/i);
  return match ? (match[1] ?? null) : null;
}

function parseDecomposition(output: string): DecomposeOutcome {
  const block = extractJsonBlock(output);
  if (block === null) {
    return { kind: "direct", answer: output.trim() };
  }
  try {
    const parsed = JSON.parse(block) as { subtasks?: unknown };
    if (!Array.isArray(parsed.subtasks)) {
      return { kind: "invalid" };
    }
    const subtasks = parsed.subtasks
      .map((item): DecomposedSubtask | null => {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).agentId === "string" &&
          typeof (item as Record<string, unknown>).task === "string"
        ) {
          return {
            agentId: (item as { agentId: string }).agentId,
            task: (item as { task: string }).task,
          };
        }
        return null;
      })
      .filter((item): item is DecomposedSubtask => item !== null);
    if (subtasks.length === 0) {
      return { kind: "invalid" };
    }
    return { kind: "subtasks", subtasks };
  } catch {
    return { kind: "invalid" };
  }
}

export class SessionEngine {
  private readonly timers = new Map<string, Map<string, NodeJS.Timeout>>();
  private readonly queuedSubtasks = new Map<string, DecomposedSubtask[]>();
  private readonly roundResults = new Map<string, RoundResult[]>();

  constructor(
    private readonly store: JsonStore,
    private readonly agents: AgentService,
    private readonly workspaces: WorkspaceManager,
    private readonly turnTimeoutMs: number,
  ) {
    this.agents.on("run:settled", ({ agentId, run }: { agentId: string; run: AgentRun }) => {
      void this.handleRunSettled(agentId, run).catch(() => undefined);
    });
  }

  getSession(id: string, callerId?: string | null): Session {
    const session = this.store.snapshot().sessions.find((item) => item.id === id);
    if (!session) {
      throw new HttpError(404, "Session not found");
    }
    if (!hasSessionAccess(session, callerId)) {
      throw new HttpError(404, "Session not found");
    }
    return session;
  }

  listSessions(callerId: string): Session[] {
    return this.store
      .snapshot()
      .sessions.filter((session) => hasSessionAccess(session, callerId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  transcriptFor(sessionId: string, callerId?: string | null): Message[] {
    this.getSession(sessionId, callerId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createSession(input: CreateSessionInput, ownerId: string | null): Promise<Session> {
    const name = input.name.trim();
    const uniqueMembers = Array.from(new Set(input.memberAgentIds));
    if (uniqueMembers.length === 0) {
      throw new HttpError(400, "A Session needs at least one member Agent");
    }
    for (const agentId of uniqueMembers) {
      const agent = this.agents.getAgent(agentId, ownerId);
      if (agent.kind === "orchestrator") {
        throw new HttpError(400, "An orchestrator Agent cannot be a Session member");
      }
    }
    const id = randomUUID();
    const description = input.description?.trim() ?? "";
    const orchestrator = await this.agents.createAgent(
      {
        name: `Orchestrator — ${name}`,
        description: `Hidden routing orchestrator for the "${name}" Session.`,
        instructions: ORCHESTRATOR_INSTRUCTIONS,
        kind: "orchestrator",
      },
      ownerId,
    );
    const workspacePath = await this.workspaces.createSessionWorkspace(id, name, description);
    const timestamp = now();
    const session: Session = {
      id,
      name,
      description,
      memberAgentIds: uniqueMembers,
      orchestratorAgentId: orchestrator.id,
      workspacePath,
      stage: "idle",
      pendingSubtasks: [],
      memberThreadIds: {},
      formatRetries: 0,
      lastError: null,
      ownerId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => database.sessions.push(session));
    return session;
  }

  /**
   * Any Session member (owner or collaborator) can contribute their own
   * Agents to the roster — `add` only accepts Agents the caller owns. A
   * member can remove their own contributed Agents; only the owner can
   * remove anyone else's.
   */
  async updateMembers(
    id: string,
    add: string[] = [],
    remove: string[] = [],
    callerId?: string | null,
  ): Promise<Session> {
    const session = this.getSession(id, callerId);
    for (const agentId of add) {
      const agent = this.agents.getAgent(agentId, callerId);
      if (agent.kind === "orchestrator") {
        throw new HttpError(400, "An orchestrator Agent cannot be a Session member");
      }
    }
    for (const agentId of remove) {
      if (callerId !== undefined && callerId !== session.ownerId) {
        try {
          const agent = this.agents.getAgent(agentId);
          if (agent.ownerId !== callerId) {
            throw new HttpError(403, "You can only remove Agents you contributed yourself");
          }
        } catch (error) {
          if (error instanceof HttpError && error.statusCode === 404) continue; // already gone — nothing to protect
          throw error;
        }
      }
    }
    return this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === id);
      if (!stored) {
        throw new HttpError(404, "Session not found");
      }
      const members = new Set(stored.memberAgentIds);
      for (const agentId of add) members.add(agentId);
      for (const agentId of remove) members.delete(agentId);
      stored.memberAgentIds = Array.from(members);
      stored.updatedAt = now();
      return structuredClone(stored);
    });
  }

  async updateCollaborators(
    id: string,
    add: string[] = [],
    remove: string[] = [],
    ownerId?: string | null,
  ): Promise<Session> {
    const session = this.getSession(id, ownerId);
    assertIsOwner(session, ownerId);
    return this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === id);
      if (!stored) {
        throw new HttpError(404, "Session not found");
      }
      const collaborators = new Set(stored.collaboratorIds ?? []);
      for (const userId of add) collaborators.add(userId);
      for (const userId of remove) collaborators.delete(userId);
      stored.collaboratorIds = Array.from(collaborators);
      stored.updatedAt = now();
      return structuredClone(stored);
    });
  }

  async stopSession(id: string, callerId?: string | null): Promise<Session> {
    const session = this.getSession(id, callerId);
    this.clearTimers(id);
    this.queuedSubtasks.delete(id);
    this.roundResults.delete(id);
    const busyAgentIds = new Set([
      ...session.pendingSubtasks.map((pending) => pending.agentId),
      ...(session.stage === "decomposing" || session.stage === "synthesizing"
        ? [session.orchestratorAgentId]
        : []),
    ]);
    for (const agentId of busyAgentIds) {
      // Member Agents can be contributed by any collaborator, not just the
      // Session owner — this is an internal/trusted stop, not a per-caller check.
      await this.agents.stopAgent(agentId).catch(() => undefined);
    }
    return this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === id);
      if (!stored) {
        throw new HttpError(404, "Session not found");
      }
      stored.stage = "idle";
      stored.pendingSubtasks = [];
      stored.updatedAt = now();
      return structuredClone(stored);
    });
  }

  async deleteSession(id: string, ownerId?: string | null): Promise<void> {
    const session = this.getSession(id, ownerId);
    assertIsOwner(session, ownerId);
    await this.stopSession(id).catch(() => undefined);
    await this.agents.deleteAgent(session.orchestratorAgentId, session.ownerId).catch(() => undefined);
    await this.workspaces.archiveSessionWorkspace(session.workspacePath, session.id).catch(() => undefined);
    await this.store.mutate((database) => {
      database.sessions = database.sessions.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.sessionId !== id);
      database.runs = database.runs.filter((item) => item.sessionId !== id);
    });
  }

  async handleUserMessage(
    sessionId: string,
    content: string,
    callerId?: string | null,
    senderUsername?: string,
  ): Promise<{ message: Message }> {
    const session = this.getSession(sessionId, callerId);
    if (session.stage !== "idle") {
      throw new HttpError(409, "This Session is already handling a message");
    }
    const timestamp = now();
    const userMessage: Message = {
      id: randomUUID(),
      agentId: session.orchestratorAgentId,
      runId: randomUUID(),
      role: "user",
      content,
      sessionId,
      senderId: USER_PARTY,
      recipientId: session.orchestratorAgentId,
      ...(callerId ? { senderUserId: callerId } : {}),
      ...(senderUsername ? { senderUsername } : {}),
      createdAt: timestamp,
    };
    await this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === sessionId);
      if (!stored) {
        throw new HttpError(404, "Session not found");
      }
      database.messages.push(userMessage);
      stored.stage = "decomposing";
      stored.formatRetries = 0;
      stored.lastError = null;
      stored.updatedAt = now();
    });
    this.roundResults.set(sessionId, []);
    await this.dispatchDecompose(sessionId, content);
    return { message: userMessage };
  }

  /**
   * A human-to-human aside — never gated by `stage`, never dispatched to the
   * orchestrator. The one channel that stays open while agents are busy.
   */
  async postComment(
    sessionId: string,
    content: string,
    callerId: string | null | undefined,
    senderUsername?: string,
  ): Promise<{ message: Message }> {
    const session = this.getSession(sessionId, callerId);
    const timestamp = now();
    const comment: Message = {
      id: randomUUID(),
      agentId: session.orchestratorAgentId,
      runId: randomUUID(),
      role: "user",
      content,
      sessionId,
      kind: "comment",
      senderId: USER_PARTY,
      ...(callerId ? { senderUserId: callerId } : {}),
      ...(senderUsername ? { senderUsername } : {}),
      createdAt: timestamp,
    };
    await this.store.mutate((database) => {
      database.messages.push(comment);
    });
    return { message: comment };
  }

  private resolveMembers(session: Session): Agent[] {
    return session.memberAgentIds
      .map((agentId) => {
        try {
          // Trusted lookup — member Agents can be owned by any collaborator,
          // not just the Session owner; roster membership is the authorization.
          return this.agents.getAgent(agentId);
        } catch {
          return null;
        }
      })
      .filter((agent): agent is Agent => agent !== null);
  }

  private async dispatchDecompose(sessionId: string, userContent: string): Promise<void> {
    const session = this.getSession(sessionId);
    const members = this.resolveMembers(session);
    const roster = members
      .map(
        (agent) =>
          `- id: ${agent.id}, name: "${agent.name}", description: "${agent.description || "(no description)"}"`,
      )
      .join("\n");
    const prompt = [
      "Member Agents you may delegate to (use ONLY these ids):",
      roster || "(none currently available)",
      "",
      "User request:",
      userContent,
      "",
      'Reply with EITHER a ```json fenced block of {"subtasks":[{"agentId":"...","task":"..."}]}',
      "assigning each subtask to a member id above, OR — if no delegation is needed — a plain",
      "text direct answer with no json block.",
    ].join("\n");
    await this.dispatchOrchestratorTurn(session, prompt, "decomposing");
  }

  private async dispatchSynthesis(sessionId: string): Promise<void> {
    // Two independent subtask settles can each observe an empty pending
    // queue and both try to advance the round — a read-then-act check alone
    // isn't safe. Claim the transition atomically inside one store.mutate;
    // only the caller that actually flips the stage proceeds.
    const claimed = await this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === sessionId);
      if (!stored) return false;
      if (stored.stage !== "delegating" && stored.stage !== "decomposing") return false;
      stored.stage = "synthesizing";
      stored.updatedAt = now();
      return true;
    });
    if (!claimed) return; // another concurrent settle already claimed this round's synthesis

    const session = this.getSession(sessionId);
    const results = this.roundResults.get(sessionId) ?? [];
    if (results.length === 0) {
      await this.finishTurn(sessionId);
      return;
    }
    const resultsText = results
      .map((result) => `Agent ${result.agentId} was asked: "${result.task}"\nResult:\n${result.output}`)
      .join("\n\n---\n\n");
    const prompt = [
      "Here are the results of the subtasks you delegated:",
      resultsText,
      "",
      "Write one clear final answer for the user in plain text, combining these results.",
      "Do not include a json block.",
    ].join("\n");
    await this.dispatchOrchestratorTurn(session, prompt, "synthesizing", USER_PARTY);
  }

  private async dispatchOrchestratorTurn(
    session: Session,
    prompt: string,
    stage: SessionStage,
    recipientOverride?: string,
  ): Promise<void> {
    const orchestratorId = session.orchestratorAgentId;
    let run: AgentRun;
    try {
      ({ run } = await this.agents.sendMessage(orchestratorId, prompt, session.ownerId, {
        workspaceOverride: session.workspacePath,
        sessionId: session.id,
        sender: SYSTEM_PARTY,
        ...(recipientOverride ? { recipient: recipientOverride } : {}),
        session: {
          threadId: session.memberThreadIds[orchestratorId] ?? null,
          onThreadId: (threadId) => {
            void this.persistThreadId(session.id, orchestratorId, threadId);
          },
        },
      }));
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 409) {
        // The orchestrator is already mid-turn — a concurrent settle already
        // advanced this round. Nothing to do.
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.failSession(session.id, `Could not dispatch the orchestrator: ${message}`);
      return;
    }
    await this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === session.id);
      if (!stored) return;
      stored.stage = stage;
      stored.updatedAt = now();
    });
    this.armTimeout(session.id, run.id, orchestratorId);
  }

  private async dispatchSubtask(session: Session, subtask: DecomposedSubtask): Promise<void> {
    try {
      // Trusted dispatch — the target may be a collaborator's own Agent, not
      // the Session owner's; roster membership was already validated when it
      // was added to memberAgentIds.
      const { run } = await this.agents.sendMessage(subtask.agentId, subtask.task, undefined, {
        workspaceOverride: session.workspacePath,
        sessionId: session.id,
        sender: session.orchestratorAgentId,
        session: {
          threadId: session.memberThreadIds[subtask.agentId] ?? null,
          onThreadId: (threadId) => {
            void this.persistThreadId(session.id, subtask.agentId, threadId);
          },
        },
      });
      await this.store.mutate((database) => {
        const stored = database.sessions.find((item) => item.id === session.id);
        if (!stored) return;
        const entry: PendingSubtask = { runId: run.id, agentId: subtask.agentId, task: subtask.task };
        stored.pendingSubtasks = [...stored.pendingSubtasks, entry];
        stored.updatedAt = now();
      });
      this.armTimeout(session.id, run.id, subtask.agentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendRoundResult(session.id, {
        agentId: subtask.agentId,
        task: subtask.task,
        output: `(could not dispatch: ${message})`,
      });
      await this.maybeAdvanceAfterSettle(session.id);
    }
  }

  /**
   * Dispatches at most one subtask per call, session-wide — every Agent in a
   * Session shares one workspace directory
   * (`workspaceOverride: session.workspacePath`), so running more than one
   * Codex process against it at a time risks unlocked concurrent writes.
   * `maybeAdvanceAfterSettle` calls this again once that subtask settles,
   * which drains the rest of the queue one at a time.
   */
  private async pumpQueue(sessionId: string): Promise<void> {
    const queue = this.queuedSubtasks.get(sessionId) ?? [];
    if (queue.length === 0) return;
    const session = this.getSession(sessionId);
    if (session.pendingSubtasks.length > 0) return; // something is already mid-turn; wait for it to settle
    const [subtask, ...remaining] = queue;
    if (!subtask) return;
    this.queuedSubtasks.set(sessionId, remaining);
    await this.dispatchSubtask(session, subtask);
  }

  private async handleRunSettled(agentId: string, run: AgentRun): Promise<void> {
    if (!run.sessionId) return; // not a Session turn — e.g. a direct Playground message
    this.clearRunTimer(run.sessionId, run.id);
    const session = this.store.snapshot().sessions.find((item) => item.id === run.sessionId);
    if (!session) return;

    if (
      agentId === session.orchestratorAgentId &&
      (session.stage === "decomposing" || session.stage === "synthesizing")
    ) {
      await this.handleOrchestratorSettled(session, run);
      return;
    }

    const pendingEntry = session.pendingSubtasks.find((pending) => pending.runId === run.id);
    if (!pendingEntry) return; // already handled (e.g. via timeout) — ignore the late settle
    await this.handleSubtaskSettled(session, run, pendingEntry);
  }

  private async handleOrchestratorSettled(session: Session, run: AgentRun): Promise<void> {
    if (run.status !== "completed") {
      await this.failSession(session.id, `Orchestrator run did not complete: ${run.error ?? "unknown error"}`);
      return;
    }

    if (session.stage === "synthesizing") {
      await this.finishTurn(session.id);
      return;
    }

    const outcome = parseDecomposition(run.output ?? "");
    if (outcome.kind === "direct") {
      // No delegation was needed — this reply IS the final answer for the
      // user, not a reply to the system prompt that requested it, so redirect
      // its recipient instead of leaving it addressed back to SYSTEM_PARTY.
      await this.redirectReplyToUser(run.id);
      await this.finishTurn(session.id);
      return;
    }
    if (outcome.kind === "invalid") {
      const current = this.getSession(session.id);
      if (current.formatRetries >= MAX_FORMAT_RETRIES) {
        await this.failSession(session.id, "Orchestrator repeatedly failed to produce a valid delegation plan");
        return;
      }
      await this.store.mutate((database) => {
        const stored = database.sessions.find((item) => item.id === session.id);
        if (stored) {
          stored.formatRetries += 1;
          stored.updatedAt = now();
        }
      });
      await this.dispatchOrchestratorTurn(
        current,
        [
          "Your previous reply did not match the required format. Reply with EITHER a",
          '```json fenced block of {"subtasks":[{"agentId":"...","task":"..."}]} using ONLY',
          "the member ids you were given, OR a plain-text direct answer with no json block.",
        ].join("\n"),
        "decomposing",
      );
      return;
    }

    const memberIds = new Set(session.memberAgentIds);
    const valid: DecomposedSubtask[] = [];
    for (const subtask of outcome.subtasks) {
      if (memberIds.has(subtask.agentId)) {
        valid.push(subtask);
      } else {
        // Access-control enforcement: never dispatch to an Agent outside the roster.
        this.appendRoundResult(session.id, {
          agentId: subtask.agentId,
          task: subtask.task,
          output: "(skipped — this Agent is not a member of this Session)",
        });
      }
    }

    if (valid.length === 0) {
      await this.dispatchSynthesis(session.id);
      return;
    }

    await this.recordPlanMessage(session, summarizePlan(valid, this.resolveMembers(session)));
    this.queuedSubtasks.set(session.id, valid);
    await this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === session.id);
      if (stored) {
        stored.stage = "delegating";
        stored.updatedAt = now();
      }
    });
    await this.pumpQueue(session.id);
  }

  private async handleSubtaskSettled(
    session: Session,
    run: AgentRun,
    pendingEntry: PendingSubtask,
  ): Promise<void> {
    const outputText =
      run.status === "completed" ? run.output ?? "" : `(run ${run.status}: ${run.error ?? "no output"})`;
    this.appendRoundResult(session.id, {
      agentId: pendingEntry.agentId,
      task: pendingEntry.task,
      output: outputText,
    });
    await this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === session.id);
      if (!stored) return;
      stored.pendingSubtasks = stored.pendingSubtasks.filter((pending) => pending.runId !== run.id);
      stored.updatedAt = now();
    });
    await this.maybeAdvanceAfterSettle(session.id);
  }

  private async maybeAdvanceAfterSettle(sessionId: string): Promise<void> {
    const queue = this.queuedSubtasks.get(sessionId) ?? [];
    if (queue.length > 0) {
      await this.pumpQueue(sessionId);
      return;
    }
    const session = this.getSession(sessionId);
    if (session.pendingSubtasks.length === 0) {
      await this.dispatchSynthesis(sessionId);
    }
  }

  private async handleTimeout(sessionId: string, runId: string, agentId: string): Promise<void> {
    const session = this.store.snapshot().sessions.find((item) => item.id === sessionId);
    if (!session) return;
    const isOrchestratorTurn =
      agentId === session.orchestratorAgentId &&
      (session.stage === "decomposing" || session.stage === "synthesizing");
    const pendingEntry = session.pendingSubtasks.find((pending) => pending.runId === runId);
    if (!isOrchestratorTurn && !pendingEntry) return; // already settled

    // `stopAgent` awaits the run's own cancellation all the way through,
    // including the `run:settled` event that cancellation triggers — which
    // this engine also listens for. Settle this turn's bookkeeping BEFORE
    // calling stopAgent, so that nested event sees it as already handled
    // instead of double-processing the same turn.
    if (isOrchestratorTurn) {
      await this.failSession(sessionId, `Orchestrator did not respond within ${this.turnTimeoutMs}ms`);
      await this.agents.stopAgent(agentId).catch(() => undefined);
      return;
    }

    await this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === sessionId);
      if (stored) {
        stored.pendingSubtasks = stored.pendingSubtasks.filter((pending) => pending.runId !== runId);
        stored.updatedAt = now();
      }
    });
    this.appendRoundResult(sessionId, {
      agentId,
      task: pendingEntry?.task ?? "",
      output: `(timed out after ${this.turnTimeoutMs}ms)`,
    });
    await this.agents.stopAgent(agentId).catch(() => undefined);
    await this.maybeAdvanceAfterSettle(sessionId);
  }

  private async finishTurn(sessionId: string): Promise<void> {
    this.roundResults.delete(sessionId);
    this.queuedSubtasks.delete(sessionId);
    await this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === sessionId);
      if (!stored) return;
      stored.stage = "idle";
      stored.pendingSubtasks = [];
      stored.updatedAt = now();
    });
  }

  private async failSession(sessionId: string, reason: string): Promise<void> {
    this.clearTimers(sessionId);
    this.roundResults.delete(sessionId);
    this.queuedSubtasks.delete(sessionId);
    await this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === sessionId);
      if (!stored) return;
      stored.stage = "failed";
      stored.pendingSubtasks = [];
      stored.lastError = reason;
      stored.updatedAt = now();
    });
  }

  /** Records a locally-synthesized (not model-generated) message from the orchestrator to the user — e.g. the plan summary. */
  private async recordPlanMessage(session: Session, content: string): Promise<void> {
    const timestamp = now();
    const message: Message = {
      id: randomUUID(),
      agentId: session.orchestratorAgentId,
      runId: randomUUID(),
      role: "assistant",
      content,
      sessionId: session.id,
      senderId: session.orchestratorAgentId,
      recipientId: USER_PARTY,
      createdAt: timestamp,
    };
    await this.store.mutate((database) => {
      database.messages.push(message);
    });
  }

  private async redirectReplyToUser(runId: string): Promise<void> {
    await this.store.mutate((database) => {
      const message = database.messages.find((item) => item.runId === runId && item.role === "assistant");
      if (message) message.recipientId = USER_PARTY;
    });
  }

  private async persistThreadId(sessionId: string, agentId: string, threadId: string | null): Promise<void> {
    await this.store.mutate((database) => {
      const stored = database.sessions.find((item) => item.id === sessionId);
      if (!stored) return;
      stored.memberThreadIds = { ...stored.memberThreadIds, [agentId]: threadId };
    });
  }

  private appendRoundResult(sessionId: string, result: RoundResult): void {
    const list = this.roundResults.get(sessionId) ?? [];
    list.push(result);
    this.roundResults.set(sessionId, list);
  }

  private armTimeout(sessionId: string, runId: string, agentId: string): void {
    const timer = setTimeout(() => void this.handleTimeout(sessionId, runId, agentId), this.turnTimeoutMs);
    timer.unref();
    let perSession = this.timers.get(sessionId);
    if (!perSession) {
      perSession = new Map();
      this.timers.set(sessionId, perSession);
    }
    perSession.set(runId, timer);
  }

  private clearRunTimer(sessionId: string, runId: string): void {
    const perSession = this.timers.get(sessionId);
    const timer = perSession?.get(runId);
    if (timer) clearTimeout(timer);
    perSession?.delete(runId);
  }

  private clearTimers(sessionId: string): void {
    const perSession = this.timers.get(sessionId);
    if (!perSession) return;
    for (const timer of perSession.values()) clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}
