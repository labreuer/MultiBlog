"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { canUserReadDoc } from "@/lib/doc-authz";
import { canUserReadFile } from "@/lib/file-authz";
import { canUserDeleteAnchoredLink, canUserRenameAnchoredLink } from "@/lib/anchored-link-authz";
import { normalizeLinkName } from "@/lib/anchored-link-name";
import { DRAFT_BLOCKS_EDIT_MESSAGE, LAST_PART_MESSAGE } from "@/lib/anchored-link-editing";
import { appUrl } from "@/lib/app-url";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";
import {
  parseAnchorTargetKind,
  parseSelector,
  targetFromColumns,
  targetToColumns,
  type AnchorSelector,
  type AnchorTarget,
} from "@/lib/anchors";
import { captureAnchorInYdoc, capturePdfTextAnchor } from "@/lib/anchors/capture";
import { docContentExtensions, pmDocContentSchema } from "@/lib/tiptap-schema";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { resolveUpdateIdForSnapshot } from "@/lib/ydoc-version";
import { ydocStore } from "../../../server/ydoc-store";

// docs/ANCHORED_LINKS.md — mutations on **the viewer's one open link** (a
// draft, or a minted link reopened for editing), the mint that turns a
// draft into a shareable URL, the open/close pair that puts a minted link
// back in the tray, the rename both the tray and /links share, and (at the
// bottom) the /links table's soft delete. The
// tag-actions shape (src/app/actions/tags.ts on the part-anchors branch)
// with one owner row per act; what differs is that the act accumulates
// across pages — each "Add to link" posts its part immediately, captured
// and verified against its own version stamp at that instant, so no
// client-side part bank exists and the server row *is* the cross-page
// persistence.
//
// **Edits to a minted link are live.** Its URL is out and stays out: every
// add, remove and reorder lands on the row recipients are following, and
// nothing here stages a copy to swap in later. The two rules that keep that
// honest are that only the creator may reopen a link, and that a minted
// link never drops to zero parts (`removeAnchoredLinkPart`).
//
// **No revalidatePath anywhere in this file, deliberately** (contrast
// untagObject): both reading routes are per-request dynamic — nothing is
// cached to invalidate — and the tray self-fetches on its own notify
// events, so a revalidation would only force full-page work to update a
// fixed-position island that already knows how to update itself. The same
// holds for /links below: it reads the session and is dynamic, and its table
// calls router.refresh() after every action, as the kit's tables do.
//
// **Create-permission is read-the-target** — the annotate precedent, not
// the tag one: no role floor beyond being signed in, because pointing at a
// passage claims nothing about it. `post`/`annotation` targets are rejected
// as deferred (the arc columns exist; the writer refuses).

/** One selection, as the client names it. The target's kind picks the shape. */
export type AnchoredLinkPartInput =
  | { kind: "doc-range"; from: number; to: number; quotedText: string }
  | { kind: "pdf-text"; target: unknown };

export type OpenLinkPart = {
  anchorId: string;
  /** The target's title — "(no longer available)" if it vanished since the add. */
  label: string;
  quotedText: string;
  /**
   * Which object the part points into, so a surface can filter the open
   * link to its own passages and paint them (docs/ANCHORED_LINKS.md,
   * "Painting the open link"). Null only for a malformed arc, which the
   * CHECK makes unreachable.
   */
  target: AnchorTarget | null;
  /** DOC_RANGE offsets; null on a PDF_TEXT part, whose quads live in `selector`. */
  from: number | null;
  to: number | null;
  selector: AnchorSelector | null;
};

export type OpenLinkView = {
  id: string;
  /**
   * False for a draft. True means a minted link reopened for editing: its
   * URL is out, and every change the tray makes is live for whoever holds it.
   */
  minted: boolean;
  /** The share URL of a minted link, so the tray's Copy link copies without minting. Null for a draft. */
  url: string | null;
  /** The creator-given name, or null (docs/ANCHORED_LINKS.md, "Naming a link") — the tray's name field edits it. */
  name: string | null;
  parts: OpenLinkPart[];
};

async function requireSignedIn() {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  return session;
}

/**
 * "The viewer's open link" as a `where`: unminted (a draft), or minted and
 * reopened. The partial unique index `anchored_link_one_open_per_user` is
 * over exactly this predicate, which is what lets every findFirst below be
 * a definite article.
 */
