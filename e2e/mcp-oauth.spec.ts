import { createHash, randomBytes } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema, OAuthTokensSchema } from "@modelcontextprotocol/core";
import { test, expect, openDashboardCard } from "./fixtures";
import {
  ADMIN_EMAIL,
  TEST_PASSWORD,
  backdateRefreshRotation,
  createTestBot,
  createTestOauthClient,
  createTestUser,
  deleteTestOauthClient,
  deleteTestUser,
  expireTestApiToken,
  lapseTestConnection,
  revokeTestOauthClient,
  setTestUserRole,
  uniqueEmail,
  type TestUser,
} from "./db";
import { uniqueTitle } from "./naming";
import { createAgent, mcpRequest } from "./mcp";

// docs/MCP.md §21, Build order 5, 7, 9 and 10 — the thin slice, enough OAuth
// for claude.ai to connect, refresh tokens with their rotation, the consent
// page in full with the other two kinds of client, and /dashboard's
// Connections card. Claude's real published identity unless a test says
// otherwise, so the redirect URI is claude.ai's callback: the spec reads each
// code from the `Location` of the decision's 303 and redeems it itself, never
// following it.
//
// **The issuer and the endpoint's URL come from the documents**, as a client
// reads them, and are sent as `Origin` and `resource`; nothing is computed.
// The e2e server's APP_URL is its own origin (scripts/prod-web.ts), so the
// documents name the server this spec talks to.
//
// The suite's `request` context carries the admin's session cookie, which is
// what the consent page and its decision read; the token endpoint and
// /api/mcp never read it.

const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const STATE = "e2e-state";
/** Past the two minutes a rotated refresh token is answered as a retry. */
const PAST_THE_RETRY_WINDOW = 3 * 60_000;

type OAuthTokens = ReturnType<typeof OAuthTokensSchema.parse>;
type Discovered = { endpoint: string; issuer: string; authorize: string; token: string; metadataUrl: string };

