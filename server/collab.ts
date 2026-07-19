import "dotenv/config";
import * as Y from "yjs";
import { Server } from "@hocuspocus/server";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prisma } from "../src/lib/prisma";
import { verifyCollabToken } from "../src/lib/collab-token";
import { contentExtensions } from "../src/lib/tiptap-schema";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
const PORT = Number(process.env.COLLAB_PORT ?? 1234);

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
    if (existing) {
      Y.applyUpdate(document, existing.ydoc);
      return;
    }

    const latestRevision = await prisma.revision.findFirst({
      where: { postId: documentName },
      orderBy: { revisionNumber: "desc" },
    });
    const seedYdoc = TiptapTransformer.toYdoc(latestRevision?.doc ?? EMPTY_DOC, "default", contentExtensions);
    Y.applyUpdate(document, Y.encodeStateAsUpdate(seedYdoc));
  },

  async onStoreDocument({ documentName, document }) {
    const state = Buffer.from(Y.encodeStateAsUpdate(document));
    await prisma.postCollab.upsert({
      where: { postId: documentName },
      create: { postId: documentName, ydoc: state },
      update: { ydoc: state },
    });
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
    await prisma.postCollabUpdate.create({
      data: { postId: documentName, update: Buffer.from(toStore) },
    });
  },
});

server.listen();
