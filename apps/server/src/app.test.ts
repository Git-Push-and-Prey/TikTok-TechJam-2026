import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { AuthService } from "./auth.js";
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

const fakeAuth = {
  resolveToken: async (token: string) =>
    token === "valid-token" ? { id: "user-1", username: "test" } : null,
  login: async () => {
    throw new Error("not implemented");
  },
  logout: async () => undefined,
  getUserById: () => ({ id: "user-1", username: "test" }),
} as unknown as AuthService;

describe("HTTP boundary", () => {
  it(
    "protects API routes with a per-user session token",
    async () => {
      // Fastify app construction (plugin registration, etc.) can take several
      // seconds on a slow/cold machine — this test's own logic is instant,
      // so give it real headroom rather than relying on vitest's 5s default.
      const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, sessions, fakeAuth);
      const denied = await app.inject({ method: "GET", url: "/api/agents" });
      expect(denied.statusCode).toBe(401);

      const allowed = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: "Bearer valid-token" },
      });
      expect(allowed.statusCode).toBe(200);
      await app.close();
    },
    20_000,
  );

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, sessions, fakeAuth);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", authorization: "Bearer valid-token" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", authorization: "Bearer valid-token" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

describe("Auth routes", () => {
  it("logs in with valid credentials and rejects invalid ones", async () => {
    const { app, auth } = await makeRealApp();
    await auth.createUser("alice", "correct-password");

    const badLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "wrong-password" },
    });
    expect(badLogin.statusCode).toBe(401);

    const goodLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "correct-password" },
    });
    expect(goodLogin.statusCode).toBe(200);
    const { token, user } = goodLogin.json() as { token: string; user: { username: string } };
    expect(user.username).toBe("alice");

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { username: string } }).user.username).toBe("alice");

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterLogout.statusCode).toBe(401);
    await app.close();
  });

  it("registers a new account, logs it in immediately, and rejects a duplicate username", async () => {
    const { app } = await makeRealApp();

    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "bob", password: "a-strong-password" },
    });
    expect(signup.statusCode).toBe(201);
    const { token, user } = signup.json() as { token: string; user: { username: string } };
    expect(user.username).toBe("bob");

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);

    const dupe = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "bob", password: "another-password" },
    });
    expect(dupe.statusCode).toBe(409);

    const tooShort = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "carol", password: "short" },
    });
    expect(tooShort.statusCode).toBe(400);
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
  const auth = new AuthService(store);
  const app = await createApp(config, agents, engine, auth);
  return { app, agents, engine, auth };
}

/** Creates a user and logs them in, returning their id and an auth header for app.inject(). */
async function loginAs(auth: AuthService, username: string) {
  const user = await auth.createUser(username, "password123");
  const { token } = await auth.login(username, "password123");
  return { userId: user.id, headers: { authorization: `Bearer ${token}` } };
}

