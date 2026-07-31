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
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import type { JSONContent } from "@tiptap/core";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { colorForSeed } from "@/lib/author-colors";
import { uniqueUserSlug } from "@/lib/user-slug";
import { uniquePostSlug } from "@/lib/post-slug";
import { uniqueDocSlug } from "@/lib/doc-slug";
import { contentExtensions, collectMarkAttrValues, pmDocContentSchema } from "@/lib/tiptap-schema";
import { findQuoteOccurrences } from "@/lib/quote-occurrences";
import { captureAnchor } from "@/lib/doc-link-anchor";
import { postContentFromYdoc } from "@/lib/post-content";
import { ensureYdocSnapshotAt } from "@/lib/ydoc-snapshot";
import { isTestYdocDocument, newTestYdocId, ydocIdForDoc, ydocIdForAnnotation } from "@/lib/ydoc-names";
import type { Role, ModerationPolicy, CommentStatus, DocVisibility } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { SAFE_EMAIL, TEST_PASSWORD, E2E_PREFIX, E2E_TITLE_PREFIX, uniqueTitle, docFromText } from "./naming";
// server/ isn't under src/, but it's still part of the one tsconfig project
// (CLAUDE.md's ydoc-store note) — same relative-import style server/collab.ts
// itself uses for src/lib.
import { ydocStore, encodeYdocState } from "../server/ydoc-store";

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
  // annotation.user_id is ON DELETE RESTRICT (an annotation's author is never
  // optional, unlike Commenter's) — a secondUser({role: "AUTHORIZED"}) who
  // annotated a doc during the test would otherwise block their own
  // teardown. deleted_by_user_id is ON DELETE SET NULL, so only the
  // authored side needs handling here. Each deleted annotation's own ydoc
  // row (§13a) has to go too, captured before the deleteMany — same "no FK
  // means nothing cascades this" reasoning as deleteTestDoc above.
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    const annotationIds = (
      await prisma.annotation.findMany({ where: { userId: user.id }, select: { id: true } })
    ).map((a) => a.id);
    await prisma.annotation.deleteMany({ where: { userId: user.id } });
    if (annotationIds.length > 0) {
      await prisma.ydoc.deleteMany({ where: { id: { in: annotationIds.map(ydocIdForAnnotation) } } });
    }
    // doc_link.user_id and doc_link_group.user_id are the same shape of
    // required, RESTRICT-by-default FK — and unlike annotations, PLAN.md
    // §14b's soft delete is deletedAt-only, so a group "deleted" through
    // the UI (updateDocLinkGroup's soft delete) still owns the row and
    // still blocks this. Links first (a link can live in a group owned by
    // someone else), then this user's own groups (whose onDelete: Cascade
    // takes any remaining links in them, e.g. someone else's link inside
    // a group this user created).
    await prisma.docLink.deleteMany({ where: { userId: user.id } });
    await prisma.docLinkGroup.deleteMany({ where: { userId: user.id } });
  }
  await prisma.user.deleteMany({ where: { email } });
}

export type TestPost = {
  id: string;
  slug: string;
  title: string;
  docId: string;
  /** null unless `publish` was requested. */
  eventId: string | null;
  bodyText: string;
};

