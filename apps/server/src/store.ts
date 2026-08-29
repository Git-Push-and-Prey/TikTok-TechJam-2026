import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, AgentRun, Database, Message } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 2,
  agents: [],
  messages: [],
  runs: [],
  sessions: [],
});

interface DatabaseV1 {
  version: 1;
  agents: Array<Omit<Agent, "kind">>;
  messages: Array<Omit<Message, "sessionId">>;
  runs: Array<Omit<AgentRun, "sessionId">>;
}

function migrateV1ToV2(v1: DatabaseV1): Database {
  return {
    version: 2,
    agents: v1.agents.map((agent) => ({ ...agent, kind: "user" })),
    messages: v1.messages.map((message) => ({ ...message, sessionId: null })),
    runs: v1.runs.map((run) => ({ ...run, sessionId: null })),
    sessions: [],
  };
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown; agents?: unknown };
      if (parsed.version === 1 && Array.isArray(parsed.agents)) {
        this.data = migrateV1ToV2(parsed as unknown as DatabaseV1);
        await this.persist();
      } else if (parsed.version === 2 && Array.isArray(parsed.agents)) {
        this.data = parsed as unknown as Database;
      } else {
        throw new Error("Unsupported database format");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
