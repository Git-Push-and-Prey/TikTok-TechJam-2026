import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import { SYSTEM_PARTY, USER_PARTY } from "./types";
import type { Agent, AgentRun, Message, Session, SessionStage, SystemInfo } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

const emptySessionForm = {
  name: "",
  description: "",
  memberAgentIds: [] as string[],
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function sessionStatusClass(stage: SessionStage): "ready" | "busy" | "error" {
  if (stage === "idle") return "ready";
  if (stage === "failed") return "error";
  return "busy";
}

function agentDisplayName(agents: Agent[], session: Session, agentId: string): string {
  if (agentId === session.orchestratorAgentId) return "Orchestrator";
  return agents.find((agent) => agent.id === agentId)?.name ?? "Unknown Agent";
}

/** A message belongs in the default (non-detail) view iff the user is a party to it — sender or recipient. Rows written before senderId/recipientId existed default to visible. */
function isUserFacing(message: Message): boolean {
  if (message.senderId === undefined && message.recipientId === undefined) return true;
  return message.senderId === USER_PARTY || message.recipientId === USER_PARTY;
}

function partyLabel(agents: Agent[], session: Session, partyId: string | undefined): string {
  if (!partyId || partyId === USER_PARTY) return "You";
  if (partyId === SYSTEM_PARTY) return "System";
  return agentDisplayName(agents, session, partyId);
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [view, setView] = useState<"playground" | "sessions">("playground");
  const [sessionsList, setSessionsList] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Message[]>([]);
  const [showCreateSession, setShowCreateSession] = useState(false);
  const [showSessionMembers, setShowSessionMembers] = useState(false);
  const [showSessionDetails, setShowSessionDetails] = useState(false);
  const [sessionForm, setSessionForm] = useState(emptySessionForm);
  const [sessionPrompt, setSessionPrompt] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const sessionMessageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const pollingSessionIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;
  selectedSessionIdRef.current = selectedSessionId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const selectedSession = useMemo(
    () => sessionsList.find((item) => item.id === selectedSessionId) ?? null,
    [sessionsList, selectedSessionId],
  );

  const visibleSessionMessages = useMemo(
    () => sessionMessages.filter((message) => showSessionDetails || isUserFacing(message)),
    [sessionMessages, showSessionDetails],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    const { sessions: next } = await api.listSessions();
    setSessionsList(next);
    setSelectedSessionId((current) =>
      current && next.some((item) => item.id === current) ? current : (next[0]?.id ?? null),
    );
  }, []);

  const refreshSessionMessages = useCallback(async (sessionId: string) => {
    const result = await api.sessionMessages(sessionId);
    if (mountedRef.current && selectedSessionIdRef.current === sessionId) {
      setSessionMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  useEffect(() => {
    sessionMessageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [sessionMessages]);

  useEffect(() => {
    if (view === "sessions" && authRequired === false) {
      void refreshSessions().catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    }
  }, [view, authRequired, refreshSessions]);

  const pollSessionStage = useCallback(
    async (sessionId: string) => {
      if (pollingSessionIds.current.has(sessionId)) return;
      pollingSessionIds.current.add(sessionId);
      try {
        while (mountedRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          if (!mountedRef.current) return;
          const { session } = await api.getSession(sessionId);
          setSessionsList((current) =>
            current.map((item) => (item.id === session.id ? session : item)),
          );
          await refreshSessionMessages(sessionId);
          if (session.stage === "idle" || session.stage === "failed") return;
        }
      } finally {
        pollingSessionIds.current.delete(sessionId);
      }
    },
    [refreshSessionMessages],
  );

  useEffect(() => {
    if (!selectedSessionId) {
      setSessionMessages([]);
      return;
    }
    const sessionId = selectedSessionId;
    void Promise.all([refreshSessionMessages(sessionId), api.getSession(sessionId)])
      .then(([, result]) => {
        if (selectedSessionIdRef.current !== sessionId) return;
        setSessionsList((current) =>
          current.map((item) => (item.id === result.session.id ? result.session : item)),
        );
        if (result.session.stage !== "idle" && result.session.stage !== "failed") {
          void pollSessionStage(sessionId);
        }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [selectedSessionId, refreshSessionMessages, pollSessionStage]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const createSession = async (event: React.FormEvent) => {
    event.preventDefault();
    if (sessionForm.memberAgentIds.length === 0) {
      setError("Pick at least one member Agent for this Session.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { session } = await api.createSession(sessionForm);
      await refreshSessions();
      setSelectedSessionId(session.id);
      setShowCreateSession(false);
      setSessionForm(emptySessionForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleSessionMember = async (agentId: string, isMember: boolean) => {
    if (!selectedSession) return;
    setBusy(true);
    setError(null);
    try {
      const { session } = await api.updateSessionMembers(
        selectedSession.id,
        isMember ? { remove: [agentId] } : { add: [agentId] },
      );
      setSessionsList((current) => current.map((item) => (item.id === session.id ? session : item)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const stopSelectedSession = async () => {
    if (!selectedSession) return;
    setBusy(true);
    setError(null);
    try {
      await api.stopSession(selectedSession.id);
      await refreshSessions();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelectedSession = async () => {
    if (!selectedSession) return;
    if (!window.confirm("Delete " + selectedSession.name + "? Its shared workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteSession(selectedSession.id);
      setSelectedSessionId(null);
      await refreshSessions();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const sendSessionMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedSession || !sessionPrompt.trim()) return;
    const content = sessionPrompt.trim();
    setSessionPrompt("");
    setError(null);
    try {
      const result = await api.sendSessionMessage(selectedSession.id, content);
      if (selectedSessionIdRef.current === selectedSession.id) {
        setSessionMessages((current) => [...current, result.message]);
      }
      setSessionsList((current) =>
        current.map((item) =>
          item.id === selectedSession.id ? { ...item, stage: "decomposing" } : item,
        ),
      );
      await pollSessionStage(selectedSession.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshSessions();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <div className="view-toggle">
          <button
            type="button"
            className={"button " + (view === "playground" ? "button-primary" : "button-ghost")}
            onClick={() => setView("playground")}
          >
            Playground
          </button>
          <button
            type="button"
            className={"button " + (view === "sessions" ? "button-primary" : "button-ghost")}
            onClick={() => setView("sessions")}
          >
            Sessions
          </button>
        </div>

        {view === "playground" ? (
          <>
            <button
              className="button button-primary create-button"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              <span>＋</span> Create Agent
            </button>

            <div className="sidebar-label">
              <span>Your Agents</span>
              <span>{agents.length}</span>
            </div>
            <nav className="agent-list">
              {agents.map((agent) => (
                <button
                  className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
                  key={agent.id}
                  onClick={() => setSelectedId(agent.id)}
                >
                  <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
                  <div className="agent-card-copy">
                    <strong>{agent.name}</strong>
                    <span>{agent.description || "Coding Agent"}</span>
                  </div>
                  <span className={"mini-dot mini-" + agent.status} />
                </button>
              ))}
              {agents.length === 0 && (
                <div className="empty-sidebar">
                  <span>◇</span>
                  Create your first coding Agent.
                </div>
              )}
            </nav>
          </>
        ) : (
          <>
            <button
              className="button button-primary create-button"
              onClick={() => {
                setSessionForm(emptySessionForm);
                setShowCreateSession(true);
              }}
            >
              <span>＋</span> Create Session
            </button>

            <div className="sidebar-label">
              <span>Sessions</span>
              <span>{sessionsList.length}</span>
            </div>
            <nav className="agent-list">
              {sessionsList.map((sessionItem) => (
                <button
                  className={"agent-card " + (sessionItem.id === selectedSessionId ? "selected" : "")}
                  key={sessionItem.id}
                  onClick={() => setSelectedSessionId(sessionItem.id)}
                >
                  <div className="agent-avatar">{sessionItem.name.slice(0, 1).toUpperCase()}</div>
                  <div className="agent-card-copy">
                    <strong>{sessionItem.name}</strong>
                    <span>
                      {sessionItem.memberAgentIds.length} member
                      {sessionItem.memberAgentIds.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span className={"mini-dot mini-" + sessionStatusClass(sessionItem.stage)} />
                </button>
              ))}
              {sessionsList.length === 0 && (
                <div className="empty-sidebar">
                  <span>◇</span>
                  Create your first multi-agent Session.
                </div>
              )}
            </nav>
          </>
        )}

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.openrouterModel ?? "OpenRouter model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.openrouterConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.openrouterConfigured
                  ? "Set OPENROUTER_API_KEY in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {view === "playground" ? (
        selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )
        ) : selectedSession ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selectedSession.name}</h1>
                  <span className={"status status-" + sessionStatusClass(selectedSession.stage)}>
                    <span className="status-dot" />
                    {selectedSession.stage}
                  </span>
                </div>
                <p>
                  {selectedSession.description ||
                    "A multi-agent Session routed by a lightweight orchestrator."}
                </p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSessionMembers((value) => !value)}
                >
                  Members
                </button>
                <button
                  className="button button-ghost"
                  onClick={stopSelectedSession}
                  disabled={busy || selectedSession.stage === "idle"}
                >
                  Stop
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteSelectedSession}
                  disabled={busy || selectedSession.stage !== "idle"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSessionMembers && (
              <div className="settings-panel">
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Session roster</span>
                    <h2>Only these Agents can be routed to</h2>
                  </div>
                  <button type="button" onClick={() => setShowSessionMembers(false)}>×</button>
                </div>
                <div className="form-grid">
                  {agents.map((agent) => {
                    const isMember = selectedSession.memberAgentIds.includes(agent.id);
                    return (
                      <label key={agent.id} className="member-checkbox">
                        <input
                          type="checkbox"
                          checked={isMember}
                          disabled={busy}
                          onChange={() => toggleSessionMember(agent.id, isMember)}
                        />
                        {agent.name}
                      </label>
                    );
                  })}
                  {agents.length === 0 && <span>Create an Agent first.</span>}
                </div>
              </div>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Session</span>
                  <h2>
                    Delegates to:{" "}
                    {selectedSession.memberAgentIds
                      .map((id) => agentDisplayName(agents, selectedSession, id))
                      .join(", ") || "no members yet"}
                  </h2>
                </div>
                <div className="session-info">
                  <button
                    type="button"
                    className="details-toggle"
                    onClick={() => setShowSessionDetails((value) => !value)}
                  >
                    {showSessionDetails ? "Hide details" : "Show details"}
                  </button>
                  <span className="pulse" />
                  {selectedSession.stage === "idle" ? "Ready" : "Working…"}
                </div>
              </div>

              <div className="messages">
                {visibleSessionMessages.length === 0 ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>Ask the orchestrator for something</h3>
                    <p>
                      It will break your request into subtasks and delegate each to the right
                      member Agent, then combine the results into one answer.
                    </p>
                  </div>
                ) : (
                  visibleSessionMessages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{partyLabel(agents, selectedSession, message.senderId)}</strong>
                        {message.recipientId && message.recipientId !== message.senderId && (
                          <span className="message-recipient">
                            → {partyLabel(agents, selectedSession, message.recipientId)}
                          </span>
                        )}
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {selectedSession.stage !== "idle" && selectedSession.stage !== "failed" && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>Orchestrator</strong>
                      <span>{selectedSession.stage}…</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Routing and running the Session's Agents…
                    </div>
                  </article>
                )}
                {selectedSession.stage === "failed" && (
                  <article className="run-error">
                    <strong>Session failed</strong>
                    <span>{selectedSession.lastError}</span>
                  </article>
                )}
                <div ref={sessionMessageEnd} />
              </div>

              <form className="composer" onSubmit={sendSessionMessage}>
                <textarea
                  value={sessionPrompt}
                  onChange={(event) => setSessionPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Describe what the Session should get done…"
                  disabled={selectedSession.stage !== "idle"}
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {selectedSession.memberAgentIds.length}{" "}
                    member Agent{selectedSession.memberAgentIds.length === 1 ? "" : "s"}
                  </span>
                  <button
                    className="send-button"
                    disabled={!sessionPrompt.trim() || selectedSession.stage !== "idle"}
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">S</div>
            <span className="eyebrow">Sessions</span>
            <h1>Create a Session to route work across multiple Agents.</h1>
            <p>
              Add member Agents; the orchestrator will decompose each request and delegate to
              them, kept separate from their own Playground conversations.
            </p>
            <button
              className="button button-primary"
              onClick={() => {
                setSessionForm(emptySessionForm);
                setShowCreateSession(true);
              }}
            >
              Create your first Session
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showCreateSession && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreateSession(false)}>
          <form
            className="modal"
            onSubmit={createSession}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New Session</span>
                <h2>Create a multi-agent Session</h2>
                <p>
                  A lightweight orchestrator will break each request into subtasks and route
                  them only to the member Agents you pick below.
                </p>
              </div>
              <button type="button" onClick={() => setShowCreateSession(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Docs + Tests"
                value={sessionForm.name}
                onChange={(event) => setSessionForm({ ...sessionForm, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Writes docs and matching tests together"
                value={sessionForm.description}
                onChange={(event) =>
                  setSessionForm({ ...sessionForm, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <div className="form-grid">
              {agents.map((agent) => {
                const checked = sessionForm.memberAgentIds.includes(agent.id);
                return (
                  <label key={agent.id} className="member-checkbox">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSessionForm((current) => ({
                          ...current,
                          memberAgentIds: checked
                            ? current.memberAgentIds.filter((id) => id !== agent.id)
                            : [...current.memberAgentIds, agent.id],
                        }))
                      }
                    />
                    {agent.name}
                  </label>
                );
              })}
              {agents.length === 0 && <span>Create an Agent first.</span>}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreateSession(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={busy || sessionForm.memberAgentIds.length === 0}
              >
                {busy ? <Spinner /> : "Create Session"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
