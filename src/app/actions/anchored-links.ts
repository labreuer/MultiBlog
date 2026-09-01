"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { canUserReadDoc } from "@/lib/doc-authz";
import { canUserReadFile } from "@/lib/file-authz";
import { appUrl } from "@/lib/app-url";
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

// docs/ANCHORED_LINKS.md — mutations on **the viewer's one draft link** and
// the mint that turns it into a shareable URL. The tag-actions shape
// (src/app/actions/tags.ts on the part-anchors branch) with one owner row
// per act; what differs is that the act accumulates across pages — each
// "Add to link" posts its part immediately, captured and verified against
// its own version stamp at that instant, so no client-side part bank exists
// and the server row *is* the cross-page persistence.
//
// **No revalidatePath anywhere in this file, deliberately** (contrast
// untagObject): both reading routes are per-request dynamic — nothing is
// cached to invalidate — and the tray self-fetches on its own notify
// events, so a revalidation would only force full-page work to update a
// fixed-position island that already knows how to update itself.
//
// **Create-permission is read-the-target** — the annotate precedent, not
// the tag one: no role floor beyond being signed in, because pointing at a
// passage claims nothing about it. `post`/`annotation` targets are rejected
// as deferred (the arc columns exist; the writer refuses).

/** One selection, as the client names it. The target's kind picks the shape. */
export type AnchoredLinkPartInput =
  | { kind: "doc-range"; from: number; to: number; quotedText: string }
  | { kind: "pdf-text"; target: unknown };

export type DraftLinkPart = {
  anchorId: string;
  /** The target's title — "(no longer available)" if it vanished since the add. */
  label: string;
  quotedText: string;
  /**
   * Which object the part points into, so a surface can filter the draft to
   * its own passages and paint them (docs/ANCHORED_LINKS.md, "Painting a
   * draft"). Null only for a malformed arc, which the CHECK makes
   * unreachable.
   */
  target: AnchorTarget | null;
  /** DOC_RANGE offsets; null on a PDF_TEXT part, whose quads live in `selector`. */
  from: number | null;
  to: number | null;
  selector: AnchorSelector | null;
};

export type DraftLinkView = {
  id: string;
  parts: DraftLinkPart[];
};

async function requireSignedIn() {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  return session;
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
 * The viewer's open draft, created on first use. The partial unique index
 * `anchored_link_one_draft_per_user` is what makes this a definite article:
 * two tabs racing the create can't leave two drafts — the loser's insert
 * dies with P2002 and re-finds the winner's row.
 */
async function getOrCreateDraft(userId: string): Promise<{ id: string }> {
  const existing = await prisma.anchoredLink.findFirst({
    where: { createdById: userId, mintedAt: null, deletedAt: null },
    select: { id: true },
  });
  if (existing) return existing;
  try {
    return await prisma.anchoredLink.create({
      data: { createdById: userId },
      select: { id: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.anchoredLink.findFirst({
        where: { createdById: userId, mintedAt: null, deletedAt: null },
        select: { id: true },
      });
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
 * The creator's current draft — the tray's list *and* what each reading
 * surface paints its own in-progress passages from. One read for both: the
 * two consumers share a client-side store (`draft-link-store.ts`), so a
 * second query would be a second round trip for the same row.
 *
 * BigInt-free for the same reason `anchoredLinkForViewer` is: this crosses
 * into client props, and `ydocUpdateId` would throw in serialization long
 * after this function looked done.
 */
export async function loadMyDraftLink(): Promise<DraftLinkView | null> {
  const session = await requireSignedIn();

  const draft = await prisma.anchoredLink.findFirst({
    where: { createdById: session.user.id, mintedAt: null, deletedAt: null },
    select: {
      id: true,
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
  if (!draft) return null;

  const docIds = [...new Set(draft.anchors.map((a) => a.docId).filter((id) => id !== null))];
  const fileIds = [...new Set(draft.anchors.map((a) => a.fileId).filter((id) => id !== null))];
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
    id: draft.id,
    parts: draft.anchors.map((anchor) => ({
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
 * Adds one selection to the viewer's draft link, captured and verified
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

  const draft = await getOrCreateDraft(session.user.id);
  // partOrder = current count. Removals leave gaps and nothing renumbers;
  // readers order by [partOrder, id], which absorbs both gaps and the race
  // of two tabs adding at once (equal orders tie-broken by id).
  const partOrder = await prisma.anchoredLinkAnchor.count({ where: { linkId: draft.id } });
  await prisma.anchoredLinkAnchor.create({ data: { ...row, linkId: draft.id, partOrder } });
  return {};
}

/**
 * Removes one part of the viewer's own draft — hard delete, no renumbering
 * (an anchor is a part of a record, not a record). A minted link's parts
 * are not editable; that whole surface is deferred.
 */
export async function removeAnchoredLinkPart(anchorId: string): Promise<{ error?: string }> {
  const session = await requireSignedIn();
  if (typeof anchorId !== "string" || anchorId === "") {
    throw new Error("Malformed anchor id.");
  }

  const deleted = await prisma.anchoredLinkAnchor.deleteMany({
    where: {
      id: anchorId,
      link: { createdById: session.user.id, mintedAt: null, deletedAt: null },
    },
  });
  if (deleted.count === 0) {
    return { error: "That passage is no longer in your draft." };
  }
  return {};
}

/** Throws away the viewer's draft — hard delete; the FK cascade takes its anchors. */
export async function discardDraftLink(): Promise<void> {
  const session = await requireSignedIn();
  await prisma.anchoredLink.deleteMany({
    where: { createdById: session.user.id, mintedAt: null, deletedAt: null },
  });
}

/**
 * Stamps the draft minted and hands back the URL to share — the landing
 * surface is part 0's, computed now rather than stored (no /sel/[id] route;
 * a redirect route stays a cheap later addition if minted hrefs go stale).
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

  // Part 0 decides the landing page; later parts stand in only if its
  // target vanished between add and mint (the doc/file lookups are
  // soft-delete-filtered, so a deleted target yields no href here even
  // though its row survives).
  const sel = `?sel=${encodeURIComponent(draft.id)}`;
  let href: string | null = null;
  for (const anchor of draft.anchors) {
    if (anchor.docId !== null) {
      const doc = await prisma.doc.findUnique({ where: { id: anchor.docId }, select: { id: true } });
      // By id, not slug — docs have no slug history, so the id is the only
      // rename-proof address (resolveDocParam is id-first).
      if (doc) href = `/doc/${doc.id}${sel}`;
    } else if (anchor.fileId !== null) {
      const file = await prisma.storedFile.findUnique({ where: { id: anchor.fileId }, select: { slug: true } });
      if (file) href = `/pdf/${file.slug}${sel}`;
    }
    if (href) break;
  }
  if (!href) {
    return { error: "None of the linked passages still exist." };
  }

  await prisma.anchoredLink.update({
    where: { id: draft.id },
    data: { mintedAt: new Date() },
  });
  return { url: appUrl(href) };
}
