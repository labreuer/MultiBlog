import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { resolveDocParam } from "@/lib/resolve-doc-param";
import { canUserEditDoc } from "@/lib/doc-authz";
import { uniqueDocSlug } from "@/lib/doc-slug";
import { docTitleOrFallback } from "@/lib/doc-title";
import SlugManager from "@/components/SlugManager";

export const metadata: Metadata = { title: "Doc url" };

export default async function DocSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const doc = await resolveDocParam(slug, {
    id: true,
    title: true,
    slug: true,
    slugHistory: { orderBy: { createdAt: "asc" } },
  });
  if (!doc) {
    notFound();
  }

  if (!(await canUserEditDoc(session.user.id, session.user.role, doc.id))) {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to change this doc&apos;s url.</p>
      </main>
    );
  }

  // Falls back to "Untitled" before deriving the suggestion — otherwise an
  // untitled doc's standardSlug would be slugify("", "doc") -> "doc" ->
  // reserved -> "doc-doc", which reads as a typo rather than a fallback.
  const standardSlug = await uniqueDocSlug(docTitleOrFallback(doc.title), doc.id);

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Url: {docTitleOrFallback(doc.title)}</h1>
      <p style={{ marginTop: "1em", marginBottom: "2em" }}>
        <Link href={`/doc/${doc.id}/edit`}>Back to editor</Link>
      </p>
      <SlugManager
        entityType="doc"
        entityId={doc.id}
        currentSlug={doc.slug}
        standardSlug={standardSlug}
        urlPrefix="/doc"
        history={doc.slugHistory.map((h) => ({ slug: h.slug, createdAt: h.createdAt.toISOString() }))}
      />
    </main>
  );
}
