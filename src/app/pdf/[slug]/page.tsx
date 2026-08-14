import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { canUserReadFile } from "@/lib/file-authz";
import { resolveFileParam } from "@/lib/file-slug";
import PdfViewerClient from "@/components/pdf/PdfViewerClient";
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

export default async function PdfPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const resolved = await resolveFileParam(slug, {
    id: true,
    slug: true,
    title: true,
    sha256: true,
    visibility: true,
    deletedByUserId: true,
  });
  if (!resolved) {
    notFound();
  }
  // A past slug redirects to the current one rather than rendering here, so a
  // shared link doesn't quietly become the canonical URL — same contract
  // /doc/[slug] has through resolveDocParam.
  if (resolved.redirectTo) {
    redirect(resolved.redirectTo);
  }

  const file = resolved.file;
  // resolveFileParam uses prismaIncludingDeleted so a management route could
  // offer an undelete; this is the reading route, so it checks itself.
  if (file.deletedByUserId !== null) {
    notFound();
  }

  if (!(await canUserReadFile(session.user.id, session.user.role, file))) {
    return (
      <main className={styles.forbidden}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to read this file.</p>
      </main>
    );
  }

  // The hash is in the path, which is what makes this URL immutable and lets
  // the download route answer `immutable` — see the route's own header.
  const fileUrl = `/api/files/${file.id}/${file.sha256}`;

  return <PdfViewerClient fileUrl={fileUrl} title={file.title} />;
}
