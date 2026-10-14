import { createHash, randomBytes } from "node:crypto";
import { prisma, type TransactionClient } from "@/lib/prisma";
import type { RefreshState } from "./rotation";

// docs/MCP.md §21, "A connection" — a connection's refresh token: `mbr_` and
// 32 random bytes, kept as its SHA-256 in `oauth_refresh_token`, good for 90
// days. What a presented one gets is src/lib/oauth/rotation.ts's rule; this
// is the database half: issuing one, reading a token's state for the rule,
// and pruning.

export const REFRESH_TOKEN_PREFIX = "mbr_";

/** How long a refresh token is good for. A connection unused this long ends. */
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Issues a refresh token for the connection `apiTokenId`, from `parentId` when
 * it is a rotation, inside the caller's transaction. The token itself is
 * returned once and never stored.
 */
export async function issueRefreshToken(tx: TransactionClient, apiTokenId: string, parentId: string | null, now: Date): Promise<string> {
  const token = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  await tx.oauthRefreshToken.create({
    data: {
      tokenHash: hashRefreshToken(token),
      apiTokenId,
      parentId,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    },
  });
  return token;
}

/** The token's state under the caller's lock on its connection; null once it is gone. */
export async function refreshStateOf(tx: TransactionClient, id: string): Promise<RefreshState | null> {
  const token = await tx.oauthRefreshToken.findUnique({ where: { id }, select: { usedAt: true, parentId: true } });
  if (!token) return null;
  const childUsed = (await tx.oauthRefreshToken.count({ where: { parentId: id, usedAt: { not: null } } })) > 0;
  const siblingUsed =
    token.parentId !== null &&
    (await tx.oauthRefreshToken.count({ where: { parentId: token.parentId, id: { not: id }, usedAt: { not: null } } })) > 0;
  return { usedAt: token.usedAt, childUsed, siblingUsed };
}

/**
 * Deletes the refresh tokens past their 90 days, but each connection's
 * newest, which dates its lapse (§21, "Seeing and ending a connection").
 */
export async function pruneExpiredRefreshTokens(now: Date): Promise<void> {
  const expired = await prisma.oauthRefreshToken.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true, apiTokenId: true, expiresAt: true },
  });
  if (expired.length === 0) return;
  const newest = await prisma.oauthRefreshToken.groupBy({
    by: ["apiTokenId"],
    where: { apiTokenId: { in: [...new Set(expired.map((token) => token.apiTokenId))] } },
    _max: { expiresAt: true },
  });
  const newestOf = new Map(newest.map((group) => [group.apiTokenId, group._max.expiresAt?.getTime()]));
  const spent = expired.filter((token) => token.expiresAt.getTime() < (newestOf.get(token.apiTokenId) ?? 0));
  if (spent.length > 0) await prisma.oauthRefreshToken.deleteMany({ where: { id: { in: spent.map((token) => token.id) } } });
}

/** Selects a connection's newest refresh token, whose expiry is when it lapses (`hasLapsed`). */
export const NEWEST_REFRESH_TOKEN = { orderBy: { expiresAt: "desc" }, take: 1, select: { expiresAt: true } } as const;
