import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { SessionEngine } from "./session-engine.js";
import { SessionLogger } from "./session-logger.js";
import { JsonStore } from "./store.js";
import { SYSTEM_PARTY, USER_PARTY } from "./types.js";
import type { AgentRunner, Message, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

function isUserFacing(message: Message): boolean {
  return message.senderId === USER_PARTY || message.recipientId === USER_PARTY;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type Handler = (request: RunnerRequest) => Promise<RunnerResult>;

class ScriptedRunner implements AgentRunner {
  calls: RunnerRequest[] = [];
  maxActiveByAgent = new Map<string, number>();
  private activeByAgent = new Map<string, number>();
  private cancelers = new Map<string, () => void>();
  private handler: Handler = () => {
    throw new Error("ScriptedRunner handler not set yet");
  };

  setHandler(handler: Handler): void {
    this.handler = handler;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls.push(request);
    const active = (this.activeByAgent.get(request.agentId) ?? 0) + 1;
    this.activeByAgent.set(request.agentId, active);
    this.maxActiveByAgent.set(
      request.agentId,
      Math.max(this.maxActiveByAgent.get(request.agentId) ?? 0, active),
    );
    try {
      return await this.handler(request);
    } finally {
      this.activeByAgent.set(request.agentId, (this.activeByAgent.get(request.agentId) ?? 1) - 1);
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const cancel = this.cancelers.get(agentId);
    if (!cancel) return false;
    this.cancelers.delete(agentId);
    cancel();
    return true;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  hang(agentId: string): Promise<RunnerResult> {
    return new Promise((_resolve, reject) => {
      this.cancelers.set(agentId, () => reject(new Error("cancelled by test")));
    });
  }
}

async function makeHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-session-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "openrouter/free",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const runner = new ScriptedRunner();
  const agents = new AgentService(config, store, workspaces, runner, new SessionLogger(path.join(root, "logs")));
  await agents.initialize();
  const engine = new SessionEngine(store, agents, workspaces, 200);
  return { agents, engine, runner };
}

function jsonReply(subtasks: { agentId: string; task: string }[]): RunnerResult {
  return {
    output: "```json\n" + JSON.stringify({ subtasks }) + "\n```",
    threadId: "thread-1",
    usage: null,
  };
}

function textReply(text: string): RunnerResult {
  return { output: text, threadId: "thread-1", usage: null };
}

describe("SessionEngine", () => {
  it("decomposes a request across two member Agents and synthesizes a final answer", async () => {
    const { agents, engine, runner } = await makeHarness();
    const docs = await agents.createAgent({ name: "Docs", description: "Writes documentation" });
    const tests = await agents.createAgent({ name: "Tests", description: "Writes unit tests" });

    runner.setHandler(async (request) => {
      if (request.prompt.includes("Member Agents you may delegate to")) {
        return jsonReply([
          { agentId: docs.id, task: "write the docs" },
          { agentId: tests.id, task: "write the tests" },
        ]);
      }
      if (request.prompt.includes("Here are the results of the subtasks you delegated")) {
        return textReply("Combined: docs and tests are done.");
      }
      if (request.prompt === "write the docs") return textReply("Docs written.");
      if (request.prompt === "write the tests") return textReply("Tests written.");
      throw new Error("unexpected prompt: " + request.prompt);
    });

    const session = await engine.createSession({
      name: "Docs + Tests",
      memberAgentIds: [docs.id, tests.id],
    });

    await engine.handleUserMessage(session.id, "write a README section and matching tests");
    await expect.poll(() => engine.getSession(session.id).stage).toBe("idle");

    const transcript = engine.transcriptFor(session.id);
    const finalMessage = transcript[transcript.length - 1];
    expect(finalMessage?.role).toBe("assistant");
    expect(finalMessage?.content).toBe("Combined: docs and tests are done.");

    // The default (non-detail) view should only ever show the human's
    // request, a short delegation plan, and the final synthesized answer —
    // not the engine's internal decompose/subtask/synthesis prompts, and not
    // the orchestrator's traffic with its sub-agents.
    const visible = transcript.filter(isUserFacing);
    expect(visible.map((message) => message.content)).toEqual([
      "write a README section and matching tests",
      "I'll delegate this:\n- **Docs**: write the docs\n- **Tests**: write the tests",
      "Combined: docs and tests are done.",
    ]);
    expect(visible.every((message) => message.senderId === USER_PARTY || message.recipientId === USER_PARTY)).toBe(
      true,
    );

    // The engine's own prompt to the orchestrator is system-authored, not
    // sent by the user — it must never look like something the user typed.
    const decomposePrompt = transcript.find((message) => message.content.includes("Member Agents you may delegate to"));
    expect(decomposePrompt?.senderId).toBe(SYSTEM_PARTY);
    expect(decomposePrompt?.recipientId).not.toBe(USER_PARTY);

    // A subtask dispatched to a member Agent is orchestrator -> member, not user-facing.
    const docsTask = transcript.find((message) => message.content === "write the docs");
    expect(docsTask?.senderId).toBe(session.orchestratorAgentId);
    expect(docsTask?.recipientId).toBe(docs.id);
    expect(isUserFacing(docsTask!)).toBe(false);

    expect(runner.calls.filter((call) => call.agentId === docs.id)).toHaveLength(1);
    expect(runner.calls.filter((call) => call.agentId === tests.id)).toHaveLength(1);

    // Member Agents' own Playground history stays empty — nothing leaked in.
    expect(agents.getMessages(docs.id)).toHaveLength(0);
    expect(agents.getAgent(docs.id).codexThreadId).toBeNull();
  });

  it("shows the orchestrator's reply when it answers directly with no delegation", async () => {
    const { agents, engine, runner } = await makeHarness();
    const member = await agents.createAgent({ name: "Member" });

    runner.setHandler(async (request) => {
      if (request.prompt.includes("Member Agents you may delegate to")) {
        return textReply("Two plus two is four.");
      }
      throw new Error("unexpected prompt: " + request.prompt);
    });

    const session = await engine.createSession({ name: "Direct", memberAgentIds: [member.id] });
    await engine.handleUserMessage(session.id, "what is two plus two?");
    await expect.poll(() => engine.getSession(session.id).stage).toBe("idle");

    const transcript = engine.transcriptFor(session.id);
    const visible = transcript.filter(isUserFacing);
    expect(visible.map((message) => message.content)).toEqual([
      "what is two plus two?",
      "Two plus two is four.",
    ]);

    // The direct answer must be redirected to the user, not left addressed
    // back to SYSTEM_PARTY (which requested it via the decompose prompt).
    const answer = transcript.find((message) => message.content === "Two plus two is four.");
    expect(answer?.senderId).toBe(session.orchestratorAgentId);
    expect(answer?.recipientId).toBe(USER_PARTY);
  });

  it("drops a subtask targeting an Agent outside the Session roster", async () => {
    const outsiderId = randomUUID();
    const { agents, engine, runner } = await makeHarness();
    const member = await agents.createAgent({ name: "Member" });

    runner.setHandler(async (request) => {
      if (request.prompt.includes("Member Agents you may delegate to")) {
        return jsonReply([{ agentId: outsiderId, task: "do something" }]);
      }
      if (request.prompt.includes("Here are the results of the subtasks you delegated")) {
        return textReply("Nothing valid to delegate.");
      }
      throw new Error("unexpected prompt: " + request.prompt);
    });

    const session = await engine.createSession({ name: "Guarded", memberAgentIds: [member.id] });

    await engine.handleUserMessage(session.id, "do the outsider's job");
    await expect.poll(() => engine.getSession(session.id).stage).toBe("idle");

    expect(runner.calls.some((call) => call.agentId === outsiderId)).toBe(false);
    const transcript = engine.transcriptFor(session.id);
    expect(transcript[transcript.length - 1]?.content).toBe("Nothing valid to delegate.");
  });

  it("fails the Session after repeated malformed decomposition replies", async () => {
    const { agents, engine, runner } = await makeHarness();
    const member = await agents.createAgent({ name: "Member" });

    runner.setHandler(async (request) => {
      if (
        request.prompt.includes("Member Agents you may delegate to") ||
        request.prompt.includes("required format")
      ) {
        return textReply("```json\nnot valid json\n```");
      }
      throw new Error("unexpected prompt: " + request.prompt);
    });

    const session = await engine.createSession({ name: "Flaky", memberAgentIds: [member.id] });

    await engine.handleUserMessage(session.id, "anything");
    await expect.poll(() => engine.getSession(session.id).stage).toBe("failed");
    expect(engine.getSession(session.id).lastError).toContain("valid delegation plan");
  });

  it("serializes multiple subtasks assigned to the same Agent", async () => {
    const { agents, engine, runner } = await makeHarness();
    const member = await agents.createAgent({ name: "Solo" });

    runner.setHandler(async (request) => {
      if (request.prompt.includes("Member Agents you may delegate to")) {
        return jsonReply([
          { agentId: member.id, task: "TASK_A" },
          { agentId: member.id, task: "TASK_B" },
        ]);
      }
      if (request.prompt.includes("Here are the results of the subtasks you delegated")) {
        return textReply("Both done.");
      }
      if (request.prompt === "TASK_A") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return textReply("A done.");
      }
      if (request.prompt === "TASK_B") return textReply("B done.");
      throw new Error("unexpected prompt: " + request.prompt);
    });

    const session = await engine.createSession({ name: "Serial", memberAgentIds: [member.id] });

    await engine.handleUserMessage(session.id, "do A then B");
    await expect.poll(() => engine.getSession(session.id).stage).toBe("idle");

    expect(runner.maxActiveByAgent.get(member.id)).toBe(1);
    const memberCalls = runner.calls.filter((call) => call.agentId === member.id);
    expect(memberCalls.map((call) => call.prompt)).toEqual(["TASK_A", "TASK_B"]);
  });

  it("times out a stuck subtask without hanging the Session forever", async () => {
    const { agents, engine, runner } = await makeHarness();
    const member = await agents.createAgent({ name: "Stuck" });

    runner.setHandler(async (request) => {
      if (request.prompt.includes("Member Agents you may delegate to")) {
        return jsonReply([{ agentId: member.id, task: "never finishes" }]);
      }
      if (request.prompt.includes("Here are the results of the subtasks you delegated")) {
        return textReply("Handled the timeout.");
      }
      if (request.prompt === "never finishes") {
        return runner.hang(request.agentId);
      }
      throw new Error("unexpected prompt: " + request.prompt);
    });

    const session = await engine.createSession({ name: "Timeout", memberAgentIds: [member.id] });

    await engine.handleUserMessage(session.id, "trigger the hang");
    await expect.poll(() => engine.getSession(session.id).stage, { timeout: 5_000 }).toBe("idle");

    const transcript = engine.transcriptFor(session.id);
    expect(transcript[transcript.length - 1]?.content).toBe("Handled the timeout.");
  });
});
