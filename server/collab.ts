import "dotenv/config";
import * as Y from "yjs";
import { Server } from "@hocuspocus/server";
import { TiptapTransformer } from "@hocuspocus/transformer";
import StarterKit from "@tiptap/starter-kit";
import { prisma } from "../src/lib/prisma";
import { verifyCollabToken } from "../src/lib/collab-token";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
const EXTENSIONS = [StarterKit];
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
    const seedYdoc = TiptapTransformer.toYdoc(latestRevision?.doc ?? EMPTY_DOC, "default", EXTENSIONS);
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
});

server.listen();
