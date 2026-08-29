import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";
import type { Database } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          sessionId: null,
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        sessionId: null,
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });

  it("migrates a v1 database on load, preserving existing agents/messages/runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-migrate-test-"));
    temporaryDirectories.push(root);
    const dbPath = path.join(root, "db.json");
    const v1 = {
      version: 1,
      agents: [
        {
          id: "agent-1",
          name: "Legacy Agent",
          description: "",
          instructions: "",
          status: "ready",
          workspacePath: "/workspaces/agent-1",
          codexThreadId: "thread-1",
          lastError: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      messages: [
        {
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "hello",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      runs: [
        {
          id: "run-1",
          agentId: "agent-1",
          status: "completed",
          prompt: "hello",
          output: "hi",
          error: null,
          usage: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await writeFile(dbPath, JSON.stringify(v1, null, 2), "utf8");

    const store = new JsonStore(dbPath);
    await store.initialize();

    const data = store.snapshot();
    expect(data.version).toBe(2);
    expect(data.sessions).toEqual([]);
    expect(data.agents[0]).toMatchObject({ id: "agent-1", kind: "user" });
    expect(data.messages[0]).toMatchObject({ id: "message-1", sessionId: null });
    expect(data.runs[0]).toMatchObject({ id: "run-1", sessionId: null });

    const onDisk = JSON.parse(await readFile(dbPath, "utf8")) as Database;
    expect(onDisk.version).toBe(2);
    expect(onDisk.agents[0]?.kind).toBe("user");
  });
});
