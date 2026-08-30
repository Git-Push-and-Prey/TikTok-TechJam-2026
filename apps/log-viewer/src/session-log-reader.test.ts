import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionLogReader } from "./session-log-reader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeLogsDir(files: Record<string, string[]>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "log-viewer-test-"));
  temporaryDirectories.push(root);
  await mkdir(root, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    await writeFile(path.join(root, name), lines.join("\n") + "\n", "utf8");
  }
  return root;
}

describe("SessionLogReader", () => {
  it("returns an empty list when the logs directory does not exist yet", async () => {
    const reader = new SessionLogReader(path.join(tmpdir(), "does-not-exist-" + Date.now()));
    expect(await reader.listSessions()).toEqual([]);
  });

  it("summarizes each session file into one entry with counts, timestamps, and owner", async () => {
    const logsDir = await makeLogsDir({
      "agent-1.log": [
        JSON.stringify({
          ts: "2026-01-01T00:00:00.000Z",
          type: "user_message",
          agentName: "Builder",
          ownerId: "owner-1",
        }),
        JSON.stringify({
          ts: "2026-01-01T00:00:05.000Z",
          type: "tool_call",
          agentName: "Builder",
          ownerId: "owner-1",
        }),
        JSON.stringify({
          ts: "2026-01-01T00:00:10.000Z",
          type: "agent_response",
          agentName: "Builder",
          ownerId: "owner-1",
        }),
      ],
    });
    const reader = new SessionLogReader(logsDir);
    const sessions = await reader.listSessions();
    expect(sessions).toEqual([
      {
        sessionId: "agent-1",
        agentName: "Builder",
        ownerId: "owner-1",
        entryCount: 3,
        firstAt: "2026-01-01T00:00:00.000Z",
        lastAt: "2026-01-01T00:00:10.000Z",
        counts: { user_message: 1, tool_call: 1, agent_response: 1 },
      },
    ]);
  });

  it("reports a null owner for legacy entries written before login existed", async () => {
    const logsDir = await makeLogsDir({
      "agent-legacy.log": [
        JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "user_message", agentName: "Old" }),
      ],
    });
    const reader = new SessionLogReader(logsDir);
    const sessions = await reader.listSessions();
    expect(sessions[0]?.ownerId).toBeNull();
  });

  it("filters entries by a case-insensitive keyword", async () => {
    const logsDir = await makeLogsDir({
      "agent-2.log": [
        JSON.stringify({ ts: "t1", type: "user_message", content: "write hello world" }),
        JSON.stringify({ ts: "t2", type: "agent_response", content: "Done, tests pass" }),
      ],
    });
    const reader = new SessionLogReader(logsDir);
    const matches = await reader.readEntries("agent-2", "HELLO");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.content).toBe("write hello world");
  });

  it("skips malformed lines instead of failing the whole session", async () => {
    const logsDir = await makeLogsDir({
      "agent-3.log": [JSON.stringify({ ts: "t1", type: "user_message" }), "{not-json"],
    });
    const reader = new SessionLogReader(logsDir);
    const entries = await reader.readEntries("agent-3");
    expect(entries).toHaveLength(1);
  });

  it("returns no entries for an unknown session id", async () => {
    const logsDir = await makeLogsDir({});
    const reader = new SessionLogReader(logsDir);
    expect(await reader.readEntries("missing")).toEqual([]);
  });
});
