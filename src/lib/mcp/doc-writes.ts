import { parseChipRecords } from "@/lib/anchors";
import type { JSONContent } from "@tiptap/core";
import { prisma } from "@/lib/prisma";
import { canManageDocs, canUserEditDoc } from "@/lib/doc-authz";
import { BYLINE_ELIGIBLE_ROLES } from "@/lib/role-checks";
import { createDocWithContent } from "@/lib/doc-create";
import { MAX_MARKDOWN_BYTES, markdownToBlocks, markdownToDocContent, markdownToText } from "@/lib/markdown-import";
import { pmDocContentSchema } from "@/lib/tiptap-schema";
import { resolveParsedChips } from "@/lib/entity-chips/parsed-chips";
import { chipIdentitiesBetween } from "@/lib/entity-chips/renderings";
import { postedAnnotationWhere } from "@/lib/annotation-authz";
import { linkPartsInto } from "@/lib/anchored-link-data";
import { flattenForMatch, quotedTextAt } from "@/lib/comment-quote-match";
import { resolveQuote } from "@/lib/quote-resolve";
import { alignBlocks, diffRuns, renderWordDiff } from "@/lib/block-align";
import { blockKey, type EditSpec, type EditTarget } from "@/lib/doc-edit";
import { requestDocEdit, type AnchorRef } from "@/lib/doc-edit-client";
import { docLogTail, isDocVersion, loadDocState, loadDocStateAt } from "@/lib/doc-state";
import { docTitleOrFallback } from "@/lib/doc-title";
import { displayNameOf } from "@/lib/display-name";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { viewerOf, type Actor } from "@/lib/actor";
import { ApiError, ERROR_LIST_CAP, forbidden, invalid } from "@/lib/api/errors";
import type { McpContext, ToolResult } from "./tool";
import { readableDoc, type ResolvedDoc } from "./resolve";
import { checkFragmentLinks } from "./fragment-links";

// docs/MCP.md §6 — writing docs: creating one, and editing one by targeted
// edits, never a whole-body replace. A whole-body replace compares whole
// blocks, marks and all, and in a doc a person has typed in every character
// carries their author mark, so nearly every block would differ from a
// Markdown-parsed one and be rebuilt: an update nearly as large as the doc,
// every mark in it lost (author colours, editor-anchored notes), and a base
// that never matches while someone types. The importer's planner stays the
// importer's, for re-imports.

/**
 * Who a new doc's byline (or a new file's owner list) names under `write`
 * (§3, §12): the actor first and the token's issuer second, or the issuer
 * alone when they ask to be. On a PRIVATE object that list is the access
 * list, so naming anyone else is `manage`. An issuer who can't carry a byline
 * is left off it, and can't be its only name.
 */
export function newObjectPeople(ctx: McpContext, issuerOnly: boolean | undefined): string[] {
  const issuerEligible = BYLINE_ELIGIBLE_ROLES.includes(ctx.token.issuer.role);
  if (issuerOnly) {
    if (!issuerEligible) throw invalid("The token's issuer can't carry a byline, so can't be its only name.");
    return [ctx.token.issuer.id];
  }
  return [...new Set([ctx.actor.userId, ...(issuerEligible ? [ctx.token.issuer.id] : [])])];
}

async function bylineNames(docId: string): Promise<string> {
  const authors = await prisma.docAuthor.findMany({
    where: { docId },
    orderBy: { bylineOrder: "asc" },
    select: { user: { select: { name: true } } },
  });
  return authors.map((a) => displayNameOf(a.user)).join(", ");
}

