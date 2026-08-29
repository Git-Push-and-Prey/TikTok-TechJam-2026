import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Mirrors the JSONL record shape written by apps/server's SessionLogger.
 * Deliberately untyped beyond the common envelope fields — this viewer
 * renders whatever a session file actually contains rather than depending
 * on the server package's internal types.
 */
export interface SessionEntry {
  ts?: string;
  sessionId?: string;
  agentName?: string;
  runId?: string;
  type?: string;
  [key: string]: unknown;
}

export interface SessionSummary {
  sessionId: string;
  agentName: string | null;
  entryCount: number;
  firstAt: string | null;
  lastAt: string | null;
  counts: Record<string, number>;
}

function sessionFilePath(logsDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(logsDir, safe + ".log");
}

function parseLines(raw: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // Skip a malformed/partially-written line rather than failing the whole session.
    }
  }
  return entries;
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class SessionLogReader {
  constructor(private readonly logsDir: string) {}

  async listSessions(): Promise<SessionSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.logsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".log")) continue;
      const raw = await readFileSafe(path.join(this.logsDir, file));
      if (!raw) continue;
      const entries = parseLines(raw);
      if (entries.length === 0) continue;
      summaries.push(this.summarize(path.basename(file, ".log"), entries));
    }
    return summaries.sort((left, right) => (right.lastAt ?? "").localeCompare(left.lastAt ?? ""));
  }

  async readEntries(sessionId: string, keyword?: string): Promise<SessionEntry[]> {
    const raw = await readFileSafe(sessionFilePath(this.logsDir, sessionId));
    if (!raw) return [];
    const entries = parseLines(raw);
    if (!keyword?.trim()) return entries;
    const needle = keyword.trim().toLowerCase();
    return entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(needle));
  }

  private summarize(sessionId: string, entries: SessionEntry[]): SessionSummary {
    const counts: Record<string, number> = {};
    let agentName: string | null = null;
    for (const entry of entries) {
      const type = entry.type ?? "unknown";
      counts[type] = (counts[type] ?? 0) + 1;
      if (typeof entry.agentName === "string" && entry.agentName) agentName = entry.agentName;
    }
    return {
      sessionId,
      agentName,
      entryCount: entries.length,
      firstAt: entries[0]?.ts ?? null,
      lastAt: entries.at(-1)?.ts ?? null,
      counts,
    };
  }
}
