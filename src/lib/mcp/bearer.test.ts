import { test } from "node:test";
import assert from "node:assert/strict";
import { OAuthError } from "@modelcontextprotocol/server";
import type { AuthenticatedToken } from "@/lib/api/tokens";
import { authInfoFor, bearerGate, tokenVerifier, type Authenticate, type Bearer } from "./bearer";

// docs/MCP.md §21, "The bearer check, on v2's terms" — the verifier's pure
// half, and the gate's answers, with §3's one check stood in for by a map
// from bearer value to what it authenticates as.

const RESOURCE = new URL("https://multiblog.example/api/mcp");
const METADATA = "https://multiblog.example/.well-known/oauth-protected-resource/api/mcp";
const SECRET = "mb_known";

function token(oauthClientId: string | null = null): AuthenticatedToken {
  const person = { id: "u1", name: "Claude", slug: "claude", role: "AUTHOR" as const };
  return {
    id: "t1",
    prefix: oauthClientId ? "oa_abcdefg" : "mb_known",
    scopes: ["READ", "WRITE"],
    client: oauthClientId ? "CLAUDE_AI" : "CLAUDE_CODE",
    oauthClientId,
    expiresAt: null,
    user: person,
    issuer: person,
  };
}

const inAYear = Math.floor(Date.UTC(2027, 9, 14, 12, 0, 0) / 1000);

function only(known: Bearer): Authenticate {
  return async (value) => (value === SECRET ? known : null);
}

function post(authorization?: string): Request {
  return new Request(RESOURCE, { method: "POST", headers: authorization ? { Authorization: authorization } : {} });
}

test("a header token reports OAuth's scope names, its expiry, the endpoint, its prefix and itself", () => {
  const known = token();
  const info = authInfoFor({ token: known, resource: RESOURCE, expiresAt: inAYear }, SECRET);
  assert.deepEqual(info, {
    token: SECRET,
    clientId: "mb_known",
    scopes: ["read", "write"],
    expiresAt: inAYear,
    resource: RESOURCE,
    extra: { token: known },
  });
});

test("a connection reports its client_id as its client", () => {
  const known = token("https://claude.ai/oauth/mcp-oauth-client-metadata");
  const info = authInfoFor({ token: known, resource: RESOURCE, expiresAt: inAYear }, "eyJ.access.token");
  assert.equal(info.clientId, "https://claude.ai/oauth/mcp-oauth-client-metadata");
  assert.equal(info.resource, RESOURCE);
});

test("a bearer the check doesn't pass is refused as invalid_token", async () => {
  const verifier = tokenVerifier(RESOURCE, only({ token: token(), resource: RESOURCE, expiresAt: inAYear }));
  await assert.rejects(verifier.verifyAccessToken("mb_unknown"), (err) => err instanceof OAuthError && err.code === "invalid_token");
});

test("a request with no token is answered with v2's 401, naming the scopes and the endpoint's metadata", async () => {
  const answer = await bearerGate(post(), RESOURCE, only({ token: token(), resource: RESOURCE, expiresAt: inAYear }));
  assert.ok(answer instanceof Response);
  assert.equal(answer.status, 401);
  assert.equal(
    answer.headers.get("WWW-Authenticate"),
    `Bearer error="invalid_token", error_description="Missing Authorization header", scope="read write", resource_metadata="${METADATA}"`,
  );
  assert.deepEqual(await answer.json(), { error: "invalid_token", error_description: "Missing Authorization header" });
});

test("a token sent and refused is answered with the same challenge and its own description", async () => {
  const answer = await bearerGate(post("Bearer mb_unknown"), RESOURCE, only({ token: token(), resource: RESOURCE, expiresAt: inAYear }));
  assert.ok(answer instanceof Response);
  assert.equal(answer.status, 401);
  assert.match(
    answer.headers.get("WWW-Authenticate") ?? "",
    /^Bearer error="invalid_token", error_description="[^"]+", scope="read write", resource_metadata="[^"]+"$/,
  );
});

test("a token the check passes comes through with itself in extra", async () => {
  const known = token();
  const answer = await bearerGate(post(`Bearer ${SECRET}`), RESOURCE, only({ token: known, resource: RESOURCE, expiresAt: inAYear }));
  assert.ok(!(answer instanceof Response));
  assert.equal(answer.extra?.token, known);
});

test("an access token made for another endpoint is refused here", async () => {
  const elsewhere = new URL("https://multiblog.example/api/mcp/read");
  const answer = await bearerGate(post(`Bearer ${SECRET}`), RESOURCE, only({ token: token("c1"), resource: elsewhere, expiresAt: inAYear }));
  assert.ok(answer instanceof Response);
  assert.equal(answer.status, 401);
  assert.equal((await answer.json()).error_description, "Token was not issued for this resource");
});

test("v2 refuses a token with no expiry, and one past it", async () => {
  for (const [expiresAt, description] of [
    [undefined, "Token has no expiration time"],
    [Math.floor(Date.now() / 1000) - 60, "Token has expired"],
  ] as const) {
    const answer = await bearerGate(post(`Bearer ${SECRET}`), RESOURCE, only({ token: token(), resource: RESOURCE, expiresAt }));
    assert.ok(answer instanceof Response);
    assert.equal(answer.status, 401);
    assert.equal((await answer.json()).error_description, description);
  }
});

test("a check that fails rather than refuses is a 500, not a 401", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const answer = await bearerGate(post(`Bearer ${SECRET}`), RESOURCE, async () => {
      throw new Error("the database is down");
    });
    assert.ok(answer instanceof Response);
    assert.equal(answer.status, 500);
  } finally {
    console.error = original;
  }
});
