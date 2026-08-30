import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService, hashPassword, verifyPassword } from "./auth.js";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeAuth(): Promise<AuthService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-auth-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return new AuthService(store);
}

describe("password hashing", () => {
  it("round-trips a correct password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });
});

describe("AuthService", () => {
  it("logs in with correct credentials and rejects incorrect ones", async () => {
    const auth = await makeAuth();
    await auth.createUser("alice", "s3cret!!");

    await expect(auth.login("alice", "wrong")).rejects.toMatchObject({ statusCode: 401 });
    const { token, user } = await auth.login("alice", "s3cret!!");
    expect(user.username).toBe("alice");
    expect(token.length).toBeGreaterThan(0);
  });

  it("rejects creating a duplicate username", async () => {
    const auth = await makeAuth();
    await auth.createUser("alice", "s3cret!!");
    await expect(auth.createUser("alice", "other-pw")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a password shorter than 8 characters", async () => {
    const auth = await makeAuth();
    await expect(auth.createUser("alice", "short")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("registers a new account and logs it in immediately", async () => {
    const auth = await makeAuth();
    const { token, user } = await auth.register("alice", "s3cret!!");
    expect(user.username).toBe("alice");
    expect(await auth.resolveToken(token)).toMatchObject({ username: "alice" });

    await expect(auth.register("alice", "other-pw")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("resolves a valid token and rejects an invalid or logged-out one", async () => {
    const auth = await makeAuth();
    await auth.createUser("alice", "s3cret!!");
    const { token } = await auth.login("alice", "s3cret!!");

    expect(await auth.resolveToken(token)).toMatchObject({ username: "alice" });
    expect(await auth.resolveToken("not-a-real-token")).toBeNull();

    await auth.logout(token);
    expect(await auth.resolveToken(token)).toBeNull();
  });
});
