import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, AgentRun, Database, Message, Session } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 3,
  agents: [],
  messages: [],
  runs: [],
  sessions: [],
  users: [],
  authTokens: [],
});

interface DatabaseV1 {
  version: 1;
  agents: Array<Omit<Agent, "kind">>;
  messages: Array<Omit<Message, "sessionId">>;
  runs: Array<Omit<AgentRun, "sessionId">>;
}

interface DatabaseV2 {
  version: 2;
  agents: Array<Omit<Agent, "ownerId">>;
  messages: Message[];
  runs: AgentRun[];
  sessions: Array<Omit<Session, "ownerId">>;
}

function migrateV1ToV2(v1: DatabaseV1): DatabaseV2 {
  return {
    version: 2,
    agents: v1.agents.map((agent) => ({ ...agent, kind: "user" })),
    messages: v1.messages.map((message) => ({ ...message, sessionId: null })),
    runs: v1.runs.map((run) => ({ ...run, sessionId: null })),
    sessions: [],
  };
}

function migrateV2ToV3(v2: DatabaseV2): Database {
  return {
    version: 3,
    agents: v2.agents.map((agent) => ({ ...agent, ownerId: null })),
    messages: v2.messages,
    runs: v2.runs,
    sessions: v2.sessions.map((session) => ({ ...session, ownerId: null })),
    users: [],
    authTokens: [],
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
        this.data = migrateV2ToV3(migrateV1ToV2(parsed as unknown as DatabaseV1));
        await this.persist();
      } else if (parsed.version === 2 && Array.isArray(parsed.agents)) {
        this.data = migrateV2ToV3(parsed as unknown as DatabaseV2);
        await this.persist();
      } else if (parsed.version === 3 && Array.isArray(parsed.agents)) {
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
