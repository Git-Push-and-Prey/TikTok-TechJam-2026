import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  describeCodexFailure,
  parseCodexEventLine,
} from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("explains ModelArk rate limits without removing provider detail", () => {
    const detail = "exceeded retry limit, last status: 429 Too Many Requests, request id: abc";
    expect(describeCodexFailure(detail)).toContain("BytePlus ModelArk rate limited");
    expect(describeCodexFailure(detail)).toContain("request id: abc");
  });

  it("emits a tool_call event for non-agent_message items and an error event on failures", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
    };
    const events: unknown[] = [];
    const onEvent = (event: unknown) => events.push(event);

    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "npm test", exit_code: 0 },
      }),
      parsed,
      onEvent,
    );
    parseCodexEventLine(
      JSON.stringify({ type: "error", message: "Codex ran out of turns" }),
      parsed,
      onEvent,
    );

    expect(events).toEqual([
      {
        kind: "tool_call",
        itemType: "command_execution",
        status: "succeeded",
        summary: "npm test",
        detail: { type: "command_execution", command: "npm test", exit_code: 0 },
      },
      { kind: "error", message: "Codex ran out of turns" },
    ]);
  });
});
