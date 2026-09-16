import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canEditAnyPost } from "@/lib/authz";
import { gated, titleWhenOk } from "@/lib/route-access";
import { derivePostStatus } from "@/lib/post-status";
import { canUserReadDoc, editableDocsFor } from "@/lib/doc-authz";
import { tagsNotYetOn } from "@/lib/tag-data";
import { docTitleOrFallback } from "@/lib/doc-title";
import { signInPath } from "@/lib/sign-in-redirect";
import PostPublisher from "@/components/PostPublisher";
import TagChips from "@/components/tags/TagChips";

// prismaIncludingDeleted rather than the soft-delete-filtered prisma — a
// soft-deleted post must still load here so its Settings panel can offer
// Undelete; the ordinary prisma client would 404 it instead.
const loadPostForEdit = gated(async (user, id: string) => {
  const post = await prismaIncludingDeleted.post.findUnique({
    where: { id },
    include: {
      authors: { select: { userId: true }, orderBy: { bylineOrder: "asc" } },
      // `visibility` is for the §20m tag offer below, not for this page
      // gate: the offer shows the *doc's* terms, so it owes the doc's own
      // read rule on top of the post gate this function already applies.
      doc: { select: { id: true, slug: true, title: true, visibility: true } },
      publishEvent: { select: { createdAt: true, ydocSnapshot: { select: { lastYdocUpdateId: true } } } },
    },
  });
  if (!post) {
    return "not-found";
  }
  const isOwner = post.authors.some((a) => a.userId === user.id);
  if (!canEditAnyPost(user.role) && !isOwner) {
    return "forbidden";
  }
  return post;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return titleWhenOk(await loadPostForEdit(id), (post) => `✎ ${post.title}`);
}

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Free — generateMetadata already ran this for the same request.
  const access = await loadPostForEdit(id);
  if (access.status === "signed-out") {
    redirect(signInPath(`/post/${id}/edit`));
  }
  if (access.status === "redirect") {
    redirect(access.to);
  }
  if (access.status === "not-found") {
    notFound();
  }
  if (access.status === "forbidden") {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to edit this post.</p>
      </main>
    );
  }
  const { value: post, user } = access;

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
  const editableDocs = await editableDocsFor(user.id, user.role);

  // PLAN.md §20m — the source doc's terms that haven't come across yet, for
  // the "From the doc" offer under the post's own strip.
  //
  // **Gated on `canUserReadDoc`, not on this page's gate.** A post author need
  // not be an author of the doc it was made from, so a PRIVATE doc's terms
  // would otherwise be disclosed to whoever holds the post's byline. This is
  // the one surface that renders one object's tags on another object's page,
  // which is why it is also the one that needs a second check rather than
  // inheriting its container's — docs/PERMISSIONS.md's Tags section states it.
  //
  // `post.doc` is the post's *actual* source doc. PostPublisher's "Change
  // doc…" select changes only what the scrub bar previews; the post's doc
  // moves when it is published from a different one, and the refresh that
  // follows re-renders this against the new source.
  const docTagOffer = (await canUserReadDoc(user.id, user.role, post.doc))
    ? await tagsNotYetOn({ kind: "doc", id: post.doc.id }, { kind: "post", id: post.id })
    : [];

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
      slug={post.slug}
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
      liveEventAt={post.publishEvent?.createdAt ?? null}
      // PLAN.md §20d — TagChips is an async Server Component, so it can't be
      // imported by PostPublisher ("use client"); it crosses as a prop
      // instead, the way /pdf/[slug] hands one to its viewer. The gate is
      // this page's own loadPostForEdit, which already required ownership or
      // canEditAnyPost — the strip adds no second check.
      //
      // The `key` is load-bearing and this is not a list: PostPublisher
      // renders it among siblings, and while a tagged post's chips are still
      // awaiting, the RSC stream hands the element over as a lazy chunk whose
      // resolved form the client reconciler then checks for a key.
      // CLAUDE.md's Gotchas has why.
      tags={<TagChips key="tags" target={{ kind: "post", id: post.id }} />}
      // Plain data rather than a rendered element, unlike `tags` above:
      // DocTagOffer is a client component, so PostPublisher can import it
      // directly and the keyed-lazy-chunk hazard doesn't arise at all.
      docTagOffer={docTagOffer}
      sourceDocTitle={docTitleOrFallback(post.doc.title)}
    />
  );
}
