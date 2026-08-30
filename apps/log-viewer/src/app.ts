import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { SessionLogReader } from "./session-log-reader.js";

const sessionIdParams = z.object({ id: z.string().min(1).max(128) });
const sessionQuery = z.object({ q: z.string().max(200).optional() });

export async function createApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });
  const reader = new SessionLogReader(config.logsDir);

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({ ok: true, service: "log-viewer" }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/sessions", async () => ({ sessions: await reader.listSessions() }));

  app.get("/api/sessions/:id", async (request) => {
    const { id } = sessionIdParams.parse(request.params);
    const { q } = sessionQuery.parse(request.query);
    return { sessionId: id, entries: await reader.readEntries(id, q) };
  });

  const publicRoot = fileURLToPath(new URL("../public", import.meta.url));
  await app.register(fastifyStatic, { root: publicRoot, prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const statusCode = validationError ? 400 : 500;
    if (statusCode >= 500) request.log.error(appError);
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
