import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { isDocParamShape, resolveDocParam } from "@/lib/resolve-doc-param";
import { canUserEditDoc, canUserReadDoc } from "@/lib/doc-authz";
import { uniqueDocSlug } from "@/lib/doc-slug";
import { docTitleOrFallback } from "@/lib/doc-title";
import { signInPath } from "@/lib/sign-in-redirect";
import { wikiPathOfDoc } from "@/lib/wiki-address";
import SlugManager from "@/components/SlugManager";

export const metadata: Metadata = { title: "Doc url" };

export default async function DocSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath(`/doc/${slug}/slug`));
  }
  if (!isDocParamShape(slug)) notFound();

  const doc = await resolveDocParam(slug, {
    id: true,
    title: true,
    slug: true,
    visibility: true,
    wikiName: true,
    wikiVariant: true,
    wikiOwner: { select: { slug: true } },
    slugHistory: { orderBy: { createdAt: "asc" } },
  });
  if (!doc) {
    notFound();
  }

  if (!(await canUserEditDoc(session.user.id, session.user.role, doc.id))) {
    // A wiki doc's Forbidden goes only to a reader, to whom it reveals
    // nothing; anyone else gets the answer for a missing doc, since a
    // Forbidden would confirm that a page of that name exists (docs/WIKI.md
    // "URLs").
    if (doc.wikiName !== null && !(await canUserReadDoc(session.user.id, session.user.role, doc))) notFound();
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to change this doc&apos;s url.</p>
      </main>
    );
  }

  const wikiPath = wikiPathOfDoc({ wikiName: doc.wikiName, wikiVariant: doc.wikiVariant, ownerSlug: doc.wikiOwner?.slug ?? null });
  // Falls back to "Untitled" before deriving the suggestion — otherwise an
  // untitled doc's standardSlug would be slugify("", "doc") -> "doc" ->
  // reserved -> "doc-doc", which reads as a typo rather than a fallback.
  const standardSlug = await uniqueDocSlug(docTitleOrFallback(doc.title), doc.id);

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Url: {docTitleOrFallback(doc.title)}</h1>
      <p style={{ marginTop: "1em", marginBottom: "2em" }}>
        <Link href={wikiPath ? `${wikiPath}/edit` : `/doc/${doc.id}/edit`}>Back to editor</Link>
      </p>
      {wikiPath && (
        // docs/WIKI.md "URLs" — a wiki page's url is its address. Its slug is
        // an internal handle, frozen while it is in the wiki, whose past urls
        // still redirect on to the address.
        <p style={{ marginBottom: "1.5em" }}>
          This is a wiki page, at <Link href={wikiPath}>{wikiPath}</Link>. Its doc url below is frozen while it is in the
          wiki; links to it, and to its past urls, go on to the page.
        </p>
      )}
      <SlugManager
        entityType="doc"
        entityId={doc.id}
        currentSlug={doc.slug}
        standardSlug={standardSlug}
        urlPrefix="/doc"
        history={doc.slugHistory.map((h) => ({ slug: h.slug, createdAt: h.createdAt.toISOString() }))}
        frozen={wikiPath !== null}
      />
    </main>
  );
}
