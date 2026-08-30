import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialService } from "./credential-service.js";
import { createApp } from "./app.js";
import type { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeCredentials(overlap = 300_000) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-credential-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const agentId = "00000000-0000-4000-8000-000000000001";
  await store.mutate((database) => {
    database.agents.push({
      id: agentId,
      name: "Credential test",
      description: "",
      instructions: "",
      status: "ready",
      workspacePath: path.join(root, "workspace"),
      codexThreadId: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });
  const config = loadConfig({
    NODE_ENV: "test",
    AGENT_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    AGENT_CREDENTIAL_OVERLAP_MS: String(overlap),
  });
  return { agentId, service: new CredentialService(config, store), store };
}

describe("CredentialService", () => {
  it("encrypts a newly issued secret and returns it only at issuance", async () => {
    const { agentId, service, store } = await makeCredentials();
    const issued = await service.createCredential(agentId);

    expect(issued.secret).toMatch(/^agent_key_[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
    const credential = store.snapshot().credentials[0];
    expect(credential?.encryptedSecret).not.toContain(issued.secret);
    expect(JSON.stringify(store.snapshot())).not.toContain(issued.secret);
    expect(service.listCredentials(agentId)[0]).not.toHaveProperty("encryptedSecret");

    await expect(service.verifyCredential(agentId, "AgentKey " + issued.secret)).resolves.toBeUndefined();
    expect(service.listCredentials(agentId)[0]?.lastUsedAt).not.toBeNull();
  });

  it("keeps the old key valid during rotation overlap, then expires it", async () => {
    const { agentId, service, store } = await makeCredentials();
    const oldKey = await service.createCredential(agentId);
    const newKey = await service.rotateCredential(agentId, oldKey.keyId);
    await expect(service.verifyCredential(agentId, "AgentKey " + oldKey.secret)).resolves.toBeUndefined();
    await expect(service.verifyCredential(agentId, "AgentKey " + newKey.secret)).resolves.toBeUndefined();

    await store.mutate((database) => {
      const oldCredential = database.credentials.find((item) => item.keyId === oldKey.keyId);
      if (oldCredential) oldCredential.overlapUntil = "2000-01-01T00:00:00.000Z";
    });
    await expect(service.verifyCredential(agentId, "AgentKey " + oldKey.secret)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(service.listCredentials(agentId).find((item) => item.keyId === oldKey.keyId)?.status)
      .toBe("expired");
    expect(service.getAuditEvents(agentId).some((event) => event.type === "key_expired")).toBe(true);
  });

  it("revokes credentials and records failed revoked-key authentication without storing secrets", async () => {
    const { agentId, service } = await makeCredentials();
    const issued = await service.createCredential(agentId);
    await service.revokeCredential(agentId, issued.keyId, "operator request");
    await expect(service.verifyCredential(agentId, "AgentKey " + issued.secret)).rejects.toMatchObject({
      statusCode: 401,
    });
    const events = service.getAuditEvents(agentId);
    expect(events.some((event) => event.type === "authentication_failed_revoked_key")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(issued.secret);
  });

  it("revokes every credential when an Agent is removed", async () => {
    const { agentId, service } = await makeCredentials();
    const first = await service.createCredential(agentId);
    const second = await service.createCredential(agentId);
    await service.revokeAllForAgent(agentId, "Agent deleted");

    await expect(service.verifyCredential(agentId, "AgentKey " + first.secret)).rejects
      .toMatchObject({ statusCode: 401 });
    await expect(service.verifyCredential(agentId, "AgentKey " + second.secret)).rejects
      .toMatchObject({ statusCode: 401 });
    expect(service.listCredentials(agentId).every((credential) => credential.status === "revoked"))
      .toBe(true);
  });

  it("authenticates AgentKey requests at the Fastify message boundary", async () => {
    const { agentId, service: credentials } = await makeCredentials();
    const issued = await credentials.createCredential(agentId);
    const sendMessage = async () => ({ run: {}, message: {} });
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        APP_AUTH_TOKEN: "shared-demo-token",
        AGENT_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      }),
      { sendMessage } as unknown as AgentService,
      credentials,
    );
    const allowed = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      headers: {
        authorization: "AgentKey " + issued.secret,
        "content-type": "application/json",
      },
      payload: { content: "secure message" },
    });
    expect(allowed.statusCode).toBe(202);

    const denied = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      headers: {
        authorization: "AgentKey agent_key_00000000-0000-4000-8000-000000000000.bad",
        "content-type": "application/json",
      },
      payload: { content: "secure message" },
    });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });
});