async function discover(request: APIRequestContext): Promise<Discovered> {
  const metadataPath = "/.well-known/oauth-protected-resource/api/mcp";
  const resource = OAuthProtectedResourceMetadataSchema.parse(await (await request.get(metadataPath)).json());
  const server = OAuthMetadataSchema.parse(await (await request.get("/.well-known/oauth-authorization-server")).json());
  return {
    endpoint: resource.resource,
    issuer: server.issuer,
    authorize: server.authorization_endpoint,
    token: server.token_endpoint,
    metadataUrl: new URL(metadataPath, server.issuer).href,
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** An authorize request from Claude's identity, with any field replaced or (null) left out. */
function authorizeFields(d: Discovered, challenge: string, overrides: Record<string, string | null> = {}): Record<string, string> {
  const fields: Record<string, string | null> = {
    response_type: "code",
    client_id: CLAUDE,
    redirect_uri: CLAUDE_CALLBACK,
    state: STATE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "read write",
    resource: d.endpoint,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== null));
}

function authorizeUrl(d: Discovered, challenge: string, overrides: Record<string, string | null> = {}): string {
  const url = new URL(d.authorize);
  for (const [name, value] of Object.entries(authorizeFields(d, challenge, overrides))) url.searchParams.set(name, value);
  return url.href;
}

/** The decision, posted as the page's form would post it, with this site's Origin unless told otherwise. */
function decide(request: APIRequestContext, d: Discovered, form: Record<string, string>, origin: string | null = d.issuer): Promise<APIResponse> {
  return request.post(new URL("/authorize/decide", d.issuer).href, {
    form,
    headers: origin ? { Origin: origin } : {},
    maxRedirects: 0,
  });
}

/** What a redirect to the client's callback, claude.ai's unless named, carries, after checking it goes there and names the issuer. */
function callback(d: Discovered, location: string | undefined, redirectUri = CLAUDE_CALLBACK): URLSearchParams {
  expect(location).toBeTruthy();
  const url = new URL(location!);
  expect(url.origin + url.pathname).toBe(redirectUri);
  expect(url.searchParams.get("iss")).toBe(d.issuer);
  return url.searchParams;
}

/** Approves through the decision directly, with write unless told otherwise, and returns the code. */
async function approve(request: APIRequestContext, d: Discovered, bot: TestUser, challenge: string, write = true): Promise<string> {
  const res = await decide(request, d, { ...authorizeFields(d, challenge), bot: bot.id, ...(write ? { write: "1" } : {}), decision: "approve" });
  expect(res.status()).toBe(303);
  const code = callback(d, res.headers()["location"]).get("code");
  expect(code).toBeTruthy();
  return code!;
}

function redeem(request: APIRequestContext, d: Discovered, form: Record<string, string>): Promise<APIResponse> {
  return request.post(d.token, { form: { grant_type: "authorization_code", client_id: CLAUDE, ...form } });
}

/** A claude.ai connection for `bot`, approved and redeemed: its first access and refresh tokens. */
async function connect(request: APIRequestContext, d: Discovered, bot: TestUser, write = true): Promise<OAuthTokens> {
  const { verifier, challenge } = pkce();
  const code = await approve(request, d, bot, challenge, write);
  const res = await redeem(request, d, { code, code_verifier: verifier });
  expect(res.status()).toBe(200);
  return OAuthTokensSchema.parse(await res.json());
}

function refresh(request: APIRequestContext, d: Discovered, refreshToken: string | undefined, form: Record<string, string> = {}): Promise<APIResponse> {
  expect(refreshToken).toMatch(/^mbr_/);
  return request.post(d.token, { form: { grant_type: "refresh_token", client_id: CLAUDE, refresh_token: refreshToken!, ...form } });
}

/** A refresh that must succeed, and the pair it answers. */
async function refreshed(request: APIRequestContext, d: Discovered, refreshToken: string | undefined): Promise<OAuthTokens> {
  const res = await refresh(request, d, refreshToken);
  expect(res.status()).toBe(200);
  return OAuthTokensSchema.parse(await res.json());
}

async function errorOf(res: APIResponse): Promise<string> {
  expect(res.status()).toBe(400);
  return (await res.json()).error;
}

/** What a call with this access token gets: 200, or 401 once its connection has ended. */
async function callStatus(request: APIRequestContext, accessToken: string): Promise<number> {
  return (await mcpRequest(request, accessToken, "tools/list")).status;
}

async function toolNames(request: APIRequestContext, accessToken: string): Promise<string[]> {
  const listed = await mcpRequest(request, accessToken, "tools/list");
  expect(listed.status).toBe(200);
  return (listed.body.result?.tools as { name: string }[]).map((tool) => tool.name);
}

test("the documents name the endpoint and this origin, and the 401 points at them", async ({ request }) => {
  const d = await discover(request);
  expect(new URL(d.endpoint).pathname).toBe("/api/mcp");
  expect(new URL(d.endpoint).origin).toBe(d.issuer);
  expect(d.issuer).not.toMatch(/\/$/);

  const resource = await (await request.get("/.well-known/oauth-protected-resource/api/mcp")).json();
  expect(resource).toEqual({ resource: d.endpoint, authorization_servers: [d.issuer], scopes_supported: ["read", "write"] });
  const server = await (await request.get("/.well-known/oauth-authorization-server")).json();
  expect(server).toEqual({
    issuer: d.issuer,
    authorization_endpoint: `${d.issuer}/authorize`,
    token_endpoint: `${d.issuer}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    // offline_access here and nowhere else, as the spec asks.
    scopes_supported: ["read", "write", "offline_access"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
  // The endpoint's document is at its own path and nowhere else.
  expect((await request.get("/.well-known/oauth-protected-resource")).status()).toBe(404);

  const none = await mcpRequest(request, null, "tools/list");
  expect(none.status).toBe(401);
  expect(none.headers["www-authenticate"]).toBe(
    `Bearer error="invalid_token", error_description="Missing Authorization header", scope="read write", resource_metadata="${d.metadataUrl}"`,
  );

  // A browser client's preflight, to each document and to /token.
  for (const [path, method] of [
    ["/.well-known/oauth-protected-resource/api/mcp", "GET"],
    ["/.well-known/oauth-authorization-server", "GET"],
    ["/token", "POST"],
  ] as const) {
    const preflight = await request.fetch(path, {
      method: "OPTIONS",
      headers: { Origin: "https://inspector.example", "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "mcp-protocol-version" },
    });
    expect(preflight.status(), path).toBe(204);
    expect(preflight.headers()["access-control-allow-origin"], path).toBe("*");
    expect(preflight.headers()["access-control-allow-headers"], path).toBe("mcp-protocol-version");
  }
});

test("a connection approved on the page lists a claude.ai connection's tools, to both eras' clients", async ({ page, request }) => {
  const d = await discover(request);
  const bot = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  const { verifier, challenge } = pkce();
  try {
    await page.goto(authorizeUrl(d, challenge));
    await expect(page.getByRole("heading", { name: "Connect Claude" })).toBeVisible();
    // The client's name and the host its connection goes to, which the spec
    // requires on every consent page.
    await expect(page.getByText("the connection goes to claude.ai")).toBeVisible();
    await expect(page.getByText("Its identity is published by claude.ai")).toBeVisible();
    await expect(page.getByText("Approve only a connection you have just started yourself")).toBeVisible();
    await expect(page.getByText("is a program on your own computer")).toHaveCount(0);
    await expect(page.getByText("Signed in as")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in as someone else" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What the connection can do" })).toBeVisible();
    // Every link off the page would abandon the flow, so the site's header isn't there.
    await expect(page.locator("header")).toHaveCount(0);
    await expect(page.locator('input[name="write"]')).not.toBeChecked();

    // The form's post goes to the real decision, whose 303 is read and not
    // followed: claude.ai is never reached.
    const decision: { status?: number; location?: string } = {};
    await page.route("**/authorize/decide", async (route) => {
      const res = await route.fetch({ maxRedirects: 0 });
      decision.status = res.status();
      decision.location = res.headers()["location"];
      await route.fulfill({ status: 200, contentType: "text/html", body: "<p id=stub>decided</p>" });
    });
    await page.selectOption('select[name="bot"]', bot.id);
    await page.check('input[name="write"]');
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("#stub")).toBeVisible();
    expect(decision.status).toBe(303);
    const answered = callback(d, decision.location);
    expect(answered.get("state")).toBe(STATE);

    // OAuth 2.1 drops redirect_uri from the redemption.
    const res = await redeem(request, d, { code: answered.get("code")!, code_verifier: verifier, resource: d.endpoint });
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    const tokens = OAuthTokensSchema.parse(await res.json());
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope).toBe("read write");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toMatch(/^mbr_/);

    // The 2025-era leg.
    const names = await toolNames(request, tokens.access_token);
    expect(names).toContain("multiblog_search");
    expect(names).toContain("multiblog_create_doc");
    for (const forced of ["multiblog_edit_link", "multiblog_rename_file", "multiblog_manage"]) expect(names).not.toContain(forced);

    // The 2026-07-28 leg, as claude.ai opens.
    const client = new Client({ name: "e2e", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const transport = new StreamableHTTPClientTransport(new URL(d.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    try {
      await client.connect(transport);
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      expect(client.getInstructions()).toContain(`You act as ${bot.name}`);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(names);
      const found = await client.callTool({ name: "multiblog_find_users", arguments: { query: bot.name } });
      expect(found.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  } finally {
    await deleteTestUser(bot.email);
  }
});

test("a code is good once, with its verifier, and a replay with the verifier revokes its connection", async ({ request }) => {
  const d = await discover(request);
  const bot = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  const { verifier, challenge } = pkce();
  try {
    const code = await approve(request, d, bot, challenge);

    // A redirect_uri that isn't the code's, sent as OAuth 2.0 sends one, is
    // refused, and spends nothing.
    const wrongRedirect = await redeem(request, d, { code, code_verifier: verifier, redirect_uri: "https://claude.ai/elsewhere" });
    expect(wrongRedirect.status()).toBe(400);
    expect((await wrongRedirect.json()).error).toBe("invalid_grant");
    const wrongVerifier = await redeem(request, d, { code, code_verifier: pkce().verifier });
    expect((await wrongVerifier.json()).error).toBe("invalid_grant");

    const first = await redeem(request, d, { code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK });
    expect(first.status()).toBe(200);
    const { access_token: accessToken } = OAuthTokensSchema.parse(await first.json());
    expect((await mcpRequest(request, accessToken, "tools/list")).status).toBe(200);

    // Again without the verifier: refused, and the connection left alone,
    // or anyone who saw a code could end it.
    const guessed = await redeem(request, d, { code, code_verifier: pkce().verifier });
    expect((await guessed.json()).error).toBe("invalid_grant");
    expect((await mcpRequest(request, accessToken, "tools/list")).status).toBe(200);

    // Again with it: someone else had the code, so the connection ends.
    const replayed = await redeem(request, d, { code, code_verifier: verifier });
    expect((await replayed.json()).error).toBe("invalid_grant");
    expect((await mcpRequest(request, accessToken, "tools/list")).status).toBe(401);
  } finally {
    await deleteTestUser(bot.email);
  }
});

test("the page answers a wrong client or redirect URI itself, and redirects every other refusal to the client", async ({ request }) => {
  const d = await discover(request);
  const { challenge } = pkce();

  for (const [overrides, message] of [
    [{ client_id: "https://evil.example/client.json" }, "comes from a client this site"],
    [{ redirect_uri: "https://evil.example/callback" }, "one its client registered"],
  ] as const) {
    const res = await request.get(authorizeUrl(d, challenge, overrides), { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain(message);
  }

  for (const [overrides, error] of [
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge: null }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ resource: `${d.endpoint}#fragment` }, "invalid_target"],
    [{ resource: new URL("/api/mcp/read", d.issuer).href }, "invalid_target"],
  ] as const) {
    const res = await request.get(authorizeUrl(d, challenge, overrides), { maxRedirects: 0 });
    expect(res.status(), JSON.stringify(overrides)).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    const answered = callback(d, res.headers()["location"]);
    expect(answered.get("error")).toBe(error);
    expect(answered.get("state")).toBe(STATE);
    expect(answered.get("code")).toBeNull();
  }

  // Neither page is framed.
  for (const path of [authorizeUrl(d, challenge), "/sign-in"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.headers()["content-security-policy"], path).toBe("frame-ancestors 'none'");
    expect(res.headers()["x-frame-options"], path).toBe("DENY");
  }
});

test("a signed-out visitor signs in before anything is redirected, and comes back to the page", async ({ browser, playwright, request, baseURL }) => {
  const d = await discover(request);
  const { challenge } = pkce();
  // Empty by name: a context made here inherits the project's storageState,
  // the admin's session, otherwise.
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    // A malformed request too goes to sign in, never to the client unseen.
    for (const overrides of [{}, { response_type: "token" }] as Record<string, string>[]) {
      const res = await anonymous.get(authorizeUrl(d, challenge, overrides), { maxRedirects: 0 });
      const location = new URL(res.headers()["location"] ?? "", d.issuer);
      expect(location.pathname).toBe("/sign-in");
      const callbackUrl = location.searchParams.get("callbackUrl") ?? "";
      expect(callbackUrl.startsWith("/authorize?")).toBe(true);
      expect(new URLSearchParams(callbackUrl.slice("/authorize?".length)).get("client_id")).toBe(CLAUDE);
    }
    // A signed-out post of the decision is refused outright.
    const posted = await decide(anonymous, d, { ...authorizeFields(d, challenge), decision: "approve" });
    expect(posted.status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.goto(authorizeUrl(d, challenge));
    await expect(page).toHaveURL(/\/sign-in\?callbackUrl=/);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Connect Claude" })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("code_challenge")).toBe(challenge);
  } finally {
    await context.close();
  }
});

test("the decision trusts no Origin but this site's, no bot but the person's, and cancels to access_denied", async ({ request }) => {
  const d = await discover(request);
  const mine = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  const otherEmail = uniqueEmail("oauth-person");
  await createTestUser({ email: otherEmail, role: "AUTHOR" });
  const theirs = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: otherEmail });
  const { verifier, challenge } = pkce();
  const approval = { ...authorizeFields(d, challenge), bot: mine.id, decision: "approve" };
  try {
    expect((await decide(request, d, approval, "https://evil.example")).status()).toBe(403);
    expect((await decide(request, d, approval, null)).status()).toBe(403);
    expect((await decide(request, d, { ...approval, bot: theirs.id })).status()).toBe(403);

    const cancelled = await decide(request, d, { ...approval, decision: "cancel" });
    expect(cancelled.status()).toBe(303);
    const answered = callback(d, cancelled.headers()["location"]);
    expect(answered.get("error")).toBe("access_denied");
    expect(answered.get("state")).toBe(STATE);
    expect(answered.get("code")).toBeNull();

    // The form is parsed as the page parses it: a client it doesn't know is
    // refused here too, and never redirected.
    expect((await decide(request, d, { ...approval, client_id: "https://evil.example/client.json" })).status()).toBe(400);

    // Write left unchecked is not granted, though the client asked for it.
    const readOnly = await decide(request, d, approval);
    const code = callback(d, readOnly.headers()["location"]).get("code");
    expect(code).toBeTruthy();
    const tokens = OAuthTokensSchema.parse(await (await redeem(request, d, { code: code!, code_verifier: verifier })).json());
    expect(tokens.scope).toBe("read");
    const names = await toolNames(request, tokens.access_token);
    expect(names).toContain("multiblog_search");
    expect(names).not.toContain("multiblog_create_doc");
  } finally {
    await deleteTestUser(theirs.email);
    await deleteTestUser(otherEmail);
    await deleteTestUser(mine.email);
  }
});

