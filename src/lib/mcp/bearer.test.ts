import { test } from "node:test";
import assert from "node:assert/strict";
import { OAuthError } from "@modelcontextprotocol/server";
import type { AuthenticatedToken } from "@/lib/api/tokens";
import { authInfoFor, bearerGate, tokenVerifier, type Authenticate } from "./bearer";

// docs/MCP.md §21, "The bearer check, on v2's terms" — the verifier's pure
// half, and the gate's answers, with §3's one check stood in for by a map
// from secret to token.

const RESOURCE = new URL("https://multiblog.example/api/mcp");
const SECRET = "mb_known";

function token(expiresAt: Date | null): AuthenticatedToken {
  const person = { id: "u1", name: "Claude", slug: "claude", role: "AUTHOR" as const };
  return { id: "t1", prefix: "mb_known", scopes: ["READ", "WRITE"], client: "CLAUDE_CODE", expiresAt, user: person, issuer: person };
}

const inAYear = new Date(Date.UTC(2027, 9, 14, 12, 0, 0, 750));

function only(known: AuthenticatedToken): Authenticate {
  return async (secret) => (secret === SECRET ? known : null);
}

function post(authorization?: string): Request {
  return new Request(RESOURCE, { method: "POST", headers: authorization ? { Authorization: authorization } : {} });
}

test("a header token reports OAuth's scope names, its expiry in seconds, the endpoint, its prefix and itself", () => {
  const known = token(inAYear);
  const info = authInfoFor(known, SECRET, RESOURCE);
  assert.deepEqual(info, {
    token: SECRET,
    clientId: "mb_known",
    scopes: ["read", "write"],
    expiresAt: Math.floor(inAYear.getTime() / 1000),
    resource: RESOURCE,
    extra: { token: known },
  });
  assert.equal(Number.isInteger(info.expiresAt), true);
});

test("a secret the check doesn't pass is refused as invalid_token", async () => {
  const verifier = tokenVerifier(RESOURCE, only(token(inAYear)));
  await assert.rejects(verifier.verifyAccessToken("mb_unknown"), (err) => err instanceof OAuthError && err.code === "invalid_token");
});

test("a request with no token is answered with v2's 401, naming the scopes", async () => {
  const answer = await bearerGate(post(), RESOURCE, only(token(inAYear)));
  assert.ok(answer instanceof Response);
  assert.equal(answer.status, 401);
  assert.equal(
    answer.headers.get("WWW-Authenticate"),
    'Bearer error="invalid_token", error_description="Missing Authorization header", scope="read write"',
  );
  assert.deepEqual(await answer.json(), { error: "invalid_token", error_description: "Missing Authorization header" });
});

test("a token sent and refused is answered with the same challenge and its own description", async () => {
  const answer = await bearerGate(post("Bearer mb_unknown"), RESOURCE, only(token(inAYear)));
  assert.ok(answer instanceof Response);
  assert.equal(answer.status, 401);
  assert.match(answer.headers.get("WWW-Authenticate") ?? "", /^Bearer error="invalid_token", error_description="[^"]+", scope="read write"$/);
});

test("a token the check passes comes through with itself in extra", async () => {
  const known = token(inAYear);
  const answer = await bearerGate(post(`Bearer ${SECRET}`), RESOURCE, only(known));
  assert.ok(!(answer instanceof Response));
  assert.equal(answer.extra?.token, known);
});

test("v2 refuses a token with no expiry, and one past it", async () => {
  for (const [expiresAt, description] of [
    [null, "Token has no expiration time"],
    [new Date(Date.now() - 60_000), "Token has expired"],
  ] as const) {
    const answer = await bearerGate(post(`Bearer ${SECRET}`), RESOURCE, only(token(expiresAt)));
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
