// Direct-to-Postgres helpers for the e2e suite: throwaway users, posts, and
// comments.
//
// This mirrors what scripts/test-user.ts, scripts/test-post.ts and
// scripts/test-comment.ts do for manual testing (see CLAUDE.md), and keeps
// their safety rail: every write is gated on an @example.com address, so a
// misfiring test can't touch a real account or a real post.
//
// It runs in a `tsx` child process rather than inside Playwright, because
// Playwright's TypeScript loader can't require the generated Prisma client:
// src/generated/prisma/client.ts uses `import.meta.url`, which has no CJS
// equivalent, so Playwright's transform leaves ESM syntax in its own CJS
// output and Node dies with "exports is not defined". `tsx` handles the file
// fine — which is why every script in scripts/ already runs under it.
//
// e2e/db.ts is the client side: same function names, one JSON line each way.
import "dotenv/config";
import readline from "node:readline";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { colorForSeed } from "@/lib/author-colors";
import { uniqueUserSlug } from "@/lib/user-slug";
import { uniquePostSlug } from "@/lib/post-slug";
import type { Role, ModerationPolicy, CommentStatus } from "@/generated/prisma/enums";
import { SAFE_EMAIL, TEST_PASSWORD, E2E_PREFIX, E2E_TITLE_PREFIX, uniqueTitle, docFromText } from "./naming";

function assertSafe(email: string) {
  if (!SAFE_EMAIL.test(email)) {
    throw new Error(`Refusing to touch "${email}" — the e2e helpers only operate on @example.com addresses.`);
  }
}

export type TestUser = { id: string; email: string; name: string; role: Role };

export async function createTestUser(opts: {
  email: string;
  name?: string;
  role?: Role;
  /** approvedCount 100 — enough to clear any realistic trust threshold. */
  trusted?: boolean;
  forceModerate?: boolean;
}): Promise<TestUser> {
  const { email, name = email.split("@")[0], role = "ADMIN", trusted = false, forceModerate = false } = opts;
  assertSafe(email);

  // Delete-then-create rather than upsert: a leftover row from a killed run
  // could carry the wrong role or a stale Commenter, and the point of a
  // fixture is a known starting state.
  await deleteTestUser(email);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email,
      slug: await uniqueUserSlug(name, email),
      name,
      passwordHash,
      role,
      color: colorForSeed(email),
      adminInitials: name.slice(0, 2).toUpperCase(),
    },
  });

  if (trusted || forceModerate) {
    await prisma.commenter.create({
      data: {
        userId: user.id,
        email: user.email,
        displayName: name,
        approvedCount: trusted ? 100 : 0,
        forceModerate,
      },
    });
  }

  return { id: user.id, email: user.email, name, role };
}

export async function deleteTestUser(email: string): Promise<void> {
  assertSafe(email);
  // Commenter.email is unique and its userId FK is optional, so deleting the
  // User alone strands a row that then blocks reusing this address — the same
  // collision scripts/test-user.ts documents.
  await prisma.commenter.deleteMany({ where: { email } });
  await prisma.user.deleteMany({ where: { email } });
}

export type TestPost = {
  id: string;
  slug: string;
  title: string;
  revisionId: string;
  bodyText: string;
};

export async function createTestPost(opts: {
  authorEmail: string;
  title?: string;
  bodyText?: string;
  policy?: ModerationPolicy;
  publish?: boolean;
}): Promise<TestPost> {
  const {
    authorEmail,
    title = uniqueTitle("post"),
    bodyText = "The quick brown fox jumps over the lazy dog.",
    policy = "AUTO",
    publish = false,
  } = opts;
  assertSafe(authorEmail);

  const author = await prisma.user.findUnique({ where: { email: authorEmail } });
  if (!author) throw new Error(`No such test author: ${authorEmail}`);

  const post = await prisma.post.create({
    data: {
      slug: await uniquePostSlug(title),
      title,
      moderationPolicy: policy,
      authors: { create: { userId: author.id, bylineOrder: 0 } },
      revisions: {
        create: { revisionNumber: 1, title, doc: docFromText(bodyText), editorId: author.id },
      },
      ...(publish ? { publishedAt: new Date() } : {}),
    },
    include: { revisions: true },
  });

  const revisionId = post.revisions[0].id;
  if (publish) {
    // Can't be part of the nested create above — the revision has no id yet.
    await prisma.post.update({ where: { id: post.id }, data: { publishRevisionId: revisionId } });
  }

  return { id: post.id, slug: post.slug, title: post.title, revisionId, bodyText };
}