function openLinkWhere(userId: string): Prisma.AnchoredLinkWhereInput {
  return { createdById: userId, deletedAt: null, OR: [{ mintedAt: null }, { reopenedAt: { not: null } }] };
}

/**
 * The read gate, per target kind — an id naming nothing fails as "you may
 * not link this", which is the right answer and reveals nothing about what
 * exists. Doc/file reads are soft-delete-filtered by the prisma $extends.
 */
async function canUserLinkTarget(userId: string, role: Parameters<typeof canUserReadDoc>[1], target: AnchorTarget): Promise<boolean> {
  if (target.kind === "doc") {
    const doc = await prisma.doc.findUnique({
      where: { id: target.id },
      select: { id: true, visibility: true },
    });
    return !!doc && (await canUserReadDoc(userId, role, doc));
  }
  if (target.kind === "file") {
    const file = await prisma.storedFile.findUnique({
      where: { id: target.id },
      select: { id: true, visibility: true },
    });
    return !!file && (await canUserReadFile(userId, role, file));
  }
  return false;
}

/**
 * The viewer's open link, created as a draft on first use. The partial
 * unique index `anchored_link_one_open_per_user` is what makes this a
 * definite article: two tabs racing the create can't leave two drafts — the
 * loser's insert dies with P2002 and re-finds the winner's row.
 */
async function getOrCreateOpenLink(userId: string): Promise<{ id: string; mintedAt: Date | null }> {
  const select = { id: true, mintedAt: true } as const;
  const existing = await prisma.anchoredLink.findFirst({ where: openLinkWhere(userId), select });
  if (existing) return existing;
  try {
    return await prisma.anchoredLink.create({ data: { createdById: userId }, select });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.anchoredLink.findFirst({ where: openLinkWhere(userId), select });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * The coordinate system a doc part's offsets are about to be expressed in
 * (§20b: the stamp and the target live on the same row). The client's own
 * version wins when it sent one — it names what the linker was looking at —
 * with the log's tail as the fallback, exactly `postAnnotation`'s §13q
 * order. A failure to resolve the client's version degrades to the tail
 * rather than failing the add: `captureAnchorInYdoc` re-derives against
 * whatever is stamped, so the row stays self-consistent either way.
 *
 * Duplicated from the part-anchors branch's tags.ts on purpose
 * (docs/ANCHORED_LINKS.md Increment 0) — unify the two if that branch lands.
 */
async function resolveCaptureStamp(ydocId: string, atVersion: string | undefined): Promise<bigint | null> {
  if (atVersion) {
    try {
      const resolved = await resolveUpdateIdForSnapshot(ydocId, Buffer.from(atVersion, "base64"));
      return resolved.updateId;
    } catch (err) {
      console.error(`[anchored-links] couldn't resolve the client's version for ${ydocId}:`, err);
    }
  }
  return ydocStore.maxUpdateId(ydocId);
}

/**
 * The viewer's open link — the tray's list *and* what each reading surface
 * paints its own in-progress passages from. One read for both: the two
 * consumers share a client-side store (`open-link-store.ts`), so a second
 * query would be a second round trip for the same row.
 *
 * BigInt-free for the same reason `anchoredLinkForViewer` is: this crosses
 * into client props, and `ydocUpdateId` would throw in serialization long
 * after this function looked done.
 */
export async function loadMyOpenLink(): Promise<OpenLinkView | null> {
  const session = await requireSignedIn();

  const link = await prisma.anchoredLink.findFirst({
    where: openLinkWhere(session.user.id),
    select: {
      id: true,
      mintedAt: true,
      name: true,
      anchors: {
        orderBy: [{ partOrder: "asc" }, { id: "asc" }],
        select: {
          id: true,
          docId: true,
          postId: true,
          fileId: true,
          targetAnnotationId: true,
          quotedText: true,
          anchorFrom: true,
          anchorTo: true,
          selectorKind: true,
          selector: true,
        },
      },
    },
  });
  if (!link) return null;

  const docIds = [...new Set(link.anchors.map((a) => a.docId).filter((id) => id !== null))];
  const fileIds = [...new Set(link.anchors.map((a) => a.fileId).filter((id) => id !== null))];
  const [docs, files] = await Promise.all([
    docIds.length > 0
      ? prisma.doc.findMany({ where: { id: { in: docIds } }, select: { id: true, title: true } })
      : [],
    fileIds.length > 0
      ? prisma.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, title: true } })
      : [],
  ]);
  const titles = new Map([...docs, ...files].map((row) => [row.id, row.title]));

  return {
    id: link.id,
    minted: link.mintedAt !== null,
    url: link.mintedAt ? appUrl(`/link/${link.id}`) : null,
    name: link.name,
    parts: link.anchors.map((anchor) => ({
      anchorId: anchor.id,
      label: titles.get(anchor.docId ?? anchor.fileId ?? "") ?? "(no longer available)",
      quotedText: anchor.quotedText,
      target: targetFromColumns(anchor),
      from: anchor.anchorFrom,
      to: anchor.anchorTo,
      // Never a cast — a blob this server wrote is parsed on the way back out
      // exactly as `anchoredLinkForViewer` parses one. An unparseable selector
      // degrades to null: the part still lists in the tray, painted nowhere.
      selector: parseSelector(anchor.selectorKind, anchor.selector),
    })),
  };
}

