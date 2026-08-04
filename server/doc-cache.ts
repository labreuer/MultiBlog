import type * as Y from "yjs";
import { docContentFromYdoc } from "../src/lib/doc-content";
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

  // The derivation lives in docContentFromYdoc so the two places that seed a
  // doc's ydoc without a collab server in the loop — scripts/seed-sample-data.ts
  // and e2e/db-worker.ts's createTestDoc — can write exactly the same cache
  // this would have written, rather than approximating it. When they drifted,
  // the symptom was a doc reading 0 characters on /docs forever.
  let bodyJSON: unknown;
  let titleText: string;
  try {
    ({ proseJson: bodyJSON, title: titleText } = docContentFromYdoc(document));
  } catch (err) {
    console.error(`[doc-cache] ${ydocId} isn't TipTap-compatible, leaving prose_json unchanged:`, err);
    return;
  }

  try {
    await prisma.doc.updateMany({
      where: { id: docId },
      data: {
        proseJson: bodyJSON as Prisma.InputJsonValue,
        // Unlike updatePostTitle's skip-empty rule (src/app/actions/posts.ts)
        // — a post's title has no fragment behind it, so an empty string
        // there really would mean "nothing was ever typed, don't overwrite
        // the real title with blank." A doc's title fragment IS the title;
        // Doc.title is only ever a cache of it (PLAN.md §12n), so an empty
        // fragment has to write through as an empty title, not freeze the
        // cache at whatever was last typed before it got cleared. Docs are
        // also created with title: "" (createDoc, src/app/actions/docs.ts)
        // and no seeded title fragment, so this runs from the first store
        // debounce, not just on a later clear.
        title: titleText,
      },
    });
  } catch (err) {
    console.error(`[doc-cache] failed to update prose_json for ${ydocId}:`, err);
  }
}