// PLAN.md §15 — a post is a snapshot of a doc, so creating one always creates
// its own throwaway backing doc first (createTestDoc, below — same E2E_TITLE_
// PREFIX naming, so sweepTestData's existing doc sweep catches it even if a
// test's own teardown doesn't run). publish snapshots that doc's just-seeded
// content and publishes it immediately, the fixture-level equivalent of
// publishPostFromDoc (src/app/actions/posts.ts).
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

  const doc = await createTestDoc({ authorEmail, title: uniqueTitle("post-doc"), bodyText });

  const post = await prisma.post.create({
    data: {
      slug: await uniquePostSlug(title),
      title,
      docId: doc.id,
      moderationPolicy: policy,
      authors: { create: { userId: author.id, bylineOrder: 0, createdUserId: author.id } },
    },
  });

  let eventId: string | null = null;
  if (publish) {
    const throughUpdateId = await ydocStore.maxUpdateId(ydocIdForDoc(doc.id));
    if (throughUpdateId === null) throw new Error(`Test doc ${doc.id} has no update history to publish.`);
    const { snapshotId, doc: materialized } = await ensureYdocSnapshotAt({
      ydocId: ydocIdForDoc(doc.id),
      throughUpdateId,
      userId: author.id,
    });
    const { proseJson, title: docTitle } = postContentFromYdoc(materialized);
    materialized.destroy();
    const publishedTitle = title || docTitle || "Untitled";

    const event = await prisma.postPublicationEvent.create({
      data: {
        postId: post.id,
        type: "PUBLISHED",
        docId: doc.id,
        ydocSnapshotId: snapshotId,
        title: publishedTitle,
        proseJson: proseJson as Prisma.InputJsonValue,
        actorId: author.id,
      },
    });
    await prisma.post.update({
      where: { id: post.id },
      data: {
        title: publishedTitle,
        proseJson: proseJson as Prisma.InputJsonValue,
        publishEventId: event.id,
        publishedAt: new Date(),
      },
    });
    eventId = event.id;
  }

  return { id: post.id, slug: post.slug, title: post.title, docId: doc.id, eventId, bodyText };
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
  const docId = post.docId;
  // Post.doc is ON DELETE RESTRICT (PLAN.md §15) — the post has to go first.
  await prisma.post.delete({ where: { id: post.id } });
  // Best-effort: createTestPost always creates its own private backing doc,
  // so cleaning it up here too (rather than waiting for sweepTestData's
  // generic doc sweep) is safe. deleteTestDoc no-ops on an id that's already
  // gone, which covers a post created from a *shared* fixture doc (draftDoc/
  // sharedDoc) whose own teardown will delete it separately.
  await deleteTestDoc(docId).catch(() => {});
}

// ---------------------------------------------------------------------------
// Docs and annotations (PLAN.md §12) — same @example.com safety rail as
// posts/users; deleteTestDoc additionally removes the doc's derived ydoc:
// row (§12b: no FK between the two tables, so nothing cascades this).
// ---------------------------------------------------------------------------

export type TestDoc = { id: string; slug: string; title: string };

/**
 * Creates a doc the same way createDocAction does — a doc row plus an
 * eagerly-created ydoc row (ydocStore.createIfAbsent), so it's a real
 * invariant-1 document, not a hand-rolled shortcut around the code path
 * under test. bodyText, if given, seeds the "default" fragment via the same
 * TiptapTransformer.toYdoc path server/collab.ts's onLoadDocument uses to
 * seed a post from a revision — merged into a fresh Y.Doc via
 * encodeStateAsUpdate/applyUpdate so the seeded doc's own clientID isn't
 * reused, mirroring the caution in that same onLoadDocument's title-seeding
 * comment.
 */
export async function createTestDoc(opts: {
  authorEmail: string;
  title?: string;
  visibility?: DocVisibility;
  bodyText?: string;
}): Promise<TestDoc> {
  const { authorEmail, title = uniqueTitle("doc"), visibility = "PRIVATE", bodyText } = opts;
  assertSafe(authorEmail);

  const author = await prisma.user.findUnique({ where: { email: authorEmail } });
  if (!author) throw new Error(`No such test author: ${authorEmail}`);

  const doc = await prisma.doc.create({
    data: {
      slug: await uniqueDocSlug(title),
      title,
      visibility,
      authors: { create: { userId: author.id, bylineOrder: 0 } },
    },
  });

  const seed = new Y.Doc();
  if (bodyText) {
    const seeded = TiptapTransformer.toYdoc(docFromText(bodyText), "default", contentExtensions);
    Y.applyUpdate(seed, Y.encodeStateAsUpdate(seeded));
    seeded.destroy();
  }
  const { ydoc, stateVector } = encodeYdocState(seed);
  seed.destroy();
  await ydocStore.createIfAbsent(ydocIdForDoc(doc.id), ydoc, stateVector);

  return { id: doc.id, slug: doc.slug, title: doc.title };
}

