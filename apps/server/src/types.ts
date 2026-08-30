export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type AgentKind = "user" | "orchestrator";
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
  /** The User that owns this Agent. Null for rows migrated before accounts existed. */
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  username: string;
  /** Self-describing scrypt hash string: "scrypt:<saltHex>:<hashHex>". */
  passwordHash: string;
  createdAt: string;
}

export interface AuthToken {
  /** sha256 hex digest of the opaque bearer token — the raw token is never persisted. */
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
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
  /**
   * "comment" = a human-to-human aside in a Session, not addressed to any
   * Agent (no `recipientId`) and never gated by the Session's `stage`.
   * Absent/"task" for every other message (a normal turn to the
   * orchestrator, or a Playground message).
   */
  kind?: "task" | "comment";
  /** The real User who sent this — set only for human turns in a Session. */
  senderUserId?: string;
  /** Denormalized at write time, like SessionLogger's `agentName`, so no lookup is needed to render it. */
  senderUsername?: string;
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
  /** The User that created this Session. Null for rows migrated before accounts existed. */
  ownerId: string | null;
  /** Other Users with full read/participate access. Absent means none — read as `?? []`. */
  collaboratorIds?: string[];
  createdAt: string;
  updatedAt: string;
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
  version: 4;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  sessions: Session[];
  users: User[];
  authTokens: AuthToken[];
  credentials: AgentCredential[];
  credentialAuditEvents: CredentialAuditEvent[];
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
