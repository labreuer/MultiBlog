// The MCP server's specs drive /api/mcp from below the UI, the way
// e2e/doc-apply-update.spec.ts drives the collab server: Playwright's
// `request` fixture and a small JSON-RPC helper (docs/MCP.md §18). The
// request context carries the suite's admin cookie, which the endpoint never
// reads — every call here is the bearer token's.
import type { APIRequestContext } from "@playwright/test";
import { createTestApiToken, createTestBot, createTestUser, deleteTestUser, type TestUser } from "./db";
import { ADMIN_EMAIL, uniqueEmail } from "./naming";

export type ToolAnswer = {
  /** True for a tool error (`isError`), whose body is `error`. */
  isError: boolean;
  /** The structured result, as the model reads it. */
  result: Record<string, unknown> & { [key: string]: unknown };
  /** The `{ code, message, … }` body of a refusal. */
  error: Record<string, unknown> & { code?: string; message?: string };
  /** The serialized size of what the model reads. */
  size: number;
};

let nextId = 1;

type RpcBody = { id?: unknown; result?: Record<string, unknown>; error?: unknown };

/**
 * One 2025-era JSON-RPC request to /api/mcp, its HTTP status and headers, and
 * its parsed body. The server answers such a request with a one-event stream rather than
 * JSON (MCP.md §21, "Moving to SDK v2"), so the response is taken from the
 * event that carries this request's id; any other body is parsed whole.
 */
export async function mcpRequest(
  request: APIRequestContext,
  secret: string | null,
  method: string,
  params: unknown = {},
): Promise<{ status: number; headers: Record<string, string>; body: RpcBody }> {
  const id = nextId++;
  const res = await request.post("/api/mcp", {
    headers: {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
    },
    data: { jsonrpc: "2.0", id, method, params },
    maxRetries: 2,
  });
  const text = await res.text();
  let body: RpcBody = { error: text };
  try {
    if (res.headers()["content-type"]?.startsWith("text/event-stream")) {
      const events = text.split(/\r?\n\r?\n/).map((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n"),
      );
      const response = events.filter(Boolean).map((data) => JSON.parse(data) as RpcBody).find((message) => message.id === id);
      if (response) body = response;
    } else {
      body = JSON.parse(text);
    }
  } catch {
    // Not JSON-RPC: a refusal the route wrote itself keeps its text as `error`.
  }
  return { status: res.status(), headers: res.headers(), body };
}

/** The prefix every listed tool name carries (docs/MCP.md §21, "The names"). */
export const TOOL_PREFIX = "multiblog_";

/**
 * `tools/call`, answered as the model would read it. `name` is the tool's
 * short name, the code's, and the prefix goes on here, so a spec changes
 * only where a tool's verb does.
 */
export async function callTool(
  request: APIRequestContext,
  secret: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const { status, body } = await mcpRequest(request, secret, "tools/call", { name: `${TOOL_PREFIX}${name}`, arguments: args });
  if (status !== 200 || !body.result) throw new Error(`tools/call ${name} answered ${status}: ${JSON.stringify(body)}`);
  const result = body.result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) {
    return { isError: true, result: {}, error: JSON.parse(text), size: text.length };
  }
  return {
    isError: false,
    result: result.structuredContent ?? {},
    error: {},
    size: JSON.stringify(result.structuredContent ?? {}).length,
  };
}

/**
 * A machine client: by default a bot, an AUTHOR working for its issuer (the
 * shared admin unless `issuerEmail` says otherwise), with a token that issuer
 * issued — §3's check refuses any other (docs/MCP.md §21, "Whose account").
 * With `person`, an account of its own with a password, holding a token it
 * issued itself: what a spec that calls `manage` needs, since no bot's token
 * lists it.
 */
export type Agent = {
  user: TestUser;
  secret: string;
  tokenId: string;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>;
  dispose: () => Promise<void>;
};

export async function createAgent(
  request: APIRequestContext,
  opts: {
    scopes?: ("READ" | "WRITE" | "MANAGE")[];
    client?: "CLAUDE_CODE" | "CLAUDE_AI" | "OTHER";
    issuerEmail?: string;
    name?: string;
    person?: boolean;
  } = {},
): Promise<Agent> {
  const email = uniqueEmail("mcp-bot");
  const name = opts.name ?? `E2E Bot ${Math.random().toString(36).slice(2, 7)}`;
  const issuerEmail = opts.person ? email : (opts.issuerEmail ?? ADMIN_EMAIL);
  const user = opts.person
    ? await createTestUser({ email, name, role: "AUTHOR" })
    : await createTestBot({ email, worksForEmail: issuerEmail, name, role: "AUTHOR" });
  const { id, secret } = await createTestApiToken({
    email,
    issuerEmail,
    scopes: opts.scopes ?? ["READ", "WRITE"],
    client: opts.client ?? "CLAUDE_CODE",
  });
  return {
    user,
    secret,
    tokenId: id,
    call: (name, args) => callTool(request, secret, name, args),
    dispose: () => deleteTestUser(email),
  };
}
