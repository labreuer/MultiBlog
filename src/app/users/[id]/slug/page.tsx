import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/authz";
import { uniqueUserSlug } from "@/lib/user-slug";
import SlugManager from "@/components/SlugManager";

export default async function UserSlugPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!isAdmin(session.user.role)) {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage users.</p>
      </main>
    );
  }

  const user = await prisma.user.findUnique({
    where: { id },
    include: { slugHistory: { orderBy: { createdAt: "asc" } } },
  });
  if (!user) {
    notFound();
  }

  const standardSlug = await uniqueUserSlug(user.name, user.email, user.id);

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Url: {user.name ?? user.email}</h1>
      <p style={{ marginTop: "1em", marginBottom: "2em" }}>
        <Link href="/users">Back to users</Link>
      </p>
      <SlugManager
        entityType="user"
        entityId={user.id}
        currentSlug={user.slug}
        standardSlug={standardSlug}
        urlPrefix="/authors"
        history={user.slugHistory.map((h) => ({ slug: h.slug, createdAt: h.createdAt.toISOString() }))}
      />
    </main>
  );
}
