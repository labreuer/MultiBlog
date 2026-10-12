import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prisma } from "@/lib/prisma";
import { markdownToAnnotationContent, markdownToText } from "@/lib/markdown-import";
import { annotationContentExtensions, pmAnnotationContentSchema } from "@/lib/tiptap-schema";
import { createPostedAnnotation, type PostedAnchor } from "@/lib/annotation-post";
import { parentSettledMark, settleAnnotationBody, writeSettledBody } from "@/lib/annotation-settle";
import { replaceAnnotationBody } from "@/lib/annotation-admin";
import { decodeAnnotationSnapshot } from "@/lib/annotation-body";
import { canUserEditAnnotationBody } from "@/lib/annotation-authz";
import { STALE_EDIT_SESSION_MS } from "@/lib/edit-grace";
import { mergeDoc } from "@/lib/doc-edit";
import { viewerOf } from "@/lib/actor";
import * as Y from "yjs";
import { captureAnchorInNode } from "@/lib/anchors/capture";
import { annotationAnchorName } from "@/lib/annotation-anchor-name";
import { displayNameOf } from "@/lib/display-name";
import { flattenForMatch } from "@/lib/comment-quote-match";
import { contextOf, hasQuote, resolveQuote, type QuoteSpec } from "@/lib/quote-resolve";
import { blocksOfRange, docBlocks, headingAbove } from "@/lib/doc-text";
import { docLogTail, isDocVersion, loadDocStateAt } from "@/lib/doc-state";
import { materializeYdocAt } from "@/lib/ydoc-snapshot";
import { ydocIdForAnnotation } from "@/lib/ydoc-names";
import { ApiError, ERROR_LIST_CAP, forbidden, invalid, notFound } from "@/lib/api/errors";
import type { McpContext, ToolResult } from "./tool";
import { parse, readableContainer, readableDocByParam, readableFileBySlug, type ResolvedContainer } from "./resolve";
import { annotationByFragment } from "./read/threads";
import { checkFragmentLinks } from "./fragment-links";
import { anchorPdfQuote } from "./pdf-anchoring";

// docs/MCP.md §9 — `annotate`: a LIVE annotation, root or reply, anchored by
// quote or on the whole. Always the column mechanism: the MCP server has no
// editor surface, so it never writes an annotation mark into a doc.
//
// - **A quote is optional.** With none, a root is a note on the whole doc or
//   PDF, as the composer below the article posts, and a reply answers its
//   parent as a whole, as the plain Reply button does. With one, a miss is
//   `no_match`, never a note on the whole: an agent that named a passage
//   didn't ask for one.
// - **A root with a quote** anchors into the doc, stamped with `version` —
//   validated as a row of this doc's own log at or before its tail, so
//   "`ydocUpdateId` is the version the annotator was looking at" stays true
//   for an agent — or into a PDF page, with server quads.
// - **A reply with a quote** anchors into its parent's *body*, at the
//   parent's newest settled version, whatever its container.

type Target = { container: ResolvedContainer; parent: { id: string } | null };

/** What `on` names: a doc or PDF to annotate, or an annotation (by id, or its card's URL) to reply to. */
async function resolveOn(ctx: McpContext, on: string): Promise<Target> {
  const parsed = parse(on);
  let parentId: string | null = null;
  if (parsed.kind === "id") {
    const annotation = await prisma.annotation.findUnique({ where: { id: parsed.id }, select: { id: true } });
    if (annotation) parentId = annotation.id;
  } else if ((parsed.kind === "doc" || parsed.kind === "pdf") && parsed.fragment && !/(^|&)(page|text)=/.test(parsed.fragment)) {
    const container = await readableContainer(ctx.actor, on.split("#")[0]);
    parentId = await annotationByFragment(
      container.kind === "doc" ? { docId: container.doc.id } : { fileId: container.file.id },
      parsed.fragment,
    );
    if (!parentId) throw notFound("An annotation with that card fragment");
  }
  if (!parentId) return { container: await readableContainer(ctx.actor, on), parent: null };

  // A reply's parent must be readable, posted and not deleted: a DRAFT is its
  // writer's alone, and a reply quoting one would search that private body.
  const parent = await prisma.annotation.findUnique({
    where: { id: parentId },
    select: { id: true, status: true, deletedByUserId: true, docId: true, fileId: true },
  });
  if (!parent || parent.status === "DRAFT") throw notFound("That annotation");
  const container: ResolvedContainer = parent.docId
    ? { kind: "doc", doc: await readableDocByParam(ctx.actor, parent.docId) }
    : { kind: "file", file: await readableFileBySlug(ctx.actor, parent.fileId!) };
  if (parent.deletedByUserId !== null) throw invalid("That annotation has been deleted; reply to its thread's root instead.");
  return { container, parent: { id: parent.id } };
}

