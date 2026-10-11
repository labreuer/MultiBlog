import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { canUserReadDoc } from "@/lib/doc-authz";
import { canUserReadFile } from "@/lib/file-authz";
import { canUserDeleteAnchoredLink, canUserRenameAnchoredLink } from "@/lib/anchored-link-authz";
import { normalizeLinkName } from "@/lib/anchored-link-name";
import { LAST_PART_MESSAGE } from "@/lib/anchored-link-editing";
import type { AnchorTarget, DocRangeSelector } from "@/lib/anchors";
import { targetToColumns } from "@/lib/anchors";
import type { PdfTarget } from "@/lib/pdf-anchor";
import { ApiError, forbidden } from "@/lib/api/errors";
import type { Actor } from "@/lib/actor";

// docs/ANCHORED_LINKS.md, docs/MCP.md §10 — the writes on anchored links
// that take an explicit actor, so the tray's actions (src/app/actions/
// anchored-links.ts) and the MCP server's link tools share one body for
// each: the target gate, a part's row, removing and reordering parts,
// renaming, and the soft delete.
//
// Two front doors, two shapes of answer: the tray's part edits report a
// refusal as `{ error }` for the tray to show, so those bodies return one;
// everything else throws an ApiError, whose message reads the same in
// either.

/** The interactive-transaction client of the extended `prisma`, as the integrity scripts spell it. */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** One part's row, before it belongs to a link. */
export type LinkPartRow = Omit<Prisma.AnchoredLinkAnchorCreateManyInput, "linkId" | "partOrder">;

/**
 * The read gate, per target kind — an id naming nothing fails as "you may
 * not link this", which is the right answer and reveals nothing about what
 * exists. Doc/file reads are soft-delete-filtered by the prisma $extends.
 * Posts, annotations and comments are refused: the arc columns exist, and
 * nothing writes them yet.
 */
export async function canUserLinkTarget(actor: Actor, target: AnchorTarget): Promise<boolean> {
  if (target.kind === "doc") {
    const doc = await prisma.doc.findUnique({ where: { id: target.id }, select: { id: true, visibility: true } });
    return !!doc && (await canUserReadDoc(actor.userId, actor.role, doc));
  }
  if (target.kind === "file") {
    const file = await prisma.storedFile.findUnique({ where: { id: target.id }, select: { id: true, visibility: true } });
    return !!file && (await canUserReadFile(actor.userId, actor.role, file));
  }
  return false;
}

/** A doc part's row: offsets, quote and selector as captured, stamped with the version they were measured at. */
export function docRangePartRow(
  docId: string,
  captured: { from: number; to: number; quotedText: string; selector: DocRangeSelector },
  stamp: bigint,
): LinkPartRow {
  return {
    ...targetToColumns({ kind: "doc", id: docId }),
    selectorKind: "DOC_RANGE",
    anchorFrom: captured.from,
    anchorTo: captured.to,
    quotedText: captured.quotedText,
    selector: captured.selector as unknown as Prisma.InputJsonValue,
    ydocUpdateId: stamp,
  };
}

/**
 * A PDF part's row. The blob is the anchor (quads are correct forever);
 * offsets and stamp stay null — the shape check-tag-constraints names as
 * intended.
 */
export function pdfPartRow(fileId: string, captured: { target: PdfTarget; quotedText: string }): LinkPartRow {
  return {
    ...targetToColumns({ kind: "file", id: fileId }),
    selectorKind: "PDF_TEXT",
    selector: captured.target as unknown as Prisma.InputJsonValue,
    quotedText: captured.quotedText,
  };
}

/** A change to a *minted* link's parts is an edit; a draft's changes are not. */
export async function stampLinkEdited(tx: Tx, linkId: string): Promise<void> {
  await tx.anchoredLink.update({ where: { id: linkId }, data: { editedAt: new Date() } });
}

/**
 * Removes parts from a link — hard delete, no renumbering (an anchor is a
 * part of a record, not a record). On a minted link the last part stays: a
 * shared URL that resolves to nothing is what a delete is for. Count then
 * delete, so the caller holds the link row (`FOR UPDATE`): two tabs removing
 * the last two parts at once would each count two otherwise.
 */
