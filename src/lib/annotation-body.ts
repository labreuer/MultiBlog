import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import type { JSONContent } from "@tiptap/core";
import { annotationContentExtensions } from "./tiptap-schema";
import { extractText } from "./diff";

// PLAN.md §22e — the one definition of what an annotation body's *text* is.
//
// Three writers used to decode a body independently: the store debounce
// (server/annotation-cache.ts), the settle path that records a version, and
// the reader that shows an earlier one. The cache columns and a settled
// version are compared to each other (`settled-cache` in
// scripts/integrity/check-annotation-snapshots.ts, the no-op check in
// `finishAnnotationEdit`), so two decoders that could disagree about
// whitespace or about which fragment to read would produce findings that are
// really a decoding difference wearing a fault's clothes. One function, so
// they cannot.
//
// Server-side only: it pulls in yjs and the Hocuspocus transformer, which no
// client component should carry.

export type DecodedAnnotationBody = { proseJson: JSONContent; bodyText: string };

/**
 * The body as the cache columns hold it. Throws when the "default" fragment
 * is not decodable by the annotation schema — a body written with the doc
 * schema, or a bare /ydoc-debug document — which every caller treats as
 * "leave things as they are" rather than as empty.
 */
export function decodeAnnotationBody(doc: Y.Doc): DecodedAnnotationBody {
  const proseJson = TiptapTransformer.extensions(annotationContentExtensions).fromYdoc(doc, "default") as JSONContent;
  return { proseJson, bodyText: extractText(proseJson) };
}

/**
 * A settled version, decoded from its `ydoc_snapshot` bytes. A snapshot is a
 * full Yjs state (invariant 2, PLAN.md §11b), so applying it to an empty
 * document *is* the document at that mark — no log replay involved, which is
 * what makes listing a body's history a decode per version rather than a
 * replay per version.
 */
export function decodeAnnotationSnapshot(bytes: Uint8Array): DecodedAnnotationBody {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    return decodeAnnotationBody(doc);
  } finally {
    doc.destroy();
  }
}