export async function deleteTestPost(idOrSlug: string): Promise<void> {
  const post = await prisma.post.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: { authors: { include: { user: true } } },
  });
  if (!post) return;

  const unsafe = post.authors.filter((a) => !SAFE_EMAIL.test(a.user.email));
  if (post.authors.length === 0 || unsafe.length > 0) {
    throw new Error(`Refusing to delete post "${post.title}" — it has a non-throwaway (or missing) author.`);
  }
  await prisma.post.delete({ where: { id: post.id } });
}

/**
 * Inserts a comment straight into the DB, skipping submitComment entirely.
 *
 * Deliberate: the real form is rate-limited to 5 comments per IP per 10
 * minutes (src/lib/rate-limit.ts) and every worker shares 127.0.0.1, so a
 * suite that posted its fixtures through the UI would start failing on the
 * sixth one. Tests that need a comment to *exist* use this; the one test
 * that's actually about the form uses the form.
 */
export async function createComment(opts: {
  postId: string;
  anchoredRevisionId: string;
  email: string;
  displayName: string;
  body: string;
  status?: CommentStatus;
}): Promise<{ id: string; commenterId: string }> {
  const { postId, anchoredRevisionId, email, displayName, body, status = "PENDING" } = opts;
  assertSafe(email);

  const commenter = await prisma.commenter.upsert({
    where: { email },
    update: {},
    create: { email, displayName },
  });

  const thread =
    (await prisma.commentThread.findFirst({ where: { postId, quotedText: "" } })) ??
    (await prisma.commentThread.create({
      data: { postId, anchoredRevisionId, anchorFrom: 0, anchorTo: 0, quotedText: "" },
    }));

  const comment = await prisma.comment.create({
    data: { threadId: thread.id, commenterId: commenter.id, body: { text: body }, status },
  });

  return { id: comment.id, commenterId: commenter.id };
}

/**
 * A quote-anchored thread with one APPROVED comment, so it surfaces publicly
 * (`getPostThreadsWithApprovedComments` hides threads with nothing approved).
 *
 * Anchors are passed in as raw ProseMirror positions rather than derived from
 * a text search, because that's exactly what the remap under test operates on
 * — computing them here from the same doc the assertion checks would make the
 * test agree with itself.
 */
export async function createQuoteThread(opts: {
  postId: string;
  anchoredRevisionId: string;
  anchorFrom: number;
  anchorTo: number;
  quotedText: string;
  email: string;
  displayName: string;
  body: string;
}): Promise<{ threadId: string; commentId: string }> {
  const { postId, anchoredRevisionId, anchorFrom, anchorTo, quotedText, email, displayName, body } = opts;
  assertSafe(email);

  const commenter = await prisma.commenter.upsert({
    where: { email },
    update: {},
    create: { email, displayName },
  });
  const thread = await prisma.commentThread.create({
    data: { postId, anchoredRevisionId, anchorFrom, anchorTo, quotedText },
  });
  const comment = await prisma.comment.create({
    data: { threadId: thread.id, commenterId: commenter.id, body: { text: body }, status: "APPROVED" },
  });

  return { threadId: thread.id, commentId: comment.id };
}

export type ThreadState = {
  status: string;
  anchorFrom: number;
  anchorTo: number;
  anchoredRevisionId: string;
};

