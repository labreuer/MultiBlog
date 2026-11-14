import { chipMarkdownBetween, chipMarkdowns, chipsInJSON } from "@/lib/entity-chips/renderings";
import { writesBack } from "@/lib/entity-chips/registry";
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
import { chipMergeFor, mergeDoc } from "@/lib/doc-edit";
import { viewerOf } from "@/lib/actor";
import * as Y from "yjs";
import { captureAnchorInNode } from "@/lib/anchors/capture";
import type { DocRangeSelector } from "@/lib/anchors";
import { annotationAnchorName } from "@/lib/annotation-anchor-name";
import { displayNameOf } from "@/lib/display-name";
import { flattenForMatch } from "@/lib/comment-quote-match";
import { contextOf, hasQuote, resolveQuote, type QuoteSpec } from "@/lib/quote-resolve";
import { blocksOfRange, docBlocks, headingAbove } from "@/lib/doc-text";
import { docLogTail, isDocVersion, loadDocStateAt } from "@/lib/doc-state";
import { materializeYdocAt } from "@/lib/ydoc-snapshot";
import { ydocIdForAnnotation } from "@/lib/ydoc-names";
import { ApiError, ERROR_LIST_CAP, forbidden, invalid, notFound } from "@/lib/api/errors";
import { chipInputsForBody } from "@/lib/entity-chips/context";
import { resolveParsedChips, withQuoteChips } from "@/lib/entity-chips/parsed-chips";
import { chipLabels, displayTextBetween, type ChipLabels } from "@/lib/entity-chips/text";
import type { McpContext, ToolResult } from "./tool";
import { parse, readableContainer, readableDocByParam, readableFileBySlug, type ResolvedContainer } from "./resolve";
import { annotationByFragment } from "./read/threads";
import { checkFragmentLinks } from "./fragment-links";
import { anchorPdfQuote } from "./pdf-anchoring";

// docs/MCP.md §9 — `add_note`: a LIVE annotation, root or reply, anchored by
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

/**
 * A quote's one match in `node`, or the refusal: `no_match` with near misses,
 * `ambiguous` with where. `labels` are the node's entity chips as the agent
 * read them, so a quote that holds a label finds its chip; what is captured
 * and stored is the node's own text, where a chip is its anchor text.
 */
function findOne(
  node: PMNode,
  chips: { labels: ChipLabels; markdown: ReadonlyMap<string, string> },
  spec: QuoteSpec,
  describeWhere: (from: number, to: number) => Record<string, unknown>,
) {
  const { labels } = chips;
  const target = flattenForMatch(node, labels);
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
  const captured = captureAnchorInNode(node, match.from, match.to, node.textBetween(match.from, match.to, " "), labels);
  if (!captured) throw new ApiError("no_match", "That quote couldn't be anchored.");
  // `shown` is the passage as the agent reads it, for the answer; `quotedText` is what is stored.
  // A quote that named its chips with other fields than they hold lands on
  // them all the same, and is told what they hold (docs/ENTITY_CHIPS.md, MCP item 3).
  return {
    ...captured,
    shown: displayTextBetween(node, captured.from, captured.to, labels),
    ...(match.chipsDiffer ? { chipsNow: chipMarkdownBetween(node, match.from, match.to, chips.markdown) } : {}),
  };
}

export type QuoteInput = QuoteSpec & { version?: string; page?: number; label?: string };

/**
 * A root's anchor in a doc, measured at `version` (the tail by default): the
 * doc rebuilt there once, the quote found in it, and the anchor captured from
 * that same node — whose `textBetween` is what is stored, never the agent's
 * quote, so replaying to the stamp reproduces it by construction.
 */
export async function anchorInDoc(
  docId: string,
  quote: QuoteInput,
): Promise<{ stamp: bigint; from: number; to: number; quotedText: string; shown: string; selector: DocRangeSelector; chipsNow?: string[] }> {
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
  const blocks = docBlocks(state.node, state.chips.labels);
  const captured = findOne(state.node, state.chips, await withQuoteChips(quote), (from, to) => {
    const at = blocksOfRange(blocks, from, to);
    const heading = at ? headingAbove(blocks, at.from) : null;
    return at
      ? { blocks: at.from === at.to ? String(at.from) : `${at.from}-${at.to}`, ...(heading ? { heading: heading.heading!.text } : {}) }
      : {};
  });
  return {
    stamp,
    from: captured.from,
    to: captured.to,
    quotedText: captured.quotedText,
    shown: captured.shown,
    selector: captured.selector,
    ...(captured.chipsNow ? { chipsNow: captured.chipsNow } : {}),
  };
}

