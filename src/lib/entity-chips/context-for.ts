import type { JSONContent } from "@tiptap/core";
import type { Actor } from "@/lib/actor";
import { canUserAccessAnnotationYdoc } from "@/lib/annotation-authz";
import { canUserReadDoc } from "@/lib/doc-authz";
import { prisma } from "@/lib/prisma";
import { loadChipContext } from "./context";
import { CITATION } from "./kinds/citation";
import { MENTION } from "./kinds/mention";
import { mentionableAmong } from "./kinds/mention-rule";
import { chipsInJSON, chipTargets } from "./renderings";
import { parseChipStyles } from "./settings";
import { DEFAULT_CHIP_STYLES, type ChipInputs, type ChipOccurrence, type ChipStyles } from "./types";

// docs/ENTITY_CHIPS.md, step 1, item 5 — the chip context for one object, as
// one viewer may have it. Behind `GET /api/chip-context`, and behind a page's
// first paint, which passes the same answer as props. Server-only.

/** The object whose chips are being rendered: a doc, or an annotation's body. */
export type ChipTarget = { doc: string } | { annotation: string };

/** A chip target `actor` may read: its stored body, and what it is on. */
export type ResolvedChipTarget = {
  body: JSONContent | null;
  /** The styles the body's chips are shown in: a doc's own; none for a note, whose body has no style of its own. */
  styles: ChipStyles;
  /** The doc itself, or the doc an annotation is on. Null for a note on a PDF. */
  doc: { id: string; visibility: "PRIVATE" | "SHARED" } | null;
  /** The file a note on a PDF is on. Null for a doc and for a note on one. */
  file: { id: string; visibility: "PRIVATE" | "SHARED" } | null;
};

/**
 * `target` under its own read rule, or null when it doesn't exist or `actor`
 * may not read it. The one gate for everything that answers about a chip
 * target: the context endpoint, and each chip kind's menu search.
 */
export async function resolveChipTarget(actor: Actor, target: ChipTarget): Promise<ResolvedChipTarget | null> {
  if ("doc" in target) {
    const doc = await prisma.doc.findUnique({
      where: { id: target.doc },
      select: { id: true, visibility: true, proseJson: true, chipStyles: true },
    });
    if (!doc || !(await canUserReadDoc(actor.userId, actor.role, doc))) return null;
    return {
      body: doc.proseJson as JSONContent | null,
      styles: parseChipStyles(doc.chipStyles),
      doc: { id: doc.id, visibility: doc.visibility },
      file: null,
    };
  }
  const annotation = await prisma.annotation.findUnique({
    where: { id: target.annotation },
    select: {
      userId: true,
      status: true,
      proseJson: true,
      doc: { select: { id: true, visibility: true } },
      file: { select: { id: true, visibility: true } },
    },
  });
  if (!annotation || !(await canUserAccessAnnotationYdoc(actor.userId, actor.role, annotation))) return null;
  return { body: annotation.proseJson as JSONContent | null, styles: DEFAULT_CHIP_STYLES, doc: annotation.doc, file: annotation.file };
}

/**
 * The inputs for `target` as `actor` may have them, or null when the actor
 * may not read it.
 *
 * It answers for the ids the object's stored body holds, and, of `asked`, for
 * those each chip kind's insertion rule lets this actor see anyway. So a chip
 * a collaborator has just inserted resolves before the next store writes it
 * into the body, and the endpoint can't be used to look up any other record.
 */
export async function chipInputsFor(
  actor: Actor,
  target: ChipTarget,
  asked: Record<string, readonly string[]>,
): Promise<ChipInputs | null> {
  const resolved = await resolveChipTarget(actor, target);
  if (!resolved) return null;
  const { body } = resolved;
  const docId = resolved.doc?.id ?? null;

  const held = body ? chipTargets(chipsInJSON(body)) : {};
  const allowed: Record<string, Set<string>> = {};
  for (const [kind, ids] of Object.entries(held)) allowed[kind] = new Set(ids);

  // Each chip kind's insertion rule, for what was asked beyond the body's own.
  const askedMentions = (asked[MENTION] ?? []).filter((id) => !allowed[MENTION]?.has(id));
  for (const id of await mentionableAmong(actor, docId, askedMentions)) {
    (allowed[MENTION] ??= new Set()).add(id);
  }

  // A reference's record is public (docs/CITATIONS.md, "Pages"), so anything
  // asked about a citation's works may be answered.
  for (const id of asked[CITATION] ?? []) (allowed[CITATION] ??= new Set()).add(id);

  const occurrences: ChipOccurrence[] = [];
  for (const [kind, ids] of Object.entries(allowed)) {
    // One synthetic chip per target is all a loader reads: the kind and the id.
    if (kind === MENTION) for (const id of ids) occurrences.push({ kind, iid: "", pos: 0, data: { userId: id } });
    if (kind === CITATION) for (const id of ids) occurrences.push({ kind, iid: "", pos: 0, data: { items: [{ refId: id }] } });
  }
  return { styles: resolved.styles, context: await loadChipContext(occurrences) };
}