export async function deleteTestDoc(idOrSlug: string): Promise<void> {
  const doc = await prisma.doc.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: { authors: { include: { user: true } } },
  });
  if (!doc) return;

  const unsafe = doc.authors.filter((a) => !SAFE_EMAIL.test(a.user.email));
  if (doc.authors.length === 0 || unsafe.length > 0) {
    throw new Error(`Refusing to delete doc "${doc.title}" — it has a non-throwaway (or missing) author.`);
  }

  // PLAN.md §13a — captured before the delete cascades the Annotation rows
  // away, same reason scripts/test-doc.ts's own delete does this.
  const annotationIds = (await prisma.annotation.findMany({ where: { docId: doc.id }, select: { id: true } })).map(
    (a) => a.id,
  );

  await prisma.doc.delete({ where: { id: doc.id } });
  await prisma.ydoc.deleteMany({
    where: { id: { in: [ydocIdForDoc(doc.id), ...annotationIds.map(ydocIdForAnnotation)] } },
  });
}

export type DocState = { title: string; proseText: string | null; visibility: DocVisibility };

export async function getDocState(docId: string): Promise<DocState | null> {
  const doc = await prisma.doc.findUnique({ where: { id: docId } });
  if (!doc) return null;
  return {
    title: doc.title,
    proseText: doc.proseJson ? extractText(doc.proseJson) : null,
    visibility: doc.visibility,
  };
}

/** Row count in ydoc_update for docId's own ydoc — invariant 1 (§11b), same check createTestYdoc's own spec makes for /ydoc-debug documents. */
export async function countDocYdocUpdates(docId: string): Promise<number> {
  return prisma.ydocUpdate.count({ where: { ydocId: ydocIdForDoc(docId) } });
}

// ---------------------------------------------------------------------------
// Doc links (PLAN.md §14) — a doc link's anchor is a plain JSON blob computed
// against a doc's body text, not a live-collab mark, so unlike an annotation
// it needs no collab connection to create. `bodyText` here must be exactly
// what createTestDoc's own `bodyText` seeded (docFromText builds the same
// paragraph-split JSON both times), so the anchor this computes matches what
// the reading view actually renders. deleteTestDoc already cascades DocLink
// rows away (onDelete: Cascade on doc_id, §14b) but not their DocLinkGroup —
// deleteTestDocLinkGroup is the explicit cleanup for that.
// ---------------------------------------------------------------------------

export type TestDocLink = { id: string; groupId: string };

export async function createTestDocLink(opts: {
  docId: string;
  authorEmail: string;
  bodyText: string;
  quotedText: string;
  groupId?: string;
  overrideColor?: string;
}): Promise<TestDocLink> {
  const { docId, authorEmail, bodyText, quotedText, groupId, overrideColor } = opts;
  assertSafe(authorEmail);
  const author = await prisma.user.findUniqueOrThrow({ where: { email: authorEmail } });

  const node = pmDocContentSchema.nodeFromJSON(docFromText(bodyText));
  const occurrences = findQuoteOccurrences(node, quotedText);
  if (occurrences.length !== 1) {
    throw new Error(`"${quotedText}" occurs ${occurrences.length} time(s) in the given bodyText — need exactly one.`);
  }
  const mark = captureAnchor(node, occurrences[0].from, occurrences[0].to);

  const group = groupId
    ? await prisma.docLinkGroup.findUniqueOrThrow({ where: { id: groupId } })
    : await prisma.docLinkGroup.create({ data: { name: quotedText.slice(0, 60), userId: author.id } });

  const link = await prisma.docLink.create({
    data: { docId, mark: mark as object, docLinkGroupId: group.id, userId: author.id, overrideColor },
  });

  return { id: link.id, groupId: group.id };
}