/**
 * Adds one selection to the viewer's open link, captured and verified
 * *now*, against its own stamp — §12i's trust rule: what lands in
 * `quoted_text` is this server's reading of the stamped state, never the
 * client's. A part the state cannot confirm is not stored — never silently,
 * and never degraded to a whole-object link (`tagObject`'s stance: a link
 * part IS the content, and a link to "the whole doc" is what an ordinary
 * href already is).
 */
export async function addAnchoredLinkPart(
  targetKind: string,
  targetId: string,
  part: AnchoredLinkPartInput,
  /** PLAN.md §13q — the document version the range was measured against, base64; doc targets only. */
  atVersion?: string,
): Promise<{ error?: string }> {
  const session = await requireSignedIn();

  const kind = parseAnchorTargetKind(targetKind);
  if (!kind || typeof targetId !== "string" || targetId === "") {
    throw new Error("Malformed link target.");
  }
  if (kind === "post" || kind === "annotation") {
    throw new Error("Only doc and PDF passages can be linked for now.");
  }
  const target: AnchorTarget = { kind, id: targetId };
  const expectedShape = kind === "file" ? "pdf-text" : "doc-range";
  if (part.kind !== expectedShape) {
    throw new Error("Malformed part for this target.");
  }

  if (!(await canUserLinkTarget(session.user.id, session.user.role, target))) {
    throw new Error("You don't have permission to link this.");
  }

  const columns = targetToColumns(target);
  let row: Omit<Prisma.AnchoredLinkAnchorCreateManyInput, "linkId">;

  if (part.kind === "pdf-text") {
    const captured = await capturePdfTextAnchor({ fileId: target.id, rawTarget: part.target });
    if (!captured) {
      return { error: "That selection couldn't be anchored." };
    }
    row = {
      ...columns,
      selectorKind: "PDF_TEXT",
      // The blob is the anchor (§19: quads are correct forever); offsets and
      // stamp stay null — the KNOWN_RESIDUALS shape check-tag-constraints
      // names as intended.
      selector: captured.target as unknown as Prisma.InputJsonValue,
      quotedText: captured.quotedText,
    };
  } else {
    const ydocId = ydocIdForDoc(target.id);
    const stamp = await resolveCaptureStamp(ydocId, atVersion);
    if (stamp === null) {
      // No update log at all — a doc whose ydoc was never seeded. Nothing
      // can verify a range into it.
      return { error: "This document can't be linked to yet." };
    }
    const captured = await captureAnchorInYdoc({
      ydocId,
      throughUpdateId: stamp,
      extensions: docContentExtensions,
      schema: pmDocContentSchema,
      from: part.from,
      to: part.to,
      quotedText: part.quotedText,
    });
    if (!captured) {
      return { error: "The selected passage couldn't be anchored — the document may have changed under the selection." };
    }
    row = {
      ...columns,
      selectorKind: "DOC_RANGE",
      anchorFrom: captured.from,
      anchorTo: captured.to,
      quotedText: captured.quotedText,
      selector: captured.selector as unknown as Prisma.InputJsonValue,
      ydocUpdateId: stamp,
    };
  }

  const open = await getOrCreateOpenLink(session.user.id);
  await prisma.$transaction(async (tx) => {
    // partOrder = current count. Removals leave gaps and nothing renumbers;
    // readers order by [partOrder, id], which absorbs both gaps and the race
    // of two tabs adding at once (equal orders tie-broken by id).
    const partOrder = await tx.anchoredLinkAnchor.count({ where: { linkId: open.id } });
    await tx.anchoredLinkAnchor.create({ data: { ...row, linkId: open.id, partOrder } });
    if (open.mintedAt) await stampEdited(tx, open.id);
  });
  return {};
}

