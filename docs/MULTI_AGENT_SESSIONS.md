# Multi-Agent Sessions Architecture

This document explains the multi-agent **Session** feature: what a Session
is, how the orchestrator decomposes and delegates a request, how access
control and isolation are enforced, and the message model that decides what
shows up in the transcript. See [ARCHITECTURE.md](ARCHITECTURE.md) for how
this fits into the rest of the system.

## What a Session is

A **Session** holds a roster of existing Agents and is fronted by a hidden
**orchestrator** Agent that breaks an incoming request into subtasks and
delegates each one to the right roster member. It is a new, separate
concept from each Agent's own private **workspace**
(`WorkspaceManager`, `workspaces/<agentId>/`) — that naming collision is
deliberate to avoid: a Session owns its own *shared* workspace directory
(`workspaces/.sessions/<sessionId>/`), but the entity itself is named
`Session`, not "workspace."

Three things define the feature, all enforced in
[session-engine.ts](../apps/server/src/session-engine.ts):

- **Only roster members can be routed to.** The orchestrator can propose
  delegating to any Agent id it likes; the engine only ever dispatches a
  subtask whose `agentId` is in `session.memberAgentIds` — this is a
  code-level guarantee, not a UI restriction.
- **A Session's activity is isolated from each Agent's own Playground
  conversation.** Different Codex thread, different message history.
- **The orchestrator is lightweight** — it reuses the exact same Codex
  runner path every regular Agent uses (`AgentRunner` → `codex exec
  --json`), it just never touches code itself; it only plans, delegates,
  and synthesizes.

## The boundary, in one picture

```mermaid
flowchart TB
    subgraph Experience["apps/web"]
        UI["Sessions view\n(create, roster, transcript, composer)"]
    end

    subgraph ControlPlane["apps/server"]
        Routes["Fastify routes: /api/sessions"]
        Engine["SessionEngine"]
        Service["AgentService\n(+ run:settled event,\n+ workspaceOverride / sender / recipient)"]
        Store["JsonStore\n+ sessions, Message.senderId/recipientId"]
        Workspaces["WorkspaceManager\n+ createSessionWorkspace()"]
    end

    subgraph Runtime["Agent Runtime (unchanged)"]
        RunnerO["AgentRunner for the\nhidden orchestrator Agent"]
        RunnerM["AgentRunner for each\nmember Agent"]
        Codex["codex exec --json"]
    end

    UI -->|create/roster/send/stop| Routes
    Routes --> Engine
    Engine -->|sendMessage(agentId, prompt, opts)| Service
    Service -->|"run:settled" event| Engine
    Service --> RunnerO
    Service --> RunnerM
    RunnerO -->|reads/writes shared Session workspace| Codex
    RunnerM -->|reads/writes shared Session workspace| Codex
    Engine --> Store
    Engine --> Workspaces
    Service --> Store
```

`SessionEngine` sits above `AgentService` the same way `AgentService` sits
above `AgentRunner` — it never talks to the Runner or Codex directly, and it
never bypasses `AgentService`'s own `busy`/`ready`/`stopped` lifecycle. An
Agent that is mid-turn is automatically protected from a stray direct
Playground message racing the engine, because `AgentService.sendMessage`
already refuses a second concurrent Run on a `busy` Agent — that guarantee
is inherited, not re-implemented.

## The orchestrator is a real, hidden Agent

`SessionEngine.createSession` calls `AgentService.createAgent(...,
kind: "orchestrator")`. Giving the orchestrator a real `Agent` row — instead
of a bespoke pseudo-agent — means every existing lifecycle mechanism is
reused for free: the busy-state guard, cancellation, `run:settled`
emission, session logging. `AgentService.listAgents()` filters out
`kind === "orchestrator"` so it never shows up in the normal Agent
list/picker; `getAgent(id)` is unchanged, since the engine still needs to
fetch it directly by id.

## Isolation from an Agent's own Playground conversation

Two separate mechanisms make Session activity invisible to an Agent's own
Playground view:

