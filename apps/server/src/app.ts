import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { CredentialService } from "./credential-service.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { AuthService } from "./auth.js";
import type { SessionEngine } from "./session-engine.js";
import type { Session } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

const agentIdParams = z.object({ id: z.string().uuid() });
const credentialParams = z.object({ id: z.string().uuid(), keyId: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const sessionIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
  maxExecutionSteps: z.number().int().positive().optional(),
  maxExecutionTimeoutMs: z.number().int().positive().optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const shareAgentBody = z.object({
  username: z.string().trim().min(1),
});
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  kind: z.enum(["task", "comment"]).default("task"),
});
const revocationBody = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
const createSessionBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  memberAgentIds: z.array(z.string().uuid()).min(1).max(20),
});
const updateSessionMembersBody = z
  .object({
    add: z.array(z.string().uuid()).optional(),
    remove: z.array(z.string().uuid()).optional(),
  })
  .refine(
    (value) => (value.add?.length ?? 0) + (value.remove?.length ?? 0) > 0,
    "At least one of add/remove is required",
  );
const loginBody = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});
const registerBody = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(200),
});
const updateSessionCollaboratorsBody = z
  .object({
    add: z.array(z.string().trim().min(1)).optional(),
    remove: z.array(z.string().trim().min(1)).optional(),
  })
  .refine(
    (value) => (value.add?.length ?? 0) + (value.remove?.length ?? 0) > 0,
    "At least one of add/remove is required",
  );

