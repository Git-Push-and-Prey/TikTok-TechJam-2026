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

const OWNER = "owner-1";
const OTHER_USER = "user-2";

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
    const docs = await agents.createAgent(
      { name: "Docs", description: "Writes documentation" },
      OWNER,
    );
    const tests = await agents.createAgent(
      { name: "Tests", description: "Writes unit tests" },
      OWNER,
    );

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

    const session = await engine.createSession(
      {
        name: "Docs + Tests",
        memberAgentIds: [docs.id, tests.id],
      },
      OWNER,
    );

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
    const member = await agents.createAgent({ name: "Member" }, OWNER);

    runner.setHandler(async (request) => {
      if (request.prompt.includes("Member Agents you may delegate to")) {
        return textReply("Two plus two is four.");
      }
      throw new Error("unexpected prompt: " + request.prompt);
    });

    const session = await engine.createSession(
      { name: "Direct", memberAgentIds: [member.id] },
      OWNER,
    );
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
    const member = await agents.createAgent({ name: "Member" }, OWNER);

    runner.setHandler(async (request) => {
      if (request.prompt.includes("Member Agents you may delegate to")) {
        return jsonReply([{ agentId: outsiderId, task: "do something" }]);
      }
      if (request.prompt.includes("Here are the results of the subtasks you delegated")) {
        return textReply("Nothing valid to delegate.");
      }
      throw new Error("unexpected prompt: " + request.prompt);
    });

    const session = await engine.createSession(
      { name: "Guarded", memberAgentIds: [member.id] },
      OWNER,
    );

    await engine.handleUserMessage(session.id, "do the outsider's job");
    await expect.poll(() => engine.getSession(session.id).stage).toBe("idle");

    expect(runner.calls.some((call) => call.agentId === outsiderId)).toBe(false);
    const transcript = engine.transcriptFor(session.id);
    expect(transcript[transcript.length - 1]?.content).toBe("Nothing valid to delegate.");
  });

  it("fails the Session after repeated malformed decomposition replies", async () => {
    const { agents, engine, runner } = await makeHarness();
    const member = await agents.createAgent({ name: "Member" }, OWNER);

    runner.setHandler(async (request) => {
      if (
        request.prompt.includes("Member Agents you may delegate to") ||
        request.prompt.includes("required format")
      ) {
        return textReply("```json\nnot valid json\n```");
      }
      throw new Error("unexpected prompt: " + request.prompt);
    });

    const session = await engine.createSession(
      { name: "Flaky", memberAgentIds: [member.id] },
      OWNER,
    );

    await engine.handleUserMessage(session.id, "anything");
    await expect.poll(() => engine.getSession(session.id).stage).toBe("failed");
    expect(engine.getSession(session.id).lastError).toContain("valid delegation plan");
  });

  it("serializes multiple subtasks assigned to the same Agent", async () => {
    const { agents, engine, runner } = await makeHarness();
    const member = await agents.createAgent({ name: "Solo" }, OWNER);

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

    const session = await engine.createSession(
      { name: "Serial", memberAgentIds: [member.id] },
      OWNER,
    );

    await engine.handleUserMessage(session.id, "do A then B");
    await expect.poll(() => engine.getSession(session.id).stage).toBe("idle");

    expect(runner.maxActiveByAgent.get(member.id)).toBe(1);
    const memberCalls = runner.calls.filter((call) => call.agentId === member.id);
    expect(memberCalls.map((call) => call.prompt)).toEqual(["TASK_A", "TASK_B"]);
  });

  it("times out a stuck subtask without hanging the Session forever", async () => {
    const { agents, engine, runner } = await makeHarness();
    const member = await agents.createAgent({ name: "Stuck" }, OWNER);

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

    const session = await engine.createSession(
      { name: "Timeout", memberAgentIds: [member.id] },
      OWNER,
    );

    await engine.handleUserMessage(session.id, "trigger the hang");
    await expect.poll(() => engine.getSession(session.id).stage, { timeout: 5_000 }).toBe("idle");

    const transcript = engine.transcriptFor(session.id);
    expect(transcript[transcript.length - 1]?.content).toBe("Handled the timeout.");
  });
});

