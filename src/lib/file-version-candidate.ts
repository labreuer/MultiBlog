import type { JSONContent } from "@tiptap/core";
import type { Actor } from "@/lib/actor";
import { readableAnnotationsWhere } from "@/lib/annotation-authz";
import { publicCommentsWhere } from "@/lib/comment-authz";
import { readableDocsWhere } from "@/lib/doc-authz";
import { CITATION } from "@/lib/entity-chips/kinds/citation";
import { chipsInJSON } from "@/lib/entity-chips/renderings";
import { linkHrefsIn } from "@/lib/pdf-fragment-findings";
import { pdfMetadata } from "@/lib/pdf-metadata";
import { usablePageLabels } from "@/lib/pdf-page-labels";
import { readablePostWhere } from "@/lib/post-status";
import { prisma } from "@/lib/prisma";
import { parseReferenceSegment } from "@/lib/references/keys";

// docs/PDF.md §13, "The upload" — what a candidate's page tells whoever may
// manage the file, beside the banner every reader gets: what a promotion
// would do to the citations of the file.
//
// **A citation's page is a printed page, read on the latest version's labels
// at every click, and on a version without usable labels as that version's
// sheet number** (§13, "Links into the file"). So a version without labels
// that moves the sheets misdirects every citation that names a page and no
// passage, with nothing to say so. No page map carries them: the map carries
// a sheet exactly, and a locator read as a sheet for want of labels is a
// guess. Labels on the new version are what fix it, and a scan from a
// pipeline that can write `/PageLabels` is better given them before it is
// uploaded.
//
// Nothing here is stored: it is worked out when the candidate's page is
// opened by a manager. Server-only.

export type CandidateFacts = {
  /** The candidate has no usable page labels: every citation of the file will take its page as one of the candidate's sheet numbers. */
  unlabelled: boolean;
  /**
   * How many citations name a page of this file, in the bodies this manager
   * may read, where either the candidate or the latest version has no usable
   * labels: the ones a promotion can misdirect. Null where both have them,
   * and a printed page is the same page in each.
   */
  pagedCitations: number | null;
};

async function usableLabelsOf(version: { id: string; pageCount: number | null }): Promise<boolean> {
  if (version.pageCount === null) return false;
  const metadata = await pdfMetadata(version.id);
  return metadata !== null && usablePageLabels(metadata.pageLabels, version.pageCount) !== null;
}

/** The citation chips in a body that cite one of `referenceIds` at a page. */
function pagedChips(json: unknown, referenceIds: ReadonlySet<string>): number {
  if (!json || typeof json !== "object") return 0;
  let count = 0;
  for (const chip of chipsInJSON(json as JSONContent)) {
    if (chip.kind !== CITATION || !Array.isArray(chip.data.items)) continue;
    for (const item of chip.data.items as { refId?: unknown; locator?: unknown }[]) {
      if (typeof item?.refId === "string" && referenceIds.has(item.refId) && typeof item.locator === "string" && item.locator !== "") count++;
    }
  }
  return count;
}

/** A post's frozen links to a page of one of the works: `/references/<key>/p/<page>`, which is what its doc's citations became at publish. */
function pagedLinks(json: unknown, keys: ReadonlySet<string>): number {
  let count = 0;
  for (const href of linkHrefsIn(json)) {
    const match = /^\/references\/([^/?#]+)\/p\/[^/?#]+/.exec(href);
    if (!match) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    const parsed = parseReferenceSegment(segment);
    if (parsed && parsed.kind !== "list" && keys.has(parsed.key.toLowerCase())) count++;
  }
  return count;
}

/**
 * How many citations of the works this file is the PDF of name a page, in
 * the docs, notes, comments and posts `actor` may read. Each kind goes
 * through its own read rule, as search's do, and the citing bodies are found
 * by the trigger-kept `citation` table, so only they are read.
 */
async function countPagedCitations(actor: Actor, fileId: string): Promise<number> {
  const references = await prisma.reference.findMany({ where: { fileId }, select: { id: true, keyFolded: true } });
  if (references.length === 0) return 0;
  const ids = new Set(references.map((reference) => reference.id));
  const keys = new Set(references.map((reference) => reference.keyFolded));
  const cites = { citations: { some: { referenceId: { in: [...ids] } } } };
  const docsWhere = readableDocsWhere(actor.userId, actor.role);
  const notesWhere = readableAnnotationsWhere(actor.userId, actor.role);
  const [docs, notes, comments, posts] = await Promise.all([
    docsWhere ? prisma.doc.findMany({ where: { AND: [docsWhere, cites] }, select: { proseJson: true } }) : [],
    notesWhere ? prisma.annotation.findMany({ where: { AND: [notesWhere, cites] }, select: { proseJson: true } }) : [],
    prisma.comment.findMany({ where: { AND: [publicCommentsWhere(), cites] }, select: { body: true } }),
    prisma.post.findMany({ where: { AND: [readablePostWhere(actor.userId, actor.role), cites] }, select: { proseJson: true } }),
  ]);
  return (
    docs.reduce((sum, doc) => sum + pagedChips(doc.proseJson, ids), 0) +
    notes.reduce((sum, note) => sum + pagedChips(note.proseJson, ids), 0) +
    comments.reduce((sum, comment) => sum + pagedChips(comment.body, ids), 0) +
    posts.reduce((sum, post) => sum + pagedLinks(post.proseJson, keys), 0)
  );
}

/** What a promotion of `candidate` over `latest` would do to the citations of the file, for a manager's eyes. */
export async function candidateFactsFor(
  actor: Actor,
  fileId: string,
  candidate: { id: string; pageCount: number | null },
  latest: { id: string; pageCount: number | null },
): Promise<CandidateFacts> {
  const [candidateLabelled, latestLabelled] = await Promise.all([usableLabelsOf(candidate), usableLabelsOf(latest)]);
  return {
    unlabelled: !candidateLabelled,
    pagedCitations: candidateLabelled && latestLabelled ? null : await countPagedCitations(actor, fileId),
  };
}
