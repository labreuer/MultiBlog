import { ALL_SCOPES } from "@/lib/api/tokens";
import type { ApiScope } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { signAccessToken } from "./access-token";
import { findClient } from "./clients";
import { hashCode } from "./consent";
import { mcpEndpointUrl } from "./discovery";
import { verifierMatches } from "./pkce";
import { namesEndpoint } from "./resource";

// docs/MCP.md §21, "The token endpoint" — what `POST /token` answers, for
// the `authorization_code` grant: a code minted on the consent page,
// redeemed once, makes the connection's `api_token` row and an access token
// for it. Errors are RFC 6749 §5.2's.
//
// No rate limit here: a code is good once, and only a person approving on the
// consent page makes one. A code that matches no row is refused for the cost
// of a hash and an index lookup.

export type TokenAnswer = { status: number; body: Record<string, unknown> };

function oauthError(error: string, description: string): TokenAnswer {
  return { status: 400, body: { error, error_description: description } };
}

const invalidGrant = (description: string) => oauthError("invalid_grant", description);

/** A connection's prefix: `oa_` and the end of its id, a cuid's random part, so two made in one second differ. */
export function connectionPrefix(tokenId: string): string {
  return `oa_${tokenId.slice(-7)}`;
}

/** A connection's name: its client's, and the day it was made. */
function connectionName(clientName: string, at: Date): string {
  return `${clientName} ${at.toISOString().slice(0, 10)}`;
}

/** Scopes as OAuth names them, in the order the enum declares them. */
function scopeString(scopes: readonly ApiScope[]): string {
  return ALL_SCOPES.filter((scope) => scopes.includes(scope))
    .map((scope) => scope.toLowerCase())
    .join(" ");
}

/** One line per grant and revocation, beside §4's audit line: the client, the row's prefix, the account and the issuer. */
function logLine(fields: { event: "grant" | "revoke"; reason?: string; client: string; token: string; user: string; issuer: string }): void {
  console.log(JSON.stringify({ at: "oauth", ...fields }));
}

/** The answer to a token request's form. */
export async function tokenGrant(form: URLSearchParams): Promise<TokenAnswer> {
  // No parameter more than once (RFC 6749 §3.2), but `resource`, which RFC
  // 8707 lets a request repeat.
  for (const name of new Set(form.keys())) {
    if (name !== "resource" && form.getAll(name).length > 1) return oauthError("invalid_request", `${name} is sent more than once.`);
  }
  const grantType = form.get("grant_type") || null;
  if (!grantType) return oauthError("invalid_request", "grant_type is required.");
  if (grantType !== "authorization_code") return oauthError("unsupported_grant_type", "Only the authorization_code grant is supported.");
  return redeemCode(form);
}

/**
 * The `authorization_code` grant. Any client authentication sent is ignored:
 * every client is public, and claude.ai's own-client option may send an
 * empty secret.
 */
