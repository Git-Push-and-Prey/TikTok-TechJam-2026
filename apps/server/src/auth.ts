import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { HttpError } from "./errors.js";
import type { JsonStore } from "./store.js";
import type { User } from "./types.js";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_KEY_LENGTH = 64;

const now = () => new Date().toISOString();

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) {
    return false;
  }
  const candidate = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface AuthUser {
  id: string;
  username: string;
}

export class AuthService {
  constructor(private readonly store: JsonStore) {}

  async createUser(username: string, password: string): Promise<User> {
    const trimmed = username.trim();
    if (!trimmed) {
      throw new HttpError(400, "Username is required");
    }
    if (password.length < 8) {
      throw new HttpError(400, "Password must be at least 8 characters");
    }
    return this.store.mutate((database) => {
      if (database.users.some((user) => user.username === trimmed)) {
        throw new HttpError(409, `User "${trimmed}" already exists`);
      }
      const user: User = {
        id: randomUUID(),
        username: trimmed,
        passwordHash: hashPassword(password),
        createdAt: now(),
      };
      database.users.push(user);
      return user;
    });
  }

  /** Self-service signup: creates the account, then immediately logs it in. */
  async register(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
    await this.createUser(username, password);
    return this.login(username, password);
  }

  async login(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const trimmed = username.trim();
    const user = this.store.snapshot().users.find((item) => item.username === trimmed);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new HttpError(401, "Invalid credentials");
    }
    const token = generateToken();
    const timestamp = now();
    await this.store.mutate((database) => {
      database.authTokens.push({
        tokenHash: hashToken(token),
        userId: user.id,
        createdAt: timestamp,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      });
    });
    return { token, user: { id: user.id, username: user.username } };
  }

  getUserById(id: string): AuthUser | null {
    const user = this.store.snapshot().users.find((item) => item.id === id);
    return user ? { id: user.id, username: user.username } : null;
  }

  getUserByUsername(username: string): AuthUser | null {
    const trimmed = username.trim();
    const user = this.store.snapshot().users.find((item) => item.username === trimmed);
    return user ? { id: user.id, username: user.username } : null;
  }

  async resolveToken(token: string): Promise<AuthUser | null> {
    if (!token) {
      return null;
    }
    const tokenHash = hashToken(token);
    const database = this.store.snapshot();
    const authToken = database.authTokens.find((item) => item.tokenHash === tokenHash);
    if (!authToken || authToken.expiresAt <= now()) {
      return null;
    }
    const user = database.users.find((item) => item.id === authToken.userId);
    if (!user) {
      return null;
    }
    return { id: user.id, username: user.username };
  }

  async logout(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    await this.store.mutate((database) => {
      database.authTokens = database.authTokens.filter((item) => item.tokenHash !== tokenHash);
    });
  }
}