/** A quote's one match in `node`, or the refusal: `no_match` with near misses, `ambiguous` with where. */
function findOne(node: PMNode, spec: QuoteSpec, describeWhere: (from: number, to: number) => Record<string, unknown>) {
  const target = flattenForMatch(node);
  const found = resolveQuote(target, spec, markdownToText);
  if (found.kind === "none") {
    throw new ApiError("no_match", "That quote isn't there as written.", {
      nearMisses: found.nearMisses.map((miss) => ({ text: miss.quotedText, context: contextOf(target, miss), ...describeWhere(miss.from, miss.to) })),
    });
  }
  if (found.matches.length > 1) {
    throw new ApiError("ambiguous", "That quote occurs more than once; add a prefix or suffix.", {
      occurrences: found.matches.slice(0, ERROR_LIST_CAP).map((m) => ({ context: contextOf(target, m), ...describeWhere(m.from, m.to) })),
      total: found.matches.length,
    });
  }
  const match = found.matches[0];
  const captured = captureAnchorInNode(node, match.from, match.to, node.textBetween(match.from, match.to, " "));
  if (!captured) throw new ApiError("no_match", "That quote couldn't be anchored.");
  return captured;
}

export type QuoteInput = QuoteSpec & { version?: string; page?: number; label?: string };

/**
 * A root's anchor in a doc, measured at `version` (the tail by default): the
 * doc rebuilt there once, the quote found in it, and the anchor captured from
 * that same node — whose `textBetween` is what is stored, never the agent's
 * quote, so replaying to the stamp reproduces it by construction.
 */
export async function anchorInDoc(docId: string, quote: QuoteInput): Promise<{ stamp: bigint; from: number; to: number; quotedText: string }> {
  const tail = await docLogTail(docId);
  if (tail === null) throw invalid("This doc has no history to anchor into yet.");
  let stamp = tail;
  if (quote.version !== undefined) {
    stamp = BigInt(quote.version);
    if (stamp > tail || !(await isDocVersion(docId, stamp))) {
      throw invalid("That version isn't in this doc's history; pass the version a read of this doc returned.");
    }
  }
  const state = await loadDocStateAt(docId, stamp);
  const blocks = docBlocks(state.node);
  const captured = findOne(state.node, quote, (from, to) => {
    const at = blocksOfRange(blocks, from, to);
    const heading = at ? headingAbove(blocks, at.from) : null;
    return at
      ? { blocks: at.from === at.to ? String(at.from) : `${at.from}-${at.to}`, ...(heading ? { heading: heading.heading!.text } : {}) }
      : {};
  });
  return { stamp, from: captured.from, to: captured.to, quotedText: captured.quotedText };
}

/** A reply's anchor in its parent's body, at the parent's newest settled version — what the replier was reading. */
async function anchorInParent(parentId: string, quote: QuoteInput) {
  const stamp = await parentSettledMark(parentId);
  if (stamp === null) throw invalid("That annotation's body has no settled version to quote.");
  const doc = await materializeYdocAt(ydocIdForAnnotation(parentId), stamp);
  try {
    const json = TiptapTransformer.extensions(annotationContentExtensions).fromYdoc(doc, "default") as JSONContent;
    const captured = findOne(pmAnnotationContentSchema.nodeFromJSON(json), quote, () => ({}));
    return { stamp, from: captured.from, to: captured.to, quotedText: captured.quotedText };
  } finally {
    doc.destroy();
  }
}