export async function createApp(
  config: AppConfig,
  service: AgentService,
  sessions: SessionEngine,
  auth: AuthService,
  credentials?: CredentialService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  /**
   * Adds display-only fields to a Session response: resolved collaborator
   * usernames, whether the caller is the owner, and — since the roster can
   * hold Agents contributed by different collaborators, each still strictly
   * single-owner via `AgentService` — a read-only roster listing (name,
   * status, contributing username) so a viewer can see Agents they don't
   * personally own without that granting them any other access to those Agents.
   */
  function enrichSession(session: Session, callerId: string) {
    const collaborators = (session.collaboratorIds ?? [])
      .map((id) => auth.getUserById(id))
      .filter((user): user is { id: string; username: string } => user !== null);
    const members = session.memberAgentIds
      .map((id) => {
        try {
          const agent = service.getAgent(id);
          return {
            id: agent.id,
            name: agent.name,
            status: agent.status,
            ownerId: agent.ownerId,
            ownerUsername: agent.ownerId ? (auth.getUserById(agent.ownerId)?.username ?? null) : null,
          };
        } catch {
          return null;
        }
      })
      .filter((member): member is NonNullable<typeof member> => member !== null);
    return { ...session, collaborators, members, isOwner: session.ownerId === callerId };
  }

  app.addHook("onRequest", async (request, reply) => {
    const agentKeyMessageRequest =
      request.method === "POST" &&
      /^\/api\/agents\/[0-9a-f-]{36}\/messages(?:\?.*)?$/i.test(request.url) &&
      request.headers.authorization?.startsWith("AgentKey ");
    if (
      agentKeyMessageRequest ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth/login" ||
      request.url === "/api/auth/register"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const user = token ? await auth.resolveToken(token) : null;
    if (!user) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    request.userId = user.id;
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.post("/api/auth/login", async (request) => {
    const body = loginBody.parse(request.body);
    return auth.login(body.username, body.password);
  });

  app.post("/api/auth/register", async (request, reply) => {
    const body = registerBody.parse(request.body);
    const result = await auth.register(body.username, body.password);
    return reply.code(201).send(result);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    await auth.logout(token);
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request) => ({
    user: auth.getUserById(request.userId),
  }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async (request) => ({
    agents: service.listAgents(request.userId),
  }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body, request.userId);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id, request.userId) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body, request.userId) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id, request.userId);
  });

  app.post("/api/agents/:id/share", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = shareAgentBody.parse(request.body);
    const target = auth.getUserByUsername(body.username);
    if (!target) {
      throw new HttpError(404, `User "${body.username}" not found`);
    }
    const agent = await service.shareAgent(id, request.userId, target.id);
    return reply.code(201).send({ agent });
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id, request.userId) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id, request.userId) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id, request.userId) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id, request.userId) };
  });

  app.post("/api/agents/:id/credentials", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    service.getAgent(id, request.userId);
    if (!credentials?.isConfigured()) throw new HttpError(503, "Agent credentials are not configured");
    return reply.code(201).send(await credentials.createCredential(id));
  });

  app.get("/api/agents/:id/credentials", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    service.getAgent(id, request.userId);
    if (!credentials?.isConfigured()) throw new HttpError(503, "Agent credentials are not configured");
    return { credentials: credentials.listCredentials(id) };
  });

  app.get("/api/agents/:id/credentials/audit", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    service.getAgent(id, request.userId);
    if (!credentials?.isConfigured()) throw new HttpError(503, "Agent credentials are not configured");
    return { events: credentials.getAuditEvents(id) };
  });

  app.post("/api/agents/:id/credentials/:keyId/rotate", async (request) => {
    const { id, keyId } = credentialParams.parse(request.params);
    service.getAgent(id, request.userId);
    if (!credentials?.isConfigured()) throw new HttpError(503, "Agent credentials are not configured");
    return credentials.rotateCredential(id, keyId);
  });

  app.post("/api/agents/:id/credentials/:keyId/revoke", async (request) => {
    const { id, keyId } = credentialParams.parse(request.params);
    const body = revocationBody.parse(request.body);
    service.getAgent(id, request.userId);
    if (!credentials?.isConfigured()) throw new HttpError(503, "Agent credentials are not configured");
    return { credential: await credentials.revokeCredential(id, keyId, body.reason ?? null) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const agentKeyAuth = request.headers.authorization?.startsWith("AgentKey ");
    if (agentKeyAuth) {
      if (!credentials?.isConfigured()) throw new HttpError(503, "Agent credentials are not configured");
      await credentials.verifyCredential(id, request.headers.authorization);
    }
    const result = await service.sendMessage(id, body.content, agentKeyAuth ? undefined : request.userId);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id, request.userId) };
  });

  app.get("/api/sessions", async (request) => ({
    sessions: sessions.listSessions(request.userId).map((session) => enrichSession(session, request.userId)),
  }));

  app.post("/api/sessions", async (request, reply) => {
    const body = createSessionBody.parse(request.body);
    const session = await sessions.createSession(body, request.userId);
    return reply.code(201).send({ session: enrichSession(session, request.userId) });
  });

  app.get("/api/sessions/:id", async (request) => {
    const { id } = sessionIdParams.parse(request.params);
    return { session: enrichSession(sessions.getSession(id, request.userId), request.userId) };
  });

  app.patch("/api/sessions/:id/members", async (request) => {
    const { id } = sessionIdParams.parse(request.params);
    const body = updateSessionMembersBody.parse(request.body);
    const session = await sessions.updateMembers(id, body.add, body.remove, request.userId);
    return { session: enrichSession(session, request.userId) };
  });

  app.patch("/api/sessions/:id/collaborators", async (request) => {
    const { id } = sessionIdParams.parse(request.params);
    const body = updateSessionCollaboratorsBody.parse(request.body);
    const resolve = (username: string) => {
      const user = auth.getUserByUsername(username);
      if (!user) {
        throw new HttpError(404, `User "${username}" not found`);
      }
      return user.id;
    };
    const add = (body.add ?? []).map(resolve);
    const remove = (body.remove ?? []).map(resolve);
    const session = await sessions.updateCollaborators(id, add, remove, request.userId);
    return { session: enrichSession(session, request.userId) };
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = sessionIdParams.parse(request.params);
    await sessions.deleteSession(id, request.userId);
    return reply.code(204).send();
  });

  app.post("/api/sessions/:id/stop", async (request) => {
    const { id } = sessionIdParams.parse(request.params);
    const session = await sessions.stopSession(id, request.userId);
    return { session: enrichSession(session, request.userId) };
  });

  app.get("/api/sessions/:id/messages", async (request) => {
    const { id } = sessionIdParams.parse(request.params);
    return { messages: sessions.transcriptFor(id, request.userId) };
  });

  app.post("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = sessionIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const username = auth.getUserById(request.userId)?.username;
    const result =
      body.kind === "comment"
        ? await sessions.postComment(id, body.content, request.userId, username)
        : await sessions.handleUserMessage(id, body.content, request.userId, username);
    return reply.code(202).send(result);
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
