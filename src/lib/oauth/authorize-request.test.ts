import { test } from "node:test";
import assert from "node:assert/strict";
import type { OauthClientInfo } from "./clients";
import {
  asksForMore,
  authorizationResponseUrl,
  clientIdHost,
  grantedScopes,
  isLoopbackRedirect,
  parseAuthorizeRequest,
  redirectUriMatches,
  redirectUriRefusal,
  scopesAsked,
  searchParamsOf,
  type AuthorizeParse,
} from "./authorize-request";

// docs/MCP.md §21, Testing — the authorize parse's refusals, each with
// whether it redirects; the scopes a request asks for; and the response URL.

const ENDPOINT = new URL("https://multiblog.example/api/mcp");
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const CLAUDE: OauthClientInfo = {
  clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  name: "Claude",
  redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  kind: "CLAUDE_AI",
};

/** A client with two loopback redirect URIs, as Claude Code's identity has. */
const NATIVE: OauthClientInfo = {
  clientId: "cnative0000000000000000000",
  name: "A native app",
  redirectUris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  kind: "OTHER",
};

function request(overrides: Record<string, string | null> = {}, client: OauthClientInfo = CLAUDE): URLSearchParams {
  const fields: Record<string, string | null> = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0],
    state: "s-123",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "read write",
    resource: ENDPOINT.href,
    ...overrides,
  };
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) if (value !== null) params.set(name, value);
  return params;
}

function parse(params: URLSearchParams, client: OauthClientInfo | null = CLAUDE): AuthorizeParse {
  return parseAuthorizeRequest(params, client, ENDPOINT);
}

function assertRedirected(result: AuthorizeParse, error: string, state: string | null = "s-123"): void {
  assert.equal(result.kind, "redirect-error", JSON.stringify(result));
  if (result.kind !== "redirect-error") return;
  assert.equal(result.error, error);
  assert.equal(result.state, state);
  assert.equal(result.redirectUri, CLAUDE.redirectUris[0]);
}

test("a well-formed request parses, with what it asked for", () => {
  const result = parse(request());
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.request, {
    client: CLAUDE,
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    state: "s-123",
    codeChallenge: CHALLENGE,
    scopesAsked: ["READ", "WRITE"],
  });
});

test("a wrong client or redirect URI is answered on the page, never redirected", () => {
  for (const [params, client] of [
    [request(), null],
    [request({ client_id: null }), CLAUDE],
    [request({ client_id: "https://claude.ai/oauth/claude-code-client-metadata" }), CLAUDE],
    [request({ redirect_uri: "https://evil.example/callback" }), CLAUDE],
    [request({ redirect_uri: "https://claude.ai/api/mcp/auth_callback/" }), CLAUDE],
    [request({ redirect_uri: "https://claude.ai/api/mcp/auth_callback?x=1" }), CLAUDE],
  ] as const) {
    assert.equal(parse(params, client).kind, "page-error", params.toString());
  }
  const twice = request();
  twice.append("client_id", CLAUDE.clientId);
  assert.equal(parse(twice).kind, "page-error");
  const twoRedirects = request();
  twoRedirects.append("redirect_uri", CLAUDE.redirectUris[0]);
  assert.equal(parse(twoRedirects).kind, "page-error");
});

test("a request with no redirect_uri takes its client's one, and is refused on the page when there are several", () => {
  const one = parse(request({ redirect_uri: null }));
  assert.equal(one.kind, "ok");
  if (one.kind === "ok") assert.equal(one.request.redirectUri, CLAUDE.redirectUris[0]);
  assert.equal(parse(request({ redirect_uri: null }, NATIVE), NATIVE).kind, "page-error");
});

test("a loopback redirect URI matches on any port, and nothing else does", () => {
  const ok = parse(request({ redirect_uri: "http://127.0.0.1:53712/callback" }, NATIVE), NATIVE);
  assert.equal(ok.kind, "ok");
  if (ok.kind === "ok") assert.equal(ok.request.redirectUri, "http://127.0.0.1:53712/callback");

  assert.equal(redirectUriMatches("http://localhost/callback", "http://localhost:8080/callback"), true);
  for (const requested of [
    "http://127.0.0.1:53712/other",
    "https://127.0.0.1:53712/callback",
    "http://127.0.0.2:53712/callback",
    "http://localhost:53712/callback?x=1",
    "http://localhost:53712/callback#x",
    "http://user@localhost:53712/callback",
  ]) {
    assert.equal(redirectUriMatches("http://localhost/callback", requested) || redirectUriMatches("http://127.0.0.1/callback", requested), false, requested);
  }
  // Only a loopback URI is matched on any port.
  assert.equal(redirectUriMatches("https://claude.ai/api/mcp/auth_callback", "https://claude.ai:444/api/mcp/auth_callback"), false);
});

test("a client_id's host is shown only when the id is an https URL", () => {
  assert.equal(clientIdHost("https://claude.ai/oauth/mcp-oauth-client-metadata"), "claude.ai");
  assert.equal(clientIdHost("https://claude.ai/oauth/claude-code-client-metadata"), "claude.ai");
  assert.equal(clientIdHost("cmv9r8eov0000ycijfbjniqtp"), null);
  assert.equal(clientIdHost("http://evil.example/client.json"), null);
});

