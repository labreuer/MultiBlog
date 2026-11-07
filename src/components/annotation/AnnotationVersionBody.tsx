"use client";

import type { JSONContent } from "@tiptap/core";
import { annotationContentExtensions } from "@/lib/tiptap-schema";
import { renderWithChips } from "@/lib/entity-chips/static";
import { NO_CHIP_INPUTS, type ChipInputs } from "@/lib/entity-chips/types";

// PLAN.md §22e — one earlier version of an annotation body, inside the
// history panel.
//
// The same static render annotation-entries.ts makes on the server, run in the
// browser instead because the versions arrive from a server *action* rather
// than in the page's tree. The action sends the chip inputs with a version
// that holds a chip, so a mention in an earlier version is labelled as the
// current body's are. That costs nothing this surface
// wasn't already paying: `AnnotationBodyReader` mounts a whole read-only
// editor over these same extensions, so a static render of a 500-character
// body beside it is the cheap half.
//
// Falls back to the stored plain text on anything the renderer refuses, the
// same degradation annotation-entries.ts has — a version that will not render
// is still a version worth reading.
export default function AnnotationVersionBody({
  proseJson,
  bodyText,
  chipInputs,
}: {
  proseJson: unknown;
  bodyText: string;
  chipInputs?: ChipInputs;
}) {
  if (!proseJson) return bodyText;
  try {
    return renderWithChips(proseJson as JSONContent, annotationContentExtensions, chipInputs ?? NO_CHIP_INPUTS);
  } catch {
    return bodyText;
  }
}
