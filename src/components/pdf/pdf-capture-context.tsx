"use client";

import { createContext, useContext } from "react";
import type { CaptureOrigin } from "@/lib/file-version";

// docs/PDF.md §13, "Versions" — where a capture on this page is made: the
// version the viewer loaded, and the kind of address it loaded it from. The
// PDF surface provides it; the composers, which are the doc side's too and
// take no PDF props, read it when they open a draft on a selection or post.
// The server checks it inside the transaction that inserts, so a tab left
// open across a promotion is refused rather than writing on another version.
//
// Null outside a PDF surface: a doc has no versions of this kind.
const PdfCaptureContext = createContext<CaptureOrigin | null>(null);

export const PdfCaptureProvider = PdfCaptureContext.Provider;

export function usePdfCaptureOrigin(): CaptureOrigin | null {
  return useContext(PdfCaptureContext);
}