test("a loopback redirect URI is plain http to this machine, on any port", () => {
  for (const uri of ["http://localhost/callback", "http://127.0.0.1:53712/callback", "http://[::1]:8080/cb"]) {
    assert.equal(isLoopbackRedirect(uri), true, uri);
  }
  for (const uri of ["https://localhost/callback", "https://claude.ai/api/mcp/auth_callback", "http://127.0.0.2/cb", "not a uri"]) {
    assert.equal(isLoopbackRedirect(uri), false, uri);
  }
});

test("a redirect URI registered by hand is absolute, has no fragment, and is https unless it is loopback", () => {
  for (const uri of [
    "https://app.example/callback",
    "https://app.example/callback?keep=1",
    "http://127.0.0.1/callback",
    "http://localhost:6274/oauth/callback",
    "http://[::1]/cb",
    "com.example.app:/callback",
  ]) {
    assert.equal(redirectUriRefusal(uri), null, uri);
  }
  for (const uri of [
    "/callback",
    "app.example/callback",
    "https://app.example/callback#x",
    "https://app.example/callback#",
    "http://app.example/callback",
    "http://192.168.1.5/callback",
  ]) {
    assert.notEqual(redirectUriRefusal(uri), null, uri);
  }
});

test("everything else is redirected to the client with its error and state", () => {
  assertRedirected(parse(request({ response_type: "token" })), "unsupported_response_type");
  assertRedirected(parse(request({ response_type: null })), "invalid_request");
  assertRedirected(parse(request({ code_challenge: null })), "invalid_request");
  // A missing method would mean plain.
  assertRedirected(parse(request({ code_challenge_method: null })), "invalid_request");
  assertRedirected(parse(request({ code_challenge_method: "plain" })), "invalid_request");
  assertRedirected(parse(request({ code_challenge: "too-short" })), "invalid_request");
  assertRedirected(parse(request({ resource: `${ENDPOINT.href}#fragment` })), "invalid_target");
  assertRedirected(parse(request({ resource: "https://multiblog.example/api/mcp/read" })), "invalid_target");
  assertRedirected(parse(request({ resource: "https://evil.example/api/mcp" })), "invalid_target");
  const twoScopes = request();
  twoScopes.append("scope", "read");
  assertRedirected(parse(twoScopes), "invalid_request");
  const twoStates = request();
  twoStates.append("state", "s-456");
  assertRedirected(parse(twoStates), "invalid_request", null);
  assertRedirected(parse(request({ response_type: "token", state: null })), "unsupported_response_type", null);
});

test("no resource is taken as naming the endpoint, and the endpoint named twice is fine", () => {
  assert.equal(parse(request({ resource: null })).kind, "ok");
  const twice = request();
  twice.append("resource", `${ENDPOINT.href}/`);
  assert.equal(parse(twice).kind, "ok");
});

test("write implies read, neither asks for both, and any other word is ignored", () => {
  assert.deepEqual(scopesAsked("read"), ["READ"]);
  assert.deepEqual(scopesAsked("read offline_access"), ["READ"]);
  assert.deepEqual(scopesAsked("write"), ["READ", "WRITE"]);
  assert.deepEqual(scopesAsked("read write"), ["READ", "WRITE"]);
  assert.deepEqual(scopesAsked(null), ["READ", "WRITE"]);
  assert.deepEqual(scopesAsked("offline_access"), ["READ", "WRITE"]);
  assert.deepEqual(scopesAsked("openid profile email"), ["READ", "WRITE"]);
  assert.deepEqual(scopesAsked("manage"), ["READ", "WRITE"]);
});

test("a refresh asks for more only by naming write on a connection that can only read", () => {
  assert.equal(asksForMore("read write", ["READ"]), true);
  assert.equal(asksForMore("write", ["READ"]), true);
  assert.equal(asksForMore("read write offline_access", ["READ", "WRITE"]), false);
  assert.equal(asksForMore("read offline_access", ["READ"]), false);
  assert.equal(asksForMore("manage", ["READ"]), false);
  assert.equal(asksForMore(null, ["READ"]), false);
  assert.equal(asksForMore("", ["READ"]), false);
});

test("the page grants read alone until the person chooses write, and never more than was asked", () => {
  assert.deepEqual(grantedScopes(["READ", "WRITE"], false), ["READ"]);
  assert.deepEqual(grantedScopes(["READ", "WRITE"], true), ["READ", "WRITE"]);
  assert.deepEqual(grantedScopes(["READ"], true), ["READ"]);
});

test("a response keeps the redirect URI's own query, adds iss, and leaves out a null", () => {
  const url = new URL(
    authorizationResponseUrl("https://app.example/cb?keep=1", "https://multiblog.example", { code: "c-1", state: null }),
  );
  assert.equal(url.origin + url.pathname, "https://app.example/cb");
  assert.deepEqual([...url.searchParams], [
    ["keep", "1"],
    ["code", "c-1"],
    ["iss", "https://multiblog.example"],
  ]);
});

test("a page's searchParams keep their repeats", () => {
  assert.deepEqual([...searchParamsOf({ a: "1", b: ["2", "3"], c: undefined })], [
    ["a", "1"],
    ["b", "2"],
    ["b", "3"],
  ]);
});