export async function deleteTestDocLinkGroup(groupId: string): Promise<void> {
  await prisma.docLink.deleteMany({ where: { docLinkGroupId: groupId } });
  await prisma.docLinkGroup.deleteMany({ where: { id: groupId } });
}

/** Non-deleted doc_link rows for a doc — used to assert the Phase 5 creation flow wrote a real row, not just painted a decoration. */
export async function countDocLinks(docId: string): Promise<number> {
  return prisma.docLink.count({ where: { docId, deletedAt: null } });
}

/** groupId for every non-deleted doc_link on a doc — lets a test clean up the groups it created through the UI, which it has no id for otherwise. */
export async function getDocLinkGroupIds(docId: string): Promise<string[]> {
  const links = await prisma.docLink.findMany({ where: { docId, deletedAt: null }, select: { docLinkGroupId: true } });
  return Array.from(new Set(links.map((l) => l.docLinkGroupId)));
}

/** A single doc_link's editable fields — for asserting the §14j edit-popover flow actually persisted, not just repainted. */
export type DocLinkFields = { text: string | null; overrideColor: string | null };
export async function getDocLinkFields(linkId: string): Promise<DocLinkFields | null> {
  const link = await prisma.docLink.findUnique({ where: { id: linkId }, select: { text: true, overrideColor: true } });
  return link ?? null;
}

export type AnnotationState = {
  id: string;
  parentAnnotationId: string | null;
  bodyText: string;
  /** Only meaningful for a root (parentAnnotationId null) — see §12h/§12i. */
  anchored: boolean;
  deletedAt: string | null;
};

/**
 * Every annotation on a doc, with each root's anchored/document-level state
 * resolved the same way annotation-data.ts's getDocAnnotationsAsThreads does —
 * a mark still present in Doc.proseJson vs. not (PLAN.md §12h).
 */
export async function getAnnotationStates(docId: string): Promise<AnnotationState[]> {
  const [doc, annotations] = await Promise.all([
    prisma.doc.findUnique({ where: { id: docId }, select: { proseJson: true } }),
    prisma.annotation.findMany({ where: { docId }, orderBy: { createdAt: "asc" } }),
  ]);
  const proseJson = doc?.proseJson as JSONContent | null;
  const markedIds = new Set(proseJson ? collectMarkAttrValues(proseJson, "annotation", "id") : []);

  return annotations.map((a) => ({
    id: a.id,
    parentAnnotationId: a.parentAnnotationId,
    bodyText: a.bodyText,
    anchored: markedIds.has(a.id),
    deletedAt: a.deletedAt?.toISOString() ?? null,
  }));
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
  anchoredEventId: string;
  email: string;
  displayName: string;
  body: string;
  status?: CommentStatus;
}): Promise<{ id: string; commenterId: string }> {
  const { postId, anchoredEventId, email, displayName, body, status = "PENDING" } = opts;
  assertSafe(email);

  const commenter = await prisma.commenter.upsert({
    where: { email },
    update: {},
    create: { email, displayName },
  });

  const thread =
    (await prisma.commentThread.findFirst({ where: { postId, quotedText: "" } })) ??
    (await prisma.commentThread.create({
      data: { postId, anchoredEventId, anchorFrom: 0, anchorTo: 0, quotedText: "" },
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
  anchoredEventId: string;
  anchorFrom: number;
  anchorTo: number;
  quotedText: string;
  email: string;
  displayName: string;
  body: string;
}): Promise<{ threadId: string; commentId: string }> {
  const { postId, anchoredEventId, anchorFrom, anchorTo, quotedText, email, displayName, body } = opts;
  assertSafe(email);

  const commenter = await prisma.commenter.upsert({
    where: { email },
    update: {},
    create: { email, displayName },
  });
  const thread = await prisma.commentThread.create({
    data: { postId, anchoredEventId, anchorFrom, anchorTo, quotedText },
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
  anchoredEventId: string;
};

export async function getThread(threadId: string): Promise<ThreadState | null> {
  return prisma.commentThread.findUnique({
    where: { id: threadId },
    select: { status: true, anchorFrom: true, anchorTo: true, anchoredEventId: true },
  });
}

export type PublicationEventSummary = {
  id: string;
  type: string;
  title: string | null;
  text: string | null;
  createdAt: string;
};

/** A post's publish/schedule/unpublish history — the direct successor to getRevisions (PLAN.md §15). */
export async function getPublicationEvents(postId: string): Promise<PublicationEventSummary[]> {
  const events = await prisma.postPublicationEvent.findMany({
    where: { postId },
    orderBy: { createdAt: "asc" },
  });
  return events.map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title,
    text: e.proseJson ? extractText(e.proseJson) : null,
    createdAt: e.createdAt.toISOString(),
  }));
}

/** Post.proseJson as plain text, or null for a never-published post — what the public page actually renders. */
export async function getPostContentText(postId: string): Promise<string | null> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { proseJson: true } });
  return post?.proseJson ? extractText(post.proseJson) : null;
}

