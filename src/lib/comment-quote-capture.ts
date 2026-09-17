import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { prisma } from "./prisma";
import { pmCommentContentSchema, pmSchema, toPlainJSON } from "./tiptap-schema";
import { deriveDocRangeSelector, targetKey, type AnchorTarget, type DocRangeSelector } from "./anchors";
import { commentBodyText } from "./comment-body";
import { flattenForMatch, matchQuoteAcross, type FlatTarget, type QuoteRange } from "./comment-quote-match";
import { applyQuoteResolutions, clearUnassignedAnchorIds, extractQuoteCandidates, type QuoteResolution } from "./comment-quote-extract";
import { isPendingAnchorId, type PendingQuoteHint } from "./comment-quote-pending";
import { isCommentPublic } from "./comment-authz";

// PLAN.md §23n — the server half of the matcher: load the immutable targets
// a comment on this page may quote (§23e's audience rule is the load itself
// — only published posts and public comments are ever candidates), run the
// pure matcher over every candidate span in the body, rewrite the body
// (§23f) and hand back the anchor rows to write beside it.
//
// One function for both front doors and for both submit and edit. A hint —
// the rich composer's pending quotation, or on edit an existing anchor row
// — reorders the candidates and, when it carries offsets, is tried first;
// it is never trusted as the answer. The stored `quoted_text` is always
// `quotedTextAt` a verified range.

/** The most quotations one comment may carry (§23f's count cap). */
export const MAX_QUOTES_PER_COMMENT = 20;

/** The longest quotation, in characters of the typed text (§23f's per-quotation cap). */
export const MAX_QUOTE_CHARS = 2000;

/** The most comments on the page that are loaded as candidates. */
const MAX_COMMENT_CANDIDATES = 200;

export type CommentQuoteHost = {
  postId: string;
  /** The parent when replying — the first candidate searched. */
  parentCommentId: string | null;
  /** The thread's passage anchor in the host post, for the nearest-occurrence rule. */
  threadAnchorFrom: number | null;
  /** On edit, the comment being edited — never its own candidate. */
  editingCommentId?: string | null;
};

/** An existing row on the comment being edited, so its quotation re-pins to the version it already names. */
export type ExistingQuoteAnchor = {
  id: string;
  target: AnchorTarget;
  anchorFrom: number | null;
  anchorTo: number | null;
  anchoredEventId: string | null;
  quotedRevisionId: string | null;
};

export type CommentQuoteAnchorInput = {
  id: string;
  partOrder: number;
  target: AnchorTarget;
  anchorFrom: number;
  anchorTo: number;
  quotedText: string;
  selector: DocRangeSelector;
  anchoredEventId: string | null;
  quotedRevisionId: string | null;
};

export type CapturedQuotes = {
  json: JSONContent;
  text: string;
  anchors: CommentQuoteAnchorInput[];
};

type Candidate = {
  /** `targetKey(target)` plus, for a pinned version, the version — what hints name. */
  key: string;
  target: AnchorTarget;
  flat: FlatTarget;
  anchoredEventId: string | null;
  quotedRevisionId: string | null;
  near?: number;
};

function candidateFromComment(
  comment: { id: string; revisions: { id: string; body: unknown }[] },
  revision: { id: string; body: unknown } | undefined = comment.revisions[0],
  pinned = false,
): Candidate | null {
  if (!revision) return null;
  let node: PMNode;
  try {
    node = pmCommentContentSchema.nodeFromJSON(revision.body as JSONContent);
  } catch {
    return null;
  }
  const target: AnchorTarget = { kind: "comment", id: comment.id };
  return {
    key: pinned ? `${targetKey(target)}@${revision.id}` : targetKey(target),
    target,
    flat: flattenForMatch(node),
    anchoredEventId: null,
    quotedRevisionId: revision.id,
  };
}