async function redeemCode(form: URLSearchParams): Promise<TokenAnswer> {
  const code = form.get("code") || null;
  const clientId = form.get("client_id") || null;
  const verifier = form.get("code_verifier") || null;
  if (!code || !clientId || !verifier) return oauthError("invalid_request", "code, client_id and code_verifier are required.");

  const client = await findClient(clientId);
  if (!client) return oauthError("invalid_client", "The client is unknown.");

  const row = await prisma.oauthCode.findUnique({ where: { codeHash: hashCode(code) } });
  if (!row) return invalidGrant("The code is unknown.");

  // What only the code's requester has: its client, and the verifier to its
  // challenge. A replay without both revokes nothing, or anyone who saw a
  // code could end the connection (OAuth 2.1 §7.5.3).
  const proven = row.clientId === client.clientId && verifierMatches(verifier, row.codeChallenge);
  if (row.usedAt !== null) {
    // Presented again: someone else had it (RFC 6749 §4.1.2).
    if (proven) await revokeReplayed(row.id);
    return invalidGrant("The code has been used.");
  }
  if (!proven) return invalidGrant("The code was issued to another client, or the code_verifier doesn't match its challenge.");
  if (row.expiresAt.getTime() <= Date.now()) return invalidGrant("The code has expired.");

  // OAuth 2.1 drops redirect_uri from this request, since PKCE binds the
  // code; a client following OAuth 2.0 still sends it, and has it checked.
  const redirectUri = form.get("redirect_uri") || null;
  if (redirectUri !== null && redirectUri !== row.redirectUri) return invalidGrant("redirect_uri isn't the one the code was issued for.");

  const endpoint = mcpEndpointUrl();
  if (form.getAll("resource").some((resource) => !namesEndpoint(resource, endpoint))) {
    return oauthError("invalid_target", "resource must be the endpoint the code was issued for, with no query or fragment.");
  }

  // The bot must still work for the person who approved it, and both be
  // live: the soft-delete filter leaves a deleted account out.
  const [bot, issuer] = await Promise.all([
    prisma.user.findUnique({ where: { id: row.userId }, select: { worksForUserId: true } }),
    prisma.user.findUnique({ where: { id: row.issuerId }, select: { id: true } }),
  ]);
  if (!bot || !issuer || bot.worksForUserId !== issuer.id) {
    return invalidGrant("The account no longer works for the person who approved the connection.");
  }

  const now = new Date();
  const made = await prisma.$transaction(async (tx) => {
    // The claim, in the transaction that uses it: one use, however many
    // redemptions race.
    const claimed = await tx.oauthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (claimed.count === 0) return null;
    const created = await tx.apiToken.create({
      data: {
        userId: row.userId,
        createdByUserId: row.issuerId,
        name: connectionName(client.name, now),
        oauthClientId: client.clientId,
        prefix: "oa_",
        scopes: row.scopes,
        client: client.kind,
      },
      select: { id: true },
    });
    const prefix = connectionPrefix(created.id);
    await tx.apiToken.update({ where: { id: created.id }, data: { prefix } });
    await tx.oauthCode.update({ where: { id: row.id }, data: { apiTokenId: created.id } });
    return { id: created.id, prefix };
  });
  if (!made) {
    // Another redemption claimed it first, so this one is the replay.
    await revokeReplayed(row.id);
    return invalidGrant("The code has been used.");
  }

  const { accessToken, expiresIn } = await signAccessToken(made.id, endpoint);
  logLine({ event: "grant", client: client.clientId, token: made.prefix, user: row.userId, issuer: row.issuerId });
  return {
    status: 200,
    body: { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, scope: scopeString(row.scopes) },
  };
}

/** Revokes the connection a code's first use made, now that the code has come back. */
async function revokeReplayed(codeId: string): Promise<void> {
  const code = await prisma.oauthCode.findUnique({
    where: { id: codeId },
    select: { clientId: true, userId: true, issuerId: true, apiToken: { select: { id: true, prefix: true } } },
  });
  if (!code?.apiToken) return;
  const revoked = await prisma.apiToken.updateMany({ where: { id: code.apiToken.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (revoked.count === 0) return;
  logLine({
    event: "revoke",
    reason: "code_replayed",
    client: code.clientId,
    token: code.apiToken.prefix,
    user: code.userId,
    issuer: code.issuerId,
  });
}

/** Pruning runs at most this often. */
const PRUNE_EVERY_MS = 60 * 60_000;
/** A spent or lapsed code is kept this long past its expiry, so a late replay still finds its connection. */
const CODE_KEPT_MS = 24 * 60 * 60_000;

let lastPrunedAt = 0;

/**
 * Deletes codes a day past their expiry, at most once an hour per process.
 * The route runs it after its answer is sent (`after()`): claude.ai waits 10
 * seconds for `/token`, and a flow answered later fails even when the token
 * was issued.
 */
export async function pruneSpentCodes(): Promise<void> {
  const now = Date.now();
  if (now - lastPrunedAt < PRUNE_EVERY_MS) return;
  lastPrunedAt = now;
  await prisma.oauthCode.deleteMany({ where: { expiresAt: { lt: new Date(now - CODE_KEPT_MS) } } });
}
