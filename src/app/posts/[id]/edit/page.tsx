import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canEditAnyPost } from "@/lib/authz";
import { derivePostStatus } from "@/lib/post-status";
import PostEditor from "@/components/PostEditor";

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const post = await prisma.post.findUnique({
    where: { id },
    include: {
      authors: { select: { userId: true } },
      publishRevision: { select: { revisionNumber: true } },
      revisions: { orderBy: { revisionNumber: "desc" }, take: 1, select: { title: true, revisionNumber: true, doc: true } },
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

  const latest = post.revisions[0];
  const status = derivePostStatus(post);

  return (
    <PostEditor
      postId={post.id}
      slug={post.slug}
      initialTitle={latest?.title ?? post.title}
      revisionNumber={latest?.revisionNumber ?? 0}
      publishedRevisionNumber={status === "published" ? post.publishRevision!.revisionNumber : null}
      postStatus={status}
      publishedAt={post.publishedAt}
      lastRevisionDoc={latest?.doc ?? null}
      userId={session.user.id}
      userName={session.user.name ?? session.user.email ?? "Anonymous"}
      userColor={session.user.color}
    />
  );
}
