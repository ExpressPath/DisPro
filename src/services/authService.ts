import { randomBytes } from "node:crypto";
import { makeId, sha256 } from "../domain/ids.js";
import type { UserAccount, UserApiKey, UserSession } from "../domain/types.js";
import type { DisproStore } from "../storage/disproStore.js";

const EMAIL_CHALLENGE_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Mailer {
  sendSignInLink(input: { email: string; signInUrl: string; expiresAt: string }): Promise<void>;
}

export interface AuthContext {
  user: UserAccount;
  credential: "session" | "apiKey";
  apiKey?: UserApiKey;
  session?: UserSession;
}

export interface RequestSignInResult {
  email: string;
  expiresAt: string;
  devSignInUrl?: string;
}

export interface VerifySignInResult {
  user: UserAccount;
  sessionToken: string;
  sessionExpiresAt: string;
}

export interface CreateApiKeyResult {
  apiKey: UserApiKey;
  secret: string;
}

export class ConsoleMailer implements Mailer {
  async sendSignInLink(input: { email: string; signInUrl: string; expiresAt: string }): Promise<void> {
    console.log(`[Dispro auth] Sign-in link for ${input.email}: ${input.signInUrl} (expires ${input.expiresAt})`);
  }
}

export async function requestEmailSignIn(
  store: DisproStore,
  mailer: Mailer,
  input: { email: string; baseUrl: string; exposeDevLink: boolean },
  now = new Date()
): Promise<RequestSignInResult> {
  const email = normalizeEmail(input.email);
  let user = await store.getUserByEmail(email);
  const nowIso = now.toISOString();

  if (!user) {
    user = {
      id: makeId("usr", { email }),
      email,
      status: "pending",
      createdAt: nowIso,
      updatedAt: nowIso
    };
    await store.upsertUser(user);
  }

  if (user.status === "disabled") {
    throw new AuthError(403, "This account is disabled.");
  }

  const token = createSecret("ml");
  const expiresAt = new Date(now.getTime() + EMAIL_CHALLENGE_TTL_MS).toISOString();
  const challenge = {
    id: makeId("mlc", { email, tokenHash: hashSecret(token), createdAt: nowIso }),
    userId: user.id,
    email,
    tokenHash: hashSecret(token),
    createdAt: nowIso,
    expiresAt
  };

  await store.saveEmailChallenge(challenge);

  const signInUrl = createSignInUrl(input.baseUrl, token);
  await mailer.sendSignInLink({ email, signInUrl, expiresAt });

  const result: RequestSignInResult = {
    email,
    expiresAt
  };

  if (input.exposeDevLink) {
    result.devSignInUrl = signInUrl;
  }

  return result;
}

export async function verifyEmailSignIn(
  store: DisproStore,
  input: { token: string },
  now = new Date()
): Promise<VerifySignInResult> {
  if (!input.token || input.token.length < 24) {
    throw new AuthError(400, "A valid sign-in token is required.");
  }

  const tokenHash = hashSecret(input.token);
  const challenge = await store.getEmailChallengeByTokenHash(tokenHash);

  if (!challenge || challenge.consumedAt) {
    throw new AuthError(401, "This sign-in link is invalid or has already been used.");
  }

  if (new Date(challenge.expiresAt).getTime() <= now.getTime()) {
    throw new AuthError(401, "This sign-in link has expired.");
  }

  const user = await store.getUser(challenge.userId);
  if (!user || user.status === "disabled") {
    throw new AuthError(403, "This account is not available.");
  }

  const nowIso = now.toISOString();
  const activeUser: UserAccount = {
    ...user,
    status: "active",
    updatedAt: nowIso,
    lastSignedInAt: nowIso
  };
  await store.upsertUser(activeUser);
  await store.markEmailChallengeConsumed(challenge.id, nowIso);

  const sessionToken = createSecret("sess");
  const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const session: UserSession = {
    id: makeId("ses", { userId: activeUser.id, tokenHash: hashSecret(sessionToken), createdAt: nowIso }),
    userId: activeUser.id,
    tokenHash: hashSecret(sessionToken),
    createdAt: nowIso,
    expiresAt: sessionExpiresAt,
    lastUsedAt: nowIso
  };
  await store.saveSession(session);

  return {
    user: activeUser,
    sessionToken,
    sessionExpiresAt
  };
}

