"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

// PLAN.md §19 — the `ssr: false` boundary.
//
// It has to be its own `"use client"` module: `next/dynamic` with
// `ssr: false` is not allowed inside a Server Component, and /pdf/[slug]'s
// page is one (it does the session and permission work). So the page renders
// this, and this renders the viewer.
//
// The dynamic import is not an optimisation. pdfjs touches `DOMMatrix` and
// `Path2D` at module scope, and `pdfjs-dist/web/pdf_viewer.mjs` reaches for
// `document` — none of which exist in Node, so a static import would crash the
// server render rather than merely slow it.
const PdfViewer = dynamic(() => import("./PdfViewer"), {
  ssr: false,
  loading: () => <p style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>Loading viewer…</p>,
});

export default function PdfViewerClient({ fileUrl, title }: { fileUrl: string; title: string }) {
  // Panel state lives here rather than in PdfViewer so that Phase 3's
  // annotation tree — which this component will own — and the toolbar's toggle
  // are looking at the same value without either being the other's parent.
  const [panelOpen, setPanelOpen] = useState(true);

  return (
    <PdfViewer
      fileUrl={fileUrl}
      title={title}
      panelOpen={panelOpen}
      onTogglePanel={() => setPanelOpen((open) => !open)}
    />
  );
}
