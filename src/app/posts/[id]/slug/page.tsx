import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserEditPost } from "@/lib/authz";
import { uniquePostSlug } from "@/lib/post-slug";
import SlugManager from "@/components/SlugManager";

export default async function PostSlugPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const post = await prisma.post.findUnique({
    where: { id },
    include: { slugHistory: { orderBy: { createdAt: "asc" } } },
  });
  if (!post) {
    notFound();
  }

  if (!(await canUserEditPost(session.user.id, session.user.role, post.id))) {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to change this post&apos;s url.</p>
      </main>
    );
  }

  const standardSlug = await uniquePostSlug(post.title, post.id);

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Url: {post.title}</h1>
      <p style={{ marginTop: "1em", marginBottom: "2em" }}>
        <Link href={`/posts/${post.id}/edit`}>Back to editor</Link>
      </p>
      <SlugManager
        entityType="post"
        entityId={post.id}
        currentSlug={post.slug}
        standardSlug={standardSlug}
        urlPrefix=""
        history={post.slugHistory.map((h) => ({ slug: h.slug, createdAt: h.createdAt.toISOString() }))}
      />
    </main>
  );
}
