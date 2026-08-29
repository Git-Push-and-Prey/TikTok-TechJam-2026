import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\bsk-or-[A-Za-z0-9_-]{8,}/g,
  /\b[A-Za-z0-9]{32,}\b/g,
];
const MAX_FIELD_LENGTH = 4_000;

function truncateString(value: string): string {
  return value.length > MAX_FIELD_LENGTH
    ? value.slice(0, MAX_FIELD_LENGTH) + "…[truncated]"
    : value;
}

function truncateDetail(detail: unknown): unknown {
  const serialized = JSON.stringify(detail);
  if (serialized === undefined || serialized.length <= MAX_FIELD_LENGTH) return detail;
  return { truncated: true, preview: serialized.slice(0, MAX_FIELD_LENGTH) };
}

/** Caps string/object fields to MAX_FIELD_LENGTH so a giant Codex output can't blow up the log file, while keeping the line valid JSON. */
function boundEntry(entry: SessionLogEntry): SessionLogEntry {
  switch (entry.type) {
    case "user_message":
      return { ...entry, content: truncateString(entry.content) };
    case "agent_response":
      return { ...entry, content: truncateString(entry.content) };
    case "tool_call":
      return {
        ...entry,
        summary: truncateString(entry.summary),
        detail: truncateDetail(entry.detail),
      };
    case "error":
      return { ...entry, message: truncateString(entry.message) };
  }
}

/** Strips API keys/bearer tokens/long opaque strings from a serialized log line before it touches disk. */
function redact(serialized: string): string {
  let result = serialized;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[redacted]");
  return result;
}

export type SessionLogEntry =
  | { type: "user_message"; content: string }
  | { type: "tool_call"; itemType: string; status: string; summary: string; detail: unknown }
  | { type: "agent_response"; content: string; usage: unknown }
  | { type: "error"; message: string };

export interface SessionLogContext {
  agentId: string;
  agentName: string;
  runId: string;
}

/** One append-only JSONL file per Agent conversation (session = agentId), so the whole exchange history lives in one place. */
export class SessionLogger {
  constructor(private readonly logsDir: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.logsDir, { recursive: true });
  }

  private sessionPath(agentId: string): string {
    const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.logsDir, safe + ".log");
  }

  private async write(context: SessionLogContext, entry: SessionLogEntry): Promise<void> {
    const record = {
      ts: new Date().toISOString(),
      sessionId: context.agentId,
      agentName: context.agentName,
      runId: context.runId,
      ...boundEntry(entry),
    };
    const line = redact(JSON.stringify(record));
    try {
      await appendFile(this.sessionPath(context.agentId), line + "\n", "utf8");
    } catch {
      // Logging must never break a Run; drop the entry on write failure.
    }
  }

  logUserMessage(context: SessionLogContext, content: string): Promise<void> {
    return this.write(context, { type: "user_message", content });
  }

  logToolCall(
    context: SessionLogContext,
    input: { itemType: string; status: string; summary: string; detail: unknown },
  ): Promise<void> {
    return this.write(context, { type: "tool_call", ...input });
  }

  logAgentResponse(context: SessionLogContext, content: string, usage: unknown): Promise<void> {
    return this.write(context, { type: "agent_response", content, usage });
  }

  logError(context: SessionLogContext, message: string): Promise<void> {
    return this.write(context, { type: "error", message });
  }
}
