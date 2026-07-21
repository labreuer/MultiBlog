import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserEditPost } from "@/lib/authz";
import ModerateCommentButtons from "@/components/ModerateCommentButtons";

export default async function ModerateCommentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const post = await prisma.post.findUnique({
    where: { id },
    select: { id: true, title: true },
  });
  if (!post) {
    notFound();
  }

  const allowed = await canUserEditPost(session.user.id, session.user.role, post.id);
  if (!allowed) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to moderate comments on this post.</p>
      </main>
    );
  }

  const pending = await prisma.comment.findMany({
    where: { thread: { postId: post.id }, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: { commenter: true },
  });

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Moderate comments: {post.title}</h1>
      <p>
        <Link href={`/posts/${post.id}/edit`}>Back to editor</Link>
      </p>
      {pending.length === 0 ? (
        <p>No comments awaiting moderation.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {pending.map((comment) => (
            <li key={comment.id} style={{ padding: "12px 0", borderBottom: "1px solid #ddd" }}>
              <p style={{ fontWeight: "bold", marginBottom: 2 }}>
                {comment.commenter.displayName}{" "}
                <span style={{ fontWeight: "normal", color: "#666" }}>({comment.commenter.email})</span>
              </p>
              <p style={{ color: "#666", fontSize: "0.85rem", marginBottom: 4 }}>
                {comment.createdAt.toLocaleString()}
                {comment.ipAddress && ` · ${comment.ipAddress}`}
              </p>
              <p>{(comment.body as { text?: string } | null)?.text ?? ""}</p>
              <ModerateCommentButtons commentId={comment.id} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
