import "dotenv/config";
import * as Y from "yjs";
import { Server } from "@hocuspocus/server";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prisma } from "../src/lib/prisma";
import { verifyCollabToken } from "../src/lib/collab-token";
import { contentExtensions } from "../src/lib/tiptap-schema";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
const PORT = Number(process.env.COLLAB_PORT ?? 1234);

// Prisma's foreign-key-violation code.
const FK_VIOLATION = "P2003";

function isMissingPostError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === FK_VIOLATION;
}

async function ignoreMissingPost(documentName: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (!isMissingPostError(err)) throw err;
    console.warn(`[collab] post ${documentName} no longer exists; dropping its pending collab write.`);
  }
}

const server = new Server({
  port: PORT,

  async onAuthenticate({ token, documentName }) {
    const payload = await verifyCollabToken(token).catch(() => null);
    if (!payload) {
      throw new Error("Invalid or expired collab token.");
    }
    if (payload.postId !== documentName) {
      throw new Error("Token does not match this document.");
    }
    return { userId: payload.sub, role: payload.role };
  },

  async onLoadDocument({ documentName, document }) {
    const existing = await prisma.postCollab.findUnique({ where: { postId: documentName } });
    const latestRevision = await prisma.revision.findFirst({
      where: { postId: documentName },
      orderBy: { revisionNumber: "desc" },
    });

    if (existing) {
      Y.applyUpdate(document, existing.ydoc);
    } else {
      const seedYdoc = TiptapTransformer.toYdoc(latestRevision?.doc ?? EMPTY_DOC, "default", contentExtensions);
      Y.applyUpdate(document, Y.encodeStateAsUpdate(seedYdoc));
    }

    // The title is a second fragment of this same doc rather than a node
    // inside "default" — see titleExtensions (src/lib/tiptap-schema.ts) for
    // why. It's seeded here for a fresh doc *and* backfilled for any
    // PostCollab row written before the title moved into the Yjs doc, which
    // is why this runs outside the branch above.
    //
    // Built directly on `document` rather than via TiptapTransformer.toYdoc +
    // applyUpdate: merging a second, independently-created Y.Doc's update in
    // risks a clientID collision with overlapping clocks, whereas writing here
    // uses this document's own clientID.
    //
    // Note this also re-seeds a title that's been emptied to nothing. That's
    // intended — a title is required at creation and empty is invalid
    // everywhere downstream (slug generation, listings, the public <h1>).
    const titleFragment = document.getXmlFragment("title");
    if (titleFragment.length === 0) {
      const title = latestRevision?.title ?? "";
      const paragraph = new Y.XmlElement("paragraph");
      if (title) {
        paragraph.insert(0, [new Y.XmlText(title)]);
      }
      titleFragment.insert(0, [paragraph]);
    }
  },

  // Both persistence hooks below write rows whose postId is a foreign key to
  // Post. If the post is hard-deleted while its doc is still loaded in memory,
  // the write fails with P2003 — and because Hocuspocus doesn't catch what its
  // hooks throw, the rejection is unhandled and takes the whole collab process
  // down with it. There is nothing useful to persist for a post that no longer
  // exists, so treat that one error as "the document outlived its post" and
  // let the doc go. Every other error still propagates.
  async onStoreDocument({ documentName, document }) {
    const state = Buffer.from(Y.encodeStateAsUpdate(document));
    await ignoreMissingPost(documentName, () =>
      prisma.postCollab.upsert({
        where: { postId: documentName },
        create: { postId: documentName, ydoc: state },
        update: { ydoc: state },
      }),
    );
  },

  // Append-only log of raw updates for the current (unpublished) session —
  // lets a reader replay/scrub through it later. Reset whenever a revision
  // is saved (see saveDraft/publishPost), so this never grows past "since
  // the last revision".
  //
  // The log has to be self-sufficient when replayed from an empty Y.Doc:
  // a plain delta's insertions reference *origin* items (the paragraph, or
  // whatever text preceded them) that may have existed since long before
  // the log's current generation started — replaying the delta alone would
  // leave those origins missing. Whenever the log is empty (a fresh session,
  // or right after saveDraft/publishPost just reset it while this same Y.Doc
  // kept running in memory), record the *full* current state instead of
  // just this one delta — it already has this change merged in, and, being
  // taken from the real live document, uses the same item ids any later
  // delta's origins will reference.
  async onChange({ documentName, document, update }) {
    const existingCount = await prisma.postCollabUpdate.count({ where: { postId: documentName } });
    const toStore = existingCount === 0 ? Y.encodeStateAsUpdate(document) : update;
    await ignoreMissingPost(documentName, () =>
      prisma.postCollabUpdate.create({
        data: { postId: documentName, update: Buffer.from(toStore) },
      }),
    );
  },
});

server.listen();
