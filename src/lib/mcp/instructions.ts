import { displayNameOf } from "@/lib/display-name";
import { BYLINE_ELIGIBLE_ROLES } from "@/lib/role-checks";
import type { AuthenticatedToken, TokenPerson } from "@/lib/api/tokens";
import { listedName, TOOL_PREFIX, type Who } from "./tool";

// docs/MCP.md §5, §21 — the server instructions, and the text they share
// with the skill (./skill.ts). Claude Code reads the instructions in every
// session where the server is configured; claude.ai never passes them to its
// model. So they hold only what belongs to no one tool — whose account, what
// the server holds, and to search it first — and each tool's conventions are
// in that tool's description, which both clients show once the tool loads.
//
// Claude Code cuts the instructions off at 2,048 characters. A spec holds
// them under the cap with long names for the actor and the issuer
// (e2e/mcp-read.spec.ts).

export const INSTRUCTIONS_MAX_CHARS = 2048;

/** What the server holds: the instructions' and the skill's. */
export const HOLDS =
  "MultiBlog is a research archive: docs and drafts, PDFs, notes on passages (annotations), anchored links, tags, posts and their comments, and earlier conversations with Claude imported as docs.";

/** When to reach for it: the instructions' and the skill's. */
export const FIRST =
  "Search it before researching elsewhere or answering from memory, whenever a question might touch what it holds.";

/** How a research session goes, step by step: the skill's, which the instructions leave to each tool's description. */
export const SESSION_STEPS = [
  `**Find.** Start with ${listedName("search")}: words or a phrase, or a filter (kinds, authors, tags, dates) to list what it selects. Pass exact:true when the question is whether something exists.`,
  `**Read.** ${listedName("read")} takes any URL a hit gives. A long doc answers with its outline; read the sections you need, several reads at once. A doc hit's passage is one read with around set to a phrase from its snippet.`,
  `**Cite.** Name every source you use by its MultiBlog URL, as search and read give it.`,
  `**Write up**, when asked, with ${listedName("create_doc")}: the prompt quoted at the top, and each claim linked to the passage behind it.`,
  `**Mark passages.** ${listedName("add_note")} leaves a note on a passage; ${listedName("create_link")} mints a link to one for a summary to cite, once ${listedName("read")} with include:["links"] shows there is none already.`,
  `**Act on notes.** When you do what someone's note asks, reply to it with ${listedName("add_note")}: what was done, and a link.`,
];

function person(p: TokenPerson): string {
  // A nameless account's slug is made from its email (user-slug.ts), so it is
  // never shown.
  return p.name?.trim() ? `${displayNameOf(p)} (author slug ${p.slug})` : displayNameOf(p);
}

/** The token's two people, named as the instructions and the descriptions name them. */
export function whoFor(token: AuthenticatedToken): Who {
  const sameIssuer = token.issuer.id === token.user.id;
  return {
    actor: person(token.user),
    issuer: sameIssuer ? null : person(token.issuer),
    issuerOnByline: !sameIssuer && BYLINE_ELIGIBLE_ROLES.includes(token.issuer.role),
  };
}

export function instructionsFor(token: AuthenticatedToken): string {
  const who = whoFor(token);
  return [
    `You act as ${who.actor}, on a token issued by ${who.issuer ?? "the same account"}.`,
    HOLDS,
    FIRST,
    `Each ${TOOL_PREFIX}* tool's description carries its own conventions; a session starts with ${listedName("search")} and ${listedName("read")}.`,
  ].join("\n");
}
