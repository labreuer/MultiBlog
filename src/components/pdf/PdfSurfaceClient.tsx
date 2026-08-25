"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import type { PdfAnnotationEntry } from "./PdfAnnotationPanel";

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
// the function. It is how KeywordChips — which queries Postgres — ends up in
// the Metadata pane of a viewer that never renders on the server at all. The
// cost is that the chips are absent from the initial HTML and arrive with the
// island; on a route that redirects anonymous visitors to /sign-in and opens on
// a different tab, that buys nothing worth keeping them out here for.
const PdfAnnotationSurface = dynamic(() => import("./PdfAnnotationSurface"), {
  ssr: false,
  loading: () => <p style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>Loading viewer…</p>,
});

export default function PdfSurfaceClient(props: {
  fileId: string;
  fileUrl: string;
  title: string;
  entries: PdfAnnotationEntry[];
  metadata: ReactNode;
}) {
  return <PdfAnnotationSurface {...props} />;
}
