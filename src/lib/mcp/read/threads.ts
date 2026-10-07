import type { JSONContent } from "@tiptap/core";
import { prisma } from "@/lib/prisma";
import { readableAnnotationsWhere, postedAnnotationWhere } from "@/lib/annotation-authz";
import { visibleAnnotationEditDates } from "@/lib/annotation-data";
import { resolveAnnotationRangesInNode, collectAnnotationMarkRanges } from "@/lib/annotation-marks";
import { annotationAnchorName } from "@/lib/annotation-anchor-name";
import { annotationHistoryFor } from "@/lib/annotation-history";
import { annotationContentToMarkdown } from "@/lib/markdown-import";
import { displayNameOf } from "@/lib/display-name";
import { docTitleOrFallback } from "@/lib/doc-title";
import { parsePdfTarget } from "@/lib/pdf-anchor";
import { blocksOfRange, headingAbove, type BlockSpan } from "@/lib/doc-text";
import { loadDocState, loadDocStateAt, type DocState } from "@/lib/doc-state";
import { searchAuthorOptions } from "@/lib/search/authors";
import { searchActorOf } from "@/lib/actor";
import { ApiError, ERROR_LIST_CAP, invalid, notFound } from "@/lib/api/errors";
import { canUserReadDoc } from "@/lib/doc-authz";
import { canUserReadFile } from "@/lib/file-authz";
import type { McpContext, ToolResult } from "../tool";
import { clip, decodeCursor, encodeCursor, minuteOf, pageOf } from "../shape";
import type { ReadArgs } from "./args";
import { pdfLabels } from "./pdf-meta";

// docs/MCP.md §9 — annotation threads as the MCP server reads them: a
// container's, filtered, ordered by the document and paged; every readable
// container's at /annotations; and one thread read alone.
//
// Every listing goes through `postedAnnotationWhere` or
// `readableAnnotationsWhere` (CLAUDE.md), so a DRAFT — a private note, its
// writer's alone — is never among them. Each writer is a name, never an
// email, and history runs through edit-grace.ts on the server, exactly as the
// UI runs it, because the existence of a silent edit is the thing withheld.

/** Threads per page, by default (§4). */
const THREADS_PER_PAGE = 20;
/** How much of a passage a thread in a list carries; a thread read alone carries it whole. */
const PASSAGE_CHARS = 300;
/** A reply's quote of its parent's body, in a list. */
const REPLY_QUOTE_CHARS = 200;

const ROW_SELECT = {
  id: true,
  docId: true,
  fileId: true,
  parentAnnotationId: true,
  userId: true,
  status: true,
  postedAt: true,
  createdAt: true,
  deletedByUserId: true,
  anchorFrom: true,
  anchorTo: true,
  quotedText: true,
  ydocUpdateId: true,
  pdfTarget: true,
  proseJson: true,
  bodyText: true,
  user: { select: { name: true, slug: true } },
} as const;

type Row = {
  id: string;
  docId: string | null;
  fileId: string | null;
  parentAnnotationId: string | null;
  userId: string;
  status: "DRAFT" | "LIVE" | "RAISED";
  postedAt: Date | null;
  createdAt: Date;
  deletedByUserId: string | null;
  anchorFrom: number | null;
  anchorTo: number | null;
  quotedText: string;
  ydocUpdateId: bigint | null;
  pdfTarget: unknown;
  proseJson: unknown;
  bodyText: string;
  user: { name: string | null; slug: string };
};

type Thread = {
  root: Row;
  members: Row[];
  /** When each live member last did something readers are told about: posted, or visibly edited. */
  activity: Map<string, Date>;
  edited: Map<string, Date | null>;
};

