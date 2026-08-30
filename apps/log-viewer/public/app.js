(() => {
  "use strict";

  let token = "";
  let sessions = [];
  let selectedId = null;
  let autoRefreshTimer = null;

  const els = {
    unlockScreen: document.getElementById("unlock-screen"),
    unlockForm: document.getElementById("unlock-form"),
    unlockToken: document.getElementById("unlock-token"),
    unlockError: document.getElementById("unlock-error"),
    app: document.getElementById("app"),
    sessionList: document.getElementById("session-list"),
    sessionFilter: document.getElementById("session-filter"),
    sessionTitle: document.getElementById("session-title"),
    keywordFilter: document.getElementById("keyword-filter"),
    entries: document.getElementById("entries"),
    refreshBtn: document.getElementById("refresh-btn"),
    autoRefresh: document.getElementById("auto-refresh"),
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlight(text, keyword) {
    const escaped = escapeHtml(text);
    if (!keyword) return escaped;
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return escaped.replace(new RegExp("(" + escapedKeyword + ")", "ig"), "<mark>$1</mark>");
  }

  async function api(path) {
    const headers = {};
    if (token) headers.Authorization = "Bearer " + token;
    const response = await fetch(path, { headers });
    if (response.status === 401) {
      showUnlock("The access token is not valid.");
      throw new Error("unauthorized");
    }
    if (!response.ok) {
      throw new Error("Request failed: " + response.status);
    }
    return response.json();
  }

  function showUnlock(message) {
    els.app.classList.add("hidden");
    els.unlockScreen.classList.remove("hidden");
    if (message) {
      els.unlockError.textContent = message;
      els.unlockError.classList.remove("hidden");
    }
  }

  function showApp() {
    els.unlockScreen.classList.add("hidden");
    els.app.classList.remove("hidden");
  }

  async function bootstrap() {
    const auth = await fetch("/api/auth").then((response) => response.json());
    if (auth.required && !token) {
      showUnlock("");
      return;
    }
    showApp();
    await loadSessions();
  }

  async function loadSessions() {
    const data = await api("/api/sessions");
    sessions = data.sessions;
    renderSessionList();
  }

  function renderSessionList() {
    const filter = els.sessionFilter.value.trim().toLowerCase();
    const filtered = sessions.filter((session) => {
      if (!filter) return true;
      return (
        session.sessionId.toLowerCase().includes(filter) ||
        (session.agentName ?? "").toLowerCase().includes(filter)
      );
    });

    els.sessionList.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "No sessions logged yet.";
      els.sessionList.appendChild(empty);
      return;
    }

    for (const session of filtered) {
      const item = document.createElement("li");
      item.className = "session-item" + (session.sessionId === selectedId ? " active" : "");
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = session.agentName || session.sessionId;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent =
        session.entryCount + " entries · " + (session.lastAt ? new Date(session.lastAt).toLocaleString() : "—");
      const owner = document.createElement("div");
      owner.className = "meta";
      owner.textContent = "Owner: " + (session.ownerId ? session.ownerId.slice(0, 8) : "—");
      item.appendChild(name);
      item.appendChild(meta);
      item.appendChild(owner);
      item.addEventListener("click", () => selectSession(session.sessionId));
      els.sessionList.appendChild(item);
    }
  }

  async function selectSession(sessionId) {
    selectedId = sessionId;
    els.keywordFilter.disabled = false;
    renderSessionList();
    const session = sessions.find((item) => item.sessionId === sessionId);
    els.sessionTitle.textContent = session ? session.agentName || session.sessionId : sessionId;
    await loadEntries();
  }

  async function loadEntries() {
    if (!selectedId) return;
    const keyword = els.keywordFilter.value.trim();
    const query = keyword ? "?q=" + encodeURIComponent(keyword) : "";
    const data = await api("/api/sessions/" + encodeURIComponent(selectedId) + query);
    renderEntries(data.entries, keyword);
  }

  function renderEntries(entries, keyword) {
    els.entries.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = keyword ? "No entries match that keyword." : "No entries in this session yet.";
      els.entries.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const card = document.createElement("div");
      card.className = "entry";

      const header = document.createElement("div");
      header.className = "entry-header";
      const badge = document.createElement("span");
      badge.className = "badge badge-" + (entry.type || "unknown");
      badge.textContent = entry.type || "unknown";
      const ts = document.createElement("span");
      ts.className = "entry-ts";
      ts.textContent = entry.ts ? new Date(entry.ts).toLocaleString() : "";
      const run = document.createElement("span");
      run.className = "entry-run";
      run.textContent = entry.runId ? "run " + entry.runId.slice(0, 8) : "";
      const owner = document.createElement("span");
      owner.className = "entry-run";
      owner.textContent = entry.ownerId ? "owner " + entry.ownerId.slice(0, 8) : "";
      header.appendChild(badge);
      header.appendChild(ts);
      header.appendChild(run);
      header.appendChild(owner);

      const body = document.createElement("div");
      body.className = "entry-body";
      body.innerHTML = renderBody(entry, keyword);

      card.appendChild(header);
      card.appendChild(body);
      els.entries.appendChild(card);
    }
  }

  function renderBody(entry, keyword) {
    switch (entry.type) {
      case "user_message":
      case "agent_response":
        return highlight(entry.content ?? "", keyword);
      case "error":
        return highlight(entry.message ?? "", keyword);
      case "tool_call":
        return (
          highlight(entry.itemType + " · " + entry.status + " — " + entry.summary, keyword) +
          "<pre>" +
          highlight(JSON.stringify(entry.detail, null, 2), keyword) +
          "</pre>"
        );
      default:
        return "<pre>" + highlight(JSON.stringify(entry, null, 2), keyword) + "</pre>";
    }
  }

  function scheduleAutoRefresh() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    if (els.autoRefresh.checked) {
      autoRefreshTimer = setInterval(() => {
        loadSessions();
        loadEntries();
      }, 4000);
    }
  }

  els.unlockForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    token = els.unlockToken.value.trim();
    els.unlockError.classList.add("hidden");
    try {
      await bootstrap();
    } catch {
      // showUnlock already surfaced the error via the 401 handler in api().
    }
  });

  els.refreshBtn.addEventListener("click", () => {
    loadSessions();
    if (selectedId) loadEntries();
  });

  els.sessionFilter.addEventListener("input", renderSessionList);
  els.keywordFilter.addEventListener("input", () => loadEntries());
  els.autoRefresh.addEventListener("change", scheduleAutoRefresh);

  bootstrap().catch((error) => {
    if (error.message !== "unauthorized") {
      console.error(error);
    }
  });
})();
