import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { SessionLogger } from "./session-logger.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "openrouter/free",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    new SessionLogger(path.join(root, "logs")),
  );
  await service.initialize();
  return service;
}

async function makeServiceWithLogs(): Promise<{ service: AgentService; logsDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-logs-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "openrouter/free",
  });
  const logsDir = path.join(root, "logs");
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    new FakeRunner(),
    new SessionLogger(logsDir),
  );
  await service.initialize();
  return { service, logsDir };
}

const OWNER = "owner-1";
const OTHER_OWNER = "owner-2";

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" }, OWNER);
    expect(service.listAgents(OWNER)).toHaveLength(1);
    expect(
      (await service.updateAgent(agent.id, { description: "Builds apps" }, OWNER)).description,
    ).toBe("Builds apps");
    expect((await service.stopAgent(agent.id, OWNER)).status).toBe("stopped");
    expect((await service.startAgent(agent.id, OWNER)).status).toBe("ready");
    await service.deleteAgent(agent.id, OWNER);
    expect(service.listAgents(OWNER)).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" }, OWNER);
    const { run } = await service.sendMessage(agent.id, "write hello world", OWNER);
    await expect.poll(() => service.getRun(run.id, OWNER).status).toBe("completed");
    const messages = service.getMessages(agent.id, OWNER);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id, OWNER).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" }, OWNER);
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first", OWNER),
      service.sendMessage(agent.id, "second", OWNER),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id, OWNER)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id, OWNER).status).toBe(
        "completed",
      );
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" }, OWNER);
    const { run } = await service.sendMessage(agent.id, "first", OWNER);

    await expect(service.startAgent(agent.id, OWNER)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second", OWNER)).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id, OWNER).status).toBe("completed");
  });
});

describe("Session-turn support", () => {
  it("keeps a session-scoped thread separate from the Agent's own codexThreadId", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Shared" }, OWNER);
    let observedThreadId: string | null | undefined;
    await service.sendMessage(agent.id, "session turn", OWNER, {
      workspaceOverride: agent.workspacePath,
      sessionId: "11111111-1111-1111-1111-111111111111",
      session: {
        threadId: null,
        onThreadId: (threadId) => {
          observedThreadId = threadId;
        },
      },
    });
    await expect.poll(() => service.getAgent(agent.id, OWNER).status).toBe("ready");
    expect(observedThreadId).toBe("fake-thread");
    expect(service.getAgent(agent.id, OWNER).codexThreadId).toBeNull();
    expect(service.getMessages(agent.id, OWNER)).toHaveLength(0);
  });

  it("emits run:settled exactly once with the final run status", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Watched" }, OWNER);
    const settled: unknown[] = [];
    service.on("run:settled", (event) => settled.push(event));
    const { run } = await service.sendMessage(agent.id, "hello", OWNER);
    await expect.poll(() => service.getRun(run.id, OWNER).status).toBe("completed");
    await expect.poll(() => settled.length).toBe(1);
    expect(settled[0]).toMatchObject({ agentId: agent.id, run: { id: run.id, status: "completed" } });
  });

  it("hides orchestrator-kind Agents from listAgents()", async () => {
    const service = await makeService();
    await service.createAgent({ name: "Visible" }, OWNER);
    await service.createAgent({ name: "Hidden Orchestrator", kind: "orchestrator" }, OWNER);
    const names = service.listAgents(OWNER).map((agent) => agent.name);
    expect(names).toEqual(["Visible"]);
  });
});

describe("Per-owner isolation", () => {
  it("hides another owner's Agents from listAgents() and getAgent()", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Private" }, OWNER);
    expect(service.listAgents(OTHER_OWNER)).toHaveLength(0);
    expect(() => service.getAgent(agent.id, OTHER_OWNER)).toThrowError(
      expect.objectContaining({ statusCode: 404 }),
    );
  });

  it("blocks lifecycle actions and messages from a non-owner", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Guarded" }, OWNER);
    await expect(service.stopAgent(agent.id, OTHER_OWNER)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      service.sendMessage(agent.id, "hi", OTHER_OWNER),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Sharing an Agent (clone)", () => {
  it("clones the definition into a new Agent owned by the recipient", async () => {
    const service = await makeService();
    const source = await service.createAgent(
      { name: "Original", description: "desc", instructions: "be helpful" },
      OWNER,
    );
    const clone = await service.shareAgent(source.id, OWNER, OTHER_OWNER);

    expect(clone.id).not.toBe(source.id);
    expect(clone.ownerId).toBe(OTHER_OWNER);
    expect(clone).toMatchObject({
      name: "Original",
      description: "desc",
      instructions: "be helpful",
      codexThreadId: null,
    });
    expect(clone.workspacePath).not.toBe(source.workspacePath);

    // Independent from here on — editing the clone must not touch the source.
    await service.updateAgent(clone.id, { name: "Renamed clone" }, OTHER_OWNER);
    expect(service.getAgent(source.id, OWNER).name).toBe("Original");
  });

  it("rejects sharing an Agent you don't own", async () => {
    const service = await makeService();
    const source = await service.createAgent({ name: "Not yours" }, OWNER);
    await expect(
      service.shareAgent(source.id, OTHER_OWNER, OWNER),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses to share a hidden orchestrator Agent", async () => {
    const service = await makeService();
    const orchestrator = await service.createAgent(
      { name: "Orchestrator", kind: "orchestrator" },
      OWNER,
    );
    await expect(
      service.shareAgent(orchestrator.id, OWNER, OTHER_OWNER),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("Session log attribution", () => {
  it("stamps the Agent's ownerId onto every session log entry for a Run", async () => {
    const { readFile } = await import("node:fs/promises");
    const { service, logsDir } = await makeServiceWithLogs();
    const agent = await service.createAgent({ name: "Logged" }, OWNER);
    const { run } = await service.sendMessage(agent.id, "hello", OWNER);
    await expect.poll(() => service.getRun(run.id, OWNER).status).toBe("completed");

    const raw = await readFile(path.join(logsDir, agent.id + ".log"), "utf8");
    const entries = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { ownerId?: string });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.ownerId === OWNER)).toBe(true);
  });
});