test("a refresh rotates its token; a retry within two minutes is answered, and the pair it gets retires the first", async ({ request }) => {
  const d = await discover(request);
  const bot = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  try {
    const first = await connect(request, d, bot);

    const res = await refresh(request, d, first.refresh_token, { resource: d.endpoint });
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    const one = OAuthTokensSchema.parse(await res.json());
    expect(one.token_type).toBe("Bearer");
    expect(one.expires_in).toBe(3600);
    expect(one.scope).toBe("read write");
    expect(one.refresh_token).toMatch(/^mbr_/);
    expect(one.refresh_token).not.toBe(first.refresh_token);
    expect(await callStatus(request, one.access_token)).toBe(200);

    // The same token again, as a client that lost the answer sends it: still
    // answered, though the access token that answer carried has been used.
    const two = await refreshed(request, d, first.refresh_token);
    expect(two.refresh_token).not.toBe(one.refresh_token);
    expect(await callStatus(request, two.access_token)).toBe(200);
    expect(await callStatus(request, one.access_token)).toBe(200);

    // Using either new refresh token retires the other, and the retired one,
    // presented later, is a replay: the connection ends.
    const three = await refreshed(request, d, two.refresh_token);
    expect(await errorOf(await refresh(request, d, one.refresh_token))).toBe("invalid_grant");
    expect(await callStatus(request, three.access_token)).toBe(401);
    expect(await errorOf(await refresh(request, d, three.refresh_token))).toBe("invalid_grant");
  } finally {
    await deleteTestUser(bot.email);
  }
});

