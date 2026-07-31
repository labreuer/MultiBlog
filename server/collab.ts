import "dotenv/config";
import { Server } from "@hocuspocus/server";
import { isYdocDocument, YDOC_SNAPSHOT_PATH, ANNOTATION_MARK_PATH, ANNOTATION_UNMARK_PATH, ANNOTATION_FLUSH_PATH } from "../src/lib/ydoc-names";
import {
  ydocOnAuthenticate,
  ydocOnAwarenessUpdate,
  ydocOnChange,
  ydocOnLoadDocument,
  ydocOnStoreDocument,
  handleYdocSnapshot,
  handleApplyAnnotationMark,
  handleRemoveAnnotationMark,
  handleFlushAnnotationCache,
  send,
} from "./ydoc-hooks";

const PORT = Number(process.env.COLLAB_PORT ?? 1234);

const server = new Server({
  port: PORT,

  // Explicit rather than inherited from Hocuspocus's own default — see
  // PLAN.md §11's context section for what this forecloses (relative-position
  // comment anchors) once ever turned off.
  yDocOptions: { gc: true, gcFilter: () => true },

  // PLAN.md §15e — the only document namespace left (posts' own bare-cuid
  // documents and their post_collab/post_collab_update tables are gone).
  // onAuthenticate is the real chokepoint: registering it is what makes
  // Hocuspocus require authentication on every connection at all, so
  // rejecting a non-`ydoc:` name here is a clean connection refusal — a
  // throw inside onLoadDocument would instead read as a document-creation
  // failure. The other hooks below call straight into ydoc-hooks.ts, since
  // nothing else can ever reach them once a connection gets this far.
  async onAuthenticate(payload) {
    if (!isYdocDocument(payload.documentName)) {
      throw new Error("Unknown document namespace.");
    }
    return ydocOnAuthenticate(payload);
  },

  async onAwarenessUpdate(payload) {
    ydocOnAwarenessUpdate(payload);
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
        await handleYdocSnapshot(request, response);
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
    if (request.url?.startsWith(ANNOTATION_UNMARK_PATH)) {
      try {
        await handleRemoveAnnotationMark(request, response, instance);
      } catch (err) {
        console.error("[collab] annotation-unmark failed:", err);
        send(response, 500, err instanceof Error ? err.message : "Failed to remove annotation mark.");
      }
      return Promise.reject();
    }
    if (request.url?.startsWith(ANNOTATION_FLUSH_PATH)) {
      try {
        await handleFlushAnnotationCache(request, response, instance);
      } catch (err) {
        console.error("[collab] annotation-flush failed:", err);
        send(response, 500, err instanceof Error ? err.message : "Failed to flush annotation cache.");
      }
      return Promise.reject();
    }
  },

  async onLoadDocument(payload) {
    return ydocOnLoadDocument(payload);
  },

  async onStoreDocument(payload) {
    return ydocOnStoreDocument(payload);
  },

  async onChange(payload) {
    return ydocOnChange(payload);
  },
});

server.listen();
