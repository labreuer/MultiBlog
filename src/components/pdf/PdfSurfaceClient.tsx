"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { locateFragmentMisses } from "@/app/actions/pdf-fragment";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
import { SignedOutNotice } from "@/components/SignedOutNotice";
import { OutOfDateNotice } from "@/components/OutOfDateNotice";
import type { PdfAnnotationEntry } from "./PdfAnnotationPanel";
import type { AnchoredLinkView } from "@/lib/anchored-link-data";
import type { OwnDraft } from "@/lib/annotation-data";
import { pdfPath, type ShownVersion } from "@/lib/file-version";
import { arrivalOf, parseLinkVersions } from "@/lib/pdf-link-reading";
import type { FileVersionSummary, VersionManage } from "@/lib/file-version-data";
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

/** Whether two paths are one address, a trailing slash and an escape aside. */
function samePath(a: string, b: string | null): boolean {
  if (b === null) return false;
  const plain = (path: string) => {
    const trimmed = path.replace(/\/+$/, "");
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  };
  return plain(a) === plain(b);
}

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
  /** The file's versions as a link's reading takes them, as one string (`linkVersionsJson`): a memo keys on it. */
  linkVersions: string;
  /** What whoever may manage the file is given on a waiting version's banner; null for every other reader. */
  manage: VersionManage | null;
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
  // **A link that can't be carried to the version shown opens the version it
  // names** (docs/PDF.md §13, "Links into the file"). A link is carried
  // through the page maps between the two versions, and where one on the way
  // is missing it isn't. Only the browser has the fragment, so the page for
  // the latest arrives first, and this sends the reader on before the viewer
  // mounts: to the version's own address, with the link as written, replacing
  // the history entry. On a version's own address nothing leaves: the address
  // chose the version.
  //
  // **A link whose sheet has no counterpart here is carried only by its
  // words**, where they occur exactly once in the version shown, and only
  // the server has every sheet's text. So that one question is asked before
  // the viewer mounts, and the answer decides between staying and going.
  //
  // **By a full load (`location.replace`), never `router.replace`.** Next's
  // client router keeps the fragment of a client navigation with the route it
  // reached, and puts it on every later client navigation to that path
  // (16.2.11: `discoverKnownRoute` is handed the URL with its hash, and
  // `navigateUsingPrefetchedRouteTree` then appends the new one to it). A
  // `router.replace` to `/pdf/<slug>/v/1#sheet=50` so leaves that path
  // carrying `#sheet=50`, and the next plain link to it arrives with a
  // fragment its reader never followed. A full load keeps no such memory, and
  // costs nothing here: no viewer has mounted yet, and the version's page is
  // another document.
  //
  // Null on the server and on the first paint, where there is no fragment to
  // read, so the surface waits one render for it and never mounts a viewer on
  // bytes the reader is about to leave.
  //
  // **Null, too, until the address bar shows this page's own path.** On a
  // client navigation this component renders a commit before the router
  // writes the new URL, so `window.location` is still the page the reader
  // came from, and its fragment is that page's. Read then, a reader who
  // followed "the latest is version 2" from `/pdf/book/v/1#sheet=50` would be
  // taken for someone arriving with `#sheet=50`, read as version 1's, and
  // sent straight back. `usePathname()` is the router's own answer and is
  // already this page's; once the bar agrees, the snapshot changes and this
  // renders again.
  const pathname = usePathname();
  const hash = useSyncExternalStore<string | null>(
    subscribeHash,
    () => (samePath(window.location.pathname, pathname) ? window.location.hash : null),
    () => null,
  );
  const { slug, version, fileId } = props;
  const arrival = useMemo(
    () => (hash === null ? null : arrivalOf(hash, { shown: version.number, own: version.address === "version" }, parseLinkVersions(props.linkVersions))),
    [hash, version.number, version.address, props.linkVersions],
  );
  // The server's answer for the fragment it was asked about: whether the link's words are on exactly one sheet here.
  const [wordsFound, setWordsFound] = useState<{ hash: string; found: boolean } | null>(null);
  useEffect(() => {
    if (arrival?.kind !== "by-words" || hash === null) return;
    let cancelled = false;
    locateFragmentMisses(fileId, version.id, [{ passage: arrival.passage, named: [] }])
      .then((answers) => answers[0]?.sheet != null)
      .catch(() => false)
      .then((found) => {
        if (!cancelled) setWordsFound({ hash, found });
      });
    return () => {
      cancelled = true;
    };
  }, [arrival, hash, fileId, version.id]);
  const asked = arrival?.kind === "by-words" && wordsFound?.hash === hash ? wordsFound : null;
  const waiting = arrival?.kind === "by-words" && asked === null;
  const leavingFor = arrival?.kind === "open" ? arrival.version : arrival?.kind === "by-words" && asked && !asked.found ? arrival.version : null;
  useEffect(() => {
    if (leavingFor === null) return;
    window.location.replace(`${pdfPath(slug, { number: leavingFor, isLatest: false }, { own: true })}${window.location.search}${window.location.hash}`);
  }, [leavingFor, slug]);

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
      {hash === null || waiting || leavingFor !== null ? <LoadingViewer /> : <PdfAnnotationSurface {...props} />}
    </DocPresenceProvider>
  );
}
