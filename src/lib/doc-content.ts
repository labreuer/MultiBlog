import type * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import { extractText } from "./diff";
import { readYdocContent } from "./ydoc-render";

// PLAN.md §12d — derives what a Doc row *caches* from its ydoc, which is the
// canonical copy (§3d). The doc's own title/prose_json columns are only ever
// this function's output; nothing recomputes them on read, which is why
// scripts/integrity/check-doc-integrity.ts exists to check they still agree.
//
// The deliberate contrast with postContentFromYdoc (./post-content.ts) is what
// this function *doesn't* do: no mark stripping. A post is rendered by readers
// through contentExtensions/pmSchema, which know nothing of authorHighlight or
// annotation, so leaving either in would 500 the public page — hence §15b's
// strip. A doc is the live editing surface those marks belong to, so its cache
// has to keep them or the cached copy would stop matching the ydoc it came
// from. Same source, opposite requirement; that is the whole reason these are
// two functions rather than one with a flag.
//
// Throws on a document that isn't TipTap-shaped, matching postContentFromYdoc.
// Callers on the collab server's hook path must catch — see updateDocCache,
// which logs and leaves the columns as stale as they already were rather than
// throwing into Hocuspocus (§11c).
export function docContentFromYdoc(doc: Y.Doc): { proseJson: JSONContent; title: string } {
  const content = readYdocContent(doc);
  if (!content.ok) {
    throw new Error(content.error);
  }

  // titleJSON is null only when the title fragment is genuinely empty, never
  // when decoding failed (§12n), so "" here means "this doc has no title" —
  // which must write through as an empty title rather than freeze the column
  // at whatever was last typed before it was cleared.
  return { proseJson: content.bodyJSON, title: content.titleJSON ? extractText(content.titleJSON) : "" };
}
