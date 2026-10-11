import { z } from "zod";
import type { ApiScope } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/actor";
import type { AuthenticatedToken } from "@/lib/api/tokens";

// docs/MCP.md §15 — what a tool is: its scope, its schemas, the hints a
// client uses to present and schedule it, and the operation it calls.
//
// **zod checks only the envelope** (§4). The domain parsers stay the trust
// boundary for what they parse — `parseSelector`, `parsePdfTarget`,
// `parseCommentBody` — and a parsed argument is still never a Prisma write's
// data (§1): an operation builds that from named fields.

/** Who a call acts as, and the token it came in on. */
export type McpContext = {
  token: AuthenticatedToken;
  actor: Actor;
};

/** The JSON a tool answers with: what the model reads (§4), so it is shaped for reading. */
export type ToolResult = Record<string, unknown>;

export type McpTool = {
  name: string;
  scope: ApiScope;
  description: string;
  input: z.ZodObject;
  output: z.ZodType;
  /** MCP's hints (§15): read-only tools run concurrently in Claude Code; `destructive` names an overwrite or a removal. */
  readOnly: boolean;
  destructive: boolean;
  /** A few words a client's tool search matches besides the name. */
  searchHint: string;
  /** Loaded up front rather than through tool search: `search` and `read` only (§15, §16). */
  alwaysLoad?: boolean;
  /**
   * Prompts on every call in Claude Code, whatever the allow rules — for the
   * tools whose actions can't be undone, and only those. Listed only to a
   * token issued for `claude-code` (§3).
   */
  forcePrompt?: boolean;
  /** Above Claude Code's 50,000-character default; `read` alone declares it (§4). */
  maxResultSizeChars?: number;
  run(args: unknown, ctx: McpContext): Promise<ToolResult>;
};

/** A tool, its handler typed by its own input schema. */
export function defineTool<I extends z.ZodObject, O extends z.ZodType>(
  def: Omit<McpTool, "input" | "output" | "run"> & {
    input: I;
    output: O;
    run(args: z.infer<I>, ctx: McpContext): Promise<z.infer<O> & ToolResult>;
  },
): McpTool {
  return def as unknown as McpTool;
}

/** A JSON Schema for a tool definition, without the `$schema` key a client never reads. */
export function jsonSchemaOf(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

// The handles a tool takes for an object: a MultiBlog URL, absolute or as a
// path, or an id where no URL names it (§4, §14).
export const objectRef = z
  .string()
  .min(1)
  .max(2000)
  .describe("A MultiBlog URL (absolute, or a path like /doc/<slug>), or an object's id.");

/** A version as an earlier read returned it: a decimal string, since a JSON number can't hold a BigInt (§4). */
export const versionString = z
  .string()
  .regex(/^\d{1,19}$/, "a version is a decimal string, as a read returns it")
  .describe("The `version` an earlier read returned.");

/** A quote, or a long passage named by its ends (§7). */
export const quoteFields = {
  quote: z.string().min(1).max(5000).optional().describe("The exact words, as a `text` read shows them."),
  start: z.string().min(1).max(500).optional().describe("A long passage's first words, with `end` in place of `quote`."),
  end: z.string().min(1).max(500).optional().describe("A long passage's last words, with `start`."),
  prefix: z.string().max(500).optional().describe("Words just before the quote, when it occurs more than once."),
  suffix: z.string().max(500).optional().describe("Words just after the quote, when it occurs more than once."),
};