/** ydoc_snapshot row count for a doc — the "publishing again reuses, doesn't duplicate" assertion (PLAN.md §15b). */
export async function countDocYdocSnapshots(docId: string): Promise<number> {
  return prisma.ydocSnapshot.count({ where: { ydocId: ydocIdForDoc(docId) } });
}

export async function getCommentStatus(commentId: string): Promise<CommentStatus | null> {
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, select: { status: true } });
  return comment?.status ?? null;
}

// ---------------------------------------------------------------------------
// The standalone ydoc stack (PLAN.md §11) — helpers for e2e/ydoc-debug.spec.ts.
// Every id this creates is under the ydoc:test- prefix (src/lib/ydoc-names.ts);
// deleteTestYdoc refuses anything else, the same containment convention
// createTestPost/createTestUser use for @example.com / "E2E " titles.
// ---------------------------------------------------------------------------

export type TestYdoc = { id: string };

/**
 * Creates a document the same way the "New document" button on /ydoc-debug
 * does — via ydocStore.createIfAbsent, so it's a real invariant-1 document
 * (a `ydoc` row plus exactly one full-state `ydoc_update` row), not a
 * hand-rolled shortcut around the code path under test.
 */
export async function createTestYdoc(): Promise<TestYdoc> {
  const id = newTestYdocId();
  const doc = new Y.Doc();
  const { ydoc, stateVector } = encodeYdocState(doc);
  doc.destroy();
  await ydocStore.createIfAbsent(id, ydoc, stateVector);
  return { id };
}

export async function deleteTestYdoc(id: string): Promise<void> {
  if (!isTestYdocDocument(id)) {
    throw new Error(`Refusing to delete "${id}" — the e2e helpers only touch ydoc:test- documents.`);
  }
  await prisma.ydoc.deleteMany({ where: { id } });
}

export async function countYdocUpdates(ydocId: string): Promise<number> {
  return prisma.ydocUpdate.count({ where: { ydocId } });
}

// id is a global BIGSERIAL, not per-document — a snapshot's high-water mark
// has to be compared against this, not against countYdocUpdates, which is
// only a per-document row count and can be far smaller than the actual id.
export async function getMaxYdocUpdateId(ydocId: string): Promise<string | null> {
  const row = await prisma.ydocUpdate.findFirst({ where: { ydocId }, orderBy: { id: "desc" }, select: { id: true } });
  return row ? row.id.toString() : null;
}

export type TestYdocSnapshot = { id: string; lastYdocUpdateId: string; userId: string | null };

export async function getYdocSnapshots(ydocId: string): Promise<TestYdocSnapshot[]> {
  const rows = await prisma.ydocSnapshot.findMany({ where: { ydocId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ id: r.id, lastYdocUpdateId: r.lastYdocUpdateId.toString(), userId: r.userId }));
}

