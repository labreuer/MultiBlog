import type { ReactNode } from "react";
import type * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { renderToReactElement } from "@tiptap/static-renderer";
import { docContentExtensions, titleAuthorHighlightExtensions, collectMarkAttrValues } from "@/lib/tiptap-schema";

// Renders an already-materialized Y.Doc the way LiveHistoryViewer renders a
// replayed one (src/components/LiveHistoryViewer.tsx) — but tolerant of a
// document that was never a TipTap doc to begin with (/ydoc-debug's --garbage
// fixture, PLAN.md §11f). This logic is copied rather than extracted out of
// LiveHistoryViewer, which the isolation constraint (PLAN.md §11) puts
// off-limits; de-duplicating the two belongs to the eventual cutover.
//
// Takes a Y.Doc rather than a blob, and **never destroys it** — the replay
// slider owns one long-lived doc that it advances across scrub steps, so
// tearing it down here would break the next incremental step. Decoding bytes
// into a doc is the caller's job (and, for the slider, the thing being timed).

export type YdocContent =
  | {
      ok: true;
      bodyJSON: JSONContent;
      // No fallback of its own (PLAN.md §12n) — null means the title
      // fragment is genuinely empty, not that decoding failed.
      titleJSON: JSONContent | null;
      authorIds: string[];
      clients: Record<string, string>;
    }
  | { ok: false; error: string };

// The decode-only half of renderYdocDoc below — no @tiptap/static-renderer
// work, so no React nodes. PLAN.md §15b's publish path only ever needs the
// JSON (to strip marks and derive Post.proseJson/title from), and rendering
// React elements it then throws away would be pure waste on that path.
export function readYdocContent(doc: Y.Doc): YdocContent {
  try {
    const bodyJSON = TiptapTransformer.extensions(docContentExtensions).fromYdoc(doc, "default");
    const titleFragment = doc.getXmlFragment("title");
    const titleJSON =
      titleFragment.length > 0
        ? TiptapTransformer.extensions(titleAuthorHighlightExtensions).fromYdoc(doc, "title")
        : null;

    const authorIds = new Set(collectMarkAttrValues(bodyJSON, "authorHighlight", "authorId"));
    if (titleJSON) {
      for (const id of collectMarkAttrValues(titleJSON, "authorHighlight", "authorId")) authorIds.add(id);
    }

    const clients: Record<string, string> = {};
    doc.getMap<string>("clients").forEach((userId, clientId) => {
      clients[clientId] = userId;
    });

    return { ok: true, bodyJSON, titleJSON, authorIds: Array.from(authorIds), clients };
  } catch (err) {
    // Carries the complete, user-facing sentence rather than a bare reason:
    // the replay step ahead of this one produces its own differently-worded
    // failure ("couldn't replay…"), and a caller that prefixed both the same
    // way would report a corrupt update log as a TipTap schema problem.
    return {
      ok: false,
      error: `This document isn't TipTap-compatible: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export type YdocRenderResult =
  | (Extract<YdocContent, { ok: true }> & { body: ReactNode; title: ReactNode })
  | { ok: false; error: string };

export function renderYdocDoc(doc: Y.Doc): YdocRenderResult {
  const content = readYdocContent(doc);
  if (!content.ok) return content;

  return {
    ...content,
    body: renderToReactElement({ content: content.bodyJSON, extensions: docContentExtensions }),
    title: content.titleJSON
      ? renderToReactElement({ content: content.titleJSON, extensions: titleAuthorHighlightExtensions })
      : null,
  };
}
