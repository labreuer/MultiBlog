import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canEditAnyPost } from "@/lib/authz";

export default async function PostHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const post = await prisma.post.findUnique({
    where: { id },
    include: {
      authors: { select: { userId: true } },
      revisions: {
        orderBy: { revisionNumber: "desc" },
        include: { editor: { select: { name: true, email: true } } },
      },
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
        <p>You don&apos;t have permission to view this post&apos;s history.</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>History: {post.title}</h1>
      <p>
        <Link href={`/posts/${post.id}/edit`}>Back to editor</Link>
      </p>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {post.revisions.map((revision) => (
          <li key={revision.id} style={{ padding: "8px 0", borderBottom: "1px solid #ddd" }}>
            <Link href={`/posts/${post.id}/history/${revision.revisionNumber}`}>
              Revision #{revision.revisionNumber}
            </Link>{" "}
            {revision.id === post.currentRevisionId && (
              <strong style={{ color: "green" }}>(published)</strong>
            )}
            <div style={{ color: "#666", fontSize: "0.9rem" }}>
              {revision.createdAt.toLocaleString()} by{" "}
              {revision.editor?.name ?? revision.editor?.email ?? "unknown"}
              {revision.changelog ? ` — ${revision.changelog}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