/** The interactive-transaction client, as the integrity scripts spell it. */
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** A change to a *minted* link's parts is an edit; a draft's changes are not. */
async function stampEdited(tx: Tx, linkId: string): Promise<void> {
  await tx.anchoredLink.update({ where: { id: linkId }, data: { editedAt: new Date() } });
}

/**
 * Removes one part of the viewer's open link — hard delete, no renumbering
 * (an anchor is a part of a record, not a record). On a minted link the
 * last part stays: a shared URL that resolves to nothing is what a delete
 * is for, and the landing route would otherwise render its "no passages"
 * page for a link that used to have one. That rule is count-then-delete,
 * so it runs in a transaction holding the link row — two tabs removing the
 * last two parts at once would each count two otherwise.
 */
export async function removeAnchoredLinkPart(anchorId: string): Promise<{ error?: string }> {
  const session = await requireSignedIn();
  if (typeof anchorId !== "string" || anchorId === "") {
    throw new Error("Malformed anchor id.");
  }

  return prisma.$transaction(async (tx) => {
    const anchor = await tx.anchoredLinkAnchor.findFirst({
      where: { id: anchorId, link: openLinkWhere(session.user.id) },
      select: { id: true, link: { select: { id: true, mintedAt: true } } },
    });
    if (!anchor) {
      return { error: "That passage is no longer in your open link." };
    }
    if (anchor.link.mintedAt) {
      await tx.$queryRaw`SELECT id FROM anchored_link WHERE id = ${anchor.link.id} FOR UPDATE`;
      const count = await tx.anchoredLinkAnchor.count({ where: { linkId: anchor.link.id } });
      if (count <= 1) {
        return { error: LAST_PART_MESSAGE };
      }
      await stampEdited(tx, anchor.link.id);
    }
    await tx.anchoredLinkAnchor.delete({ where: { id: anchorId } });
    return {};
  });
}

/**
 * Rewrites the open link's part order: the anchor ids in their new order,
 * renumbered 0..n-1. The set has to be exactly the link's current anchors —
 * a tray that has fallen behind another tab (a part added there) is told
 * to reload rather than silently dropping that part to the end. Groups on
 * the landing page and banner follow first-part order, so reordering
 * across targets reorders groups too.
 */
export async function reorderAnchoredLinkParts(anchorIds: string[]): Promise<{ error?: string }> {
  const session = await requireSignedIn();
  if (!Array.isArray(anchorIds) || anchorIds.some((id) => typeof id !== "string" || id === "")) {
    throw new Error("Malformed part order.");
  }

  return prisma.$transaction(async (tx) => {
    const link = await tx.anchoredLink.findFirst({
      where: openLinkWhere(session.user.id),
      select: { id: true, mintedAt: true, anchors: { select: { id: true } } },
    });
    if (!link) {
      return { error: "There's no open link to reorder." };
    }
    const current = new Set(link.anchors.map((a) => a.id));
    const proposed = new Set(anchorIds);
    if (proposed.size !== anchorIds.length || proposed.size !== current.size || anchorIds.some((id) => !current.has(id))) {
      return { error: "The link's passages changed — reloaded; try again." };
    }
    for (const [index, id] of anchorIds.entries()) {
      await tx.anchoredLinkAnchor.update({ where: { id }, data: { partOrder: index } });
    }
    if (link.mintedAt) await stampEdited(tx, link.id);
    return {};
  });
}

/** Throws away the viewer's draft — hard delete; the FK cascade takes its anchors. A reopened link is closed, never discarded. */
export async function discardDraftLink(): Promise<void> {
  const session = await requireSignedIn();
  await prisma.anchoredLink.deleteMany({
    where: { createdById: session.user.id, mintedAt: null, deletedAt: null },
  });
}

/**
 * Stamps the draft minted and hands back the URL to share: the landing
 * route, /link/[id], which decides *per viewer at follow time* where the
 * link goes (docs/ANCHORED_LINKS.md, "The landing route"). It used to be
 * part 0's own page, chosen here once for everyone — and a recipient who
 * could not read that target met its Forbidden with no way to the parts
 * they could read.
 */