function candidateFromEvent(
  postId: string,
  event: { id: string; proseJson: unknown } | null,
  near: number | null,
  pinned = false,
): Candidate | null {
  if (!event?.proseJson) return null;
  let node: PMNode;
  try {
    node = pmSchema.nodeFromJSON(event.proseJson as JSONContent);
  } catch {
    return null;
  }
  const target: AnchorTarget = { kind: "post", id: postId };
  return {
    key: pinned ? `${targetKey(target)}@${event.id}` : targetKey(target),
    target,
    flat: flattenForMatch(node),
    anchoredEventId: event.id,
    quotedRevisionId: null,
    ...(near !== null ? { near } : {}),
  };
}

const COMMENT_CANDIDATE_SELECT = {
  id: true,
  status: true,
  deletedAt: true,
  createdAt: true,
  commenter: { select: { userId: true } },
  thread: { select: { postId: true, post: { select: { id: true, publishedAt: true } } } },
  revisions: { orderBy: { revisionNo: "desc" as const }, take: 1, select: { id: true, body: true } },
} as const;

/**
 * The candidates for one submission, in §23n's priority order: the parent
 * comment, the host post, then the page's other public comments newest
 * first. A pinned version an existing row names comes ahead of its newest,
 * and a target a hint names — the off-page picker's post or comment (Phase
 * 4), which is nowhere in the page's own set — comes right after those,
 * gated by §23e exactly as an on-page candidate is (published, or public).
 * Every comment candidate is public; the host post is published, or it
 * would not be accepting comments.
 */
