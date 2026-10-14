import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { signByteGrant, verifyByteGrant } from "@/lib/api/grants";
import { signYdocToken, verifyYdocToken } from "@/lib/ydoc-token";
import { signAccessToken, verifyAccessToken } from "./access-token";

// docs/MCP.md §21, Testing — an access token is good only at the endpoint it
// was made for, and none of the three tokens signed with AUTH_SECRET passes
// for another: a byte grant and a ydoc token are refused as access tokens,
// and an access token is refused as either.

process.env.AUTH_SECRET ??= "unit-test-secret-not-for-anything-real";

const ENDPOINT = new URL("https://multiblog.example/api/mcp");
const OTHER = new URL("https://multiblog.example/api/mcp/read");

test("an access token names its connection and its endpoint, for an hour", async () => {
  const { accessToken, expiresIn } = await signAccessToken("ctoken1", ENDPOINT);
  assert.equal(expiresIn, 3600);
  const verified = await verifyAccessToken(accessToken, [ENDPOINT]);
  assert.ok(verified);
  assert.equal(verified.tokenId, "ctoken1");
  assert.equal(verified.audience.href, ENDPOINT.href);
  const inAnHour = Math.floor(Date.now() / 1000) + 3600;
  assert.ok(Math.abs(verified.expiresAt - inAnHour) <= 2);
});

test("an access token is refused where its endpoint isn't accepted", async () => {
  const { accessToken } = await signAccessToken("ctoken1", ENDPOINT);
  assert.equal(await verifyAccessToken(accessToken, [OTHER]), null);
});

test("an expired or tampered access token is refused", async () => {
  const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
  const expired = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("ctoken1")
    .setAudience(ENDPOINT.href)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(secret);
  assert.equal(await verifyAccessToken(expired, [ENDPOINT]), null);

  const { accessToken } = await signAccessToken("ctoken1", ENDPOINT);
  const [header, , signature] = accessToken.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "cother", aud: ENDPOINT.href, exp: 9_999_999_999 })).toString("base64url");
  assert.equal(await verifyAccessToken(`${header}.${forged}.${signature}`, [ENDPOINT]), null);
});

test("a byte grant and a ydoc token are refused as access tokens", async () => {
  const { grant } = await signByteGrant("ctoken1", "/api/mcp/export");
  assert.equal(await verifyAccessToken(grant, [ENDPOINT]), null);
  const ydoc = await signYdocToken({ sub: "u1", documentName: "ydoc:doc:d1", role: "AUTHOR" });
  assert.equal(await verifyAccessToken(ydoc, [ENDPOINT]), null);
});

test("an access token is refused as a byte grant and as a ydoc token", async () => {
  const { accessToken } = await signAccessToken("ctoken1", ENDPOINT);
  assert.equal(await verifyByteGrant(accessToken, "/api/mcp/export"), null);
  await assert.rejects(verifyYdocToken(accessToken));
});
