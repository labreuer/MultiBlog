import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManagePosts, canEditAnyPost } from "@/lib/authz";

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
      revisions: { orderBy: { revisionNumber: "desc" }, take: 1, select: { createdAt: true } },
    },
  });

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Posts</h1>
      <p>
        <Link href="/posts/new">+ New post</Link>
      </p>
      {posts.length === 0 ? (
        <p>No posts yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {posts.map((post) => (
            <li key={post.id} style={{ padding: "8px 0", borderBottom: "1px solid #ddd" }}>
              <Link href={`/posts/${post.id}/edit`}>{post.title}</Link>{" "}
              <span style={{ color: "#666" }}>
                [{post.status}
                {post.revisions[0] ? ` · last saved ${post.revisions[0].createdAt.toLocaleString()}` : ""}]
              </span>{" "}
              <Link href={`/posts/${post.id}/history`}>history</Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