test("a rotated refresh token presented after its successor's use, or past two minutes, ends the connection", async ({ request }) => {
  const d = await discover(request);
  const bot = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  try {
    // A token issued from it has been used, so the old one is a copy.
    const spent = await connect(request, d, bot);
    const child = await refreshed(request, d, spent.refresh_token);
    const grandchild = await refreshed(request, d, child.refresh_token);
    expect(await errorOf(await refresh(request, d, spent.refresh_token))).toBe("invalid_grant");
    expect(await callStatus(request, grandchild.access_token)).toBe(401);

    // Past the window, though nothing issued from it has been used.
    const late = await connect(request, d, bot);
    const next = await refreshed(request, d, late.refresh_token);
    await backdateRefreshRotation(late.refresh_token!, PAST_THE_RETRY_WINDOW);
    expect(await errorOf(await refresh(request, d, late.refresh_token))).toBe("invalid_grant");
    expect(await callStatus(request, next.access_token)).toBe(401);
  } finally {
    await deleteTestUser(bot.email);
  }
});

test("a refresh asking for another endpoint, more scope or another client is refused, and ends nothing", async ({ request }) => {
  const d = await discover(request);
  const bot = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  try {
    const readOnly = await connect(request, d, bot, false);
    expect(readOnly.scope).toBe("read");

    for (const resource of [new URL("/api/mcp/read", d.issuer).href, `${d.endpoint}#fragment`]) {
      expect(await errorOf(await refresh(request, d, readOnly.refresh_token, { resource }))).toBe("invalid_target");
    }
    expect(await errorOf(await refresh(request, d, readOnly.refresh_token, { scope: "read write" }))).toBe("invalid_scope");
    const otherClient = await refresh(request, d, readOnly.refresh_token, { client_id: "https://evil.example/client.json" });
    expect(await errorOf(otherClient)).toBe("invalid_client");
    expect(await callStatus(request, readOnly.access_token)).toBe(200);

    // None of those spent the token. offline_access changes nothing, and the
    // answer carries the connection's scopes.
    const res = await refresh(request, d, readOnly.refresh_token, { scope: "read offline_access" });
    expect(res.status()).toBe(200);
    const tokens = OAuthTokensSchema.parse(await res.json());
    expect(tokens.scope).toBe("read");
    expect(await toolNames(request, tokens.access_token)).not.toContain("multiblog_create_doc");
  } finally {
    await deleteTestUser(bot.email);
  }
});

