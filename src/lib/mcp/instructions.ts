import { displayNameOf } from "@/lib/display-name";
import type { AuthenticatedToken, TokenPerson } from "@/lib/api/tokens";

// docs/MCP.md §5 — the server instructions: the one part of the server every
// session reads, since Claude Code defers each tool's own description behind
// its tool search. Claude Code cuts them off at 2,048 characters, so they lead
// with what matters most and leave each tool's detail to its own description
// and parameters. A spec holds them under the cap (e2e/mcp-read.spec.ts).
//
// They name the actor and the issuer, read from the token's two rows, so "my
// annotations" needs no lookup and a token issued by someone else names them.

export const INSTRUCTIONS_MAX_CHARS = 2048;

function person(p: TokenPerson): string {
  // A nameless account's slug is made from its email (user-slug.ts), so it is
  // never shown.
  return p.name?.trim() ? `${displayNameOf(p)} (author slug ${p.slug})` : displayNameOf(p);
}

export function instructionsFor(token: AuthenticatedToken): string {
  const actor = person(token.user);
  const sameIssuer = token.issuer.id === token.user.id;
  const issuer = sameIssuer ? "the same account" : person(token.issuer);
  const writes = token.scopes.includes("WRITE");
  const lines = [
    `MultiBlog: a research archive of docs, PDFs, annotations (notes on passages), anchored links, tags, posts and comments. You act as ${actor}, on a token issued by ${issuer}.`,
    "Search it before researching elsewhere, and cite what you find by its URL.",
    "Finding: `search` first. Pass exact=1 whenever the question is whether something exists — otherwise a typo is corrected and reported as corrected:true. A doc hit's passage is one `read` away, `around` a phrase from its snippet.",
    "Reading: `read` takes any MultiBlog URL. A long doc answers with its outline; read the sections you need. Reads in one turn run in parallel. For a sweep over many docs, take the export or its catalog through `download_url` and curl, and Grep locally.",
  ];
  if (writes) {
    lines.push(
      `Writing: new docs and files are PRIVATE, with ${sameIssuer ? "you" : "you first and the issuer second"} on the byline${sameIssuer ? "" : ", or the issuer alone when they ask"}. A summary doc opens with the prompt quoted. Link a whole doc as /doc/<slug>, a section with a minted link (create_link), a PDF passage with a fragment link /pdf/<slug>#page=N&text=start,end — fragment links are checked when written.`,
      "Anchoring: a section by its heading's text, a claim by its sentence, a long passage by its first and last words (start, end). Quote from a `text` read and send its `version`.",
      "Reuse an existing link (read with include:[\"links\"]) before minting another.",
      "already_done means the write happened already; to do it again on purpose, pass a new idempotencyKey.",
      "Files and Markdown drafts go up through `upload_url` and curl --data-binary; nothing in a shell needs the token.",
    );
  }
  return lines.join("\n");
}
