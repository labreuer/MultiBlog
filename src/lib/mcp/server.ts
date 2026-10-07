import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, ERROR_LIST_CAP } from "@/lib/api/errors";
import { takeRateLimit } from "@/lib/api/rate-limit";
import type { AuthenticatedToken } from "@/lib/api/tokens";
import { instructionsFor } from "./instructions";
import { jsonSchemaOf, type McpContext, type McpTool } from "./tool";
import { TOOLS } from "./tools";

// docs/MCP.md §5 — one MCP server per request, in the SDK's stateless mode,
// built after the token has been checked so that it can list only what that
// token may call and name, in its instructions, whose account it acts as.
//
// **The low-level `Server`, not `McpServer`.** McpServer validates a tool's
// arguments itself and answers a refusal as a bare sentence, where every
// refusal here is a `{ code, message, … }` body (§4) — an `invalid` included,
// since a client that gets a code can correct itself. Listing and calling are
// two small handlers, so owning them costs less than working around them.

export const SERVER_NAME = "multiblog";
const SERVER_VERSION = "1.0.0";

/** The tools a token may see: its scopes', and the forced-prompt ones only for Claude Code (§3, §15). */
export function toolsFor(token: AuthenticatedToken): McpTool[] {
  return TOOLS.filter(
    (tool) => token.scopes.includes(tool.scope) && (!tool.forcePrompt || token.client === "CLAUDE_CODE"),
  );
}

function definitionOf(tool: McpTool) {
  const meta: Record<string, unknown> = { "anthropic/searchHint": tool.searchHint };
  if (tool.alwaysLoad) meta["anthropic/alwaysLoad"] = true;
  if (tool.forcePrompt) meta["anthropic/requiresUserInteraction"] = true;
  if (tool.maxResultSizeChars) meta["anthropic/maxResultSizeChars"] = tool.maxResultSizeChars;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: jsonSchemaOf(tool.input, "input") as { type: "object" },
    outputSchema: jsonSchemaOf(tool.output, "output") as { type: "object" },
    annotations: {
      readOnlyHint: tool.readOnly,
      ...(tool.readOnly ? {} : { destructiveHint: tool.destructive, idempotentHint: true }),
      openWorldHint: false,
    },
    _meta: meta,
  };
}

function errorResult(body: Record<string, unknown>): CallToolResult {
  // Text alone, no structuredContent: a client may hold structured content to
  // the tool's outputSchema, which an error doesn't match, and Claude Code
  // hands its model the text when there is no structured form (§4).
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

/** One structured line per call (§4's audit): token prefix, user, tool, outcome, duration. */
function audit(ctx: McpContext, tool: string, outcome: string, startedAt: number): void {
  console.log(
    JSON.stringify({
      at: "mcp",
      token: ctx.token.prefix,
      user: ctx.actor.userId,
      tool,
      outcome,
      ms: Date.now() - startedAt,
    }),
  );
}

export async function callTool(tool: McpTool, rawArgs: unknown, ctx: McpContext): Promise<CallToolResult> {
  const startedAt = Date.now();
  if (!takeRateLimit(ctx.token.id)) {
    audit(ctx, tool.name, "rate_limited", startedAt);
    return errorResult({ code: "rate_limited", message: "Too many calls on this token; wait a few seconds and retry." });
  }
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    audit(ctx, tool.name, "invalid", startedAt);
    const issues = parsed.error.issues;
    return errorResult({
      code: "invalid",
      message: `The arguments to ${tool.name} don't fit its schema.`,
      issues: issues.slice(0, ERROR_LIST_CAP).map((issue) => `${issue.path.join(".") || "(arguments)"}: ${issue.message}`),
      ...(issues.length > ERROR_LIST_CAP ? { moreIssues: issues.length - ERROR_LIST_CAP } : {}),
    });
  }
  try {
    const result = await tool.run(parsed.data, ctx);
    const checked = tool.output.safeParse(result);
    if (!checked.success) {
      // A result that doesn't fit its own schema is this server's bug, not the
      // caller's, and is logged as one; the caller gets the result anyway
      // rather than a failure for something it didn't do.
      console.error(`[mcp] ${tool.name} answered outside its outputSchema:`, checked.error.issues.slice(0, 5));
    }
    audit(ctx, tool.name, "ok", startedAt);
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  } catch (err) {
    if (err instanceof ApiError) {
      audit(ctx, tool.name, err.code, startedAt);
      return errorResult(err.body());
    }
    console.error(`[mcp] ${tool.name} failed:`, err);
    audit(ctx, tool.name, "internal", startedAt);
    return errorResult({ code: "internal", message: "Something went wrong on the server; the call may be retried." });
  }
}

export function buildMcpServer(token: AuthenticatedToken): Server {
  const ctx: McpContext = { token, actor: { userId: token.user.id, role: token.user.role } };
  const tools = toolsFor(token);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: instructionsFor(token) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(definitionOf) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return errorResult({
        code: "invalid",
        message: `No tool named ${request.params.name} is available on this token.`,
      });
    }
    return callTool(tool, request.params.arguments, ctx);
  });
  return server;
}