test("a bot's new claude.ai connection replaces its last one, which the page says first, and leaves another bot's", async ({ page, request }) => {
  const d = await discover(request);
  const bot = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  const other = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  try {
    const old = await connect(request, d, bot);
    const others = await connect(request, d, other);

    await page.goto(authorizeUrl(d, pkce().challenge));
    await expect(page.getByText(`${bot.name} already has a connection to claude.ai`)).toBeVisible();
    await expect(page.getByText(`Approving as ${bot.name} replaces it`)).toBeVisible();

    const fresh = await connect(request, d, bot);
    expect(await callStatus(request, old.access_token)).toBe(401);
    expect(await errorOf(await refresh(request, d, old.refresh_token))).toBe("invalid_grant");
    expect(await callStatus(request, fresh.access_token)).toBe(200);
    expect(await callStatus(request, others.access_token)).toBe(200);
  } finally {
    await deleteTestUser(other.email);
    await deleteTestUser(bot.email);
  }
});

test("Claude Code's identity takes a loopback redirect on any port, warns of it, and connects as other", async ({ page, request }) => {
  const d = await discover(request);
  const bot = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  const loopback = "http://127.0.0.1:53712/callback";
  const asClaudeCode = { client_id: CLAUDE_CODE, redirect_uri: loopback };
  try {
    const { verifier, challenge } = pkce();
    await page.goto(authorizeUrl(d, challenge, asClaudeCode));
    await expect(page.getByRole("heading", { name: "Connect Claude Code" })).toBeVisible();
    await expect(page.getByText("Its identity is published by claude.ai")).toBeVisible();
    await expect(page.getByText("the connection goes to 127.0.0.1:53712")).toBeVisible();
    await expect(page.getByText("127.0.0.1:53712 is a program on your own computer")).toBeVisible();

    const res = await decide(request, d, { ...authorizeFields(d, challenge, asClaudeCode), bot: bot.id, write: "1", decision: "approve" });
    expect(res.status()).toBe(303);
    const code = callback(d, res.headers()["location"], loopback).get("code");
    const redeemed = await redeem(request, d, { client_id: CLAUDE_CODE, code: code!, code_verifier: verifier });
    expect(redeemed.status()).toBe(200);
    const tokens = OAuthTokensSchema.parse(await redeemed.json());

    // A claim to be Claude Code can't be checked, so its connection is
    // `other`: it writes, but lists none of a claude-code token's tools.
    const names = await toolNames(request, tokens.access_token);
    expect(names).toContain("multiblog_create_doc");
    for (const forced of ["multiblog_edit_link", "multiblog_rename_file", "multiblog_manage"]) expect(names).not.toContain(forced);

    // Its refresh names its own client. And a second connection leaves the
    // first: only a claude.ai client's replaces.
    const next = await request.post(d.token, { form: { grant_type: "refresh_token", client_id: CLAUDE_CODE, refresh_token: tokens.refresh_token! } });
    expect(next.status()).toBe(200);
    const second = pkce();
    const again = await decide(request, d, { ...authorizeFields(d, second.challenge, { ...asClaudeCode, redirect_uri: "http://localhost:8123/callback" }), bot: bot.id, decision: "approve" });
    const secondCode = callback(d, again.headers()["location"], "http://localhost:8123/callback").get("code");
    expect((await redeem(request, d, { client_id: CLAUDE_CODE, code: secondCode!, code_verifier: second.verifier })).status()).toBe(200);
    expect(await callStatus(request, OAuthTokensSchema.parse(await next.json()).access_token)).toBe(200);

    // Its two redirect URIs mean a request must name one, and only those.
    for (const [overrides, message] of [
      [{ client_id: CLAUDE_CODE, redirect_uri: null }, "its client has more than one"],
      [{ client_id: CLAUDE_CODE, redirect_uri: "http://127.0.0.1:53712/other" }, "one its client registered"],
      [{ client_id: CLAUDE_CODE, redirect_uri: "https://127.0.0.1:53712/callback" }, "one its client registered"],
    ] as const) {
      const refused = await request.get(authorizeUrl(d, challenge, overrides), { maxRedirects: 0 });
      expect(refused.status()).toBe(200);
      expect(await refused.text()).toContain(message);
    }
  } finally {
    await deleteTestUser(bot.email);
  }
});