export async function annotateFor(ctx: McpContext, input: QuoteInput & { on: string; body: string }): Promise<ToolResult> {
  const { container, parent } = await resolveOn(ctx, input.on);
  let body: JSONContent;
  try {
    body = markdownToAnnotationContent(input.body);
  } catch (err) {
    throw invalid(`That Markdown doesn't make a valid annotation body: ${err instanceof Error ? err.message : String(err)}`);
  }
  const warnings = await checkFragmentLinks(ctx.actor, [body]);

  const quoted = hasQuote(input);
  if (!quoted && (input.quote !== undefined || input.start !== undefined || input.end !== undefined)) {
    throw invalid("Name a passage by quote, or by both start and end.");
  }
  if ((input.page !== undefined || input.label !== undefined) && (container.kind !== "file" || parent)) {
    throw invalid("page and label narrow a quote on a PDF.");
  }
  let anchor: PostedAnchor;
  let passage: Record<string, unknown> | null = null;
  if (!quoted) {
    anchor = { kind: "none", stamp: container.kind === "doc" ? await docLogTail(container.doc.id) : null };
  } else if (parent) {
    const at = await anchorInParent(parent.id, input);
    anchor = { kind: "range", ...at };
    passage = { text: at.quotedText };
  } else if (container.kind === "doc") {
    const at = await anchorInDoc(container.doc.id, input);
    anchor = { kind: "range", ...at };
    passage = { text: at.quotedText };
  } else {
    const at = await anchorPdfQuote(container.file, input);
    anchor = { kind: "pdf", target: at.target, quotedText: at.quotedText };
    passage = { text: at.quotedText, page: at.target.pageIndex + 1, ...(at.label ? { label: at.label } : {}) };
  }

  const created = await createPostedAnnotation(ctx.actor, {
    container: container.kind === "doc" ? { kind: "doc", id: container.doc.id } : { kind: "file", id: container.file.id },
    parentId: parent?.id ?? null,
    body,
    anchor,
  });
  const url = container.kind === "doc" ? `/doc/${container.doc.slug}` : `/pdf/${container.file.slug}`;
  return {
    id: created.id,
    card: `${url}#${annotationAnchorName(displayNameOf(ctx.token.user), created.createdAt)}`,
    on: url,
    ...(parent ? { replyTo: parent.id } : {}),
    // A reply's stamp is in its parent's body log when it quotes it, so a
    // version is reported only for a root, where it is the doc's.
    ...(created.stamp !== null && !parent ? { version: created.stamp.toString() } : {}),
    ...(passage ? { passage } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * edit_annotation (§9): a posted body rewritten in one call — an edit
 * session begun, the new body written through /admin/annotation-replace
 * (attributed to the actor, and refusing a read-only token), and the session
 * finished, which records the new version, or none if nothing changed. A
 * step that fails cancels, putting the last settled body back as the UI's
 * Cancel does.
 *
 * The body is merged word by word with the settled one, so the words that
 * survive keep their marks; the new words carry the actor's mark only where
 * the UI's editor would give them one — once the body has two distinct
 * writers (AnnotationBody turns the author mark on at that point).
 */
export async function editAnnotationFor(ctx: McpContext, input: { id: string; body: string }): Promise<ToolResult> {
  const annotation = await prisma.annotation.findUnique({
    where: { id: input.id },
    select: {
      id: true,
      userId: true,
      status: true,
      deletedByUserId: true,
      editingSince: true,
      createdAt: true,
      docId: true,
      fileId: true,
      user: { select: { name: true } },
    },
  });
  if (!annotation || annotation.status === "DRAFT") throw notFound("That annotation");
  const container: ResolvedContainer = annotation.docId
    ? { kind: "doc", doc: await readableDocByParam(ctx.actor, annotation.docId) }
    : { kind: "file", file: await readableFileBySlug(ctx.actor, annotation.fileId!) };
  if (annotation.deletedByUserId !== null) throw invalid("That annotation has been deleted.");
  if (!canUserEditAnnotationBody(ctx.actor.userId, ctx.actor.role, annotation)) {
    throw forbidden("Only an annotation's writer, or an admin, can edit it.");
  }
  if (
    annotation.editingSince &&
    Date.now() - annotation.editingSince.getTime() < STALE_EDIT_SESSION_MS &&
    annotation.userId !== ctx.actor.userId
  ) {
    throw new ApiError("conflict", "Someone else is editing this annotation right now.");
  }

  let next: JSONContent;
  try {
    next = markdownToAnnotationContent(input.body);
  } catch (err) {
    throw invalid(`That Markdown doesn't make a valid annotation body: ${err instanceof Error ? err.message : String(err)}`);
  }
  const warnings = await checkFragmentLinks(ctx.actor, [next]);

  const ydocId = ydocIdForAnnotation(annotation.id);
  const [newest, row] = await Promise.all([
    prisma.ydocSnapshot.findFirst({ where: { ydocId }, orderBy: { lastYdocUpdateId: "desc" }, select: { ydoc: true } }),
    prisma.ydoc.findUnique({ where: { id: ydocId }, select: { ydoc: true } }),
  ]);
  if (!newest || !row) throw invalid("This annotation has no settled version to edit from.");
  const settledBody = decodeAnnotationSnapshot(new Uint8Array(newest.ydoc));
  const writers = new Set<string>([ctx.actor.userId]);
  const live = new Y.Doc();
  try {
    Y.applyUpdate(live, new Uint8Array(row.ydoc));
    for (const userId of live.getMap<string>("clients").values()) writers.add(userId);
  } finally {
    live.destroy();
  }
  writers.add(annotation.userId);
  const merged = mergeDoc(
    pmAnnotationContentSchema.nodeFromJSON(settledBody.proseJson),
    pmAnnotationContentSchema.nodeFromJSON(next),
    { schema: pmAnnotationContentSchema, authorId: writers.size >= 2 ? ctx.actor.userId : null },
  );

  const viewer = viewerOf(ctx.actor);
  const cancel = async () => {
    await replaceAnnotationBody({ userId: viewer.id, role: viewer.role, annotationId: annotation.id, proseJson: settledBody.proseJson });
    await prisma.annotation.update({ where: { id: annotation.id }, data: { editingSince: null } });
  };
  await prisma.annotation.update({ where: { id: annotation.id }, data: { editingSince: new Date() } });
  const replaced = await replaceAnnotationBody({
    userId: viewer.id,
    role: viewer.role,
    annotationId: annotation.id,
    proseJson: merged.toJSON(),
    attribute: true,
  });
  if (!replaced.replaced) {
    await cancel().catch(() => {});
    throw new ApiError("unavailable", "The live-editing server couldn't write the new body; nothing was changed.");
  }
  const settled = await settleAnnotationBody(annotation.id, viewer, { expectChange: true });
  if ("error" in settled) {
    await cancel().catch(() => {});
    throw invalid(settled.error);
  }
  const url = container.kind === "doc" ? `/doc/${container.doc.slug}` : `/pdf/${container.file.slug}`;
  const card = `${url}#${annotationAnchorName(displayNameOf(annotation.user), annotation.createdAt)}`;
  if (settled.unchanged) {
    await prisma.annotation.update({ where: { id: annotation.id }, data: { editingSince: null } });
    return { id: annotation.id, card, unchanged: true };
  }
  const now = new Date();
  await writeSettledBody({
    annotationId: annotation.id,
    settled,
    userId: ctx.actor.userId,
    at: now,
    alongside: { editingSince: null, editedAt: now },
  });
  return { id: annotation.id, card, ...(warnings.length > 0 ? { warnings } : {}) };
}