describe("Collaborators", () => {
  it("gives a collaborator read/participate access but not management rights", async () => {
    const { agents, engine } = await makeHarness();
    const member = await agents.createAgent({ name: "Shared" }, OWNER);
    const session = await engine.createSession(
      { name: "Team", memberAgentIds: [member.id] },
      OWNER,
    );

    // A stranger has no access at all.
    expect(() => engine.getSession(session.id, OTHER_USER)).toThrowError(
      expect.objectContaining({ statusCode: 404 }),
    );

    await engine.updateCollaborators(session.id, [OTHER_USER], [], OWNER);

    // Now a collaborator: can read and participate...
    expect(engine.getSession(session.id, OTHER_USER).id).toBe(session.id);
    expect(engine.transcriptFor(session.id, OTHER_USER)).toEqual([]);
    await expect(engine.stopSession(session.id, OTHER_USER)).resolves.toMatchObject({
      stage: "idle",
    });

    // ...cannot remove someone else's contributed Agent, manage collaborators, or delete it.
    await expect(
      engine.updateMembers(session.id, [], [member.id], OTHER_USER),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      engine.updateCollaborators(session.id, [], [OTHER_USER], OTHER_USER),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(engine.deleteSession(session.id, OTHER_USER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("lets a collaborator contribute and later remove their own Agent, but not someone else's", async () => {
    const { agents, engine } = await makeHarness();
    const ownerAgent = await agents.createAgent({ name: "Owner's" }, OWNER);
    const collaboratorAgent = await agents.createAgent({ name: "Collaborator's" }, OTHER_USER);
    const session = await engine.createSession(
      { name: "Mixed roster", memberAgentIds: [ownerAgent.id] },
      OWNER,
    );
    await engine.updateCollaborators(session.id, [OTHER_USER], [], OWNER);

    // The collaborator can add their own Agent...
    const updated = await engine.updateMembers(
      session.id,
      [collaboratorAgent.id],
      [],
      OTHER_USER,
    );
    expect(updated.memberAgentIds).toEqual(
      expect.arrayContaining([ownerAgent.id, collaboratorAgent.id]),
    );

    // ...but not someone else's Agent (isn't theirs to add).
    await expect(
      engine.updateMembers(session.id, [], [], OTHER_USER),
    ).resolves.toBeDefined(); // sanity: a no-op call is fine
    await expect(
      engine.updateMembers(session.id, [ownerAgent.id], [], OTHER_USER),
    ).rejects.toMatchObject({ statusCode: 404 }); // not theirs — same 404 as any non-owned Agent lookup

    // The collaborator can remove their own contribution...
    const afterRemove = await engine.updateMembers(
      session.id,
      [],
      [collaboratorAgent.id],
      OTHER_USER,
    );
    expect(afterRemove.memberAgentIds).toEqual([ownerAgent.id]);

    // ...but the owner can remove anyone's contribution, including the collaborator's.
    await engine.updateMembers(session.id, [collaboratorAgent.id], [], OTHER_USER);
    const ownerRemoved = await engine.updateMembers(
      session.id,
      [],
      [collaboratorAgent.id],
      OWNER,
    );
    expect(ownerRemoved.memberAgentIds).toEqual([ownerAgent.id]);
  });

  it("successfully delegates to a member Agent contributed by a collaborator, not the owner", async () => {
    const { agents, engine, runner } = await makeHarness();
    const ownerAgent = await agents.createAgent({ name: "Owner's" }, OWNER);
    const collaboratorAgent = await agents.createAgent({ name: "Collaborator's" }, OTHER_USER);
    const session = await engine.createSession(
      { name: "Cross-owner roster", memberAgentIds: [ownerAgent.id] },
      OWNER,
    );
    await engine.updateCollaborators(session.id, [OTHER_USER], [], OWNER);
    await engine.updateMembers(session.id, [collaboratorAgent.id], [], OTHER_USER);

    runner.setHandler(async (request) => {
      if (request.prompt.includes("Member Agents you may delegate to")) {
        return jsonReply([{ agentId: collaboratorAgent.id, task: "do the collaborator's part" }]);
      }
      if (request.prompt.includes("Here are the results of the subtasks you delegated")) {
        return textReply("Done via the collaborator's Agent.");
      }
      return textReply("collaborator agent replied");
    });

    await engine.handleUserMessage(session.id, "delegate cross-owner", OWNER);
    await expect.poll(() => engine.getSession(session.id).stage).toBe("idle");

    const transcript = engine.transcriptFor(session.id);
    expect(transcript.at(-1)?.content).toBe("Done via the collaborator's Agent.");
    expect(runner.calls.some((call) => call.agentId === collaboratorAgent.id)).toBe(true);
  });

  it("attributes a human turn to whichever collaborator sent it", async () => {
    const { agents, engine, runner } = await makeHarness();
    const member = await agents.createAgent({ name: "Attributed" }, OWNER);
    const session = await engine.createSession(
      { name: "Attribution", memberAgentIds: [member.id] },
      OWNER,
    );
    await engine.updateCollaborators(session.id, [OTHER_USER], [], OWNER);

    runner.setHandler(async () => textReply("noted."));
    await engine.handleUserMessage(session.id, "hi from bob", OTHER_USER, "bob");
    await expect.poll(() => engine.getSession(session.id).stage).toBe("idle");

    const transcript = engine.transcriptFor(session.id, OWNER);
    const humanTurn = transcript.find((message) => message.content === "hi from bob");
    expect(humanTurn).toMatchObject({ senderUserId: OTHER_USER, senderUsername: "bob" });
  });
});

describe("Comments", () => {
  it("posts a comment without touching stage, even while the orchestrator is busy", async () => {
    const { agents, engine, runner } = await makeHarness();
    const member = await agents.createAgent({ name: "Busy" }, OWNER);
    const session = await engine.createSession(
      { name: "Discuss", memberAgentIds: [member.id] },
      OWNER,
    );
    await engine.updateCollaborators(session.id, [OTHER_USER], [], OWNER);

    let releaseOrchestrator!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseOrchestrator = resolve;
    });
    runner.setHandler(async () => {
      await pending;
      return textReply("done eventually.");
    });

    const sendPromise = engine.handleUserMessage(session.id, "start a long task", OWNER);
    await expect.poll(() => engine.getSession(session.id).stage).not.toBe("idle");

    const { message } = await engine.postComment(session.id, "still waiting?", OTHER_USER, "bob");
    expect(message).toMatchObject({
      kind: "comment",
      senderUserId: OTHER_USER,
      senderUsername: "bob",
    });
    expect(message.recipientId).toBeUndefined();
    // Stage is untouched by the comment — still mid-run.
    expect(engine.getSession(session.id).stage).not.toBe("idle");

    releaseOrchestrator();
    await sendPromise;
    await expect.poll(() => engine.getSession(session.id).stage).toBe("idle");
  });

  it("rejects a comment from someone with no access to the Session", async () => {
    const { agents, engine } = await makeHarness();
    const member = await agents.createAgent({ name: "Private" }, OWNER);
    const session = await engine.createSession(
      { name: "Solo", memberAgentIds: [member.id] },
      OWNER,
    );
    await expect(
      engine.postComment(session.id, "can I join?", OTHER_USER, "bob"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Serialized subtask dispatch", () => {
  it("never runs two subtasks from the same round at the same time, even across different Agents", async () => {
    const { agents, engine, runner } = await makeHarness();
    const docs = await agents.createAgent({ name: "Docs" }, OWNER);
    const tests = await agents.createAgent({ name: "Tests" }, OWNER);

    let active = 0;
    let maxActiveAcrossAgents = 0;
    const agentsCalled = new Set<string>();

    runner.setHandler(async (request) => {
      if (request.prompt.includes("Member Agents you may delegate to")) {
        return jsonReply([
          { agentId: docs.id, task: "write the docs" },
          { agentId: tests.id, task: "write the tests" },
        ]);
      }
      if (request.prompt.includes("Here are the results of the subtasks you delegated")) {
        return textReply("Combined.");
      }
      agentsCalled.add(request.agentId);
      active += 1;
      maxActiveAcrossAgents = Math.max(maxActiveAcrossAgents, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return textReply("done: " + request.prompt);
    });

    const session = await engine.createSession(
      { name: "NoOverlap", memberAgentIds: [docs.id, tests.id] },
      OWNER,
    );
    await engine.handleUserMessage(session.id, "write docs and tests");
    await expect.poll(() => engine.getSession(session.id).stage).toBe("idle");

    expect(agentsCalled).toEqual(new Set([docs.id, tests.id])); // both did run eventually
    expect(maxActiveAcrossAgents).toBe(1); // never overlapped, regardless of which Agent
  });
});
