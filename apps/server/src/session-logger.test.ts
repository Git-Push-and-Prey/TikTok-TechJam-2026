import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionLogger } from "./session-logger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeLogger(): Promise<{ logger: SessionLogger; logsDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-logs-test-"));
  temporaryDirectories.push(root);
  const logsDir = path.join(root, "logs");
  const logger = new SessionLogger(logsDir);
  await logger.initialize();
  return { logger, logsDir };
}

async function readLines(logsDir: string, agentId: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path.join(logsDir, agentId + ".log"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("SessionLogger", () => {
  it("appends one JSONL entry per event into a single file for the session", async () => {
    const { logger, logsDir } = await makeLogger();
    const context = { agentId: "agent-1", agentName: "Builder", runId: "run-1" };

    await logger.logUserMessage(context, "build a calculator");
    await logger.logToolCall(context, {
      itemType: "command_execution",
      status: "succeeded",
      summary: "npm test",
      detail: { command: "npm test", exitCode: 0 },
    });
    await logger.logAgentResponse(context, "Done.", { inputTokens: 10, outputTokens: 4 });

    const entries = await readLines(logsDir, "agent-1");
    expect(entries.map((entry) => entry.type)).toEqual([
      "user_message",
      "tool_call",
      "agent_response",
    ]);
    expect(entries[0]).toMatchObject({ sessionId: "agent-1", agentName: "Builder", runId: "run-1" });
    expect(entries[1]).toMatchObject({ summary: "npm test" });
    expect(entries[2]).toMatchObject({ content: "Done." });
  });

  it("appends multiple runs from the same agent to the same session file", async () => {
    const { logger, logsDir } = await makeLogger();
    const context = { agentId: "agent-2", agentName: "Builder", runId: "run-1" };
    await logger.logUserMessage(context, "first message");
    await logger.logUserMessage({ ...context, runId: "run-2" }, "second message");

    const entries = await readLines(logsDir, "agent-2");
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.runId)).toEqual(["run-1", "run-2"]);
  });

  it("redacts bearer tokens and API-key-shaped strings before writing to disk", async () => {
    const { logger, logsDir } = await makeLogger();
    const context = { agentId: "agent-3", agentName: "Builder", runId: "run-1" };
    await logger.logError(
      context,
      "Request failed with Authorization: Bearer abcdEFGH12345678ijklMNOPqrst",
    );

    const raw = await readFile(path.join(logsDir, "agent-3.log"), "utf8");
    expect(raw).not.toContain("abcdEFGH12345678ijklMNOPqrst");
    expect(raw).toContain("[redacted]");
  });

  it("truncates oversized fields while keeping the line valid JSON", async () => {
    const { logger, logsDir } = await makeLogger();
    const context = { agentId: "agent-4", agentName: "Builder", runId: "run-1" };
    await logger.logAgentResponse(context, "x".repeat(10_000), null);

    const entries = await readLines(logsDir, "agent-4");
    expect(entries).toHaveLength(1);
    expect(String(entries[0]?.content).length).toBeLessThan(10_000);
    expect(entries[0]?.content).toMatch(/…\[truncated\]$/);
  });
});