/** [3, 4, 5, 9] as "3-5, 9": a list of block numbers said once. */
export function blockList(numbers: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < numbers.length) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    parts.push(i === j ? String(numbers[i]) : `${numbers[i]}-${numbers[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

/**
 * create_doc, and POST /api/mcp/docs: a PRIVATE doc from Markdown, in one
 * transaction, its text marked as the actor's, its byline the actor and the
 * issuer. The title is the argument, or the Markdown's leading heading as the
 * importer takes it.
 */
export async function createDocFor(
  ctx: McpContext,
  input: { markdown: string; title?: string; issuerOnly?: boolean },
): Promise<ToolResult> {
  if (!canManageDocs(ctx.actor.role)) throw forbidden("This account can't create docs.");
  const bytes = Buffer.byteLength(input.markdown, "utf8");
  if (bytes > MAX_MARKDOWN_BYTES) {
    throw new ApiError("too_large", `That's ${Math.round(bytes / 1024)} KB of Markdown; the limit is ${MAX_MARKDOWN_BYTES / 1024} KB.`);
  }
  // A chip kind's syntax is a chip here as in an edit (docs/ENTITY_CHIPS.md,
  // MCP item 7), so a doc downloaded from one instance is created on another
  // with its mentions, by handle.
  const parsed = markdownToDocContent(input.markdown, { chips: true });
  let title = input.title?.replace(/\s+/g, " ").trim() || parsed.title || "";
  let body = parsed.body;
  // An explicit title that isn't the leading heading leaves the heading in the body.
  if (input.title?.trim() && parsed.title && parsed.title !== title) {
    body = { type: "doc", content: markdownToBlocks(input.markdown, { chips: true }) };
  }
  title = title.slice(0, 500);
  // No doc yet for the rule to ask about: whoever the actor may mention anywhere.
  body = await resolveParsedChips(body, ctx.actor, { docId: null, held: null });
  try {
    pmDocContentSchema.nodeFromJSON(body).check();
  } catch (err) {
    throw invalid(`That Markdown doesn't make a valid doc: ${err instanceof Error ? err.message : String(err)}`);
  }
  const warnings = await checkFragmentLinks(ctx.actor, [body]);
  const byline = newObjectPeople(ctx, input.issuerOnly);
  const doc = await createDocWithContent(ctx.actor.userId, title, body, { byline, author: ctx.actor.userId });
  const version = await docLogTail(doc.id);
  return {
    url: `/doc/${doc.slug}`,
    id: doc.id,
    title: docTitleOrFallback(title),
    byline: await bylineNames(doc.id),
    visibility: "PRIVATE",
    version: version?.toString() ?? null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** The doc an edit may change: readable, editable by the actor, and not a record. */
async function editableDoc(ctx: McpContext, url: string): Promise<ResolvedDoc> {
  const doc = await readableDoc(ctx.actor, url);
  if (!(await canUserEditDoc(ctx.actor.userId, ctx.actor.role, doc.id))) {
    throw forbidden("You can read this doc but not edit it: editing needs you on its byline.");
  }
  if (doc.record) {
    throw new ApiError("read_only", "This doc is a record of what was said (an imported chat), and isn't edited through the MCP server.");
  }
  return doc;
}

/**
 * Markdown as edit blocks, checked against the doc schema. A chip kind's
 * syntax is read as a chip and resolved under that kind's rule for `actor`
 * (`resolveParsedChips`); `held` is the doc as it stands, whose own chips an
 * edit may always write back.
 */
async function blocksOfMarkdown(markdown: string, actor: Actor, docId: string, held: JSONContent): Promise<JSONContent[]> {
  const parsed = markdownToBlocks(markdown, { chips: true });
  const resolved = await resolveParsedChips({ type: "doc", content: parsed }, actor, { docId, held });
  const blocks = resolved.content ?? [];
  try {
    pmDocContentSchema.nodeFromJSON({ type: "doc", content: blocks }).check();
  } catch (err) {
    throw invalid(`That Markdown doesn't make valid doc content: ${err instanceof Error ? err.message : String(err)}`);
  }
  return blocks;
}

export type EditInput = {
  old?: string | { start: string; end: string };
  new?: string;
  prefix?: string;
  suffix?: string;
  acrossHeadings?: boolean;
  append?: string;
  insert?: string;
  after?: string | number;
  atEnd?: boolean;
};

/** What the edit touched, and what the endpoint refused, said as the model reads them. */
function refusalError(refusal: { code: string; message: string; details?: Record<string, unknown>; edit: number }, count: number): ApiError {
  const code = refusal.code === "conflict" ? "conflict" : (refusal.code as "no_match" | "ambiguous" | "invalid" | "chip_as_text");
  // A refusal of the request as a whole names no edit.
  const numbered = count > 1 && refusal.edit >= 0;
  return new ApiError(code, numbered ? `Edit ${refusal.edit + 1}: ${refusal.message}` : refusal.message, {
    ...(numbered ? { edit: refusal.edit + 1 } : {}),
    ...(refusal.details ?? {}),
  });
}

/** The annotations and link parts on a doc that an edit reports on (§6, "An edit answers with what it touched"). */
async function anchorsOn(ctx: McpContext, docId: string) {
  const roots = await prisma.annotation.findMany({
    where: { docId, parentAnnotationId: null, deletedByUserId: null, ...postedAnnotationWhere() },
    select: { id: true, anchorFrom: true, anchorTo: true, quotedText: true, anchorChips: true },
  });
  const parts = await linkPartsInto({ kind: "doc", id: docId }, viewerOf(ctx.actor));
  const linkOf = new Map(parts.map((part) => [part.anchorId, part.linkId]));
  return {
    annotations: roots
      .filter((r) => r.anchorFrom !== null)
      .map((r): AnchorRef => ({ id: r.id, from: r.anchorFrom, to: r.anchorTo, quotedText: r.quotedText, chips: parseChipRecords(r.anchorChips) })),
    markAnnotations: roots.filter((r) => r.anchorFrom === null).map((r) => r.id),
    markChips: Object.fromEntries(
      roots.filter((r) => r.anchorFrom === null && r.anchorChips !== null).map((r) => [r.id, parseChipRecords(r.anchorChips)]),
    ),
    linkParts: parts.map(
      (p): AnchorRef => ({
        id: p.anchorId,
        from: p.from,
        to: p.to,
        quotedText: p.quotedText,
        ...(p.selector?.kind === "DOC_RANGE" && p.selector.selector.chips ? { chips: p.selector.selector.chips } : {}),
      }),
    ),
    linkOf,
  };
}

/**
 * edit_doc's edits: targeted, each passage named by its words or its ends,
 * applied word by word by the collab server (server/doc-edit.ts). A passage
 * named by its ends isn't sent whole, so its middle is checked: the request
 * carries the version it was read at, and when the log has moved past that,
 * the passage is found in the doc rebuilt there and its text sent along, for
 * the endpoint to compare with the text now.
 */
export async function editDocFor(
  ctx: McpContext,
  input: { url: string; version?: string; edits?: EditInput[]; title?: string },
): Promise<ToolResult> {
  const doc = await editableDoc(ctx, input.url);
  // The doc as it stands: whose chips an edit may write back, and what its
  // quotes are matched against on both servers.
  const current = await loadDocState(doc.id);
  const blocksOf = (markdown: string) => blocksOfMarkdown(markdown, ctx.actor, doc.id, current.json);
  const edits: EditSpec[] = [];
  const written: JSONContent[] = [];
  for (const [index, edit] of (input.edits ?? []).entries()) {
    const label = (input.edits?.length ?? 0) > 1 ? `Edit ${index + 1}: ` : "";
    if (edit.old !== undefined) {
      if (edit.new === undefined) throw invalid(`${label}old needs new beside it.`);
      const target: EditTarget =
        typeof edit.old === "string"
          ? { quote: edit.old, prefix: edit.prefix, suffix: edit.suffix }
          : { start: edit.old.start, end: edit.old.end, prefix: edit.prefix, suffix: edit.suffix, acrossHeadings: edit.acrossHeadings };
      const blocks = edit.new.trim() === "" ? [] : await blocksOf(edit.new);
      edits.push({ kind: "replace", target, blocks: blocks.length > 0 ? blocks : [] });
      written.push(...blocks);
    } else if (edit.append !== undefined) {
      const blocks = await blocksOf(edit.append);
      edits.push({ kind: "append", blocks });
      written.push(...blocks);
    } else if (edit.insert !== undefined) {
      if (edit.after === undefined) throw invalid(`${label}insert needs after: a heading's text or block number.`);
      const blocks = await blocksOf(edit.insert);
      edits.push({ kind: "insert", heading: edit.after, atEnd: edit.atEnd, blocks });
      written.push(...blocks);
    } else {
      throw invalid(`${label}an edit is {old, new}, {append} or {insert, after}.`);
    }
  }
  if (edits.length === 0 && input.title === undefined) throw invalid("Give edits, a title, or both.");

  // The middle of a passage named by its ends, checked against the version read.
  const named = edits.filter((e): e is Extract<EditSpec, { kind: "replace" }> => e.kind === "replace" && !e.target.quote);
  if (named.length > 0) {
    if (input.version === undefined) {
      throw invalid("A passage named by its start and end needs the version you read it at, so its middle can be checked.");
    }
    const version = BigInt(input.version);
    if (!(await isDocVersion(doc.id, version))) throw invalid("That version isn't in this doc's history.");
    const tail = await docLogTail(doc.id);
    if (tail !== null && version < tail) {
      const then = await loadDocStateAt(doc.id, version);
      const target = flattenForMatch(then.node, then.chips.labels);
      for (const edit of named) {
        const found = resolveQuote(target, edit.target, markdownToText);
        if (found.kind === "none" || found.matches.length === 0) {
          throw new ApiError("no_match", "That passage wasn't in the doc at the version you read.");
        }
        if (found.matches.length > 1) {
          throw new ApiError("ambiguous", "That passage occurred more than once at the version you read; add a prefix or suffix.", {
            total: found.matches.length,
          });
        }
        edit.target.expectText = quotedTextAt(then.node, found.matches[0].from, found.matches[0].to);
        edit.target.expectChips = chipIdentitiesBetween(then.node, found.matches[0].from, found.matches[0].to);
      }
    }
  }

  const warnings = await checkFragmentLinks(ctx.actor, [{ type: "doc", content: written }]);
  const anchors = await anchorsOn(ctx, doc.id);
  const answer = await requestDocEdit({
    docId: doc.id,
    userId: ctx.actor.userId,
    role: ctx.actor.role,
    edits,
    ...(input.title !== undefined ? { title: input.title } : {}),
    annotations: anchors.annotations,
    markAnnotations: anchors.markAnnotations,
    markChips: anchors.markChips,
    linkParts: anchors.linkParts,
    chipInputs: current.chips.inputs,
  });
  if (!answer.ok) {
    if ("refusal" in answer) throw refusalError(answer.refusal, edits.length);
    throw new ApiError("unavailable", answer.unavailable);
  }
  const touchedAnnotations = answer.touched.annotations.map((t) => ({ id: t.id, resolves: t.resolves }));
  const touchedLinks = answer.touched.linkParts.map((t) => ({ link: `/link/${anchors.linkOf.get(t.id)}`, resolves: t.resolves }));
  return {
    url: `/doc/${doc.slug}`,
    version: answer.updateId,
    ...(answer.applied ? {} : { unchanged: true }),
    ...(answer.changed.length > 0 ? { changed: blockList(answer.changed) } : {}),
    // Removing a mention on purpose is allowed, and never silent.
    ...(answer.chips && answer.chips.removed.length > 0 ? { mentionsRemoved: answer.chips.removed } : {}),
    ...(answer.chips && answer.chips.added > 0 ? { mentionsAdded: answer.chips.added } : {}),
    ...(touchedAnnotations.length > 0 || touchedLinks.length > 0
      ? {
          touched: {
            ...(touchedAnnotations.length > 0 ? { annotations: touchedAnnotations } : {}),
            ...(touchedLinks.length > 0 ? { links: touchedLinks } : {}),
          },
        }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

type Hunk = { n: number; summary: Record<string, unknown>; edit: EditSpec | null; title?: string; check: (text: string[]) => boolean };

/**
 * Reverting one edit (§6), from its own row in the doc's log: the doc rebuilt
 * at the row before it and at it differs by exactly that edit, and the
 * alignment turns the difference into hunks — a block changed, added or
 * deleted. They are applied backwards, located by their text now, keeping
 * the marks they had (author colours and notes, from the rebuilt doc rather
 * than given the actor's); a hunk whose text has changed since is reported
 * and skipped, never forced.
 */
export async function revertEditFor(
  ctx: McpContext,
  input: { url: string; revert: string; hunks?: number[]; dryRun?: boolean },
): Promise<ToolResult> {
  const doc = await editableDoc(ctx, input.url);
  const version = BigInt(input.revert);
  if (!(await isDocVersion(doc.id, version))) throw invalid("That version isn't in this doc's history.");
  const previous = await prisma.ydocUpdate.findFirst({
    where: { ydocId: ydocIdForDoc(doc.id), id: { lt: version } },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  if (!previous) throw invalid("That is the doc's first version, which created it; there is nothing before it to go back to.");
  const [before, after] = await Promise.all([loadDocStateAt(doc.id, previous.id), loadDocStateAt(doc.id, version)]);

  const pairs = alignBlocks(
    before.blocks.map((b) => b.text),
    after.blocks.map((b) => b.text),
    { old: before.blocks.map((b) => blockKey(b.node)), new: after.blocks.map((b) => blockKey(b.node)) },
  );
  const hunks: Hunk[] = [];
  let lastAfterText: string | null = null;
  for (const pair of pairs) {
    const b = pair.old !== null ? before.blocks[pair.old] : null;
    const a = pair.new !== null ? after.blocks[pair.new] : null;
    if (b && a && b.node.eq(a.node)) {
      lastAfterText = a.text;
      continue;
    }
    const n = hunks.length + 1;
    if (b && a) {
      hunks.push({
        n,
        summary: { hunk: n, diff: renderWordDiff(diffRuns(b.text, a.text)) },
        edit: { kind: "replaceBlock", text: a.text, block: b.node.toJSON() },
        check: (texts) => texts.filter((t) => t === a.text).length === 1,
      });
    } else if (a) {
      hunks.push({
        n,
        summary: { hunk: n, added: a.text },
        edit: { kind: "deleteBlock", text: a.text },
        check: (texts) => texts.filter((t) => t === a.text).length === 1,
      });
    } else if (b) {
      const afterText = lastAfterText;
      hunks.push({
        n,
        summary: { hunk: n, deleted: b.text },
        edit: { kind: "insertBlock", afterText, block: b.node.toJSON() },
        check: (texts) => afterText === null || texts.filter((t) => t === afterText).length === 1,
      });
    }
    if (a) lastAfterText = a.text;
  }
  if (before.title !== after.title) {
    const n = hunks.length + 1;
    hunks.push({ n, summary: { hunk: n, title: renderWordDiff(diffRuns(before.title, after.title)) }, edit: null, title: before.title, check: () => true });
  }

  if (input.dryRun) {
    return { url: `/doc/${doc.slug}`, revert: input.revert, hunks: hunks.map((h) => h.summary) };
  }
  const wanted = input.hunks ? hunks.filter((h) => input.hunks!.includes(h.n)) : hunks;
  const unknown = (input.hunks ?? []).filter((n) => !hunks.some((h) => h.n === n));
  if (unknown.length > 0) throw invalid(`That edit has ${hunks.length} hunks; there is no hunk ${unknown.slice(0, ERROR_LIST_CAP).join(", ")}.`);
  if (wanted.length === 0) return { url: `/doc/${doc.slug}`, reverted: [], note: "The edit changed nothing to put back." };

  const now = await loadDocState(doc.id);
  const texts = now.blocks.map((b) => b.text);
  const applicable = wanted.filter((h) => h.check(texts));
  const skipped = wanted.filter((h) => !h.check(texts)).map((h) => ({ hunk: h.n, reason: "its text has changed since" }));
  const titleHunk = applicable.find((h) => h.title !== undefined);
  const edits = applicable.flatMap((h) => (h.edit ? [h.edit] : []));
  if (edits.length === 0 && !titleHunk) {
    return { url: `/doc/${doc.slug}`, reverted: [], skipped };
  }
  const anchors = await anchorsOn(ctx, doc.id);
  const answer = await requestDocEdit({
    docId: doc.id,
    userId: ctx.actor.userId,
    role: ctx.actor.role,
    edits,
    keepMarks: true,
    ...(titleHunk ? { title: titleHunk.title } : {}),
    annotations: anchors.annotations,
    markAnnotations: anchors.markAnnotations,
    markChips: anchors.markChips,
    linkParts: anchors.linkParts,
    chipInputs: now.chips.inputs,
  });
  if (!answer.ok) {
    if ("refusal" in answer) throw refusalError(answer.refusal, edits.length);
    throw new ApiError("unavailable", answer.unavailable);
  }
  return {
    url: `/doc/${doc.slug}`,
    version: answer.updateId,
    reverted: applicable.map((h) => h.n),
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(answer.changed.length > 0 ? { changed: blockList(answer.changed) } : {}),
  };
}