export async function mintAnchoredLink(): Promise<{ url: string } | { error: string }> {
  const session = await requireSignedIn();

  const draft = await prisma.anchoredLink.findFirst({
    where: { createdById: session.user.id, mintedAt: null, deletedAt: null },
    select: {
      id: true,
      anchors: {
        orderBy: [{ partOrder: "asc" }, { id: "asc" }],
        select: { docId: true, fileId: true },
      },
    },
  });
  if (!draft) {
    return { error: "There's no draft link to copy." };
  }
  if (draft.anchors.length === 0) {
    return { error: "Add at least one passage first." };
  }

  // Minting still checks that some part's target exists, so a link that
  // would land nowhere is refused here rather than minted dead (the doc/file
  // lookups are soft-delete-filtered, so a deleted target counts as gone
  // even though its anchor row survives). Which target the *recipient* lands
  // on is no longer this function's question.
  let anyTargetExists = false;
  for (const anchor of draft.anchors) {
    if (anchor.docId !== null) {
      anyTargetExists =
        (await prisma.doc.findUnique({ where: { id: anchor.docId }, select: { id: true } })) !== null;
    } else if (anchor.fileId !== null) {
      anyTargetExists =
        (await prisma.storedFile.findUnique({ where: { id: anchor.fileId }, select: { id: true } })) !== null;
    }
    if (anyTargetExists) break;
  }
  if (!anyTargetExists) {
    return { error: "None of the linked passages still exist." };
  }

  await prisma.anchoredLink.update({
    where: { id: draft.id },
    data: { mintedAt: new Date() },
  });
  return { url: appUrl(`/link/${draft.id}`) };
}

// docs/ANCHORED_LINKS.md, "Editing a minted link" — the open/close pair.
// Reopening puts a minted link back in its creator's tray; nothing about
// the link changes for anyone following it, which is the point of editing
// in place rather than nulling `minted_at` (that would hide the URL from
// every recipient for the duration, make Discard a hard delete of a shared
// link, and lose the share date).

/**
 * Puts one of the viewer's own minted links in their tray. What was open
 * before decides the outcome: an empty draft is discarded (it is the row
 * removing a draft's last part leaves behind, with nothing in it to
 * finish); a draft with passages refuses, with the same sentence the Edit
 * button shows beside itself while disabled; another reopened link is
 * closed, its edits having been live. The partial unique index is the
 * backstop for the stale-tab race in between.
 */
export async function openAnchoredLinkForEditing(linkId: string): Promise<{ error?: string }> {
  const session = await requireSignedIn();
  if (typeof linkId !== "string" || linkId === "") {
    throw new Error("Malformed link id.");
  }
  const link = await prisma.anchoredLink.findFirst({
    where: { id: linkId, createdById: session.user.id, mintedAt: { not: null }, deletedAt: null },
    select: { id: true, reopenedAt: true },
  });
  // One refusal covers "not yours", "a draft", "deleted" and "no such id":
  // only the first two are reachable from a UI, and neither earns a hint
  // that names what the id points at.
  if (!link) {
    throw new Error("You can't edit this link.");
  }
  if (link.reopenedAt) return {};

  const open = await prisma.anchoredLink.findFirst({
    where: openLinkWhere(session.user.id),
    select: { id: true, mintedAt: true, _count: { select: { anchors: true } } },
  });
  if (open) {
    if (open.mintedAt === null) {
      if (open._count.anchors > 0) {
        return { error: DRAFT_BLOCKS_EDIT_MESSAGE };
      }
      await prisma.anchoredLink.delete({ where: { id: open.id } });
    } else {
      await prisma.anchoredLink.update({ where: { id: open.id }, data: { reopenedAt: null } });
    }
  }
  try {
    await prisma.anchoredLink.update({ where: { id: link.id }, data: { reopenedAt: new Date() } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: "Another link just opened in your tray — try again." };
    }
    throw err;
  }
  return {};
}

/** Done: takes the viewer's reopened link out of the tray. Its edits are already live, so there is nothing to commit. */
export async function closeAnchoredLinkEdit(): Promise<void> {
  const session = await requireSignedIn();
  await prisma.anchoredLink.updateMany({
    where: { createdById: session.user.id, reopenedAt: { not: null } },
    data: { reopenedAt: null },
  });
}

