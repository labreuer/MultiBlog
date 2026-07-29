import "dotenv/config";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as Y from "yjs";
import { Server, type Hocuspocus } from "@hocuspocus/server";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import { prisma } from "../src/lib/prisma";
import { verifyCollabToken } from "../src/lib/collab-token";
import { contentExtensions, pmSchema, pmTitleSchema } from "../src/lib/tiptap-schema";
import { REPLACE_DOC_PATH } from "../src/lib/collab-admin";
import { isYdocDocument, YDOC_SNAPSHOT_PATH, ANNOTATION_MARK_PATH } from "../src/lib/ydoc-names";
import {
  ydocOnAuthenticate,
  ydocOnAwarenessUpdate,
  ydocOnChange,
  ydocOnLoadDocument,
  ydocOnStoreDocument,
  handleYdocSnapshot,
  handleApplyAnnotationMark,
} from "./ydoc-hooks";

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

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      // The only caller posts one revision's document; anything larger is a
      // mistake or an attack, and shouldn't be buffered indefinitely.
      if (raw.length > 5_000_000) reject(new Error("Request body too large."));
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Malformed JSON body."));
      }
    });
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "text/plain" });
  response.end(message);
}

/**
 * Replaces a document's body and title fragments with the posted content, and
 * broadcasts to everyone connected — see src/lib/collab-admin.ts for why a
 * restore has to come through here rather than just writing a Revision row.
 *
 * Both fragments are written with y-prosemirror's prosemirrorToYXmlFragment,
 * which diffs against what's already there and emits only the differing ops.
 * That matters for the same reason onLoadDocument builds the title by hand:
 * merging in an update from a separately-created Y.Doc risks a clientID
 * collision with overlapping clocks, whereas this writes using the live
 * document's own clientID.
 */
async function handleReplaceDoc(request: IncomingMessage, response: ServerResponse, instance: Hocuspocus) {
  const body = (await readJsonBody(request)) as Partial<ReplaceDocBody>;
  const { token, postId, doc, title } = body;
  if (typeof token !== "string" || typeof postId !== "string" || typeof title !== "string" || !doc) {
    send(response, 400, "Expected token, postId, doc and title.");
    return;
  }

  const payload = await verifyCollabToken(token).catch(() => null);
  if (!payload || payload.postId !== postId) {
    // The token is minted by the server action only after it has checked that
    // this user may edit this post, so a valid token naming this document is
    // the authorization — same contract as onAuthenticate above.
    send(response, 403, "Invalid or mismatched collab token.");
    return;
  }

  const connection = await instance.openDirectConnection(postId);
  try {
    await connection.transact((document) => {
      prosemirrorToYXmlFragment(pmSchema.nodeFromJSON(doc), document.getXmlFragment("default"));
      prosemirrorToYXmlFragment(
        pmTitleSchema.nodeFromJSON({
          type: "doc",
          content: [{ type: "paragraph", ...(title ? { content: [{ type: "text", text: title }] } : {}) }],
        }),
        document.getXmlFragment("title"),
      );
    });
  } finally {
    await connection.disconnect();
  }

  send(response, 204, "");
}

type ReplaceDocBody = { token: string; postId: string; doc: object; title: string };

const server = new Server({
  port: PORT,

  // Explicit rather than inherited from Hocuspocus's own default — see
  // PLAN.md §11's context section for what this forecloses (relative-position
  // comment anchors) once ever turned off.
  yDocOptions: { gc: true, gcFilter: () => true },

  // Two entirely independent document stacks share this one process and port
  // (PLAN.md §11): post documents (bare cuids, handled below exactly as
  // before) and the new standalone ydoc stack (`ydoc:`-prefixed names,
  // handled by server/ydoc-hooks.ts). isYdocDocument(documentName) is the
  // only thing that tells them apart — nothing in the branches below it
  // changes for post documents.
  async onAuthenticate(payload) {
    const { token, documentName } = payload;
    if (isYdocDocument(documentName)) {
      return ydocOnAuthenticate(payload);
    }
    const collabPayload = await verifyCollabToken(token).catch(() => null);
    if (!collabPayload) {
      throw new Error("Invalid or expired collab token.");
    }
    if (collabPayload.postId !== documentName) {
      throw new Error("Token does not match this document.");
    }
    return { userId: collabPayload.sub, role: collabPayload.role };
  },

  async onAwarenessUpdate(payload) {
    if (isYdocDocument(payload.documentName)) {
      ydocOnAwarenessUpdate(payload);
    }
  },

  // Hocuspocus serves plain HTTP on the same port as the websocket. Its
  // convention for "I handled this request" is to reject with a *falsy* value
  // (its request handler rethrows anything truthy and otherwise stops), which
  // is what keeps the default "Welcome to Hocuspocus!" 200 from also being
  // written. Anything that isn't one of our endpoints returns normally and
  // falls through to that default.
  async onRequest({ request, response, instance }) {
    if (request.method !== "POST") {
      return;
    }
    if (request.url?.startsWith(YDOC_SNAPSHOT_PATH)) {
      try {
        await handleYdocSnapshot(request, response, instance);
      } catch (err) {
        console.error("[collab] ydoc-snapshot failed:", err);
        send(response, 500, err instanceof Error ? err.message : "Failed to snapshot document.");
      }
      return Promise.reject();
    }
    if (request.url?.startsWith(ANNOTATION_MARK_PATH)) {
      try {
        await handleApplyAnnotationMark(request, response, instance);
      } catch (err) {
        console.error("[collab] annotation-mark failed:", err);
        send(response, 500, err instanceof Error ? err.message : "Failed to apply annotation mark.");
      }
      return Promise.reject();
    }
    if (!request.url?.startsWith(REPLACE_DOC_PATH)) {
      return;
    }
    try {
      await handleReplaceDoc(request, response, instance);
    } catch (err) {
      console.error("[collab] replace-doc failed:", err);
      send(response, 500, err instanceof Error ? err.message : "Failed to replace document.");
    }
    return Promise.reject();
  },

  async onLoadDocument(payload) {
    const { documentName, document } = payload;
    if (isYdocDocument(documentName)) {
      return ydocOnLoadDocument(payload);
    }
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
  async onStoreDocument(payload) {
    const { documentName, document } = payload;
    if (isYdocDocument(documentName)) {
      return ydocOnStoreDocument(payload);
    }
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
  async onChange(payload) {
    const { documentName, document, update } = payload;
    if (isYdocDocument(documentName)) {
      return ydocOnChange(payload);
    }
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
