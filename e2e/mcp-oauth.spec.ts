import { createHash, randomBytes } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema, OAuthTokensSchema } from "@modelcontextprotocol/core";
import { test, expect } from "./fixtures";
import { ADMIN_EMAIL, TEST_PASSWORD, createTestBot, createTestUser, deleteTestUser, uniqueEmail, type TestUser } from "./db";
import { mcpRequest } from "./mcp";

// docs/MCP.md §21, Build order 5 — the thin slice: enough OAuth for claude.ai
// to connect. Claude's real published identity throughout, so the redirect
// URI is claude.ai's callback: the spec reads each code from the `Location`
// of the decision's 303 and redeems it itself, never following it.
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
const STATE = "e2e-state";

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

/** What a redirect to claude.ai's callback carries, after checking it goes there and names the issuer. */
function callback(d: Discovered, location: string | undefined): URLSearchParams {
  expect(location).toBeTruthy();
  const url = new URL(location!);
  expect(url.origin + url.pathname).toBe(CLAUDE_CALLBACK);
  expect(url.searchParams.get("iss")).toBe(d.issuer);
  return url.searchParams;
}

/** Approves through the decision directly and returns the code. */
async function approve(request: APIRequestContext, d: Discovered, bot: TestUser, challenge: string): Promise<string> {
  const res = await decide(request, d, { ...authorizeFields(d, challenge), bot: bot.id, write: "1", decision: "approve" });
  expect(res.status()).toBe(303);
  const code = callback(d, res.headers()["location"]).get("code");
  expect(code).toBeTruthy();
  return code!;
}

function redeem(request: APIRequestContext, d: Discovered, form: Record<string, string>): Promise<APIResponse> {
  return request.post(d.token, { form: { grant_type: "authorization_code", client_id: CLAUDE, ...form } });
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
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write"],
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
    await expect(page.getByText("Approve only a connection you have just started yourself")).toBeVisible();
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
    expect(tokens.refresh_token).toBeUndefined();

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
  const anonymous = await playwright.request.newContext({ baseURL });
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

test("the token endpoint refuses what the slice doesn't offer", async ({ request }) => {
  const d = await discover(request);
  const refresh = await request.post(d.token, { form: { grant_type: "refresh_token", refresh_token: "mbr_x", client_id: CLAUDE } });
  expect(refresh.status()).toBe(400);
  expect((await refresh.json()).error).toBe("unsupported_grant_type");

  const unknownClient = await redeem(request, d, { client_id: "https://evil.example/client.json", code: "x", code_verifier: pkce().verifier });
  expect((await unknownClient.json()).error).toBe("invalid_client");

  const unknownCode = await redeem(request, d, { code: "not-a-code", code_verifier: pkce().verifier });
  expect((await unknownCode.json()).error).toBe("invalid_grant");

  const json = await request.post(d.token, { data: { grant_type: "authorization_code" } });
  expect(json.status()).toBe(400);
  expect((await json.json()).error).toBe("invalid_request");
  expect(json.headers()["access-control-allow-origin"]).toBe("*");
});