/** A reply's anchor in its parent's body, at the parent's newest settled version — what the replier was reading. */
async function anchorInParent(parentId: string, quote: QuoteInput) {
  const stamp = await parentSettledMark(parentId);
  if (stamp === null) throw invalid("That annotation's body has no settled version to quote.");
  const doc = await materializeYdocAt(ydocIdForAnnotation(parentId), stamp);
  try {
    const json = TiptapTransformer.extensions(annotationContentExtensions).fromYdoc(doc, "default") as JSONContent;
    // The parent's chips as a thread read shows them, so a quote of one lands.
    const inputs = await chipInputsForBody(json);
    const chips = { labels: chipLabels(json, inputs), markdown: chipMarkdowns(chipsInJSON(json), inputs.styles, inputs.context) };
    const captured = findOne(pmAnnotationContentSchema.nodeFromJSON(json), chips, await withQuoteChips(quote), () => ({}));
    return {
      stamp,
      from: captured.from,
      to: captured.to,
      quotedText: captured.quotedText,
      shown: captured.shown,
      selector: captured.selector,
      ...(captured.chipsNow ? { chipsNow: captured.chipsNow } : {}),
    };
  } finally {
    doc.destroy();
  }
}

export async function annotateFor(ctx: McpContext, input: QuoteInput & { on: string; body: string }): Promise<ToolResult> {
  const { container, parent } = await resolveOn(ctx, input.on);
  let body: JSONContent;
  try {
    body = markdownToAnnotationContent(input.body, { chips: true });
  } catch (err) {
    throw invalid(`That Markdown doesn't make a valid annotation body: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A mention written in the body is one, under the rule the composer's menu lists by.
  body = await resolveParsedChips(body, ctx.actor, { docId: container.kind === "doc" ? container.doc.id : null, held: null });
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
    anchor = { kind: "range", stamp: at.stamp, from: at.from, to: at.to, quotedText: at.quotedText, chips: at.selector.chips };
    passage = { text: at.shown, ...(at.chipsNow ? { chipsNow: at.chipsNow } : {}) };
  } else if (container.kind === "doc") {
    const at = await anchorInDoc(container.doc.id, input);
    anchor = { kind: "range", stamp: at.stamp, from: at.from, to: at.to, quotedText: at.quotedText, chips: at.selector.chips };
    passage = { text: at.shown, ...(at.chipsNow ? { chipsNow: at.chipsNow } : {}) };
  } else {
    const at = await anchorPdfQuote(container.file, input);
    anchor = { kind: "pdf", target: at.target, quotedText: at.quotedText, fileVersionId: at.fileVersionId };
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
 * edit_note (§9): a posted body rewritten in one call — an edit
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
    next = markdownToAnnotationContent(input.body, { chips: true });
  } catch (err) {
    throw invalid(`That Markdown doesn't make a valid annotation body: ${err instanceof Error ? err.message : String(err)}`);
  }

  const ydocId = ydocIdForAnnotation(annotation.id);
  const [newest, row] = await Promise.all([
    prisma.ydocSnapshot.findFirst({ where: { ydocId }, orderBy: { lastYdocUpdateId: "desc" }, select: { ydoc: true } }),
    prisma.ydoc.findUnique({ where: { id: ydocId }, select: { ydoc: true } }),
  ]);
  if (!newest || !row) throw invalid("This annotation has no settled version to edit from.");
  const settledBody = await decodeAnnotationSnapshot(new Uint8Array(newest.ydoc));
  // The body's own mentions may be written back whoever they name now.
  next = await resolveParsedChips(next, ctx.actor, { docId: annotation.docId, held: settledBody.proseJson });
  const warnings = await checkFragmentLinks(ctx.actor, [next]);
  const writers = new Set<string>([ctx.actor.userId]);
  const live = new Y.Doc();
  try {
    Y.applyUpdate(live, new Uint8Array(row.ydoc));
    for (const userId of live.getMap<string>("clients").values()) writers.add(userId);
  } finally {
    live.destroy();
  }
  writers.add(annotation.userId);
  const oldNode = pmAnnotationContentSchema.nodeFromJSON(settledBody.proseJson);
  const nextNode = pmAnnotationContentSchema.nodeFromJSON(next);
  // A new body replaces the whole of the old one, and a chip the Markdown
  // parse can't read back (a kind this server doesn't know) would be dropped
  // by it: refused, as an edit over one is in a doc.
  const unwritable = [...new Set(chipsInJSON(settledBody.proseJson).map((chip) => chip.kind).filter((kind) => !writesBack(kind)))];
  if (unwritable.length > 0) {
    throw new ApiError(
      "unknown_kind",
      `This note holds ${unwritable.map((kind) => `a ${kind}`).join(" and ")}, which this server can't write back from Markdown, so its body can't be replaced here.`,
      { kinds: unwritable },
    );
  }
  // The merge keeps a mention the new text still names, instance id and all,
  // and says when one came back as its label in plain words.
  const chipMerge = chipMergeFor(oldNode, nextNode, chipLabels(settledBody.proseJson, await chipInputsForBody(settledBody.proseJson)));
  const merged = mergeDoc(oldNode, nextNode, {
    schema: pmAnnotationContentSchema,
    authorId: writers.size >= 2 ? ctx.actor.userId : null,
    chipMerge,
  });
  if (chipMerge.asText.length > 0) {
    const labels = [...new Set(chipMerge.asText)];
    throw new ApiError(
      "chip_as_text",
      `The new body has ${labels.map((label) => `"${label}"`).join(", ")} as plain words where the note has a mention. ` +
        "Write a mention as the Markdown read shows it, [@Name](/authors/handle), to keep it; leave the name out to remove it.",
      { labels },
    );
  }

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