function groupThreads(rows: Row[], edited: Map<string, Date | null>): Thread[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const rootOf = (row: Row): Row => {
    let current = row;
    const seen = new Set<string>();
    while (current.parentAnnotationId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parentAnnotationId);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const threads = new Map<string, Thread>();
  for (const row of rows) {
    const root = rootOf(row);
    let thread = threads.get(root.id);
    if (!thread) {
      thread = { root, members: [], activity: new Map(), edited };
      threads.set(root.id, thread);
    }
    thread.members.push(row);
    if (row.deletedByUserId === null) {
      const posted = row.postedAt ?? row.createdAt;
      const edit = edited.get(row.id) ?? null;
      thread.activity.set(row.id, edit && edit > posted ? edit : posted);
    }
  }
  // A thread whose every entry is deleted shows nothing; one with a deleted
  // root and live replies keeps the root's place, as the page's tombstone does.
  return [...threads.values()].filter((thread) => thread.activity.size > 0);
}

/** The newest thing a thread's readers were told about. */
function latestOf(thread: Thread): { at: Date; userId: string } | null {
  let latest: { at: Date; userId: string } | null = null;
  for (const member of thread.members) {
    const at = thread.activity.get(member.id);
    if (at && (!latest || at > latest.at)) latest = { at, userId: member.userId };
  }
  return latest;
}

type ThreadFilter = {
  by?: Set<string>;
  notBy?: Set<string>;
  awaiting?: Set<string>;
  activeSince?: Date;
  status?: "LIVE" | "RAISED";
};

function passes(thread: Thread, filter: ThreadFilter): boolean {
  const live = thread.members.filter((m) => m.deletedByUserId === null);
  if (filter.status && thread.root.status !== filter.status) return false;
  if (filter.by && !live.some((m) => filter.by!.has(m.userId))) return false;
  if (filter.notBy && live.some((m) => filter.notBy!.has(m.userId))) return false;
  if (filter.activeSince && ![...thread.activity.values()].some((at) => at >= filter.activeSince!)) return false;
  if (filter.awaiting) {
    const latest = latestOf(thread);
    if (!latest || filter.awaiting.has(latest.userId)) return false;
  }
  return true;
}

/**
 * The threads filters, with writers named by slug turned into user ids.
 *
 * **A slug outside what the reader can already see is `unknown_author`**, so
 * a typo isn't read as "no threads", or as all of them. What the reader can
 * see is the actor, the issuer, the author picker's slugs (search), and the
 * writers in the readable threads being filtered — a writer need not be on
 * any byline to annotate — so naming the refused slugs tells it nothing new.
 */
async function compileFilter(ctx: McpContext, args: ReadArgs, rows: Row[]): Promise<ThreadFilter> {
  const spec = args.threads ?? {};
  const named = [
    ...(spec.by ?? []),
    ...(spec.notBy ?? []),
    ...(spec.awaiting && spec.awaiting !== true ? spec.awaiting : []),
  ];
  const ids = new Map<string, string>();
  if (named.length > 0) {
    const visible = new Map<string, string>([
      [ctx.token.user.slug, ctx.token.user.id],
      [ctx.token.issuer.slug, ctx.token.issuer.id],
    ]);
    for (const row of rows) visible.set(row.user.slug, row.userId);
    const unknown = named.filter((slug) => !visible.has(slug));
    if (unknown.length > 0) {
      const picker = await searchAuthorOptions(searchActorOf(ctx.actor), "viewer");
      for (const option of picker) visible.set(option.slug, option.id);
    }
    const stillUnknown = [...new Set(named.filter((slug) => !visible.has(slug)))];
    if (stillUnknown.length > 0) {
      throw new ApiError("unknown_author", "No writer you can see has that slug.", {
        slugs: stillUnknown.slice(0, ERROR_LIST_CAP),
      });
    }
    for (const slug of named) ids.set(slug, visible.get(slug)!);
  }
  const set = (slugs: string[] | undefined) => (slugs ? new Set(slugs.map((slug) => ids.get(slug)!)) : undefined);
  let activeSince: Date | undefined;
  if (spec.activeSince) {
    activeSince = new Date(`${spec.activeSince}T00:00:00Z`);
    if (Number.isNaN(activeSince.getTime())) throw invalid("activeSince is a day, YYYY-MM-DD.");
  }
  return {
    by: set(spec.by),
    notBy: set(spec.notBy),
    awaiting: spec.awaiting === true ? new Set([ctx.actor.userId]) : set(spec.awaiting),
    activeSince,
    status: spec.status,
  };
}

async function loadRows(where: { docId: string } | { fileId: string }): Promise<Row[]> {
  return prisma.annotation.findMany({
    where: { ...where, ...postedAnnotationWhere() },
    orderBy: { createdAt: "asc" },
    select: ROW_SELECT,
  });
}

/** An entry's body: its settled text, as Markdown (§9: the cache is the last settled body). */
function bodyOf(row: Row, format: "markdown" | "text"): string {
  if (format === "text" || !row.proseJson) return row.bodyText;
  try {
    return annotationContentToMarkdown(row.proseJson as JSONContent).trim();
  } catch {
    return row.bodyText;
  }
}

function entryOf(thread: Thread, row: Row, format: "markdown" | "text", full: boolean): Record<string, unknown> {
  const isRoot = row.id === thread.root.id;
  if (row.deletedByUserId !== null) {
    return { id: row.id, deleted: true, ...(!isRoot && row.parentAnnotationId !== thread.root.id ? { replyTo: row.parentAnnotationId } : {}) };
  }
  const edited = thread.edited.get(row.id) ?? null;
  return {
    id: row.id,
    by: displayNameOf(row.user),
    at: minuteOf(row.postedAt ?? row.createdAt),
    ...(edited ? { edited: minuteOf(edited) } : {}),
    ...(row.status === "RAISED" && isRoot ? { status: "RAISED" } : {}),
    ...(!isRoot && row.parentAnnotationId !== thread.root.id ? { replyTo: row.parentAnnotationId } : {}),
    // A reply anchored into its parent's body carries what it quoted there.
    ...(!isRoot && row.anchorFrom !== null && row.quotedText
      ? { quote: full ? row.quotedText : clip(row.quotedText, REPLY_QUOTE_CHARS) }
      : {}),
    body: bodyOf(row, format),
  };
}

type Placed = {
  thread: Thread;
  /** Where the root's passage resolves now, or null. */
  range: { from: number; to: number } | null;
  /** The passage's text: resolved now, or the stored quote of one that no longer resolves. */
  passage: string;
  lost: boolean;
  /** Sort keys, and the group the thread goes under. */
  order: number;
  group: string | null;
  page?: number;
  label?: string;
  blocks?: BlockSpan;
};

/** Each thread placed in a doc: where its passage resolves, and the heading over it. */
function placeInDoc(threads: Thread[], state: DocState): Placed[] {
  const ranges = resolveAnnotationRangesInNode(
    state.node,
    threads.map((t) => ({ id: t.root.id, anchorFrom: t.root.anchorFrom, anchorTo: t.root.anchorTo, quotedText: t.root.quotedText })),
  );
  return threads.map((thread) => {
    const range = ranges.get(thread.root.id) ?? null;
    if (!range) {
      return {
        thread,
        range: null,
        passage: thread.root.quotedText,
        // A column anchor keeps its quote once it stops resolving; a mark
        // keeps nothing, and a note on the whole doc never had a passage.
        lost: thread.root.quotedText !== "",
        order: Number.MAX_SAFE_INTEGER,
        group: null,
      };
    }
    const blocks = blocksOfRange(state.blocks, range.from, range.to) ?? undefined;
    const heading = blocks ? headingAbove(state.blocks, blocks.from) : null;
    return {
      thread,
      range,
      passage: state.node.textBetween(range.from, range.to, " "),
      lost: false,
      order: range.from,
      group: heading?.heading?.text ?? null,
      blocks,
    };
  });
}

/** Each thread placed in a PDF: by page, then by where on the page its quote starts. */
function placeInPdf(threads: Thread[], labels: string[] | null): Placed[] {
  return threads.map((thread) => {
    const target = parsePdfTarget(thread.root.pdfTarget);
    if (!target) {
      return { thread, range: null, passage: thread.root.quotedText, lost: false, order: Number.MAX_SAFE_INTEGER, group: null };
    }
    return {
      thread,
      range: null,
      passage: target.quote.exact,
      lost: false,
      order: target.pageIndex * 1_000_000 + (target.position?.start ?? 0),
      group: `page ${target.pageIndex + 1}`,
      page: target.pageIndex + 1,
      ...(labels ? { label: labels[target.pageIndex] } : {}),
    };
  });
}

function sortPlaced(placed: Placed[]): Placed[] {
  return placed.sort(
    (a, b) =>
      a.order - b.order ||
      (a.thread.root.postedAt ?? a.thread.root.createdAt).getTime() - (b.thread.root.postedAt ?? b.thread.root.createdAt).getTime(),
  );
}

function threadOut(p: Placed, format: "markdown" | "text", full: boolean): Record<string, unknown> {
  const root = p.thread.root;
  const passage = p.passage
    ? {
        text: full ? p.passage : clip(p.passage, PASSAGE_CHARS),
        ...(p.blocks ? { blocks: p.blocks.from === p.blocks.to ? String(p.blocks.from) : `${p.blocks.from}-${p.blocks.to}` } : {}),
        ...(p.lost ? { lost: true } : {}),
      }
    : undefined;
  const [first, ...rest] = p.thread.members;
  return {
    ...entryOf(p.thread, first, format, full),
    ...(root.ydocUpdateId !== null && root.docId !== null ? { version: root.ydocUpdateId.toString() } : {}),
    ...(passage ? { passage } : {}),
    ...(rest.length > 0 ? { replies: rest.map((row) => entryOf(p.thread, row, format, full)) } : {}),
  };
}

/** Threads under the group their passage sits in — a doc's heading, a PDF's page — said once per group (§9). */
function grouped(placed: Placed[], format: "markdown" | "text"): Record<string, unknown>[] {
  const groups: Record<string, unknown>[] = [];
  let current: { key: string | null; threads: Record<string, unknown>[] } | null = null;
  for (const p of placed) {
    const key = p.group;
    if (!current || current.key !== key) {
      current = { key, threads: [] };
      const header: Record<string, unknown> =
        p.page !== undefined ? { page: p.page, ...(p.label ? { label: p.label } : {}) } : key ? { heading: key } : { unanchored: true };
      groups.push({ ...header, threads: current.threads });
    }
    current.threads.push(threadOut(p, format, false));
  }
  return groups;
}

/**
 * A container's threads, for `read` with `include: ["annotations"]`:
 * filtered under `threads`, in the document's order, paged on their own, and
 * — for a ranged read — only those whose passage lies in the range.
 */
export async function containerThreads(
  ctx: McpContext,
  container: { kind: "doc"; docId: string; state: DocState } | { kind: "file"; fileId: string },
  args: ReadArgs,
  span: BlockSpan | null,
): Promise<ToolResult> {
  const rows = await loadRows(container.kind === "doc" ? { docId: container.docId } : { fileId: container.fileId });
  const filter = await compileFilter(ctx, args, rows);
  const edited = await visibleAnnotationEditDates(rows.map((r) => r.id));
  const threads = groupThreads(rows, edited).filter((thread) => passes(thread, filter));
  let placed =
    container.kind === "doc"
      ? placeInDoc(threads, container.state)
      : placeInPdf(threads, await pdfLabels(container.fileId));
  if (span) {
    placed = placed.filter((p) => p.blocks && p.blocks.to >= span.from && p.blocks.from <= span.to);
  }
  sortPlaced(placed);
  const page = pageOf(placed, decodeCursor(args.threads?.cursor, args.threads?.limit ?? THREADS_PER_PAGE));
  return {
    total: placed.length,
    groups: grouped(page.items, args.format ?? "markdown"),
    ...(page.next ? { next: page.next } : {}),
  };
}

/**
 * Every readable container's threads at once — `read` of /annotations.
 * Through `readableAnnotationsWhere`, as the admin table is, but without its
 * `includeDeletedContainers` (a thread on a deleted doc or PDF isn't listed,
 * since its container's page refuses it) and without its page gate: what it
 * lists is readable already, as in search. Grouped by container, the one with
 * the newest activity first; within one, the document's order.
 */
export async function allThreads(ctx: McpContext, args: ReadArgs): Promise<ToolResult> {
  const where = readableAnnotationsWhere(ctx.actor.userId, ctx.actor.role);
  if (!where) return { kind: "threads", total: 0, containers: [] };
  const rows: Row[] = await prisma.annotation.findMany({ where, orderBy: { createdAt: "asc" }, select: ROW_SELECT });
  const filter = await compileFilter(ctx, args, rows);
  const edited = await visibleAnnotationEditDates(rows.map((r) => r.id));
  const threads = groupThreads(rows, edited).filter((thread) => passes(thread, filter));

  const byContainer = new Map<string, { kind: "doc" | "file"; id: string; threads: Thread[]; newest: number }>();
  for (const thread of threads) {
    const kind = thread.root.docId !== null ? "doc" : "file";
    const id = (thread.root.docId ?? thread.root.fileId)!;
    const key = `${kind}:${id}`;
    const entry = byContainer.get(key) ?? { kind, id, threads: [], newest: 0 };
    entry.threads.push(thread);
    entry.newest = Math.max(entry.newest, latestOf(thread)?.at.getTime() ?? 0);
    byContainer.set(key, entry);
  }
  const containers = [...byContainer.values()].sort((a, b) => b.newest - a.newest || a.id.localeCompare(b.id));

  // Which containers the page window touches, by thread count, so only those
  // are loaded and ordered.
  const cursor = decodeCursor(args.threads?.cursor, args.threads?.limit ?? THREADS_PER_PAGE);
  const total = threads.length;
  const out: Record<string, unknown>[] = [];
  let seen = 0;
  for (const c of containers) {
    const start = seen;
    seen += c.threads.length;
    if (seen <= cursor.offset || start >= cursor.offset + cursor.size) continue;
    let placed: Placed[];
    let head: Record<string, unknown>;
    if (c.kind === "doc") {
      const doc = await prisma.doc.findUnique({ where: { id: c.id }, select: { slug: true, title: true } });
      if (!doc) continue;
      placed = placeInDoc(c.threads, await loadDocState(c.id));
      head = { url: `/doc/${doc.slug}`, title: docTitleOrFallback(doc.title) };
    } else {
      const file = await prisma.storedFile.findUnique({ where: { id: c.id }, select: { slug: true, title: true } });
      if (!file) continue;
      placed = placeInPdf(c.threads, await pdfLabels(c.id));
      head = { url: `/pdf/${file.slug}`, title: file.title };
    }
    sortPlaced(placed);
    const from = Math.max(0, cursor.offset - start);
    const to = Math.min(placed.length, cursor.offset + cursor.size - start);
    out.push({ ...head, groups: grouped(placed.slice(from, to), args.format ?? "markdown") });
  }
  const nextOffset = cursor.offset + cursor.size;
  return {
    kind: "threads",
    total,
    containers: out,
    ...(nextOffset < total ? { next: encodeCursor({ offset: nextOffset, size: cursor.size }) } : {}),
  };
}

/**
 * One thread read alone, by its root's or any entry's id: its card's link
 * (the container's URL and the card's fragment, which changes when a writer
 * renames themselves — the id is the durable handle), its passage whole, and
 * for a note made in the editor whose mark is gone, the passage it had at its
 * stamp, where its mark is by construction (`check-annotation-anchors`'
 * `mark-at-stamp`).
 */
export async function oneThread(ctx: McpContext, annotationId: string, args: ReadArgs): Promise<ToolResult> {
  const target = await prisma.annotation.findUnique({
    where: { id: annotationId },
    select: {
      id: true,
      status: true,
      userId: true,
      docId: true,
      fileId: true,
      doc: { select: { id: true, slug: true, title: true, visibility: true, deletedByUserId: true } },
      file: { select: { id: true, slug: true, title: true, visibility: true, deletedByUserId: true } },
    },
  });
  // A DRAFT is its writer's alone and never read through here, the writer's
  // own included: the MCP server lists no drafts (§9).
  if (!target || target.status === "DRAFT") throw notFound("That annotation");
  const readable = target.doc
    ? target.doc.deletedByUserId === null && (await canUserReadDoc(ctx.actor.userId, ctx.actor.role, target.doc))
    : target.file
      ? target.file.deletedByUserId === null && (await canUserReadFile(ctx.actor.userId, ctx.actor.role, target.file))
      : false;
  if (!readable) throw notFound("That annotation");

  const rows = await loadRows(target.docId ? { docId: target.docId } : { fileId: target.fileId! });
  const edited = await visibleAnnotationEditDates(rows.map((r) => r.id));
  const thread = groupThreads(rows, edited).find((t) => t.members.some((m) => m.id === annotationId));
  if (!thread) throw notFound("That annotation");
  const format = args.format ?? "markdown";

  let placed: Placed;
  let container: Record<string, unknown>;
  if (target.doc) {
    const state = await loadDocState(target.doc.id);
    placed = placeInDoc([thread], state)[0];
    if (!placed.range && thread.root.anchorFrom === null && thread.root.ydocUpdateId !== null) {
      const atStamp = await passageAtStamp(target.doc.id, thread.root.id, thread.root.ydocUpdateId);
      if (atStamp) placed = { ...placed, passage: atStamp, lost: true };
    }
    container = { url: `/doc/${target.doc.slug}`, title: docTitleOrFallback(target.doc.title) };
  } else {
    placed = placeInPdf([thread], await pdfLabels(target.file!.id))[0];
    container = {
      url: `/pdf/${target.file!.slug}`,
      title: target.file!.title,
      ...(placed.page ? { page: placed.page, ...(placed.label ? { label: placed.label } : {}) } : {}),
    };
  }
  const heading = placed.group && !placed.page ? { heading: placed.group } : {};
  const root = thread.root;
  const card = `${container.url}#${annotationAnchorName(displayNameOf(root.user), root.createdAt)}`;

  let history: Record<string, unknown>[] | undefined;
  if (args.history) {
    const versions = await annotationHistoryFor(ctx.actor, annotationId);
    history = versions.map((v) => ({
      version: v.revisionNo,
      at: minuteOf(new Date(v.createdAt)),
      ...(v.authorName ? { by: v.authorName } : {}),
      ...(v.current ? { current: true } : {}),
      body: format === "text" || !v.proseJson ? v.bodyText : annotationContentToMarkdown(v.proseJson as JSONContent).trim(),
    }));
  }

  return {
    kind: "thread",
    container,
    ...heading,
    card,
    ...threadOut(placed, format, true),
    ...(history ? { history } : {}),
  };
}

/** A mark-anchored note's passage at its stamp, where its mark is by construction; null if it isn't there either. */
async function passageAtStamp(docId: string, annotationId: string, stamp: bigint): Promise<string | null> {
  try {
    const state = await loadDocStateAt(docId, stamp);
    const range = collectAnnotationMarkRanges(state.node).get(annotationId);
    return range ? state.node.textBetween(range.from, range.to, " ") : null;
  } catch (err) {
    console.error(`[mcp] couldn't rebuild ${docId} at ${stamp} for ${annotationId}:`, err);
    return null;
  }
}

/**
 * The annotation a card's fragment names on a container's page: its writer's
 * display name and the second it was created (annotation-anchor-name.ts). The
 * id is surer — a fragment breaks when its writer renames themselves.
 */
export async function annotationByFragment(
  container: { docId: string } | { fileId: string },
  fragment: string,
): Promise<string | null> {
  const match = /-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(fragment);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  if (Number.isNaN(at.getTime())) return null;
  const candidates = await prisma.annotation.findMany({
    where: { ...container, ...postedAnnotationWhere(), createdAt: { gte: at, lt: new Date(at.getTime() + 1000) } },
    select: { id: true, createdAt: true, user: { select: { name: true } } },
  });
  const found = candidates.filter((c) => annotationAnchorName(displayNameOf(c.user), c.createdAt) === fragment);
  // A card's name is its writer and the second it was opened, so two notes
  // one writer opened within a second share it; the page jumps to the first,
  // and a guess here could reply to the wrong one.
  if (found.length > 1) {
    throw new ApiError("ambiguous", "Two notes share that card's name; use the annotation's id instead.", {
      ids: found.map((c) => c.id).slice(0, ERROR_LIST_CAP),
    });
  }
  return found[0]?.id ?? null;
}
