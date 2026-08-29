import type { Agent, AgentRun, Message, Session, SystemInfo } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  listSessions: () => request<{ sessions: Session[] }>("/api/sessions"),
  createSession: (body: { name: string; description: string; memberAgentIds: string[] }) =>
    request<{ session: Session }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getSession: (id: string) => request<{ session: Session }>("/api/sessions/" + id),
  updateSessionMembers: (id: string, body: { add?: string[]; remove?: string[] }) =>
    request<{ session: Session }>("/api/sessions/" + id + "/members", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSession: (id: string) =>
    request<void>("/api/sessions/" + id, { method: "DELETE" }),
  stopSession: (id: string) =>
    request<{ session: Session }>("/api/sessions/" + id + "/stop", { method: "POST" }),
  sessionMessages: (id: string) =>
    request<{ messages: Message[] }>("/api/sessions/" + id + "/messages"),
  sendSessionMessage: (id: string, content: string) =>
    request<{ message: Message }>("/api/sessions/" + id + "/messages", {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
};
