// The MCP server's specs drive /api/mcp from below the UI, the way
// e2e/doc-apply-update.spec.ts drives the collab server: Playwright's
// `request` fixture and a small JSON-RPC helper (docs/MCP.md §18). The
// request context carries the suite's admin cookie, which the endpoint never
// reads — every call here is the bearer token's.
import type { APIRequestContext } from "@playwright/test";
import { createTestApiToken, createTestUser, deleteTestUser, type TestUser } from "./db";
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

/** One JSON-RPC request to /api/mcp, its HTTP status, and its parsed body. */
export async function mcpRequest(
  request: APIRequestContext,
  secret: string | null,
  method: string,
  params: unknown = {},
): Promise<{ status: number; body: { result?: Record<string, unknown>; error?: unknown } }> {
  const res = await request.post("/api/mcp", {
    headers: {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
    },
    data: { jsonrpc: "2.0", id: nextId++, method, params },
    maxRetries: 2,
  });
  const text = await res.text();
  let body: { result?: Record<string, unknown>; error?: unknown } = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  return { status: res.status(), body };
}

/** `tools/call`, answered as the model would read it. */
export async function callTool(
  request: APIRequestContext,
  secret: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const { status, body } = await mcpRequest(request, secret, "tools/call", { name, arguments: args });
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

/** A machine client: its own AUTHOR account with a name, and a token issued by the shared admin. */
export type Agent = {
  user: TestUser;
  secret: string;
  tokenId: string;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>;
  dispose: () => Promise<void>;
};

export async function createAgent(
  request: APIRequestContext,
  opts: { scopes?: ("READ" | "WRITE" | "MANAGE")[]; client?: "CLAUDE_CODE" | "CLAUDE_AI" | "OTHER"; issuerEmail?: string } = {},
): Promise<Agent> {
  const email = uniqueEmail("mcp-bot");
  const user = await createTestUser({ email, name: `E2E Bot ${Math.random().toString(36).slice(2, 7)}`, role: "AUTHOR" });
  const { id, secret } = await createTestApiToken({
    email,
    issuerEmail: opts.issuerEmail ?? ADMIN_EMAIL,
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
