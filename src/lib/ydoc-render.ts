import type { ReactNode } from "react";
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { renderToReactElement } from "@tiptap/static-renderer";
import { authorHighlightExtensions, titleAuthorHighlightExtensions, collectMarkAttrValues } from "@/lib/tiptap-schema";

// Decodes a single ydoc blob and renders it exactly the way LiveHistoryViewer
// renders a replayed one (src/components/LiveHistoryViewer.tsx) — but for one
// standalone document rather than a replay log, and tolerant of a document
// that was never a TipTap doc to begin with (/ydoc-debug's --garbage
// fixture, PLAN.md §11f). This logic is copied rather than extracted out of
// LiveHistoryViewer, which the isolation constraint (PLAN.md §11) puts
// off-limits; de-duplicating the two belongs to the eventual cutover.

export type YdocRenderResult =
  | {
      ok: true;
      body: ReactNode;
      title: ReactNode;
      authorIds: string[];
      clients: Record<string, string>;
    }
  | { ok: false; error: string };

export function renderYdocBlob(bytes: Uint8Array): YdocRenderResult {
  let scratch: Y.Doc | null = null;
  try {
    scratch = new Y.Doc();
    Y.applyUpdate(scratch, bytes);

    const bodyJSON = TiptapTransformer.extensions(authorHighlightExtensions).fromYdoc(scratch, "default");
    const titleFragment = scratch.getXmlFragment("title");
    const titleJSON =
      titleFragment.length > 0
        ? TiptapTransformer.extensions(titleAuthorHighlightExtensions).fromYdoc(scratch, "title")
        : null;

    const authorIds = new Set(collectMarkAttrValues(bodyJSON, "authorHighlight", "authorId"));
    if (titleJSON) {
      for (const id of collectMarkAttrValues(titleJSON, "authorHighlight", "authorId")) authorIds.add(id);
    }

    const clients: Record<string, string> = {};
    scratch.getMap<string>("clients").forEach((userId, clientId) => {
      clients[clientId] = userId;
    });

    return {
      ok: true,
      body: renderToReactElement({ content: bodyJSON, extensions: authorHighlightExtensions }),
      title: titleJSON ? renderToReactElement({ content: titleJSON, extensions: titleAuthorHighlightExtensions }) : null,
      authorIds: Array.from(authorIds),
      clients,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "This document isn't TipTap-compatible.",
    };
  } finally {
    scratch?.destroy();
  }
}
