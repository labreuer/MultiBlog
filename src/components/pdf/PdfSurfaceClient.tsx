"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
import { SignedOutNotice } from "@/components/SignedOutNotice";
import { OutOfDateNotice } from "@/components/OutOfDateNotice";
import type { PdfAnnotationEntry } from "./PdfAnnotationPanel";
import type { AnchoredLinkView } from "@/lib/anchored-link-data";
import type { OwnDraft } from "@/lib/annotation-data";
import { pdfPath, type ShownVersion } from "@/lib/file-version";
import { versionToOpen } from "@/lib/pdf-link-reading";
import type { FileVersionSummary } from "@/lib/file-version-data";
import type { OtherVersionNote } from "@/lib/pdf-annotation-entries";

// PLAN.md §19 — the `ssr: false` boundary.
//
// It has to be its own `"use client"` module: `next/dynamic` with `ssr: false`
// is not allowed inside a Server Component, and /pdf/[slug]'s page is one (it
// does the session, permission and annotation-fetching work). So the page
// renders this, and this renders the surface.
//
// The dynamic import is not an optimisation. pdfjs touches `DOMMatrix` and
// `Path2D` at module scope and `pdfjs-dist/web/pdf_viewer.mjs` reaches for
// `document`, none of which exist in Node — a static import would crash the
// server render rather than merely slow it.
//
// **`metadata` is a rendered Server Component, passed through as a prop.** That
// is the one way anything server-rendered gets inside this island: a client
// module may not *import* a Server Component, but it may receive one already
// rendered, because what crosses the boundary is the RSC payload rather than
// the function. It is how TagChips — which queries Postgres — ends up in
// the Metadata pane of a viewer that never renders on the server at all. The
// cost is that the chips are absent from the initial HTML and arrive with the
// island; on a route that redirects anonymous visitors to /sign-in and opens on
// a different tab, that buys nothing worth keeping them out here for.
function LoadingViewer() {
  return <p style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>Loading viewer…</p>;
}

const PdfAnnotationSurface = dynamic(() => import("./PdfAnnotationSurface"), {
  ssr: false,
  loading: LoadingViewer,
});

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export default function PdfSurfaceClient(props: {
  fileId: string;
  slug: string;
  /** The version this page shows, and which kind of address it was reached at. */
  version: ShownVersion;
  /** Every version of the file, for the banner on one that is not the latest. */
  versions: FileVersionSummary[];
  fileUrl: string;
  title: string;
  /** The notes on the version shown, with the file's own. */
  entries: PdfAnnotationEntry[];
  /** The file's notes on its other versions, each listed under its version. */
  elsewhere: OtherVersionNote[];
  /** The viewer's own drafts on this file, newest first. */
  ownDrafts: OwnDraft[];
  /** The link a ?sel= visit resolved, or null — docs/ANCHORED_LINKS.md. */
  anchoredLink: AnchoredLinkView | null;
  metadata: ReactNode;
}) {
  // **A link that names another version than the latest opens that version**
  // (docs/PDF.md §13, "Links into the file"). Only the browser has the
  // fragment, so the page for the latest arrives first, and this sends the
  // reader on before the viewer mounts: to the version's own address, with
  // the link as written, replacing the history entry. No version has a page
  // map yet, so no such link is carried to the latest instead. On a version's
  // own address nothing leaves: the address chose the version.
  //
  // Null on the server and on the first paint, where there is no fragment to
  // read, so the surface waits one render for it and never mounts a viewer on
  // bytes the reader is about to leave.
  const router = useRouter();
  const hash = useSyncExternalStore<string | null>(
    subscribeHash,
    () => window.location.hash,
    () => null,
  );
  const { slug, version, versions } = props;
  const linkVersions = useMemo(() => versions.map(({ number, state }) => ({ number, state })), [versions]);
  const leavingFor = hash === null ? null : versionToOpen(hash, { shown: version.number, own: version.address === "version" }, linkVersions);
  useEffect(() => {
    if (leavingFor === null) return;
    router.replace(`${pdfPath(slug, { number: leavingFor, isLatest: false }, { own: true })}${window.location.search}${window.location.hash}`);
  }, [leavingFor, router, slug]);

  // The provider is above the surface rather than inside it because the
  // surface's own presence hook attaches to the socket this owns (docs/YDOC.md
  // "One socket per page"), and LiveAnnotationComposer throws without it.
  // The notice sits here, outside the dynamic island, since the annotation
  // bodies inside it are what would report a sign-out, or a refused schema
  // version.
  return (
    <DocPresenceProvider>
      <SignedOutNotice />
      <OutOfDateNotice />
      {hash === null || leavingFor !== null ? <LoadingViewer /> : <PdfAnnotationSurface {...props} />}
    </DocPresenceProvider>
  );
}
