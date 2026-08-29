# Architecture

Volc Agent Launchpad is a single-node control plane for hackathon use.

```mermaid
flowchart LR
    UI["React Web UI"] --> API["Fastify API"]
    API --> Service["AgentService"]
    Service --> Store["JSON store"]
    Service --> Workspace["Agent workspace"]
    Service --> Runner{"AgentRunner"}
    Runner -->|Local POC| Container["Disposable Runtime container"]
    Runner -->|ECS| Process["Codex child process"]
    Container --> OpenRouter["OpenRouter"]
    Process --> OpenRouter
    Service --> SessionLogger["SessionLogger"]
    SessionLogger --> Logs["logs/AgentID.log"]
    Logs --> LogViewer["Log Viewer\n(apps/log-viewer, separate service)"]
```

## Components

### Web UI

Lists Agents, manages lifecycle actions, submits prompts, and polls asynchronous
Runs. It never receives the OpenRouter API key.

### Fastify API

Validates requests, protects remote demos with a shared bearer token, and
serves the compiled Web UI. The token is not user identity or authorization.

### AgentService

Coordinates lifecycle state, persistence, workspaces, and Runs. One Agent can
have only one active Run.

```text
ready -> busy -> ready
  |       |
  v       v
stopped  error
```

Interrupted Runs become `cancelled` after a restart.

### Storage

```text
data/launchpad.json       Agent, message, and Run metadata
workspaces/AgentID/       Agent-created files
workspaces/.deleted/      Archived deleted workspaces
codex-home/               Codex configuration and sessions
```

`JsonStore` serializes writes and atomically replaces one JSON file. It supports
one process only.

### Runtime providers

- `CodexRunner` runs Codex inside the application container for ECS.
- `ContainerCodexRunner` starts one disposable Docker, Colima, or Podman
  container for every local turn.

Both providers use argv-only process execution, bound output and time, resume
the stored Codex thread, and escalate termination after a grace period.

### Session logging

`SessionLogger` appends a redacted JSONL entry — user message, tool call,
agent response, or error — to `logs/AgentID.log` for every Run, keyed by
Agent (a "session" is one Agent's whole conversation). `AgentRunner`
implementations report tool-call and error events as they parse Codex's
`--json` stream, via an optional `onEvent` callback on `RunnerRequest`. The
`apps/log-viewer` package is a separately hosted, minimal Fastify service
that reads the same `LOGS_DIR` and serves a small static UI for listing
sessions and filtering one by keyword — it has no dependency on the main
server or its API. See [SESSION_LOGGING.md](SESSION_LOGGING.md) for the full
data flow, file format, and redaction rules.

## Deployment profiles

| Profile | Control plane | Agent execution |
| --- | --- | --- |
| Local POC | Host Node.js | Disposable local container |
| ECS | Application container | Codex process in the same container |
| Local development | Host Node.js | Host Codex process |

## Extension seams

| Track | Primary seam | Expected change |
| --- | --- | --- |
| Glass Box | `AgentRunner`, `AgentRun` | Emit and display correlated execution events. |
| Bouncer | API routes, Agent ownership | Add identity and server-side authorization. |
| Kill Switch | `AgentRunner` | Add threat-specific policy or a stronger sandbox. |

The current container or ECS instance is the POC trust boundary. Ordinary
containers are not hardened multi-tenant isolation.