export async function getYdocClients(ydocId: string): Promise<Record<string, string>> {
  const row = await prisma.ydoc.findUnique({ where: { id: ydocId } });
  if (!row) return {};
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, row.ydoc);
  const clients: Record<string, string> = {};
  scratch.getMap<string>("clients").forEach((userId, clientId) => {
    clients[clientId] = userId;
  });
  scratch.destroy();
  return clients;
}

/**
 * Replays every ydoc_update row for a document from scratch and extracts its
 * plain text — the duplication check from PLAN.md §11g: content should
 * appear once no matter how many deltas (or full-state resets) produced it.
 */
export async function replayYdocText(ydocId: string): Promise<string> {
  const rows = await prisma.ydocUpdate.findMany({ where: { ydocId }, orderBy: { id: "asc" } });
  const scratch = new Y.Doc();
  for (const row of rows) {
    Y.applyUpdate(scratch, row.update);
  }
  const doc = TiptapTransformer.extensions(contentExtensions).fromYdoc(scratch, "default");
  scratch.destroy();
  return extractText(doc);
}

export async function getUserIdByEmail(email: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  return user?.id ?? null;
}

export async function countAllYdocs(): Promise<number> {
  return prisma.ydoc.count();
}

/**
 * Last-resort cleanup for rows a crashed or Ctrl+C'd run left behind. Scoped
 * to the suite's own naming (`e2e-*@example.com`, "E2E …" titles, `ydoc:test-`
 * ids), so it can never reach a post, account, or document that wasn't
 * created here. Posts and docs go first: deleteTestPost/deleteTestDoc refuse
 * an authorless one, which is what one becomes the moment its only author
 * is deleted.
 */
export async function sweepTestData(): Promise<{ posts: number; docs: number; users: number; ydocs: number }> {
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

  // A doc's ydoc row is named ydoc:<docId> — not ydoc:test-<uuid> — so it
  // isn't caught by the ydoc:test- sweep below (same trap PLAN.md §12b
  // documents for scripts/test-doc.ts). Delete each one alongside its doc.
  const staleDocs = await prisma.doc.findMany({
    where: {
      title: { startsWith: E2E_TITLE_PREFIX },
      authors: { every: { user: { email: { startsWith: E2E_PREFIX, endsWith: "@example.com" } } } },
    },
    select: { id: true, authors: { select: { userId: true } } },
  });
  for (const doc of staleDocs) {
    if (doc.authors.length > 0) {
      const annotationIds = (await prisma.annotation.findMany({ where: { docId: doc.id }, select: { id: true } })).map(
        (a) => a.id,
      );
      await prisma.doc.delete({ where: { id: doc.id } });
      await prisma.ydoc.deleteMany({
        where: { id: { in: [ydocIdForDoc(doc.id), ...annotationIds.map(ydocIdForAnnotation)] } },
      });
    }
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

  const staleYdocs = await prisma.ydoc.deleteMany({ where: { id: { startsWith: "ydoc:test-" } } });

  return { posts: stalePosts.length, docs: staleDocs.length, users: staleUsers.length, ydocs: staleYdocs.count };
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
  createTestDoc,
  deleteTestDoc,
  getDocState,
  countDocYdocUpdates,
  createTestDocLink,
  deleteTestDocLinkGroup,
  countDocLinks,
  getDocLinkGroupIds,
  getDocLinkFields,
  getAnnotationStates,
  createComment,
  createQuoteThread,
  getThread,
  getPublicationEvents,
  getPostContentText,
  countDocYdocSnapshots,
  getCommentStatus,
  createTestYdoc,
  deleteTestYdoc,
  countYdocUpdates,
  getMaxYdocUpdateId,
  getYdocSnapshots,
  getYdocClients,
  replayYdocText,
  getUserIdByEmail,
  countAllYdocs,
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
