import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { SessionEngine } from "./session-engine.js";
import { SessionLogger } from "./session-logger.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const sessionLogger = new SessionLogger(config.logsDir);
const service = new AgentService(config, store, workspaces, runner, sessionLogger);
await service.initialize();
const sessions = new SessionEngine(store, service, workspaces, config.codexTimeoutMs + 30_000);

const app = await createApp(config, service, sessions);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
