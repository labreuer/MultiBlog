import type * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { authorHighlightExtensions, titleAuthorHighlightExtensions } from "../src/lib/tiptap-schema";
import { extractText } from "../src/lib/diff";
import { docIdFromYdocId } from "../src/lib/ydoc-names";
import { prisma } from "../src/lib/prisma";
import type { Prisma } from "../src/generated/prisma/client";

// PLAN.md §12d — writes doc.title/prose_json from the live ydoc, called from
// ydocOnStoreDocument's debounce for every ydoc-stack document, doc or not.
// docIdFromYdocId(ydocId) is non-null for a /ydoc-debug document too (it's
// just string surgery on the ydoc:-prefix), so the updateMany below is what
// actually decides "is this a doc's ydoc" — it matches zero rows for
// anything else. No lookup, no doc-awareness in server/ydoc-store.ts, and
// nothing here throws into the Hocuspocus hook that calls it (§11c's rule):
// a document that isn't TipTap-shaped, or any other failure, is logged and
// dropped, leaving prose_json exactly as stale as it already was.
export async function updateDocCache(ydocId: string, document: Y.Doc): Promise<void> {
  const docId = docIdFromYdocId(ydocId);
  if (!docId) return;

  let bodyJSON: unknown;
  let titleText: string;
  try {
    bodyJSON = TiptapTransformer.extensions(authorHighlightExtensions).fromYdoc(document, "default");
    const titleFragment = document.getXmlFragment("title");
    const titleJSON =
      titleFragment.length > 0 ? TiptapTransformer.extensions(titleAuthorHighlightExtensions).fromYdoc(document, "title") : null;
    titleText = titleJSON ? extractText(titleJSON) : "";
  } catch (err) {
    console.error(`[doc-cache] ${ydocId} isn't TipTap-compatible, leaving prose_json unchanged:`, err);
    return;
  }

  try {
    await prisma.doc.updateMany({
      where: { id: docId },
      data: {
        proseJson: bodyJSON as Prisma.InputJsonValue,
        // An empty title is never a real one (same rule as updatePostTitle,
        // src/app/actions/posts.ts) — skip rather than blank out Doc.title,
        // which is otherwise always non-empty.
        ...(titleText ? { title: titleText } : {}),
      },
    });
  } catch (err) {
    console.error(`[doc-cache] failed to update prose_json for ${ydocId}:`, err);
  }
}
