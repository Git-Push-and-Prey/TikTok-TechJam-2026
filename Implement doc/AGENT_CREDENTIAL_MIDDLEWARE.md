# Agent Credential Middleware

**Author: GuanHuaYu**

## Overview

This document describes the Agent Credential Middleware added for TikTok
TechJam 2026 Track 1. The feature adds an independent credential lifecycle for
each Agent without changing the existing Agent CRUD, Playground, Run lifecycle,
workspace model, or Codex Runtime flow.

The current Starter Kit gives each Agent one persistent workspace. Therefore,
this proof of concept uses `agentId` as the stable `workspaceId`.

## Credential Format

An issued credential has the following format:

```text
agent_key_<keyId>.<secret>
```

Clients authenticate a protected Agent action with:

```text
Authorization: AgentKey agent_key_<keyId>.<secret>
```

`keyId` is a UUID. The secret is generated with Node.js `crypto.randomBytes(32)`.

## Server-Side Security Model

Credential validation occurs only at the trusted Fastify server boundary,
before `AgentService.sendMessage()` is called.

The server validates:

1. Credential format and key ID.
2. Credential ownership for the Agent in the URL.
3. Credential status.
4. Credential expiration and rotation-overlap expiry.
5. The decrypted secret using `crypto.timingSafeEqual()`.

Raw credentials are never written to JSON persistence, audit events, logs, or
ordinary API responses. A raw secret is returned only once, when a credential
is created or rotated.

## Encryption at Rest

The JSON store contains encrypted credential material only:

- `encryptedSecret`
- `iv`
- `authTag`

The implementation uses AES-256-GCM and the required environment variable:

```text
AGENT_CREDENTIAL_MASTER_KEY
```

The value must be a base64-encoded 32-byte key. It is validated at startup and
is not included in system information, persisted data, or logs.

## Credential States

| Status | Behaviour |
| --- | --- |
| `active` | Valid until `expiresAt`. |
| `rotating` | The previous key remains valid until `overlapUntil`. |
| `expired` | Rejected with HTTP 401. |
| `revoked` | Rejected with HTTP 401 immediately. |

During rotation, the old credential becomes `rotating` and a new credential is
created as `active`. When the overlap period ends, the old credential is
automatically marked `expired` upon validation.

## API Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/agents/:id/credentials` | Create a credential and return its raw secret once. |
| GET | `/api/agents/:id/credentials` | List safe credential metadata. |
| GET | `/api/agents/:id/credentials/audit` | List credential audit events. |
| POST | `/api/agents/:id/credentials/:keyId/rotate` | Rotate an active credential. |
| POST | `/api/agents/:id/credentials/:keyId/revoke` | Revoke a credential. |

Credential-management endpoints remain behind the existing control-plane
authentication behavior. AgentKey authentication is supported for the existing
`POST /api/agents/:id/messages` protected Agent action.

## Audit Events

The middleware records safe, correlated events such as:

- `key_created`
- `key_rotated`
- `key_revoked`
- `key_expired`
- `authentication_succeeded`
- `authentication_failed`
- `authentication_failed_revoked_key`

Audit records contain IDs, timestamps, Agent/workspace correlation, and safe
reasons where applicable. They never contain the raw credential or decrypted
secret.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_CREDENTIAL_MASTER_KEY` | Unset | Required to enable credential APIs; base64 32-byte AES key. |
| `AGENT_CREDENTIAL_TTL_MS` | `2592000000` | Credential lifetime in milliseconds. |
| `AGENT_CREDENTIAL_OVERLAP_MS` | `300000` | Previous-key grace period during rotation. |

Generate a master key locally with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

## Validation Performed

The implementation was validated with:

```bash
npm run typecheck
npm test
npm run build
```

It was also tested against a running local POC. Credential creation succeeded,
a valid AgentKey reached the protected action, an invalid key returned HTTP 401,
and the credential listing did not expose the raw secret.