test("a client registered by hand connects, and revoking it ends its connections", async ({ request }) => {
  const d = await discover(request);
  const bot = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  const redirectUri = "https://app.example/oauth/callback";
  const name = uniqueTitle("client");
  const clientId = await createTestOauthClient({ name, redirectUris: [redirectUri], kind: "OTHER" });
  const asIt = { client_id: clientId, redirect_uri: redirectUri };
  try {
    const { verifier, challenge } = pkce();
    const html = await (await request.get(authorizeUrl(d, challenge, asIt))).text();
    expect(html).toContain(name);
    // Its client_id is no URL, so there is no host to name for it.
    expect(html).not.toContain("Its identity is published by");

    const res = await decide(request, d, { ...authorizeFields(d, challenge, asIt), bot: bot.id, decision: "approve" });
    const code = callback(d, res.headers()["location"], redirectUri).get("code");
    const redeemed = await redeem(request, d, { client_id: clientId, code: code!, code_verifier: verifier });
    expect(redeemed.status()).toBe(200);
    const tokens = OAuthTokensSchema.parse(await redeemed.json());
    expect(await callStatus(request, tokens.access_token)).toBe(200);

    expect(await revokeTestOauthClient(clientId)).toEqual({ connections: 1 });
    expect(await callStatus(request, tokens.access_token)).toBe(401);
    const refused = await request.post(d.token, { form: { grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token! } });
    expect(await errorOf(refused)).toBe("invalid_client");
    expect(await (await request.get(authorizeUrl(d, challenge, asIt), { maxRedirects: 0 })).text()).toContain("comes from a client this site");
  } finally {
    await deleteTestUser(bot.email);
    await deleteTestOauthClient(clientId);
  }
});