export async function removeLinkPartsIn(
  tx: Tx,
  link: { id: string; mintedAt: Date | null },
  anchorIds: readonly string[],
): Promise<{ error?: string }> {
  if (link.mintedAt) {
    const count = await tx.anchoredLinkAnchor.count({ where: { linkId: link.id } });
    if (count - anchorIds.length < 1) return { error: LAST_PART_MESSAGE };
    await stampLinkEdited(tx, link.id);
  }
  await tx.anchoredLinkAnchor.deleteMany({ where: { linkId: link.id, id: { in: [...anchorIds] } } });
  return {};
}

/**
 * Rewrites a link's part order: its anchor ids in their new order,
 * renumbered 0..n-1. The set has to be exactly the link's current anchors,
 * so a caller that has fallen behind (a part added elsewhere) is told to
 * look again rather than silently dropping that part to the end.
 */
export async function reorderLinkPartsIn(
  tx: Tx,
  link: { id: string; mintedAt: Date | null },
  anchorIds: readonly string[],
): Promise<{ error?: string }> {
  const current = new Set((await tx.anchoredLinkAnchor.findMany({ where: { linkId: link.id }, select: { id: true } })).map((a) => a.id));
  const proposed = new Set(anchorIds);
  if (proposed.size !== anchorIds.length || proposed.size !== current.size || anchorIds.some((id) => !current.has(id))) {
    return { error: "The link's passages changed — reloaded; try again." };
  }
  for (const [index, id] of anchorIds.entries()) {
    await tx.anchoredLinkAnchor.update({ where: { id }, data: { partOrder: index } });
  }
  if (link.mintedAt) await stampLinkEdited(tx, link.id);
  return {};
}

/**
 * Names, renames or un-names a link (docs/ANCHORED_LINKS.md, "Naming a
 * link"): `canUserRenameAnchoredLink` — the creator at any stage, a
 * moderator once the link is minted, nobody on a deleted row. What is stored
 * is the normalised name or null; a rename of a minted link stamps
 * `edited_at`, and an unchanged name stamps nothing.
 */
export async function renameLink(actor: Actor, linkId: string, nameInput: string): Promise<void> {
  const link = await prisma.anchoredLink.findUnique({
    where: { id: linkId },
    select: { createdById: true, mintedAt: true, deletedAt: true, name: true },
  });
  if (!link || !canUserRenameAnchoredLink(actor.userId, actor.role, link)) {
    // A deleted row the actor could otherwise rename gets the one remedy
    // that is theirs to apply.
    const restorable = !!link?.deletedAt && canUserRenameAnchoredLink(actor.userId, actor.role, { ...link, deletedAt: null });
    throw forbidden(restorable ? "Restore the link before renaming it." : "You can't rename this link.");
  }
  const name = normalizeLinkName(nameInput);
  if (name === link.name) return;
  await prisma.anchoredLink.update({
    where: { id: linkId },
    data: { name, ...(link.mintedAt ? { editedAt: new Date() } : {}) },
  });
}

/**
 * The soft delete and its undo (docs/ANCHORED_LINKS.md, "The management
 * table"): the creator or ADMIN/EDITOR, never a draft. The anchors stay put;
 * `anchoredLinkForViewer` reads `deletedAt`, so following a deleted link
 * 404s until it is restored. Deleting also closes an edit in progress: the
 * one-open index ignores deleted rows, so a restore of a still-reopened link
 * could otherwise collide with whatever the creator opened since.
 */
export async function setLinkDeleted(actor: Actor, linkId: string, deleted: boolean): Promise<void> {
  const link = await prisma.anchoredLink.findUnique({ where: { id: linkId }, select: { createdById: true, mintedAt: true } });
  if (!link) throw new ApiError("not_found", "Link not found.");
  if (!canUserDeleteAnchoredLink(actor.userId, actor.role, link)) {
    throw forbidden(
      link.mintedAt === null ? "A draft link is discarded from its tray, not deleted here." : "You don't have permission to delete this link.",
    );
  }
  await prisma.anchoredLink.update({
    where: { id: linkId },
    data: deleted
      ? { deletedByUserId: actor.userId, deletedAt: new Date(), reopenedAt: null }
      : { deletedByUserId: null, deletedAt: null },
  });
}