/**
 * Names, renames or un-names a link (docs/ANCHORED_LINKS.md, "Naming a
 * link"). One write path for both surfaces: the tray's name field passes
 * the open link's id, and the /links Name cell passes its row's. Who may is
 * `canUserRenameAnchoredLink` (src/lib/anchored-link-authz.ts) — the
 * creator at any stage, a moderator once the link is minted, nobody on a
 * deleted row. What is stored is the normalised name or null, never a
 * blank; the CHECK on the column agrees. A rename of a *minted* link
 * stamps `edited_at` — recipients see the name in the banner and on the
 * landing page, so it is a change they can notice — and an unchanged name
 * stamps nothing.
 */
export async function renameAnchoredLink(linkId: string, nameInput: string): Promise<void> {
  const session = await requireSignedIn();
  if (typeof linkId !== "string" || linkId === "" || typeof nameInput !== "string") {
    throw new Error("Malformed rename.");
  }
  const link = await prisma.anchoredLink.findUnique({
    where: { id: linkId },
    select: { createdById: true, mintedAt: true, deletedAt: true, name: true },
  });
  if (!link || !canUserRenameAnchoredLink(session.user.id, session.user.role, link)) {
    // One refusal covers "no such id", "not yours" and "someone else's
    // draft" — none earns a hint that names what the id points at
    // (openAnchoredLinkForEditing's stance). A deleted row the viewer could
    // otherwise rename gets the one remedy that is theirs to apply.
    const restorable =
      !!link?.deletedAt && canUserRenameAnchoredLink(session.user.id, session.user.role, { ...link, deletedAt: null });
    throw new Error(restorable ? "Restore the link before renaming it." : "You can't rename this link.");
  }
  const name = normalizeLinkName(nameInput);
  if (name === link.name) return;
  await prisma.anchoredLink.update({
    where: { id: linkId },
    data: { name, ...(link.mintedAt ? { editedAt: new Date() } : {}) },
  });
}

// docs/ANCHORED_LINKS.md, "The management table" — the /links table's
// delete. A **soft** delete, unlike everything above it: a minted URL has
// been handed out, so its row is a record that a restore may need to bring
// back exactly, where a draft is a working set nobody else has seen and
// `discardDraftLink` hard-deletes it. The anchors stay put either way (an
// anchor is a part of a record); what hides a deleted link is that
// `anchoredLinkForViewer` reads its `deletedAt`, so following it 404s until
// it is restored. Deleting also closes an edit in progress: the one-open
// index ignores deleted rows, so a restore of a still-reopened link could
// otherwise collide with whatever the creator opened since.
//
// Who may: the creator or ADMIN/EDITOR, and never for a draft
// (`canUserDeleteAnchoredLink`, src/lib/anchored-link-authz.ts). Plain
// `prisma.anchoredLink` rather than prismaIncludingDeleted, because this
// model is outside the soft-delete $extends and the ordinary client already
// finds a deleted row to restore — the TagAssignment arrangement.
async function setAnchoredLinkDeleted(linkId: string, deleted: boolean): Promise<void> {
  const session = await requireSignedIn();
  if (typeof linkId !== "string" || linkId === "") {
    throw new Error("Malformed link id.");
  }
  const link = await prisma.anchoredLink.findUnique({
    where: { id: linkId },
    select: { createdById: true, mintedAt: true },
  });
  if (!link) {
    throw new Error("Link not found.");
  }
  if (!canUserDeleteAnchoredLink(session.user.id, session.user.role, link)) {
    // Two refusals with two remedies, so the message names the right one.
    throw new Error(
      link.mintedAt === null
        ? "A draft link is discarded from its tray, not deleted here."
        : "You don't have permission to delete this link.",
    );
  }
  await prisma.anchoredLink.update({
    where: { id: linkId },
    data: deleted
      ? { deletedByUserId: session.user.id, deletedAt: new Date(), reopenedAt: null }
      : { deletedByUserId: null, deletedAt: null },
  });
}

export async function deleteAnchoredLink(linkId: string): Promise<void> {
  await setAnchoredLinkDeleted(linkId, true);
}

export async function restoreAnchoredLink(linkId: string): Promise<void> {
  await setAnchoredLinkDeleted(linkId, false);
}

// Per-row rather than one transaction — see bulkDeletePosts for the
// rationale: the per-row guard above is what a bulk path must not sidestep.
export async function bulkDeleteAnchoredLinks(linkIds: string[]): Promise<BulkResult> {
  return settleBulk(linkIds, (id) => setAnchoredLinkDeleted(id, true));
}

export async function bulkRestoreAnchoredLinks(linkIds: string[]): Promise<BulkResult> {
  return settleBulk(linkIds, (id) => setAnchoredLinkDeleted(id, false));
}
