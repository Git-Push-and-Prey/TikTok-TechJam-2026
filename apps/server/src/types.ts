export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type CredentialStatus = "active" | "rotating" | "expired" | "revoked";
export type CredentialAuditEventType =
  | "key_created"
  | "key_rotated"
  | "key_revoked"
  | "key_expired"
  | "authentication_succeeded"
  | "authentication_failed"
  | "authentication_failed_revoked_key";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
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
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AgentCredential {
  keyId: string;
  agentId: string;
  /** One Agent owns one workspace in this Starter Kit, so this is the agent ID. */
  workspaceId: string;
  encryptedSecret: string;
  iv: string;
  authTag: string;
  createdAt: string;
  expiresAt: string;
  status: CredentialStatus;
  lastUsedAt: string | null;
  overlapUntil?: string | null;
  revokedAt?: string | null;
  revocationReason?: string | null;
}

export interface CredentialAuditEvent {
  id: string;
  type: CredentialAuditEventType;
  agentId: string;
  workspaceId: string;
  keyId: string | null;
  createdAt: string;
  reason?: string | null;
}

export interface CredentialMetadata {
  keyId: string;
  agentId: string;
  workspaceId: string;
  createdAt: string;
  expiresAt: string;
  status: CredentialStatus;
  lastUsedAt: string | null;
  overlapUntil: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  credentials: AgentCredential[];
  credentialAuditEvents: CredentialAuditEvent[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
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

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
