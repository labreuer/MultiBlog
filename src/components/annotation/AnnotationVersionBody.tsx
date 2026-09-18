"use client";

import { renderToReactElement } from "@tiptap/static-renderer";
import { annotationContentExtensions } from "@/lib/tiptap-schema";

// PLAN.md §22e — one earlier version of an annotation body, inside the
// history panel.
//
// The same `@tiptap/static-renderer` call annotation-entries.ts makes on the
// server, run in the browser instead because the versions arrive from a server
// *action* rather than in the page's tree. That costs nothing this surface
// wasn't already paying: `AnnotationBodyReader` mounts a whole read-only
// editor over these same extensions, so a static render of a 500-character
// body beside it is the cheap half.
//
// Falls back to the stored plain text on anything the renderer refuses, the
// same degradation annotation-entries.ts has — a version that will not render
// is still a version worth reading.
export default function AnnotationVersionBody({ proseJson, bodyText }: { proseJson: unknown; bodyText: string }) {
  if (!proseJson) return bodyText;
  try {
    return renderToReactElement({ content: proseJson as never, extensions: annotationContentExtensions });
  } catch {
    return bodyText;
  }
}