async function loadCandidates(
  host: CommentQuoteHost,
  existing: ExistingQuoteAnchor[],
  hints: PendingQuoteHint[],
): Promise<Candidate[]> {
  const ordered: Candidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: Candidate | null) => {
    if (candidate && !seen.has(candidate.key)) {
      seen.add(candidate.key);
      ordered.push(candidate);
    }
  };

  const post = await prisma.post.findUnique({
    where: { id: host.postId },
    select: { id: true, publishedAt: true, publishEvent: { select: { id: true, proseJson: true } } },
  });
  if (!post?.publishedAt || post.publishedAt > new Date()) return [];

  // Pinned versions first, so an edit re-pins to what it already quoted.
  for (const row of existing) {
    if (row.target.kind === "comment" && row.quotedRevisionId) {
      const revision = await prisma.commentRevision.findUnique({
        where: { id: row.quotedRevisionId },
        select: { id: true, body: true, comment: { select: COMMENT_CANDIDATE_SELECT } },
      });
      if (revision && revision.comment.thread.postId === host.postId && isCommentPublic(revision.comment)) {
        push(candidateFromComment(revision.comment, revision, true));
      }
    } else if (row.target.kind === "post" && row.anchoredEventId && row.target.id === host.postId) {
      const event = await prisma.postPublicationEvent.findUnique({
        where: { id: row.anchoredEventId },
        select: { id: true, proseJson: true },
      });
      push(candidateFromEvent(host.postId, event, host.threadAnchorFrom, true));
    }
  }

  // Hinted targets, wherever they are — §23e is the load itself.
  for (const hint of hints) {
    if (hint.target.kind === "post" && hint.target.id !== host.postId) {
      const other = await prisma.post.findUnique({
        where: { id: hint.target.id },
        select: { id: true, publishedAt: true, publishEvent: { select: { id: true, proseJson: true } } },
      });
      if (other?.publishedAt && other.publishedAt <= new Date()) push(candidateFromEvent(other.id, other.publishEvent, null));
    } else if (hint.target.kind === "comment") {
      const other = await prisma.comment.findUnique({ where: { id: hint.target.id }, select: COMMENT_CANDIDATE_SELECT });
      if (other && isCommentPublic(other)) push(candidateFromComment(other));
    }
  }

  if (host.parentCommentId) {
    const parent = await prisma.comment.findUnique({ where: { id: host.parentCommentId }, select: COMMENT_CANDIDATE_SELECT });
    if (parent && parent.thread.postId === host.postId && isCommentPublic(parent)) push(candidateFromComment(parent));
  }

  push(candidateFromEvent(host.postId, post.publishEvent, host.threadAnchorFrom));

  const others = await prisma.comment.findMany({
    where: {
      thread: { postId: host.postId },
      status: "APPROVED",
      deletedAt: null,
      ...(host.editingCommentId ? { id: { not: host.editingCommentId } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: MAX_COMMENT_CANDIDATES,
    select: COMMENT_CANDIDATE_SELECT,
  });
  for (const comment of others) {
    if (isCommentPublic(comment)) push(candidateFromComment(comment));
  }

  return ordered;
}

/**
 * Finds every quotation in `node`, rewrites the body and returns the anchor
 * rows to store. A body with no candidate spans costs no query at all.
 */
export async function captureCommentQuotes(opts: {
  node: PMNode;
  host: CommentQuoteHost;
  hints: PendingQuoteHint[];
  existing?: ExistingQuoteAnchor[];
}): Promise<CapturedQuotes> {
  const { node, host, hints } = opts;
  const existing = opts.existing ?? [];
  const unchanged = () => ({ json: toPlainJSON(node.toJSON() as JSONContent), text: commentBodyText(node), anchors: [] });

  const candidatesInBody = extractQuoteCandidates(node);
  if (candidatesInBody.length === 0 && existing.length === 0) {
    return unchanged();
  }

  const targets = await loadCandidates(host, existing, hints);
  const hintsById = new Map(hints.filter((hint) => hint.id !== null).map((hint) => [hint.id, hint]));
  const existingById = new Map(existing.map((row) => [row.id, row]));

  const resolutions: QuoteResolution[] = [];
  const anchors: CommentQuoteAnchorInput[] = [];

  for (const span of candidatesInBody) {
    if (anchors.length >= MAX_QUOTES_PER_COMMENT || span.text.length > MAX_QUOTE_CHARS || !span.text.trim()) {
      resolutions.push({ candidate: span, anchorId: null });
      continue;
    }

    // What the body already says about this span, as a hint for the matcher.
    let hint: { key: string; range?: QuoteRange } | undefined;
    if (span.anchorId && isPendingAnchorId(span.anchorId)) {
      const pending = hintsById.get(span.anchorId);
      if (pending) {
        const key = targetKey({ kind: pending.target.kind, id: pending.target.id });
        hint = { key, range: pending.from !== undefined && pending.to !== undefined ? { from: pending.from, to: pending.to } : undefined };
      }
    } else if (span.anchorId) {
      const row = existingById.get(span.anchorId);
      if (row) {
        const version = row.target.kind === "comment" ? row.quotedRevisionId : row.anchoredEventId;
        hint = {
          key: version ? `${targetKey(row.target)}@${version}` : targetKey(row.target),
          range: row.anchorFrom !== null && row.anchorTo !== null ? { from: row.anchorFrom, to: row.anchorTo } : undefined,
        };
      }
    }

    const found = matchQuoteAcross(
      targets.map((candidate) => ({ key: candidate.key, target: candidate.flat, near: candidate.near })),
      span.text,
      hint,
    );
    if (!found) {
      resolutions.push({ candidate: span, anchorId: null });
      continue;
    }
    const winner = targets.find((candidate) => candidate.key === found.key)!;
    const anchorId = randomUUID();
    resolutions.push({
      candidate: span,
      anchorId,
      source: winner.flat.node,
      from: found.match.from,
      to: found.match.to,
      quotedText: found.match.quotedText,
    });
    anchors.push({
      id: anchorId,
      partOrder: anchors.length,
      target: winner.target,
      anchorFrom: found.match.from,
      anchorTo: found.match.to,
      quotedText: found.match.quotedText,
      selector: deriveDocRangeSelector(winner.flat.node, found.match.from, found.match.to),
      anchoredEventId: winner.anchoredEventId,
      quotedRevisionId: winner.quotedRevisionId,
    });
  }

  const rewritten = applyQuoteResolutions(node, resolutions);
  rewritten.check();
  const json = clearUnassignedAnchorIds(
    toPlainJSON(rewritten.toJSON() as JSONContent),
    new Set(anchors.map((anchor) => anchor.id)),
  );
  return { json, text: commentBodyText(rewritten), anchors };
}
