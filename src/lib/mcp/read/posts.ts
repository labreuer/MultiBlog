import type { JSONContent } from "@tiptap/core";
import { prisma } from "@/lib/prisma";
import { derivePostStatus, readablePostWhere } from "@/lib/post-status";
import { postPath } from "@/lib/post-path";
import { publicCommentsWhere, canUserReadComment, isCommentPublic } from "@/lib/comment-authz";
import { isCommentVisiblyEdited } from "@/lib/comment-data";
import { loadCommentQuoteCitations } from "@/lib/comment-quote-data";
import { commentAnchorName } from "@/lib/comment-anchor-name";
import { commentHistoryFor, READABLE_COMMENT_INCLUDE } from "@/lib/comment-reading";
import { commentContentToMarkdown, docContentToMarkdown } from "@/lib/markdown-import";
import { canUserReadDoc } from "@/lib/doc-authz";
import { extractText } from "@/lib/diff";
import { tagsForTarget } from "@/lib/tag-data";
import { viewerOf } from "@/lib/actor";
import { notFound } from "@/lib/api/errors";
import type { McpContext, ToolResult } from "../tool";
import { bylineOf, dayOf, minuteOf } from "../shape";
import type { ReadArgs } from "./args";

// docs/MCP.md §13 — posts and comments, read only. The MCP server writes
// neither; it reads them because search returns them, and each read is behind
// the rule search found the row with, or a wider one, so a hit never leads to
// `not_found` and `not_found` never reveals a hit.

const POST_SELECT = {
  id: true,
  slug: true,
  title: true,
  publishedAt: true,
  publishEventId: true,
  proseJson: true,
  docId: true,
  authors: { orderBy: { bylineOrder: "asc" }, select: { user: { select: { name: true } } } },
} as const;

/** A post by its public path's slug (past slugs followed) or its id, through `readablePostWhere`. */
async function readablePost(ctx: McpContext, by: { slug: string } | { id: string }) {
  const readable = readablePostWhere(ctx.actor.userId, ctx.actor.role);
  if ("id" in by) {
    return prisma.post.findFirst({ where: { AND: [{ id: by.id }, readable] }, select: POST_SELECT });
  }
  const current = await prisma.post.findFirst({ where: { AND: [{ slug: by.slug }, readable] }, select: POST_SELECT });
  if (current) return current;
  const history = await prisma.postSlugHistory.findFirst({ where: { slug: by.slug }, select: { postId: true } });
  return history ? prisma.post.findFirst({ where: { AND: [{ id: history.postId }, readable] }, select: POST_SELECT }) : null;
}

/**
 * `read` of a post: its text is the publication's (`Post.proseJson`, fixed
 * until the next publish), so no rebuild and no `version` — the publication's
 * id instead, the axis comment anchors are stamped on. Its doc is named only
 * to someone who may read the doc: a post's byline grants nothing over it, and
 * a published post doesn't tell its readers where it came from.
 */
export async function readPost(
  ctx: McpContext,
  by: { slug: string } | { id: string },
  fragment: string,
  args: ReadArgs,
): Promise<ToolResult> {
  const post = await readablePost(ctx, by);
  if (!post) throw notFound("That post");
  if (fragment) return readComment(ctx, post, fragment, args);

  const status = derivePostStatus(post);
  const url = status === "published" ? postPath(post) : `/post/${post.id}/edit`;
  const format = args.format ?? "markdown";
  const doc = post.docId
    ? await prisma.doc.findUnique({ where: { id: post.docId }, select: { id: true, slug: true, visibility: true } })
    : null;
  const showDoc = doc !== null && (await canUserReadDoc(ctx.actor.userId, ctx.actor.role, doc));
  const chips = await tagsForTarget({ kind: "post", id: post.id });
  const body = post.proseJson
    ? format === "text"
      ? extractText(post.proseJson)
      : docContentToMarkdown(post.proseJson as JSONContent).trim()
    : null;

  return {
    kind: "post",
    id: post.id,
    url,
    title: post.title,
    status,
    ...(status !== "draft" && post.publishedAt ? { published: dayOf(post.publishedAt) } : {}),
    byline: bylineOf(post.authors.map((a) => a.user)),
    ...(post.publishEventId ? { publication: post.publishEventId } : {}),
    ...(showDoc ? { doc: { id: doc!.id, url: `/doc/${doc!.slug}` } } : {}),
    ...(chips.length > 0 ? { tags: chips.map((chip) => ({ name: chip.name, slug: chip.slug })) } : {}),
    ...(body !== null
      ? { [format]: body }
      : { note: "Never published or scheduled, so it has no text of its own; its words are in its doc." }),
    ...(args.include?.includes("comments") ? { comments: await postComments(post, url, format) } : {}),
  };
}

/**
 * The post page's public comments, in threads, in the page's order:
 * `publicCommentsWhere` with the post's id — so an unpublished post lists
 * none, and pending comments are left out even for a moderator (moderation is
 * /comments', outside the MCP server). A deleted comment with public replies
 * keeps its place as the page's tombstone does: its id and parent, no body,
 * no name.
 */
