import type { JSONContent } from "@tiptap/core";
import { prisma } from "./prisma";
import { stripMarksFromDoc } from "./tiptap-schema";

export const FRONT_PAGE_DOC_TITLE = "FRONT PAGE";

// The landing page's preamble (PLAN.md §17c) — the body of the doc titled
// FRONT PAGE, with no visibility check. §12e defines DocVisibility.SHARED as
// "anyone with canViewDocs", a role gate, not "the public" — requiring it
// here would attach a meaning to that enum value it doesn't have. The title
// is the only switch, stated once, here.
//
// First-created wins (orderBy createdAt asc): Doc.title has no unique
// constraint, so a second doc titled FRONT PAGE is made inert rather than
// letting the front page flip between two preambles depending on which row
// Postgres happens to return.
//
// Only proseJson is selected — that's what makes "never show the title"
// structural rather than a rule to remember, since the title is never read.
export async function getFrontPagePreamble(): Promise<JSONContent | null> {
  const doc = await prisma.doc.findFirst({
    where: { title: { equals: FRONT_PAGE_DOC_TITLE, mode: "insensitive" } },
    orderBy: { createdAt: "asc" },
    select: { proseJson: true },
  });

  // proseJson is null for a doc created but never edited (the store
  // debounce hasn't fired yet) — omit the preamble rather than pay a ydoc
  // decode on a statically-generated page for a state that resolves itself
  // the moment anyone types a character.
  if (!doc?.proseJson) {
    return null;
  }

  // Same strip postContentFromYdoc applies before a post snapshot (§15b):
  // a doc's prose can carry authorHighlight/annotation marks the public
  // renderer's contentExtensions doesn't know, and rendering them unstripped
  // would 500 this page.
  return stripMarksFromDoc(doc.proseJson as JSONContent, ["authorHighlight", "annotation"]);
}