test("a person with no bot to connect as is told why, and offered Cancel alone; the switch signs in someone else", async ({ browser, request }) => {
  const d = await discover(request);
  const email = uniqueEmail("oauth-person");
  await createTestUser({ email, role: "AUTHOR" });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    const url = authorizeUrl(d, pkce().challenge);
    await page.goto(url);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Connect Claude" })).toBeVisible();
    await expect(page.getByText(`(${email})`)).toBeVisible();
    // The space before "writes": SWC drops one that opens a multi-line JSX text holding an entity.
    await expect(page.getByText("so that what Claude writes carries the bot’s name")).toBeVisible();
    await expect(page.getByText("No bot works for you yet. An ADMIN can make one")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();

    // A bot that came to outrank its person is named, and not offered.
    const bot = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: email });
    try {
      await setTestUserRole(email, "AUTHORIZED");
      await page.reload();
      await expect(page.getByText(`${bot.name} works for you, but a bot can’t outrank its person`)).toBeVisible();
      await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

      await setTestUserRole(email, "COMMENTER");
      await page.reload();
      await expect(page.getByText("a COMMENTER can’t have one")).toBeVisible();
    } finally {
      await deleteTestUser(bot.email);
    }

    // The switch signs out and back in, to the same request.
    await page.getByRole("button", { name: "Sign in as someone else" }).click();
    await expect(page).toHaveURL(/\/sign-in\?callbackUrl=/);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`(${ADMIN_EMAIL})`)).toBeVisible();
    expect(new URL(page.url()).searchParams.get("code_challenge")).toBe(new URL(url).searchParams.get("code_challenge"));
  } finally {
    await context.close();
    await deleteTestUser(email);
  }
});

