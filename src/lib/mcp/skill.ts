import { zipStored } from "@/lib/zip";
import { FIRST, HOLDS, SESSION_STEPS } from "./instructions";
import { TOOL_PREFIX } from "./tool";

// docs/MCP.md §21, "The skill" — the cold start claude.ai's connector can't
// carry. claude.ai never passes the server's instructions to its model, and
// a tool's description reaches it only once the tool is loaded, so what
// belongs to no one tool — that the person's research is here and is
// searched first, and how a research session goes — goes in a skill the
// person installs. claude.ai keeps only its description in context, and
// reads the rest when a request matches it.
//
// Built from the instructions' own text (./instructions.ts), so the two move
// with the tools. It names no account: the descriptions name the actor and
// the issuer per token, so one skill serves every connection.

export const SKILL_NAME = "multiblog";

/** claude.ai's cap on a skill's description, the one part of it always in context. */
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

/**
 * When the skill applies, in the words a request would use. A plain YAML
 * scalar, so no `: `, no ` #` and no `<` or `>` (skill.test.ts).
 */
export const SKILL_DESCRIPTION =
  `Searches, reads and writes the person's research archive in MultiBlog, through the ${TOOL_PREFIX}* tools. ` +
  "Use it whenever a request touches their own research or reading — their notes, docs and drafts, PDFs, the papers and books they have read or annotated, tags, posts, comments, or earlier conversations with Claude — " +
  'as in "what did I write about…", "find my notes on…", "what have I read on…", "we talked about this before", "summarize my research on…" or "write this up". ' +
  "Look there before the web or memory whenever a question might already be answered in it.";

/** How the tools are named, and how a client that defers them loads them: the skill's and the Project paragraph's. */
const TOOLS_NAMED = `Its tools are named \`${TOOL_PREFIX}*\`. Where they load through a tool search, search for "multiblog" to load them.`;

/** The skill's SKILL.md. */
export function skillMarkdown(): string {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESCRIPTION}`,
    "---",
    "",
    "# MultiBlog",
    "",
    `${HOLDS} ${FIRST}`,
    "",
    `${TOOLS_NAMED} Each one's description carries its own conventions: how to anchor a quote, which kind of link to use for what, what a refusal means.`,
    "",
    "## A research session",
    "",
    ...SESSION_STEPS.map((step, i) => `${i + 1}. ${step}`),
    "",
  ].join("\n");
}

/** The ZIP claude.ai takes under Customize > Skills: the skill's folder, holding its SKILL.md. */
export function skillZip(): Uint8Array<ArrayBuffer> {
  return zipStored([
    { name: `${SKILL_NAME}/` },
    { name: `${SKILL_NAME}/SKILL.md`, content: new TextEncoder().encode(skillMarkdown()) },
  ]);
}

/**
 * The skill's cold start as one paragraph for a claude.ai Project's
 * instructions, which /dashboard's Connections card offers beside the ZIP: a
 * skill runs only with code execution on, and without it the paragraph does
 * the same work in that Project's chats (§21, "The skill"). What the archive
 * holds, to search it first, and how its tools are named; each tool's
 * description carries the rest.
 */
export function projectInstructions(): string {
  return `${HOLDS} ${FIRST} ${TOOLS_NAMED}`;
}
