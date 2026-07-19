import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canEditAnyPost } from "@/lib/authz";
import LiveHistoryViewer from "@/components/LiveHistoryViewer";

export default async function LiveHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const post = await prisma.post.findUnique({
    where: { id },
    include: { authors: { select: { userId: true } } },
  });
  if (!post) {
    notFound();
  }

  const isOwner = post.authors.some((a) => a.userId === session.user.id);
  if (!canEditAnyPost(session.user.role) && !isOwner) {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to view this post&apos;s live history.</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "sans-serif", padding: "0 1rem" }}>
      <p>
        <Link href={`/posts/${post.id}/edit`}>Back to editor</Link>
      </p>
      <h1>{post.title} — live history</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Scrubs through edits made since the last saved revision. Read-only — stays connected while others keep
        editing.
      </p>
      <LiveHistoryViewer postId={post.id} />
    </main>
  );
}
