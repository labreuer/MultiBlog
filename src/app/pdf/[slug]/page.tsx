import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { canUserReadFile } from "@/lib/file-authz";
import { resolveFileParam } from "@/lib/file-slug";
import { gated, titleWhenOk } from "@/lib/route-access";
import PdfSurfaceClient from "@/components/pdf/PdfSurfaceClient";
import { pdfAnnotationEntriesFor } from "@/lib/pdf-annotation-entries";
import { signInPath } from "@/lib/sign-in-redirect";
import TagChips from "@/components/tags/TagChips";
import styles from "./page.module.css";

// PLAN.md §19 — the PDF reading view.
//
// Inherently dynamic (per-user gated), like /doc/[slug]: no generateStaticParams
// and none should be added, since a route eligible for static generation that
// also calls a dynamic API throws DYNAMIC_SERVER_USAGE at build (§10 item 17).
//
// A Server Component, so the session and permission work happens before any
// bytes are named; the viewer itself is a client island behind `ssr: false`
// (see PdfViewerClient for why that boundary has to exist at all).

// The one route whose resolver can answer "somewhere else": a past slug
// redirects to the current one rather than rendering here, so a shared link
// doesn't quietly become the canonical URL — the same contract /doc/[slug] has
// through resolveDocParam. That is the `redirect` arm of Access, and it is
// returned *before* the gate so the ordering the body used to have is
// unchanged.
const loadFileForRead = gated(async (user, slug: string) => {
  const resolved = await resolveFileParam(slug, {
    id: true,
    slug: true,
    title: true,
    sha256: true,
    visibility: true,
    deletedByUserId: true,
  });
  if (!resolved) {
    return "not-found";
  }
  if (resolved.redirectTo) {
    return { redirect: resolved.redirectTo };
  }
  // resolveFileParam uses prismaIncludingDeleted so a management route could
  // offer an undelete; this is the reading route, so it checks itself.
  if (resolved.file.deletedByUserId !== null) {
    return "not-found";
  }
  if (!(await canUserReadFile(user.id, user.role, resolved.file))) {
    return "forbidden";
  }
  return resolved.file;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return titleWhenOk(await loadFileForRead(slug), (file) => file.title);
}

export default async function PdfPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Free — generateMetadata already ran this for the same request.
  const access = await loadFileForRead(slug);
  if (access.status === "signed-out") {
    redirect(signInPath(`/pdf/${slug}`));
  }
  if (access.status === "redirect") {
    redirect(access.to);
  }
  if (access.status === "not-found") {
    notFound();
  }
  if (access.status === "forbidden") {
    return (
      <main className={styles.forbidden}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to read this file.</p>
      </main>
    );
  }
  const file = access.value;

  // The hash is in the path, which is what makes this URL immutable and lets
  // the download route answer `immutable` — see the route's own header.
  const fileUrl = `/api/files/${file.id}/${file.sha256}`;

  // Fetched here rather than inside the panel for the same reason
  // /doc/[slug] fetches its threads at the page level (PLAN.md §13o): the
  // *highlights* and the *cards* have to come from one snapshot, or the two
  // could disagree about which annotations exist.
  //
  // Shared with `loadPdfAnnotationEntries`, which the surface calls after a
  // post — see that action, and PdfAnnotationSurface's `liveEntries`.
  const entries = await pdfAnnotationEntriesFor(file.id);

  // PLAN.md §20d — the tag chips, handed to the viewer as its Metadata
  // pane.
  //
  // Passed as a prop, not imported by the client island: PdfSurfaceClient is a
  // `"use client"` module behind `ssr: false`, which may not import a Server
  // Component but may receive one already rendered (its header has the whole
  // reason). Gated by this page's canUserReadFile above, exactly as the doc
  // page's chips are gated by canUserReadDoc.
  //
  // The `key` is pre-emptive. An async Server Component handed across a
  // client boundary as a prop needs one the moment its client renders it
  // among siblings (CLAUDE.md's Gotchas; /doc/[slug]'s byline is the live
  // case). PdfMetadataPanel renders this as its sole child today, which is
  // the only reason it escapes — and that panel is expected to grow the
  // file's own facts beside it.
  return (
    <PdfSurfaceClient
      fileId={file.id}
      fileUrl={fileUrl}
      title={file.title}
      entries={entries}
      metadata={<TagChips key="tags" target={{ kind: "file", id: file.id }} />}
    />
  );
}