export async function getThread(threadId: string): Promise<ThreadState | null> {
  return prisma.commentThread.findUnique({
    where: { id: threadId },
    select: { status: true, anchorFrom: true, anchorTo: true, anchoredRevisionId: true },
  });
}

export type RevisionSummary = {
  revisionNumber: number;
  title: string;
  text: string;
  changelog: string | null;
};

export async function getRevisions(postId: string): Promise<RevisionSummary[]> {
  const revisions = await prisma.revision.findMany({
    where: { postId },
    orderBy: { revisionNumber: "asc" },
  });
  return revisions.map((r) => ({
    revisionNumber: r.revisionNumber,
    title: r.title,
    text: extractText(r.doc),
    changelog: r.changelog,
  }));
}

/** Whether the post has a live collab doc at all — see the PostCollab lifecycle note in CLAUDE.md. */
export async function hasCollabDoc(postId: string): Promise<boolean> {
  return (await prisma.postCollab.count({ where: { postId } })) > 0;
}

export async function getLatestRevisionId(postId: string): Promise<string | null> {
  const revision = await prisma.revision.findFirst({
    where: { postId },
    orderBy: { revisionNumber: "desc" },
    select: { id: true },
  });
  return revision?.id ?? null;
}

export async function getCommentStatus(commentId: string): Promise<CommentStatus | null> {
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, select: { status: true } });
  return comment?.status ?? null;
}

/**
 * Last-resort cleanup for rows a crashed or Ctrl+C'd run left behind. Scoped
 * to the suite's own naming (`e2e-*@example.com`, "E2E …" titles), so it can
 * never reach a post or account that wasn't created here. Posts go first:
 * deleteTestPost refuses an authorless post, which is what one becomes the
 * moment its only author is deleted.
 */
export async function sweepTestData(): Promise<{ posts: number; users: number }> {
  const stalePosts = await prisma.post.findMany({
    where: {
      title: { startsWith: E2E_TITLE_PREFIX },
      authors: { every: { user: { email: { startsWith: E2E_PREFIX, endsWith: "@example.com" } } } },
    },
    select: { id: true, authors: { select: { userId: true } } },
  });
  for (const post of stalePosts) {
    if (post.authors.length > 0) await prisma.post.delete({ where: { id: post.id } });
  }

  const staleUsers = await prisma.user.findMany({
    where: { email: { startsWith: E2E_PREFIX, endsWith: "@example.com" } },
    select: { email: true },
  });
  for (const user of staleUsers) await deleteTestUser(user.email);

  // Anonymous commenters the moderation specs invent have no User row.
  await prisma.commenter.deleteMany({
    where: { email: { startsWith: E2E_PREFIX, endsWith: "@example.com" } },
  });

  return { posts: stalePosts.length, users: staleUsers.length };
}

// ---------------------------------------------------------------------------
// stdio dispatch. One JSON request per line in, one JSON response per line
// out; stderr is inherited from the parent so Prisma's own warnings still
// surface. Nothing else may write to stdout from here.
// ---------------------------------------------------------------------------

const handlers = {
  createTestUser,
  deleteTestUser,
  createTestPost,
  deleteTestPost,
  createComment,
  createQuoteThread,
  getThread,
  getRevisions,
  hasCollabDoc,
  getLatestRevisionId,
  getCommentStatus,
  sweepTestData,
};

export type DbHandlers = typeof handlers;

type Request = { id: number; fn: keyof DbHandlers; args: unknown[] };

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const { id, fn, args } = JSON.parse(line) as Request;
  try {
    const handler = handlers[fn] as ((...a: never[]) => Promise<unknown>) | undefined;
    if (!handler) throw new Error(`Unknown db helper: ${String(fn)}`);
    const value = await handler(...(args as never[]));
    process.stdout.write(`${JSON.stringify({ id, ok: true, value })}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${JSON.stringify({ id, ok: false, error: message })}\n`);
  }
});