test("the token endpoint refuses a grant it doesn't offer, and a code or refresh token it never issued", async ({ request }) => {
  const d = await discover(request);
  // Claude's own document lists the jwt-bearer grant; this server doesn't offer it.
  const jwtBearer = await request.post(d.token, {
    form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: "x", client_id: CLAUDE },
  });
  expect(await errorOf(jwtBearer)).toBe("unsupported_grant_type");

  expect(await errorOf(await refresh(request, d, "mbr_not-a-token"))).toBe("invalid_grant");

  const unknownClient = await redeem(request, d, { client_id: "https://evil.example/client.json", code: "x", code_verifier: pkce().verifier });
  expect((await unknownClient.json()).error).toBe("invalid_client");

  const unknownCode = await redeem(request, d, { code: "not-a-code", code_verifier: pkce().verifier });
  expect((await unknownCode.json()).error).toBe("invalid_grant");

  const json = await request.post(d.token, { data: { grant_type: "authorization_code" } });
  expect(json.status()).toBe(400);
  expect((await json.json()).error).toBe("invalid_request");
  expect(json.headers()["access-control-allow-origin"]).toBe("*");
});

test("the dashboard lists what a person issued, a lapsed connection and an expired token as such, and Revoke ends a connection at its next call", async ({ page, request }) => {
  // MCP.md §21, "Seeing and ending a connection". Each row is found by its
  // bot's name, since the suite's admin issues every spec's tokens.
  const d = await discover(request);
  const bot = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  const lapsing = await createTestBot({ email: uniqueEmail("oauth-bot"), worksForEmail: ADMIN_EMAIL });
  const header = await createAgent(request, { scopes: ["READ"], client: "CLAUDE_CODE" });
  try {
    const live = await connect(request, d, bot);
    const lapsed = await connect(request, d, lapsing, false);
    await lapseTestConnection(lapsed.refresh_token!);
    await expireTestApiToken(header.tokenId);

    await page.goto("/dashboard");
    await openDashboardCard(page, "Connections");
    const row = (name: string) => page.getByRole("row").filter({ hasText: name });

    await expect(row(bot.name)).toContainText("Claude");
    await expect(row(bot.name)).toContainText("read, write");
    await expect(row(lapsing.name)).toContainText("Lapsed");
    await expect(row(lapsing.name).getByRole("button", { name: "Revoke" })).toHaveCount(0);
    await expect(row(header.user.name)).toContainText("Claude Code · header token");
    await expect(row(header.user.name)).toContainText("Expired");
    await expect(row(header.user.name).getByRole("button", { name: "Revoke" })).toHaveCount(0);

    expect(await callStatus(request, live.access_token)).toBe(200);
    await row(bot.name).getByRole("button", { name: "Revoke" }).click();
    await row(bot.name).getByRole("button", { name: "Yes" }).click();
    await expect(row(bot.name)).toHaveCount(0);
    expect(await callStatus(request, live.access_token)).toBe(401);
    expect(await errorOf(await refresh(request, d, live.refresh_token))).toBe("invalid_grant");
  } finally {
    await header.dispose();
    await deleteTestUser(lapsing.email);
    await deleteTestUser(bot.email);
  }
});

test("the dashboard offers claude.ai the skill as a ZIP and the paragraph for a Project", async ({ page, request }) => {
  await page.goto("/dashboard");
  await openDashboardCard(page, "Connections");
  await expect(page.getByText("Its tools are named `multiblog_*`.")).toBeVisible();

  const href = await page.getByRole("link", { name: "The MultiBlog skill" }).getAttribute("href");
  const zip = await request.get(href!);
  expect(zip.status()).toBe(200);
  expect(zip.headers()["content-type"]).toBe("application/zip");
  const bytes = await zip.body();
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.includes("multiblog/SKILL.md")).toBe(true);
});