describe("Session routes", () => {
  it("rejects creating a Session with an unknown member Agent id", async () => {
    const { app, auth } = await makeRealApp();
    const { headers } = await loginAs(auth, "alice");
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers,
      payload: { name: "Test", memberAgentIds: [randomUUID()] },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects adding an unknown Agent to a Session's roster", async () => {
    const { app, agents, auth } = await makeRealApp();
    const { userId, headers } = await loginAs(auth, "alice");
    const member = await agents.createAgent({ name: "Member" }, userId);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers,
      payload: { name: "Test", memberAgentIds: [member.id] },
    });
    const { session } = created.json() as { session: { id: string } };
    const response = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/members`,
      headers,
      payload: { add: [randomUUID()] },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns a Session's transcript in creation order", async () => {
    const { app, agents, engine, auth } = await makeRealApp();
    const { userId, headers } = await loginAs(auth, "alice");
    const member = await agents.createAgent({ name: "Member" }, userId);
    const session = await engine.createSession(
      { name: "Ordered", memberAgentIds: [member.id] },
      userId,
    );
    await engine.handleUserMessage(session.id, "hello");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const { messages } = response.json() as { messages: { createdAt: string }[] };
    const timestamps = messages.map((message) => message.createdAt);
    expect(timestamps).toEqual([...timestamps].sort());
    await app.close();
  });
});

describe("Per-owner isolation", () => {
  it("hides another user's Agents and Sessions, and blocks cross-owner rosters", async () => {
    const { app, agents, auth } = await makeRealApp();
    const alice = await loginAs(auth, "alice");
    const bob = await loginAs(auth, "bob");

    const aliceAgent = await agents.createAgent({ name: "Alice's Agent" }, alice.userId);
    const aliceSessionResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: alice.headers,
      payload: { name: "Alice's Session", memberAgentIds: [aliceAgent.id] },
    });
    const { session: aliceSession } = aliceSessionResponse.json() as { session: { id: string } };

    const bobAgents = await app.inject({ method: "GET", url: "/api/agents", headers: bob.headers });
    expect((bobAgents.json() as { agents: unknown[] }).agents).toHaveLength(0);

    const bobSessions = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: bob.headers,
    });
    expect((bobSessions.json() as { sessions: unknown[] }).sessions).toHaveLength(0);

    const bobGetsAliceAgent = await app.inject({
      method: "GET",
      url: `/api/agents/${aliceAgent.id}`,
      headers: bob.headers,
    });
    expect(bobGetsAliceAgent.statusCode).toBe(404);

    const bobGetsAliceSession = await app.inject({
      method: "GET",
      url: `/api/sessions/${aliceSession.id}`,
      headers: bob.headers,
    });
    expect(bobGetsAliceSession.statusCode).toBe(404);

    const bobRosterHijack = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: bob.headers,
      payload: { name: "Hijack", memberAgentIds: [aliceAgent.id] },
    });
    expect(bobRosterHijack.statusCode).toBe(404);
    await app.close();
  });
});

describe("Sharing an Agent", () => {
  it("clones the Agent into the recipient's own account, independent of the original", async () => {
    const { app, agents, auth } = await makeRealApp();
    const alice = await loginAs(auth, "alice");
    const bob = await loginAs(auth, "bob");
    const aliceAgent = await agents.createAgent(
      { name: "Alice's Agent", description: "handy" },
      alice.userId,
    );

    const share = await app.inject({
      method: "POST",
      url: `/api/agents/${aliceAgent.id}/share`,
      headers: alice.headers,
      payload: { username: "bob" },
    });
    expect(share.statusCode).toBe(201);
    const { agent: clone } = share.json() as { agent: { id: string; name: string } };
    expect(clone.id).not.toBe(aliceAgent.id);

    const bobSeesClone = await app.inject({
      method: "GET",
      url: `/api/agents/${clone.id}`,
      headers: bob.headers,
    });
    expect(bobSeesClone.statusCode).toBe(200);

    // Bob's clone doesn't grant him access to Alice's original.
    const bobGetsOriginal = await app.inject({
      method: "GET",
      url: `/api/agents/${aliceAgent.id}`,
      headers: bob.headers,
    });
    expect(bobGetsOriginal.statusCode).toBe(404);
    await app.close();
  });

  it("rejects sharing with an unknown username and sharing an Agent you don't own", async () => {
    const { app, agents, auth } = await makeRealApp();
    const alice = await loginAs(auth, "alice");
    const bob = await loginAs(auth, "bob");
    const aliceAgent = await agents.createAgent({ name: "Alice's Agent" }, alice.userId);

    const unknownRecipient = await app.inject({
      method: "POST",
      url: `/api/agents/${aliceAgent.id}/share`,
      headers: alice.headers,
      payload: { username: "nobody" },
    });
    expect(unknownRecipient.statusCode).toBe(404);

    const notYours = await app.inject({
      method: "POST",
      url: `/api/agents/${aliceAgent.id}/share`,
      headers: bob.headers,
      payload: { username: "alice" },
    });
    expect(notYours.statusCode).toBe(404);
    await app.close();
  });
});

describe("Session collaborators", () => {
  it("lets the owner add a collaborator by username, who can then read/participate", async () => {
    const { app, agents, auth } = await makeRealApp();
    const alice = await loginAs(auth, "alice");
    const bob = await loginAs(auth, "bob");
    const aliceAgent = await agents.createAgent({ name: "Alice's Agent" }, alice.userId);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: alice.headers,
      payload: { name: "Team", memberAgentIds: [aliceAgent.id] },
    });
    const { session } = created.json() as { session: { id: string } };

    const unknownUsername = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/collaborators`,
      headers: alice.headers,
      payload: { add: ["nobody"] },
    });
    expect(unknownUsername.statusCode).toBe(404);

    const bobTriesToAddHimself = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/collaborators`,
      headers: bob.headers,
      payload: { add: ["bob"] },
    });
    expect(bobTriesToAddHimself.statusCode).toBe(404); // bob has no access yet — 404, not 403

    const addBob = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/collaborators`,
      headers: alice.headers,
      payload: { add: ["bob"] },
    });
    expect(addBob.statusCode).toBe(200);
    const { session: withBob } = addBob.json() as {
      session: { collaborators: { username: string }[]; isOwner: boolean };
    };
    expect(withBob.collaborators.map((c) => c.username)).toEqual(["bob"]);
    expect(withBob.isOwner).toBe(true);

    const bobLists = await app.inject({ method: "GET", url: "/api/sessions", headers: bob.headers });
    const { sessions: bobSessions } = bobLists.json() as {
      sessions: { id: string; isOwner: boolean }[];
    };
    expect(bobSessions).toHaveLength(1);
    expect(bobSessions[0]).toMatchObject({ id: session.id, isOwner: false });

    const bobPosts = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      headers: bob.headers,
      payload: { content: "hello team", kind: "comment" },
    });
    expect(bobPosts.statusCode).toBe(202);

    // Owner-only actions still reject a collaborator, but with 403 (they do have access).
    const bobDeletes = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}`,
      headers: bob.headers,
    });
    expect(bobDeletes.statusCode).toBe(403);
    const bobEditsRoster = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/members`,
      headers: bob.headers,
      payload: { remove: [aliceAgent.id] },
    });
    expect(bobEditsRoster.statusCode).toBe(403);
    await app.close();
  });

  it("shows a collaborator the real names of roster Agents they don't own, and lets them contribute their own", async () => {
    const { app, agents, auth } = await makeRealApp();
    const alice = await loginAs(auth, "alice");
    const bob = await loginAs(auth, "bob");
    const aliceAgent = await agents.createAgent({ name: "Alice's Docs Bot" }, alice.userId);
    const bobAgent = await agents.createAgent({ name: "Bob's Test Bot" }, bob.userId);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: alice.headers,
      payload: { name: "Team", memberAgentIds: [aliceAgent.id] },
    });
    const { session } = created.json() as { session: { id: string } };
    await app.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/collaborators`,
      headers: alice.headers,
      payload: { add: ["bob"] },
    });

    // Bob can see the real name of Alice's Agent in the roster, despite not owning it.
    const bobsView = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}`,
      headers: bob.headers,
    });
    const { session: seenByBob } = bobsView.json() as {
      session: { members: { id: string; name: string; ownerUsername: string | null }[] };
    };
    expect(seenByBob.members).toEqual([
      expect.objectContaining({ id: aliceAgent.id, name: "Alice's Docs Bot", ownerUsername: "alice" }),
    ]);

    // Bob can add his own Agent to the shared roster.
    const bobAdds = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/members`,
      headers: bob.headers,
      payload: { add: [bobAgent.id] },
    });
    expect(bobAdds.statusCode).toBe(200);
    const { session: withBobAgent } = bobAdds.json() as {
      session: { members: { id: string; name: string }[] };
    };
    expect(withBobAgent.members.map((m) => m.name).sort()).toEqual([
      "Alice's Docs Bot",
      "Bob's Test Bot",
    ]);
    await app.close();
  });
});
