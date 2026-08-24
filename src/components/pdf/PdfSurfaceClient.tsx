"use client";

import dynamic from "next/dynamic";
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
const PdfAnnotationSurface = dynamic(() => import("./PdfAnnotationSurface"), {
  ssr: false,
  loading: () => <p style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>Loading viewer…</p>,
});

export default function PdfSurfaceClient(props: {
  fileId: string;
  fileUrl: string;
  title: string;
  entries: PdfAnnotationEntry[];
}) {
  return <PdfAnnotationSurface {...props} />;
}
