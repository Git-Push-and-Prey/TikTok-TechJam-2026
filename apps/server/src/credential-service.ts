import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { AppConfig } from "./config.js";
import { CredentialError, HttpError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  AgentCredential,
  CredentialAuditEvent,
  CredentialMetadata,
} from "./types.js";

const now = () => new Date().toISOString();

function toMetadata(credential: AgentCredential): CredentialMetadata {
  const {
    encryptedSecret: _encryptedSecret,
    iv: _iv,
    authTag: _authTag,
    ...metadata
  } = credential;
  return {
    ...metadata,
    overlapUntil: metadata.overlapUntil ?? null,
    revokedAt: metadata.revokedAt ?? null,
    revocationReason: metadata.revocationReason ?? null,
  };
}

export interface IssuedCredential {
  keyId: string;
  secret: string;
  expiresAt: string;
}

/** Server-side credential middleware service. It never persists or logs raw secrets. */
export class CredentialService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
  ) {}

  isConfigured(): boolean {
    return this.config.agentCredentialMasterKey !== null;
  }

  async createCredential(agentId: string): Promise<IssuedCredential> {
    return this.issueCredential(agentId, "key_created");
  }

  async rotateCredential(agentId: string, keyId: string): Promise<IssuedCredential> {
    const timestamp = now();
    const overlapUntil = new Date(
      Date.now() + this.config.agentCredentialOverlapMs,
    ).toISOString();
    await this.store.mutate((database) => {
      const credential = database.credentials.find(
        (item) => item.agentId === agentId && item.keyId === keyId,
      );
      if (!credential) throw new HttpError(404, "Credential not found");
      if (credential.status === "revoked" || credential.status === "expired") {
        throw new HttpError(409, "Only an active credential can be rotated");
      }
      credential.status = "rotating";
      credential.overlapUntil = overlapUntil;
      database.credentialAuditEvents.push(
        this.audit("key_rotated", credential, timestamp),
      );
    });
    return this.issueCredential(agentId, "key_created");
  }

  async revokeCredential(
    agentId: string,
    keyId: string,
    reason: string | null = null,
  ): Promise<CredentialMetadata> {
    const timestamp = now();
    return this.store.mutate((database) => {
      const credential = database.credentials.find(
        (item) => item.agentId === agentId && item.keyId === keyId,
      );
      if (!credential) throw new HttpError(404, "Credential not found");
      if (credential.status !== "revoked") {
        credential.status = "revoked";
        credential.revokedAt = timestamp;
        credential.revocationReason = reason;
        database.credentialAuditEvents.push(
          this.audit("key_revoked", credential, timestamp, reason),
        );
      }
      return toMetadata(credential);
    });
  }

  async revokeAllForAgent(agentId: string, reason = "Agent deleted"): Promise<void> {
    const timestamp = now();
    await this.store.mutate((database) => {
      for (const credential of database.credentials) {
        if (credential.agentId !== agentId || credential.status === "revoked") continue;
        credential.status = "revoked";
        credential.revokedAt = timestamp;
        credential.revocationReason = reason;
        database.credentialAuditEvents.push(
          this.audit("key_revoked", credential, timestamp, reason),
        );
      }
    });
  }

  async expireCredentialIfNeeded(keyId: string): Promise<boolean> {
    const timestamp = now();
    return this.store.mutate((database) => {
      const credential = database.credentials.find((item) => item.keyId === keyId);
      if (!credential || credential.status === "revoked" || credential.status === "expired") {
        return false;
      }
      const rotatingPastOverlap =
        credential.status === "rotating" &&
        (!credential.overlapUntil || timestamp > credential.overlapUntil);
      if (!rotatingPastOverlap && timestamp < credential.expiresAt) return false;
      credential.status = "expired";
      database.credentialAuditEvents.push(this.audit("key_expired", credential, timestamp));
      return true;
    });
  }

  listCredentials(agentId: string): CredentialMetadata[] {
    return this.store
      .snapshot()
      .credentials.filter((credential) => credential.agentId === agentId)
      .map(toMetadata)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getAuditEvents(agentId: string): CredentialAuditEvent[] {
    return this.store
      .snapshot()
      .credentialAuditEvents.filter((event) => event.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async verifyCredential(agentId: string, authorization: string | undefined): Promise<void> {
    const parsed = this.parseAuthorization(authorization);
    if (!parsed) throw new CredentialError();
    const timestamp = now();
    const failure = await this.store.mutate((database) => {
      const credential = database.credentials.find((item) => item.keyId === parsed.keyId);
      if (!credential || credential.agentId !== agentId) {
        if (credential) {
          database.credentialAuditEvents.push(
            this.audit("authentication_failed", credential, timestamp),
          );
        }
        return "invalid";
      }
      if (credential.status === "revoked") {
        database.credentialAuditEvents.push(
          this.audit("authentication_failed_revoked_key", credential, timestamp),
        );
        return "revoked";
      }
      if (credential.status === "expired") {
        database.credentialAuditEvents.push(
          this.audit("authentication_failed", credential, timestamp, "Credential expired"),
        );
        return "expired";
      }
      if (credential.status === "rotating") {
        if (!credential.overlapUntil || timestamp > credential.overlapUntil) {
          credential.status = "expired";
          database.credentialAuditEvents.push(this.audit("key_expired", credential, timestamp));
          return "expired";
        }
      } else if (timestamp >= credential.expiresAt) {
        credential.status = "expired";
        database.credentialAuditEvents.push(this.audit("key_expired", credential, timestamp));
        return "expired";
      }

      const expectedSecret = this.decrypt(credential);
      const suppliedSecret = Buffer.from(parsed.secret, "base64url");
      const valid =
        suppliedSecret.length === expectedSecret.length &&
        timingSafeEqual(suppliedSecret, expectedSecret);
      if (!valid) {
        database.credentialAuditEvents.push(
          this.audit("authentication_failed", credential, timestamp),
        );
        return "invalid";
      }
      credential.lastUsedAt = timestamp;
      database.credentialAuditEvents.push(
        this.audit("authentication_succeeded", credential, timestamp),
      );
      return null;
    });
    if (failure) throw new CredentialError();
  }

  private async issueCredential(
    agentId: string,
    eventType: "key_created",
  ): Promise<IssuedCredential> {
    const masterKey = this.masterKey();
    const timestamp = now();
    const keyId = randomUUID();
    const rawSecret = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
    const encryptedSecret = Buffer.concat([cipher.update(rawSecret), cipher.final()]);
    const credential: AgentCredential = {
      keyId,
      agentId,
      // One Agent owns one workspace in this Starter Kit.
      workspaceId: agentId,
      encryptedSecret: encryptedSecret.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      createdAt: timestamp,
      expiresAt: new Date(Date.now() + this.config.agentCredentialTtlMs).toISOString(),
      status: "active",
      lastUsedAt: null,
    };
    await this.store.mutate((database) => {
      if (!database.agents.some((agent) => agent.id === agentId)) {
        throw new HttpError(404, "Agent not found");
      }
      database.credentials.push(credential);
      database.credentialAuditEvents.push(this.audit(eventType, credential, timestamp));
    });
    return {
      keyId,
      secret: "agent_key_" + keyId + "." + rawSecret.toString("base64url"),
      expiresAt: credential.expiresAt,
    };
  }

  private parseAuthorization(header: string | undefined): { keyId: string; secret: string } | null {
    if (!header?.startsWith("AgentKey agent_key_")) return null;
    const value = header.slice("AgentKey agent_key_".length);
    const separator = value.indexOf(".");
    if (separator <= 0 || separator !== value.lastIndexOf(".")) return null;
    const keyId = value.slice(0, separator);
    const secret = value.slice(separator + 1);
    if (!/^[0-9a-f-]{36}$/i.test(keyId) || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;
    return { keyId, secret };
  }

  private decrypt(credential: AgentCredential): Buffer {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.masterKey(),
      Buffer.from(credential.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(credential.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(credential.encryptedSecret, "base64")),
      decipher.final(),
    ]);
  }

  private masterKey(): Buffer {
    if (!this.config.agentCredentialMasterKey) {
      throw new HttpError(503, "Agent credentials are not configured");
    }
    return this.config.agentCredentialMasterKey;
  }

  private audit(
    type: CredentialAuditEvent["type"],
    credential: AgentCredential,
    createdAt: string,
    reason: string | null = null,
  ): CredentialAuditEvent {
    return {
      id: randomUUID(),
      type,
      agentId: credential.agentId,
      workspaceId: credential.workspaceId,
      keyId: credential.keyId,
      createdAt,
      ...(reason ? { reason } : {}),
    };
  }
}
