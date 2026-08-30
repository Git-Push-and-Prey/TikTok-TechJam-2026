import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeLogsDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "log-viewer-app-test-"));
  temporaryDirectories.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "agent-1.log"),
    JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "user_message", agentName: "Builder", content: "hi" }) +
      "\n",
    "utf8",
  );
  return root;
}

describe("Log viewer HTTP boundary", () => {
  it(
    "lists and reads sessions without auth when no token is configured",
    async () => {
      // Fastify app construction can take several seconds on a slow/cold
      // machine (this is typically the first app built in the file) — the
      // test logic itself is instant, so give it real headroom rather than
      // relying on vitest's 5s default.
      const logsDir = await makeLogsDir();
      const app = await createApp(loadConfig({ NODE_ENV: "test", LOGS_DIR: logsDir }));

      const list = await app.inject({ method: "GET", url: "/api/sessions" });
      expect(list.statusCode).toBe(200);
      expect(list.json().sessions).toHaveLength(1);

      const detail = await app.inject({ method: "GET", url: "/api/sessions/agent-1" });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().entries).toHaveLength(1);

      await app.close();
    },
    20_000,
  );

  it("protects API routes with the configured shared token", async () => {
    const logsDir = await makeLogsDir();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", LOGS_DIR: logsDir, LOG_VIEWER_AUTH_TOKEN: "a-strong-test-token" }),
    );

    const denied = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);

    await app.close();
  });

  it("filters a session's entries by keyword via the query string", async () => {
    const logsDir = await makeLogsDir();
    const app = await createApp(loadConfig({ NODE_ENV: "test", LOGS_DIR: logsDir }));

    const match = await app.inject({ method: "GET", url: "/api/sessions/agent-1?q=hi" });
    expect(match.json().entries).toHaveLength(1);

    const noMatch = await app.inject({ method: "GET", url: "/api/sessions/agent-1?q=nope" });
    expect(noMatch.json().entries).toHaveLength(0);

    await app.close();
  });
});
