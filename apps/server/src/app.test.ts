import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SessionEngine } from "./session-engine.js";
import { SessionLogger } from "./session-logger.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const sessions = {
  listSessions: () => [],
} as unknown as SessionEngine;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
      sessions,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, sessions);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return { output: "done: " + request.prompt, threadId: "fake-thread", usage: null };
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
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeRealApp() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-session-test-"));
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
  const agents = new AgentService(config, store, workspaces, new FakeRunner(), new SessionLogger(path.join(root, "logs")));
  await agents.initialize();
  const engine = new SessionEngine(store, agents, workspaces, 60_000);
  const app = await createApp(config, agents, engine);
  return { app, agents, engine };
}

describe("Session routes", () => {
  it("rejects creating a Session with an unknown member Agent id", async () => {
    const { app } = await makeRealApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { name: "Test", memberAgentIds: [randomUUID()] },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects adding an unknown Agent to a Session's roster", async () => {
    const { app, agents } = await makeRealApp();
    const member = await agents.createAgent({ name: "Member" });
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { name: "Test", memberAgentIds: [member.id] },
    });
    const { session } = created.json() as { session: { id: string } };
    const response = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/members`,
      payload: { add: [randomUUID()] },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns a Session's transcript in creation order", async () => {
    const { app, agents, engine } = await makeRealApp();
    const member = await agents.createAgent({ name: "Member" });
    const session = await engine.createSession({ name: "Ordered", memberAgentIds: [member.id] });
    await engine.handleUserMessage(session.id, "hello");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages` });
    expect(response.statusCode).toBe(200);
    const { messages } = response.json() as { messages: { createdAt: string }[] };
    const timestamps = messages.map((message) => message.createdAt);
    expect(timestamps).toEqual([...timestamps].sort());
    await app.close();
  });
});
