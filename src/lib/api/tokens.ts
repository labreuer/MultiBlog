import { createHash, randomBytes } from "node:crypto";
import type { ApiScope, ApiTokenClient, Role } from "@/generated/prisma/enums";
import { prisma, type TransactionClient } from "@/lib/prisma";

// docs/MCP.md §3 — API tokens: issuing one, and the one check that
// authenticates every request to the MCP endpoint and its byte routes,
// whether the request carries the token or a grant made from it.
//
// Server-only (node:crypto, Prisma).

/** Every secret starts with this, so a leaked one is recognisable in a log or a paste. */
export const TOKEN_SECRET_PREFIX = "mb_";

/** How much of the secret `api_token.prefix` keeps, for telling tokens apart. */
const DISPLAY_PREFIX_LENGTH = 10;

/** `last_used_at` moves at most this often, so a busy token isn't a write per call. */
const LAST_USED_RESOLUTION_MS = 60_000;

export const ALL_SCOPES: readonly ApiScope[] = ["READ", "WRITE", "MANAGE"];

/** SHA-256 in hex. A fast hash is right here: a 256-bit random secret gives stretching nothing to protect. */
export function hashTokenSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateTokenSecret(): string {
  return `${TOKEN_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * Issues a token for `userId`, issued by `issuerId` — the same person for
 * one's own token, the person a bot works for otherwise. The secret is
 * returned once and never stored.
 *
 * Takes named fields and builds the row from them (CLAUDE.md, check:prisma-data).
 */
export async function issueApiToken(opts: {
  userId: string;
  issuerId: string;
  name: string;
  scopes: readonly ApiScope[];
  client: ApiTokenClient;
  expiresAt?: Date | null;
}): Promise<{ secret: string; id: string }> {
  const scopes = ALL_SCOPES.filter((scope) => opts.scopes.includes(scope));
  if (scopes.length === 0) throw new Error("A token needs at least one scope.");
  const secret = generateTokenSecret();
  const row = await prisma.apiToken.create({
    data: {
      userId: opts.userId,
      createdByUserId: opts.issuerId,
      name: opts.name.trim().slice(0, 200) || "token",
      tokenHash: hashTokenSecret(secret),
      prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH),
      scopes,
      client: opts.client,
      expiresAt: opts.expiresAt ?? null,
    },
    select: { id: true },
  });
  return { secret, id: row.id };
}

export type TokenPerson = { id: string; name: string | null; slug: string };

/** A token that passed the check, with the account it acts as and the person who issued it. */
export type AuthenticatedToken = {
  id: string;
  prefix: string;
  scopes: readonly ApiScope[];
  client: ApiTokenClient;
  user: TokenPerson & { role: Role };
  issuer: TokenPerson & { role: Role };
};

/**
 * The bearer secret on a request, or null. Only the `Authorization` header:
 * the MCP endpoint never accepts the session cookie, so it has no CSRF surface
 * to defend, and a secret in a query string is what the byte grants exist to
 * avoid.
 */
export function bearerSecret(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match ? match[1] : null;
}

/** §3's one check, from the secret. */
export async function authenticateSecret(secret: string): Promise<AuthenticatedToken | null> {
  if (!secret.startsWith(TOKEN_SECRET_PREFIX)) return null;
  return authenticate({ tokenHash: hashTokenSecret(secret) });
}

/** §3's one check, from a token id a byte grant carries (src/lib/api/grants.ts). */
export async function authenticateTokenId(id: string): Promise<AuthenticatedToken | null> {
  return authenticate({ id });
}

/**
 * The token, looked up by its hash or id, neither revoked nor expired; then
 * its user and its issuer, **each in a query of its own through the filtered
 * client**. The soft-delete `$extends` filter adds `deletedByUserId: null` to
 * a top-level `user` read and to nothing reached through an include, so an
 * `include: { user: true }` here would let a deleted account's token keep
 * working (src/lib/prisma.ts).
 *
 * The role comes from that row, read on every request, so a demotion or a
 * deletion takes effect on the token's very next call. A deleted issuer stops
 * the token too: a bot's token acts for its issuer, and an account that is
 * gone has nobody left to act for.
 */
async function authenticate(where: { tokenHash: string } | { id: string }): Promise<AuthenticatedToken | null> {
  const token = await prisma.apiToken.findUnique({
    where,
    select: {
      id: true,
      prefix: true,
      scopes: true,
      client: true,
      userId: true,
      createdByUserId: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });
  if (!token || token.revokedAt !== null) return null;
  const now = Date.now();
  if (token.expiresAt !== null && token.expiresAt.getTime() <= now) return null;

  const select = { id: true, name: true, slug: true, role: true } as const;
  const [user, issuer] = await Promise.all([
    prisma.user.findUnique({ where: { id: token.userId }, select }),
    token.createdByUserId === token.userId
      ? null
      : prisma.user.findUnique({ where: { id: token.createdByUserId }, select }),
  ]);
  if (!user) return null;
  const issuedBy = token.createdByUserId === token.userId ? user : issuer;
  if (!issuedBy) return null;

  if (token.lastUsedAt === null || now - token.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
    // Conditional, so two concurrent requests write once; not awaited, since
    // nothing the request does depends on it.
    void prisma.apiToken
      .updateMany({
        where: {
          id: token.id,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now - LAST_USED_RESOLUTION_MS) } }],
        },
        data: { lastUsedAt: new Date(now) },
      })
      .catch((err) => console.error(`[api-token] couldn't record a use of ${token.prefix}:`, err));
  }

  return {
    id: token.id,
    prefix: token.prefix,
    scopes: token.scopes,
    client: token.client,
    user: { id: user.id, name: user.name, slug: user.slug, role: user.role },
    issuer: { id: issuedBy.id, name: issuedBy.name, slug: issuedBy.slug, role: issuedBy.role },
  };
}

/**
 * Revokes every live token of `userId`, inside the caller's transaction —
 * what soft-deleting a user does in the same transaction as the delete
 * (docs/MCP.md §3). Restoring the account brings none back.
 */
export async function revokeTokensOf(tx: TransactionClient, userId: string, at: Date): Promise<void> {
  await tx.apiToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } });
}