async function postComments(post: { id: string; publishEventId: string | null }, url: string, format: "markdown" | "text") {
  const comments = await prisma.comment.findMany({
    where: { AND: [publicCommentsWhere(), { thread: { postId: post.id } }] },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      threadId: true,
      parentCommentId: true,
      body: true,
      bodyText: true,
      createdAt: true,
      editedAt: true,
      commenter: { select: { displayName: true } },
      revisions: { orderBy: { revisionNo: "asc" }, select: { createdAt: true, quotedBy: { select: { id: true }, take: 1 } } },
    },
  });
  const ids = new Set(comments.map((c) => c.id));
  const missingParents = [...new Set(comments.map((c) => c.parentCommentId).filter((id): id is string => !!id && !ids.has(id)))];
  const tombstones = missingParents.length
    ? await prisma.comment.findMany({
        where: { id: { in: missingParents }, deletedAt: { not: null } },
        select: { id: true, threadId: true, parentCommentId: true, createdAt: true },
      })
    : [];
  const threadIds = [...new Set([...comments, ...tombstones].map((c) => c.threadId))];
  const threads = await prisma.commentThread.findMany({
    where: { id: { in: threadIds } },
    orderBy: { createdAt: "asc" },
    select: { id: true, quotedText: true, status: true, anchoredEventId: true },
  });

  return threads.map((thread) => {
    const entries = [
      ...tombstones.filter((t) => t.threadId === thread.id).map((t) => ({ at: t.createdAt, out: { id: t.id, deleted: true, ...(t.parentCommentId ? { replyTo: t.parentCommentId } : {}) } })),
      ...comments
        .filter((c) => c.threadId === thread.id)
        .map((c) => {
          const visiblyEdited = isCommentVisiblyEdited(c);
          return {
            at: c.createdAt,
            out: {
              url: `${url}#${commentAnchorName(c.commenter.displayName, c.createdAt)}`,
              by: c.commenter.displayName,
              at: minuteOf(c.createdAt),
              ...(visiblyEdited && c.editedAt ? { edited: minuteOf(c.editedAt) } : {}),
              ...(c.parentCommentId ? { replyTo: c.parentCommentId } : {}),
              id: c.id,
              body: format === "text" ? c.bodyText : commentContentToMarkdown(c.body as JSONContent).trim(),
            },
          };
        }),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    return {
      ...(thread.quotedText ? { quote: thread.quotedText } : {}),
      ...(thread.status === "DETACHED" ? { detached: true } : {}),
      ...(thread.quotedText && thread.anchoredEventId && thread.anchoredEventId !== post.publishEventId
        ? { publication: thread.anchoredEventId }
        : {}),
      comments: entries.map((e) => e.out),
    };
  });
}

/**
 * One comment, by its card's fragment on its post's page — the name its
 * commenter row was made with and the second it was posted, which never
 * changes. Through `canUserReadComment`: anyone for a public comment, its own
 * writer, and the post's moderators. Never the commenter's email, user id or
 * IP: a display name is fixed when the commenter row is made, and an id beside
 * it would tie an old name to a renamed account.
 */
async function readComment(
  ctx: McpContext,
  post: { id: string; slug: string; publishedAt: Date | null; publishEventId: string | null },
  fragment: string,
  args: ReadArgs,
): Promise<ToolResult> {
  const match = /-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(fragment);
  if (!match) throw notFound("That comment");
  const [, y, mo, d, h, mi, s] = match;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  if (Number.isNaN(at.getTime())) throw notFound("That comment");
  const candidates = await prisma.comment.findMany({
    where: { thread: { postId: post.id }, createdAt: { gte: at, lt: new Date(at.getTime() + 1000) } },
    include: {
      ...READABLE_COMMENT_INCLUDE,
      commenter: { select: { userId: true, displayName: true } },
      revisions: { orderBy: { revisionNo: "asc" }, select: { createdAt: true, quotedBy: { select: { id: true }, take: 1 } } },
    },
  });
  const comment = candidates.find((c) => commentAnchorName(c.commenter.displayName, c.createdAt) === fragment);
  if (!comment || !(await canUserReadComment(viewerOf(ctx.actor), comment))) throw notFound("That comment");

  const format = args.format ?? "markdown";
  const visiblyEdited = isCommentVisiblyEdited(comment);
  const citations = (await loadCommentQuoteCitations([comment.id])).get(comment.id) ?? {};
  const status = derivePostStatus(post);
  const postUrl = status === "published" ? postPath(post) : `/post/${post.id}/edit`;
  const result: ToolResult = {
    kind: "comment",
    url: `${postUrl}#${fragment}`,
    id: comment.id,
    by: comment.commenter.displayName,
    at: minuteOf(comment.createdAt),
    ...(visiblyEdited && comment.editedAt ? { edited: minuteOf(comment.editedAt) } : {}),
    ...(!isCommentPublic(comment) ? { status: comment.deletedAt ? "DELETED" : comment.status } : {}),
    post: postUrl,
    thread: comment.threadId,
    ...(comment.parentCommentId ? { replyTo: comment.parentCommentId } : {}),
    body: format === "text" ? comment.bodyText : commentContentToMarkdown(comment.body as JSONContent).trim(),
    ...(Object.keys(citations).length > 0
      ? { cites: Object.values(citations).map((c) => ({ label: c.label, ...(c.href ? { url: c.href } : {}), ...(c.stale ? { earlierVersion: true } : {}) })) }
      : {}),
  };
  if (args.history) {
    const versions = await commentHistoryFor(viewerOf(ctx.actor), comment.id);
    result.history = versions.map((v) => ({
      version: v.revisionNo,
      at: minuteOf(new Date(v.createdAt)),
      ...(v.authorName ? { by: v.authorName } : {}),
      ...(v.current ? { current: true } : {}),
      body: format === "text" ? v.bodyText : commentContentToMarkdown(v.body).trim(),
    }));
  }
  return result;
}
