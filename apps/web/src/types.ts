export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type AgentKind = "user" | "orchestrator";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type SessionStage = "idle" | "decomposing" | "delegating" | "synthesizing" | "failed";

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
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  username: string;
}

/** Must match the server's USER_PARTY/SYSTEM_PARTY sentinels (apps/server/src/types.ts). */
export const USER_PARTY = "user";
export const SYSTEM_PARTY = "system";

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  sessionId: string | null;
  senderId?: string;
  recipientId?: string;
  kind?: "task" | "comment";
  senderUserId?: string;
  senderUsername?: string;
  createdAt: string;
}

export interface Session {
  id: string;
  name: string;
  description: string;
  memberAgentIds: string[];
  orchestratorAgentId: string;
  workspacePath: string;
  stage: SessionStage;
  pendingSubtasks: { runId: string; agentId: string; task: string }[];
  lastError: string | null;
  ownerId: string | null;
  collaborators: { id: string; username: string }[];
  members: {
    id: string;
    name: string;
    status: AgentStatus;
    ownerId: string | null;
    ownerUsername: string | null;
  }[];
  isOwner: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  openrouterConfigured: boolean;
  openrouterBaseUrl: string;
  openrouterModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