1. **Separate Codex thread.** An Agent's `codexThreadId` field only has
   room for one active conversation. Reusing it for Session turns would
   corrupt/interrupt the Agent's own Playground thread. Instead,
   `Session.memberThreadIds: Record<agentId, string | null>` keeps a
   per-member (and per-orchestrator) thread id scoped to that Session.
   `AgentService.sendMessage`'s `options.session` object
   (`{ threadId, onThreadId }`) reads/writes there instead of
   `agent.codexThreadId` whenever a Session turn is running.
2. **`sessionId` tag on `Message`/`AgentRun`.** Every row created during a
   Session turn is tagged `sessionId: session.id`.
   `AgentService.getMessages(agentId)`/`getRuns(agentId)` — the Playground
   endpoints — filter to `sessionId === null`, so nothing a Session did ever
   appears in an Agent's own history. `SessionEngine.transcriptFor(sessionId)`
   is the mirror query for the Session's own view.

## Turn lifecycle

```text
idle --(user message)--> decomposing --> delegating --> synthesizing --> idle
                              |               |
                              +---------------+--> failed
```

Driven entirely by the `run:settled` event `AgentService` emits once per
Run (`agent-service.ts`), never by polling:

1. **`handleUserMessage`** rejects with `409` if `stage !== "idle"` (one
   user turn in flight per Session, mirroring `AgentService`'s own busy
   check). It persists the human's raw message directly (not through
   `sendMessage`, so its content is exactly what the human typed, not a
   constructed prompt), then dispatches the orchestrator with a **decompose
   prompt**: the roster (`id`, `name`, `description` for every resolvable
   member) plus the request, asking for either a fenced ` ```json
   {"subtasks":[{"agentId":...,"task":...}]} ` block or a plain-text direct
   answer.
2. **`handleOrchestratorSettled`** parses the reply
   (`parseDecomposition`):
   - No fenced block → **direct answer**: no delegation needed, this reply
     *is* the final answer.
   - A block that fails to parse or contains no valid `{agentId, task}`
     entries → **invalid**: re-ask, bounded by `MAX_FORMAT_RETRIES` (2),
     then fail the Session with a clear reason rather than looping forever
     or silently treating it as a pass.
   - A block with subtasks → validate each `agentId` against
     `session.memberAgentIds` (**the access-control enforcement point** —
     an out-of-roster subtask is dropped and recorded as skipped, never
     dispatched). If nothing valid survives, skip straight to synthesis
     (so the orchestrator can explain why nothing happened); otherwise
     record a short **plan message** and dispatch every valid subtask.
3. **Dispatch** (`pumpQueue`/`dispatchSubtask`): the *first* subtask for
   each distinct Agent is dispatched immediately — different Agents run
   concurrently. A second subtask for an Agent that's already busy is
   queued and only dispatched once that Agent's current subtask settles
   (`AgentService` itself would 409 a second concurrent call, so the engine
   serializes proactively rather than racing that guard).
4. **`handleSubtaskSettled`** records the result (or `run.error` if it
   didn't complete) and calls `maybeAdvanceAfterSettle`, which pumps the
   next queued subtask for that Agent, or — once every subtask this round
   has settled — dispatches synthesis.
5. **`dispatchSynthesis`** sends the orchestrator every subtask's task +
   result and asks for one final plain-text answer. That reply is
   addressed to the user (see the message model below), and the Session
   returns to `idle`.
6. **Timeouts**: every dispatched run (orchestrator or subtask) gets a
   `setTimeout(turnTimeoutMs).unref()` (`config.codexTimeoutMs + 30_000` —
   a grace buffer over Codex's own internal timeout, so this only ever
   fires as a backstop). On fire, `AgentService.stopAgent(agentId)` cancels
   the stuck Run; a stuck **subtask** is recorded as timed out and the round
   continues without it degrading the whole Session; a stuck
   **orchestrator** turn fails the Session outright (there's no partial
   result to synthesize around).

## A concurrency bug worth knowing about (and its fix)

Two independent subtask settles can each observe an empty pending queue and
both conclude "the round is done, dispatch synthesis" — a plain
read-then-act check isn't safe, and with a fast enough model this really
does produce two competing synthesis turns (caught by a test during
development). `dispatchSynthesis` claims the stage transition atomically
inside one `store.mutate`:

```ts
const claimed = await this.store.mutate((database) => {
  const stored = database.sessions.find((item) => item.id === sessionId);
  if (!stored) return false;
  if (stored.stage !== "delegating" && stored.stage !== "decomposing") return false;
  stored.stage = "synthesizing";
  return true;
});
if (!claimed) return; // another concurrent settle already claimed this round
```

Only the caller whose mutation actually observes and flips the pre-claim
stage proceeds; the loser no-ops. The same care applies to
`handleTimeout`: it settles its own bookkeeping (or fails the Session)
*before* calling `stopAgent`, because `stopAgent` awaits the cancelled
run's own `run:settled` event all the way through — calling it first would
let that nested event see stale state and double-process the same turn.

## Access control: enforced once, mechanically

"Only Agents added to a Session can be routed to" is not a UI-layer
restriction — it is enforced at the one place every subtask passes through,
`handleOrchestratorSettled`'s `memberIds.has(subtask.agentId)` check, before
anything is ever dispatched. The orchestrator's own prompt *tells* it which
ids it may use, but the engine does not trust that instruction — a subtask
naming an id outside the roster is dropped and recorded, never given to
`AgentService.sendMessage`. `createSession`/`updateMembers` additionally
reject adding an orchestrator-kind Agent as a member, so a Session can never
end up delegating to another Session's orchestrator.

## The message model: sender, recipient, and what the user sees

Every `Message` carries `senderId`/`recipientId` (`apps/server/src/types.ts`):
either `USER_PARTY` (`"user"`), `SYSTEM_PARTY` (`"system"`), or a real
Agent id. **A message is user-facing iff the user is the sender or the
recipient** — that single rule is what the default transcript view filters
by, replacing what would otherwise be a pile of special cases:

| Message | senderId | recipientId | User-facing? |
| --- | --- | --- | --- |
| Human's request | `user` | orchestrator | yes |
| Decompose/synthesis engine prompt (`"Member Agents you may delegate to..."`, `"Here are the results..."`) | `system` | orchestrator | no — this is the "system prompt" that must never look like something the user said or received |
| Orchestrator's raw JSON delegation reply | orchestrator | `system` | no |
| Subtask handed to a member | orchestrator | `<member>` | no |
| Member's result | `<member>` | orchestrator | no |
| Plan summary (locally synthesized, not model-generated) | orchestrator | `user` | yes |
| Final synthesized answer | orchestrator | `user` | yes |
| Direct answer (no delegation needed) | orchestrator | `user` (redirected — see below) | yes |

`AgentService.sendMessage`'s `options.sender`/`options.recipient` drive
this: the prompt message's `recipientId` is always the Agent being
messaged; the reply's `recipientId` defaults to `options.recipient ??
options.sender ?? USER_PARTY` — a plain reply-to-sender exchange, which is
correct for a subtask (the member replies to the orchestrator that asked)
and for Playground messages (the Agent replies to the user). Synthesis is
the one case where the reply must NOT go back to whoever sent the prompt
(`system`) — it must go to the user — so `dispatchSynthesis` passes an
explicit `recipient: USER_PARTY` override.

One correction happens after the fact:
`redirectReplyToUser(runId)` flips a message's `recipientId` to `user` when
the decompose turn's reply turns out to be a **direct answer** — at
dispatch time the engine doesn't yet know whether the orchestrator will
delegate or answer directly, so the reply defaults to `recipientId: system`
(symmetric to the prompt's `system` sender) and gets redirected only if
`parseDecomposition` returns `{ kind: "direct" }`.

The web UI (`apps/web/src/App.tsx`) filters the transcript by this same
rule (`isUserFacing`) and labels each row by `senderId` (`You` / `System` /
the Agent's name) rather than by `role`, with a "Show details" toggle that
lifts the filter entirely — useful for seeing the orchestrator's actual
delegation traffic. `senderId`/`recipientId` are optional fields on
`Message` for backward compatibility with rows written before they existed;
an absent pair defaults to "visible" so old data doesn't silently vanish.

## API surface

| Method & path | Purpose |
| --- | --- |
| `POST /api/sessions` | `{ name, description?, memberAgentIds }` → creates the Session and its hidden orchestrator |
| `GET /api/sessions`, `GET /api/sessions/:id` | List / read |
| `PATCH /api/sessions/:id/members` | `{ add?, remove? }` — roster management; `404` if an id isn't a real, non-orchestrator Agent |
| `DELETE /api/sessions/:id` | Cancels in-flight work, archives the shared workspace, deletes the hidden orchestrator |
| `POST /api/sessions/:id/messages` | `{ content }` → `SessionEngine.handleUserMessage`, `202` (same async-with-polling shape as `POST /agents/:id/messages`) |
| `GET /api/sessions/:id/messages` | Transcript, ordered — interleaves orchestrator and member turns since it's just `Message` rows tagged with `sessionId` |
| `POST /api/sessions/:id/stop` | Administrative stop |

## Data model

```ts
export interface Session {
  id: string;
  name: string;
  description: string;
  memberAgentIds: string[];         // the ONLY Agents this Session may route to
  orchestratorAgentId: string;      // hidden Agent, kind: "orchestrator"
  workspacePath: string;            // shared dir, workspaces/.sessions/<id>/
  stage: SessionStage;              // idle | decomposing | delegating | synthesizing | failed
  pendingSubtasks: PendingSubtask[];// in-flight runs for the current turn
  memberThreadIds: Record<string, string | null>; // per-member (+ orchestrator) session-scoped Codex thread
  formatRetries: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
```

`Database.version` is `2`; `JsonStore.initialize()` migrates a `version: 1`
file in place on load (backfills `agents[].kind`, `messages[]`/`runs[]`
`.sessionId`, adds `sessions: []`) rather than rejecting it, so existing
local data survives the upgrade. `senderId`/`recipientId` were added after
that migration and are optional for the same reason — no further version
bump needed.

## Known limitations

- No human identity/ownership model exists — Session membership controls
  which *Agents* can be routed to, not which *humans* may operate a given
  Session; the shared `APP_AUTH_TOKEN` still gates the whole API. See the
  "Bouncer" extension seam in [ARCHITECTURE.md](ARCHITECTURE.md).
- Deleting a member Agent while it's still referenced in `memberAgentIds`
  isn't actively prevented; `resolveMembers` treats a dangling id as "not
  found" at dispatch time (a skipped/failed result, not a crash) rather
  than the roster being kept in sync.
- `timers`/`queuedSubtasks`/`roundResults` are in-memory `Map`s on
  `SessionEngine` — a server restart mid-turn loses the pending timeout and
  in-flight round bookkeeping, though the persisted `Session`/`Message`/
  `AgentRun` rows survive; the turn itself won't auto-resume. A
  restart-recovery sweep mirroring `AgentService.initialize()`'s own
  crash-recovery for Runs is a natural follow-up, not implemented.
- The decomposition contract is a fenced ```json``` block parsed with
  `JSON.parse`, not a schema-enforced tool call — bounded retries
  (`MAX_FORMAT_RETRIES`) make a persistently uncooperative model fail
  cleanly rather than loop, but it's still a text-pattern contract.

## Tests

- [session-engine.test.ts](../apps/server/src/session-engine.test.ts) — a
  real `AgentService`/`WorkspaceManager`/`JsonStore` stack with a scripted
  fake `AgentRunner` (no real Codex/OpenRouter calls): happy-path
  decomposition + synthesis, the direct-answer path, dropping a subtask
  outside the roster, bounded retry-then-fail on malformed output,
  same-Agent subtasks serialized, and a stuck subtask timing out without
  hanging the Session. Several tests assert exact `senderId`/`recipientId`
  values to pin the message-visibility model above.
- [agent-service.test.ts](../apps/server/src/agent-service.test.ts) — the
  `options.session` thread override doesn't touch `agent.codexThreadId`;
  `run:settled` fires exactly once per Run; `listAgents()` excludes
  `kind: "orchestrator"`.
- [app.test.ts](../apps/server/src/app.test.ts) — `/api/sessions` route
  validation (unknown member id → `404`, unordered transcript → ordered).
- [workspace.test.ts](../apps/server/src/workspace.test.ts) —
  `createSessionWorkspace`/`archiveSessionWorkspace`.
- [store.test.ts](../apps/server/src/store.test.ts) — the `v1 → v2`
  migration preserves existing agents/messages/runs.
