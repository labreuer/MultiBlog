import type { JSONContent } from "@tiptap/core";
import type { Actor } from "@/lib/actor";
import { canUserAccessAnnotationYdoc } from "@/lib/annotation-authz";
import { canUserReadDoc } from "@/lib/doc-authz";
import { prisma } from "@/lib/prisma";
import { loadChipContext } from "./context";
import { MENTION } from "./kinds/mention";
import { mentionableAmong } from "./kinds/mention-rule";
import { chipsInJSON, chipTargets } from "./renderings";
import { DEFAULT_CHIP_STYLES, type ChipInputs, type ChipOccurrence } from "./types";

// docs/ENTITY_CHIPS.md, step 1, item 5 — the chip context for one object, as
// one viewer may have it. Behind `GET /api/chip-context`, and behind a page's
// first paint, which passes the same answer as props. Server-only.

/** The object whose chips are being rendered: a doc, or an annotation's body. */
export type ChipTarget = { doc: string } | { annotation: string };

/**
 * The inputs for a body already loaded and already gated by its page: the
 * styles, and the context for exactly the chips the body holds.
 */
export async function chipInputsForBody(body: JSONContent | null | undefined): Promise<ChipInputs> {
  const chips = body ? chipsInJSON(body) : [];
  return { styles: DEFAULT_CHIP_STYLES, context: chips.length > 0 ? await loadChipContext(chips) : {} };
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
  let body: JSONContent | null;
  let docId: string | null;

  if ("doc" in target) {
    const doc = await prisma.doc.findUnique({
      where: { id: target.doc },
      select: { id: true, visibility: true, proseJson: true },
    });
    if (!doc || !(await canUserReadDoc(actor.userId, actor.role, doc))) return null;
    body = doc.proseJson as JSONContent | null;
    docId = doc.id;
  } else {
    const annotation = await prisma.annotation.findUnique({
      where: { id: target.annotation },
      select: {
        userId: true,
        status: true,
        proseJson: true,
        docId: true,
        doc: { select: { id: true, visibility: true } },
        file: { select: { id: true, visibility: true } },
      },
    });
    if (!annotation || !(await canUserAccessAnnotationYdoc(actor.userId, actor.role, annotation))) return null;
    body = annotation.proseJson as JSONContent | null;
    docId = annotation.docId;
  }

  const held = body ? chipTargets(chipsInJSON(body)) : {};
  const allowed: Record<string, Set<string>> = {};
  for (const [kind, ids] of Object.entries(held)) allowed[kind] = new Set(ids);

  // Each chip kind's insertion rule, for what was asked beyond the body's own.
  const askedMentions = (asked[MENTION] ?? []).filter((id) => !allowed[MENTION]?.has(id));
  for (const id of await mentionableAmong(actor, docId, askedMentions)) {
    (allowed[MENTION] ??= new Set()).add(id);
  }

  const occurrences: ChipOccurrence[] = [];
  for (const [kind, ids] of Object.entries(allowed)) {
    // One synthetic chip per target is all a loader reads: the kind and the id.
    if (kind === MENTION) for (const id of ids) occurrences.push({ kind, iid: "", pos: 0, data: { userId: id } });
  }
  return { styles: DEFAULT_CHIP_STYLES, context: await loadChipContext(occurrences) };
}
