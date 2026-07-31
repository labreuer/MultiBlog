import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canEditAnyPost } from "@/lib/authz";
import { derivePostStatus } from "@/lib/post-status";
import { editableDocsFor } from "@/lib/doc-authz";
import PostPublisher from "@/components/PostPublisher";

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  // prismaIncludingDeleted rather than the soft-delete-filtered prisma — a
  // soft-deleted post must still load here so its Settings panel can offer
  // Undelete; the ordinary prisma client would 404 it instead.
  const post = await prismaIncludingDeleted.post.findUnique({
    where: { id },
    include: {
      authors: { select: { userId: true }, orderBy: { bylineOrder: "asc" } },
      doc: { select: { id: true, slug: true, title: true } },
      publishEvent: { select: { ydocSnapshot: { select: { lastYdocUpdateId: true } } } },
    },
  });
  if (!post) {
    notFound();
  }

  const isOwner = post.authors.some((a) => a.userId === session.user.id);
  if (!canEditAnyPost(session.user.role) && !isOwner) {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to edit this post.</p>
      </main>
    );
  }

  const status = derivePostStatus(post);

  const eligibleUsers = await prisma.user.findMany({
    where: { role: { in: ["ADMIN", "EDITOR", "AUTHOR"] } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: "asc" },
  });

  // PLAN.md §15d — "Change doc…" only ever offers a doc this user could
  // actually publish from; the post's own current doc is always included
  // even for an ADMIN/EDITOR browsing someone else's byline-only doc, since
  // editableDocsFor already returns every doc for those roles.
  const editableDocs = await editableDocsFor(session.user.id, session.user.role);

  // The scrub bar should open on the point this post is actually live from,
  // not the doc's head — a bigint can't cross the RSC boundary (same reason
  // publishPostFromDoc's throughUpdateId is a string), so it's stringified
  // here. ydoc_update ids are a single BIGSERIAL shared by every doc, so an
  // id that belongs to a different doc's log simply won't be found there —
  // safe even if "Change doc…" is used afterward (PostSnapshotScrubBar falls
  // back to the new doc's head).
  const initialThroughUpdateId = post.publishEvent?.ydocSnapshot?.lastYdocUpdateId?.toString() ?? null;

  return (
    <PostPublisher
      postId={post.id}
      postTitle={post.title}
      docId={post.doc.id}
      editableDocs={editableDocs}
      postStatus={status}
      publishedAt={post.publishedAt}
      moderationPolicy={post.moderationPolicy}
      createdAt={post.createdAt}
      authorIds={post.authors.map((a) => a.userId)}
      eligibleUsers={eligibleUsers}
      initialDeleted={post.deletedByUserId !== null}
      initialThroughUpdateId={initialThroughUpdateId}
    />
  );
}
