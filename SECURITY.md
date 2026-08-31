# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- **Signup is open to anyone who can reach the server** — `POST
  /api/auth/register` has no invite/approval/CAPTCHA gate. On a
  network-reachable deployment this means anyone who finds the URL can
  create an account and get Codex execution via their own Agents. No
  password reset.
- No RBAC — every logged-in user has identical permissions over their own
  resources. Sessions do support real collaboration (an owner plus
  collaborators with full participate rights, see
  [MULTI_USER_COLLABORATION.md](docs/MULTI_USER_COLLABORATION.md)) and an
  Agent can be shared to another user, but sharing clones it rather than
  granting live access to the original. There is no admin role and no way
  to grant less than full rights over what a user does have access to.
- Session logs (`logs/<agentId>.log`) carry the owning user's id per entry
  but are not access-controlled by it — reading them is still only gated by
  an optional shared token, independent of per-user login
- Per-Agent execution guardrails (`maxExecutionSteps`, `maxExecutionTimeoutMs`,
  see [middleware/execution-guardrail.ts](apps/server/src/middleware/execution-guardrail.ts))
  cap how many tool calls a single Run can make and how long it can run
  before the platform cancels it. This bounds a runaway *Run*; it is not a
  CPU/memory/process sandbox — see the container limits below for that.
- [authorization.middleware.ts](apps/server/src/authorization.middleware.ts)
  and [agent-identity.ts](apps/server/src/agent-identity.ts) implement a
  role-based (Planner/Executor/Reviewer/Orchestrator) authorization policy
  engine, but neither is called from any route, service, or Runner yet.
  Treat it as unshipped design, not an active control, until something in
  the request path actually calls `authorize()`/`executeProtectedAction()`.
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- OpenRouter key available to the server and active Runtime container
- OpenRouter key stored in Terraform POC state

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Restrict network access (security group CIDR, VPN) to anyone you don't
  want to be able to self-register and run Agents — there's no other way to
  gate signup.
- Use a scoped, revocable OpenRouter key.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before logging in over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.