export async function authenticateBearerToken(
  store: DisproStore,
  authorizationHeader: string | undefined,
  now = new Date()
): Promise<AuthContext> {
  const token = parseBearerToken(authorizationHeader);
  if (!token) {
    throw new AuthError(401, "Bearer authentication is required.");
  }

  const tokenHash = hashSecret(token);
  const [session, apiKey] = await Promise.all([
    store.getSessionByTokenHash(tokenHash),
    store.getApiKeyByHash(tokenHash)
  ]);

  if (session && new Date(session.expiresAt).getTime() > now.getTime()) {
    const user = await requireActiveUser(store, session.userId);
    await store.touchSession(session.id, now.toISOString());
    return {
      user,
      credential: "session",
      session
    };
  }

  if (apiKey && !apiKey.revokedAt) {
    const user = await requireActiveUser(store, apiKey.userId);
    await store.touchApiKey(apiKey.id, now.toISOString());
    return {
      user,
      credential: "apiKey",
      apiKey
    };
  }

  throw new AuthError(401, "Bearer token is invalid or expired.");
}

export async function createApiKeyForUser(
  store: DisproStore,
  user: UserAccount,
  input: { label?: string },
  now = new Date()
): Promise<CreateApiKeyResult> {
  if (user.status !== "active") {
    throw new AuthError(403, "Only active accounts can create API keys.");
  }

  const secret = createSecret("dsk");
  const nowIso = now.toISOString();
  const apiKey: UserApiKey = {
    id: makeId("key", { userId: user.id, keyHash: hashSecret(secret), createdAt: nowIso }),
    userId: user.id,
    label: sanitizeLabel(input.label),
    keyPrefix: secret.slice(0, 12),
    keyHash: hashSecret(secret),
    createdAt: nowIso
  };

  await store.saveApiKey(apiKey);

  return {
    apiKey,
    secret
  };
}

export function publicUser(user: UserAccount): Omit<UserAccount, "updatedAt"> {
  const result: Omit<UserAccount, "updatedAt"> = {
    id: user.id,
    email: user.email,
    status: user.status,
    createdAt: user.createdAt
  };

  if (user.lastSignedInAt !== undefined) {
    result.lastSignedInAt = user.lastSignedInAt;
  }

  return result;
}

export function publicApiKey(apiKey: UserApiKey): Omit<UserApiKey, "keyHash"> {
  const result: Omit<UserApiKey, "keyHash"> = {
    id: apiKey.id,
    userId: apiKey.userId,
    label: apiKey.label,
    keyPrefix: apiKey.keyPrefix,
    createdAt: apiKey.createdAt
  };

  if (apiKey.lastUsedAt !== undefined) {
    result.lastUsedAt = apiKey.lastUsedAt;
  }
  if (apiKey.revokedAt !== undefined) {
    result.revokedAt = apiKey.revokedAt;
  }

  return result;
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new AuthError(400, "A valid email address is required.");
  }
  return normalized;
}

export function hashSecret(secret: string): string {
  return sha256(`dispro-auth:${secret}`);
}

function createSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function createSignInUrl(baseUrl: string, token: string): string {
  const url = new URL("/auth/verify", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function parseBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1];
}

async function requireActiveUser(store: DisproStore, userId: string): Promise<UserAccount> {
  const user = await store.getUser(userId);
  if (!user || user.status !== "active") {
    throw new AuthError(403, "The authenticated account is not active.");
  }
  return user;
}

function sanitizeLabel(label: string | undefined): string {
  const sanitized = label?.trim();
  return sanitized && sanitized.length > 0 ? sanitized.slice(0, 80) : "Default API key";
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
