export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type AgentKind = "user" | "orchestrator";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

/** Sentinel party ids for Message.senderId/recipientId, alongside real Agent ids. */
export const USER_PARTY = "user";
export const SYSTEM_PARTY = "system";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  kind: AgentKind;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  sessionId: string | null;
  /**
   * Who sent / received this message: USER_PARTY, SYSTEM_PARTY, or an Agent id.
   * A message is user-facing iff the user is the sender or the recipient —
   * that's what distinguishes a real human/orchestrator exchange from
   * internal engine prompts and orchestrator<->sub-agent delegation traffic.
   * Optional for backward compatibility with rows written before this field
   * existed; absent means "treat as user-facing" (legacy data default).
   */
  senderId?: string;
  recipientId?: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  sessionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export type SessionStage =
  | "idle"
  | "decomposing"
  | "delegating"
  | "synthesizing"
  | "failed";

export interface PendingSubtask {
  runId: string;
  agentId: string;
  task: string;
}

export interface Session {
  id: string;
  name: string;
  description: string;
  memberAgentIds: string[];
  orchestratorAgentId: string;
  workspacePath: string;
  stage: SessionStage;
  pendingSubtasks: PendingSubtask[];
  memberThreadIds: Record<string, string | null>;
  formatRetries: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Database {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  sessions: Session[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  kind?: AgentKind | undefined;
}

export interface CreateSessionInput {
  name: string;
  description?: string | undefined;
  memberAgentIds: string[];
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export type RunnerEvent =
  | {
      kind: "tool_call";
      itemType: string;
      status: string;
      summary: string;
      detail: unknown;
    }
  | { kind: "error"; message: string };

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  onEvent?: (event: RunnerEvent) => void;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
