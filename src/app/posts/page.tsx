import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManagePosts, canEditAnyPost } from "@/lib/authz";
import { derivePostStatus } from "@/lib/post-status";
import PostsTable from "@/components/PostsTable";

export default async function PostsPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!canManagePosts(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Posts</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage posts.</p>
      </main>
    );
  }

  const posts = await prisma.post.findMany({
    where: canEditAnyPost(session.user.role)
      ? undefined
      : { authors: { some: { userId: session.user.id } } },
    orderBy: { createdAt: "desc" },
    include: {
      publishRevision: { select: { revisionNumber: true } },
      authors: {
        orderBy: { bylineOrder: "asc" },
        select: { user: { select: { adminInitials: true } } },
      },
      revisions: {
        orderBy: { revisionNumber: "desc" },
        take: 1,
        select: {
          revisionNumber: true,
          createdAt: true,
          editor: { select: { name: true, email: true } },
        },
      },
      threads: { select: { comments: { select: { status: true, deletedByUserId: true } } } },
    },
  });

  const rows = posts.map((post) => {
    const latest = post.revisions[0];
    const status = derivePostStatus(post);
    const latestRevisionNumber = latest?.revisionNumber ?? 0;
    const publishedRevisionNumber = post.publishRevision?.revisionNumber ?? 0;
    // publishRevision is set for a scheduled post too (not just published),
    // so both non-draft statuses compare against it — "ahead" means "edited
    // since whatever's committed to go/be live," not just "since published."
    const ahead = status !== "draft" ? latestRevisionNumber - publishedRevisionNumber : latestRevisionNumber;

    let approved = 0;
    let pending = 0;
    for (const thread of post.threads) {
      for (const comment of thread.comments) {
        if (comment.deletedByUserId !== null) continue;
        if (comment.status === "APPROVED") approved++;
        else if (comment.status === "PENDING") pending++;
      }
    }

    return {
      id: post.id,
      slug: post.slug,
      title: post.title,
      authors: post.authors.map((a) => a.user.adminInitials).join(", "),
      status,
      publishedAt: post.publishedAt,
      createdAt: post.createdAt,
      ahead,
      lastEditorName: latest?.editor?.name ?? latest?.editor?.email ?? "—",
      lastEditAt: latest?.createdAt ?? null,
      approved,
      pending,
      deleted: post.deletedByUserId !== null,
    };
  });

  return (
    <main style={{ maxWidth: 1000, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Posts</h1>
      <p>
        <Link href="/posts/new">+ New post</Link>
      </p>
      <PostsTable rows={rows} />
    </main>
  );
}
