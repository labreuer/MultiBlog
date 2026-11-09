import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/actor";
import { annotationAnchorName } from "@/lib/annotation-anchor-name";
import { readableAnnotationsWhere } from "@/lib/annotation-authz";
import { commentAnchorName } from "@/lib/comment-anchor-name";
import { publicCommentsWhere } from "@/lib/comment-authz";
import { displayNameOf } from "@/lib/display-name";
import { readableDocsWhere } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { derivePostStatus, readablePostWhere } from "@/lib/post-status";
import { postPath } from "@/lib/post-path";

// docs/MENTIONS.md, "The dashboard" — where a person has been mentioned, for
// the "Mentions of you" card.
//
// **One query per kind, each through that kind's read rule**, as /tag and the
// search do, and never one across them: a mention is exactly as private as
// what it is in, and the `mention` table holds no visibility of its own. So a
// mention in a doc this person can't read is not listed, and its existence
// is not hinted at by a count.
//
// Newest first by when the mention was first seen (`mention.first_seen_at`),
// which is the moment somebody wrote it, not when its doc was last edited: a
// long doc that names you once and is edited daily should not sit at the top
// forever. One entry per doc, note, post or comment, however many times it
// names you.
//
// Server-only.

export type MentionOfYou = {
  kind: "doc" | "annotation" | "post" | "comment";
  href: string;
  /** The doc's or post's title; for a note, what it is on; for a comment, its post's. */
  title: string;
  /** For a note or a comment: who wrote it, as it was posted. */
  by: string | null;
  /** When the mention was first seen there. */
  at: Date;
};

/** A few more rows than shown, since several can be one doc's. */
const FETCH = 60;

export async function mentionsOf(actor: Actor, limit: number): Promise<MentionOfYou[]> {
  const docs = readableDocsWhere(actor.userId, actor.role);
  const notes = readableAnnotationsWhere(actor.userId, actor.role);
  const posts = readablePostWhere(actor.userId, actor.role);
  const newest = { orderBy: { firstSeenAt: "desc" as const }, take: FETCH };

  const [inDocs, inNotes, inPosts, inComments] = await Promise.all([
    docs
      ? prisma.mention.findMany({
          where: { userId: actor.userId, doc: docs },
          ...newest,
          select: { firstSeenAt: true, doc: { select: { id: true, slug: true, title: true } } },
        })
      : [],
    notes
      ? prisma.mention.findMany({
          // A relation filter goes around the soft-delete `$extends`, so a deleted note is excluded by hand.
          where: { userId: actor.userId, annotation: { AND: [notes, { deletedByUserId: null }] } },
          ...newest,
          select: {
            firstSeenAt: true,
            annotation: {
              select: {
                id: true,
                createdAt: true,
                user: { select: { name: true, email: true } },
                doc: { select: { slug: true, title: true } },
                file: { select: { slug: true, title: true } },
              },
            },
          },
        })
      : [],
    prisma.mention.findMany({
      where: { userId: actor.userId, post: { AND: [posts, { deletedByUserId: null }] } },
      ...newest,
      select: { firstSeenAt: true, post: { select: { id: true, slug: true, title: true, publishedAt: true, publishEventId: true } } },
    }),
    // A comment's rows exist only while it is APPROVED; the public rule
    // leaves out a deleted one and one on a post that isn't public.
    prisma.mention.findMany({
      where: { userId: actor.userId, comment: publicCommentsWhere() },
      ...newest,
      select: {
        firstSeenAt: true,
        comment: {
          select: {
            id: true,
            createdAt: true,
            commenter: { select: { displayName: true } },
            thread: { select: { post: { select: { slug: true, title: true, publishedAt: true } } } },
          },
        },
      },
    }),
  ]);

  const found: (MentionOfYou & { key: string })[] = [];
  for (const row of inDocs) {
    if (!row.doc) continue;
    found.push({ key: `doc:${row.doc.id}`, kind: "doc", href: `/doc/${row.doc.slug}`, title: docTitleOrFallback(row.doc.title), by: null, at: row.firstSeenAt });
  }
  for (const row of inNotes) {
    const note = row.annotation;
    if (!note) continue;
    const container = note.doc
      ? { path: `/doc/${note.doc.slug}`, title: docTitleOrFallback(note.doc.title) }
      : note.file
        ? { path: `/pdf/${note.file.slug}`, title: note.file.title }
        : null;
    if (!container) continue;
    const writer = displayNameOf(note.user);
    found.push({
      key: `annotation:${note.id}`,
      kind: "annotation",
      href: `${container.path}#${annotationAnchorName(writer, note.createdAt)}`,
      title: container.title,
      by: writer,
      at: row.firstSeenAt,
    });
  }
  for (const row of inPosts) {
    if (!row.post) continue;
    found.push({
      key: `post:${row.post.id}`,
      kind: "post",
      href: derivePostStatus(row.post) === "published" ? postPath(row.post) : `/post/${row.post.id}/edit`,
      title: row.post.title,
      by: null,
      at: row.firstSeenAt,
    });
  }

  for (const row of inComments) {
    const comment = row.comment;
    if (!comment?.thread.post.publishedAt) continue;
    const by = comment.commenter.displayName;
    found.push({
      key: `comment:${comment.id}`,
      kind: "comment",
      href: `${postPath(comment.thread.post)}#${commentAnchorName(by, comment.createdAt)}`,
      title: comment.thread.post.title,
      by,
      at: row.firstSeenAt,
    });
  }

  // Newest first, and each source once: its newest mention of this person.
  found.sort((a, b) => b.at.getTime() - a.at.getTime());
  const seen = new Set<string>();
  const out: MentionOfYou[] = [];
  for (const { key, ...mention } of found) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mention);
    if (out.length === limit) break;
  }
  return out;
}
