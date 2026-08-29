import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeWorkspaces(): Promise<WorkspaceManager> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-workspace-test-"));
  temporaryDirectories.push(root);
  const workspaces = new WorkspaceManager(root);
  await workspaces.initialize();
  return workspaces;
}

describe("WorkspaceManager sessions", () => {
  it("creates a shared session workspace with a SESSION.md describing it", async () => {
    const workspaces = await makeWorkspaces();
    const sessionId = randomUUID();
    const dir = await workspaces.createSessionWorkspace(sessionId, "Docs + Tests", "Write docs and tests together");

    expect(dir).toBe(workspaces.sessionWorkspacePath(sessionId));
    expect((await stat(dir)).isDirectory()).toBe(true);
    const content = await readFile(path.join(dir, "SESSION.md"), "utf8");
    expect(content).toContain("Docs + Tests");
    expect(content).toContain("Write docs and tests together");
  });

  it("archives a session workspace by moving it under .deleted", async () => {
    const workspaces = await makeWorkspaces();
    const sessionId = randomUUID();
    const dir = await workspaces.createSessionWorkspace(sessionId, "Temp", "");

    const destination = await workspaces.archiveSessionWorkspace(dir, sessionId);
    await expect(stat(dir)).rejects.toThrow();
    expect((await stat(destination)).isDirectory()).toBe(true);
  });
});
