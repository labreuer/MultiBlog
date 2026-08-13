import type { IncomingMessage, ServerResponse } from "node:http";
import * as Y from "yjs";
import type {
  Connection,
  Document,
  Hocuspocus,
  onAuthenticatePayload,
  onAwarenessUpdatePayload,
  onChangePayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from "@hocuspocus/server";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import { Transform } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Role } from "../src/generated/prisma/enums";
import { prisma } from "../src/lib/prisma";
import { verifyYdocToken } from "../src/lib/ydoc-token";
import { docContentExtensions, pmDocContentSchema, annotationContentExtensions, pmAnnotationContentSchema } from "../src/lib/tiptap-schema";
import { resolveAnchorInDoc } from "../src/lib/annotation-anchors";
import { annotationIdFromYdocId } from "../src/lib/ydoc-names";
import {
  ydocStore,
  drainAppends,
  UNAVAILABLE,
  markDegraded,
  clearDegraded,
  isDegraded,
  encodeYdocState,
} from "./ydoc-store";
import { materializeYdocAt } from "../src/lib/ydoc-snapshot";
import { updateDocCache } from "./doc-cache";
import { updateAnnotationCache } from "./annotation-cache";

// Every new-stack Hocuspocus hook (PLAN.md §11d). Kept entirely separate from
// server/collab.ts's post-document hooks — the two stacks share the process
// and the port, nothing else. server/collab.ts's own hooks call into this
// module only behind an isYdocDocument(documentName) guard, so nothing here
// ever runs for a post document and nothing in collab.ts's existing bodies
// changes.

export type YdocContext = { userId: string; role: Role };

const EMPTY_STATE = (() => {
  const doc = new Y.Doc();
  const state = encodeYdocState(doc);
  doc.destroy();
  return state;
})();

export async function ydocOnAuthenticate({
  token,
  documentName,
  connectionConfig,
}: onAuthenticatePayload): Promise<YdocContext> {
  const payload = await verifyYdocToken(token).catch(() => null);
  if (!payload) {
    throw new Error("Invalid or expired ydoc token.");
  }
  if (payload.documentName !== documentName) {
    throw new Error("Token does not match this document.");
  }
  // PLAN.md §12g — a doc reader's token carries readOnly: true; Hocuspocus
  // itself then refuses any write this connection attempts. Every other
  // token (including every /ydoc-debug one) leaves connectionConfig.readOnly
  // at its default (writable).
  if (payload.readOnly) {
    connectionConfig.readOnly = true;
  }
  return { userId: payload.sub, role: payload.role };
}

export async function ydocOnLoadDocument({ documentName, document }: onLoadDocumentPayload<YdocContext>): Promise<void> {
  const row = await ydocStore.load(documentName);

  if (row === UNAVAILABLE) {
    // Sticky for this document's whole in-memory lifetime (PLAN.md §11c) — a
    // document that came up unseeded must never later overwrite a real ydoc
    // row. It naturally retries on the next cold open, once the last client
    // disconnects and Hocuspocus unloads this Document instance.
    markDegraded(documentName);
    return;
  }
  clearDegraded(documentName);

  if (row) {
    Y.applyUpdate(document, row.ydoc);
    return;
  }

  // No row yet — normally the document was already created (by the "New
  // document" button or scripts/test-ydoc.ts) before anyone connected, so
  // this is the forgiving path for a connection to a name nobody made yet.
  // An empty seed can't duplicate anything, and createIfAbsent's transaction
  // handles a concurrent race regardless of who wins.
  const result = await ydocStore.createIfAbsent(documentName, EMPTY_STATE.ydoc, EMPTY_STATE.stateVector);
  Y.applyUpdate(document, result.won ? EMPTY_STATE.ydoc : result.existing.ydoc);
}

const loggedDegradedOnce = new Set<string>();

function warnDegradedOnce(documentName: string, hook: string): void {
  const key = `${documentName}:${hook}`;
  if (loggedDegradedOnce.has(key)) return;
  loggedDegradedOnce.add(key);
  console.warn(`[ydoc-hooks] ${documentName} is degraded (DB was unavailable at load) — ${hook} is a no-op.`);
}

export async function ydocOnChange({ documentName, update, connection }: onChangePayload<YdocContext>): Promise<void> {
  if (isDegraded(documentName)) {
    warnDegradedOnce(documentName, "onChange");
  } else {
    await ydocStore.appendUpdate(documentName, update);
  }
  await attributeUpdate(documentName, update, connection);
}

export async function ydocOnStoreDocument({
  documentName,
  document,
  lastContext,
}: onStoreDocumentPayload<YdocContext>): Promise<void> {
  if (isDegraded(documentName)) {
    warnDegradedOnce(documentName, "onStoreDocument");
    return;
  }
  // PLAN.md §13q — drained here and nowhere else. This is the debounce, which
  // is already async and already writing to the database, so waiting for the
  // in-flight appends costs nothing anybody is watching. Doing it on the
  // per-update path instead would put a database round trip in front of
  // collab latency, and doing it *not at all* would stamp the three writes
  // below with an id older than the content they describe.
  const lastUpdateId = await drainAppends(documentName);

  const { ydoc, stateVector } = encodeYdocState(document);
  await ydocStore.storeState(documentName, ydoc, stateVector, lastUpdateId);
  // PLAN.md §12d / §13a — each no-ops unless documentName is its own kind of
  // ydoc (a doc's vs. an annotation's own namespace, mutually exclusive by
  // construction), so both are safe to call unconditionally for every
  // ydoc-stack document, including a bare /ydoc-debug one that matches neither.
  //
  // lastContext is Hocuspocus's own "whichever connection most recently drove
  // this document" — the verified identity from onAuthenticate, not anything
  // a client asserts. It is deliberately the *only* attribution available at
  // this point: the store hook is debounced, so several authors' edits can
  // coalesce into one flush and this names whichever was last.
  await updateDocCache(documentName, document, lastContext?.userId, lastUpdateId);
  await updateAnnotationCache(documentName, document, lastUpdateId);
}

// clientID -> user_id attribution (PLAN.md §11d). A connection's own Yjs
// clientID isn't exposed directly by Hocuspocus's Connection type, but it is
// always the awareness clientID that connection reports for itself — cached
// here from onAwarenessUpdate and looked up by onChange's `connection`.
const socketClientIds = new Map<string, number>();

export function ydocOnAwarenessUpdate({ connection, added, updated }: onAwarenessUpdatePayload<YdocContext>): void {
  if (!connection) return;
  for (const clientId of [...added, ...updated]) {
    socketClientIds.set(connection.socketId, clientId);
  }
}

function getClientsMap(document: Document): Y.Map<string> {
  return document.getMap<string>("clients");
}

// Writes clientId -> userId once, the first time that client produces a
// *local, doc-changing* update — never on mere presence/awareness, and never
// overwriting an existing entry. context.userId is the identity onAuthenticate
// verified, not anything the client asserts about itself.
async function attributeUpdate(
  documentName: string,
  update: Uint8Array,
  connection: Connection<YdocContext> | undefined,
): Promise<void> {
  if (!connection) {
    // No connection on this onChange means the write originated server-side
    // (e.g. this same attribution transaction, or a DirectConnection) — skip
    // so the loop can't reprocess its own write.
    return;
  }

  let clientId = socketClientIds.get(connection.socketId);
  if (clientId === undefined) {
    // No awareness state seen yet from this connection — fall back to the
    // update's own metadata. Only trust it when unambiguous: a single
    // origin client in this update.
    const { from } = Y.parseUpdateMeta(update);
    if (from.size !== 1) return;
    clientId = from.keys().next().value;
  }
  if (clientId === undefined) return;

  const document = connection.document;
  const clients = getClientsMap(document);
  const key = String(clientId);
  if (clients.has(key)) return;

  const isNewDistinctUser = ![...clients.values()].includes(connection.context.userId);

  document.transact(() => {
    if (!clients.has(key)) {
      clients.set(key, connection.context.userId);
    }
  });

  // PLAN.md §13h — the moment a *second* distinct user shows up on an
  // annotation's own ydoc, backfill authorHighlight over everything typed
  // so far, attributed to the original (first) author. Checked after the
  // write above so `clients.values()` already reflects it; `=== 2` (not
  // `>= 2`) is what makes this fire exactly once per annotation — a third,
  // fourth, etc. co-author never re-triggers it.
  const annotationId = annotationIdFromYdocId(documentName);
  if (annotationId && isNewDistinctUser && new Set(clients.values()).size === 2) {
    await backfillAnnotationHighlight(annotationId, document);
  }
}

// PLAN.md §13h — text typed before a second author joined would otherwise
// stay uncolored forever once AuthorHighlight turns on (its plugin only
// tags *new* edits, PLAN.md §13h's own design note on why this reads as a
// bug rather than a boundary). One addMark(0, size) over the annotation's
// entire existing content, attributed to whoever created the row — the
// annotation's own `userId` column, not a guess from the clients map,
// which only just started tracking who else showed up.
async function backfillAnnotationHighlight(annotationId: string, document: Document): Promise<void> {
  const original = await prisma.annotation.findUnique({ where: { id: annotationId }, select: { userId: true } });
  if (!original) return;

  const json = TiptapTransformer.extensions(annotationContentExtensions).fromYdoc(document, "default");
  const node = pmAnnotationContentSchema.nodeFromJSON(json);
  if (node.content.size === 0) return;

  const markType = pmAnnotationContentSchema.marks.authorHighlight;
  const tr = new Transform(node);
  tr.addMark(0, node.content.size, markType.create({ authorId: original.userId }));

  document.transact(() => {
    prosemirrorToYXmlFragment(tr.doc, document.getXmlFragment("default"));
  });
}

// POST /admin/ydoc-snapshot — the new-stack twin of collab-admin.ts's
// replace-doc endpoint (PLAN.md §11d). Snapshots by replaying the log up to
// the current high-water mark, the same way src/lib/ydoc-snapshot.ts snapshots
// a *historical* mark for a publish (PLAN.md §15b) — not by encoding the live
// document via openDirectConnection. The two used to diverge: the live doc can
// run ahead of the log (onChange's appendUpdate is enqueued and un-awaited,
// PLAN.md §11c), so encoding it produced a snapshot whose bytes were ahead of
// the mark it claimed. A replay's bytes equal its mark exactly, which is what
// callers resolving a replay base (loadReplaySlice) assume.
export async function handleYdocSnapshot(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(request)) as Partial<{ token: string; documentName: string }>;
  const { token, documentName } = body;
  if (typeof token !== "string" || typeof documentName !== "string") {
    send(response, 400, "Expected token and documentName.");
    return;
  }

  const payload = await verifyYdocToken(token).catch(() => null);
  if (!payload || payload.documentName !== documentName) {
    send(response, 403, "Invalid or mismatched ydoc token.");
    return;
  }

  const throughUpdateId = await ydocStore.maxUpdateId(documentName);
  if (throughUpdateId === null) {
    send(response, 404, "This document has no update history to snapshot yet.");
    return;
  }

  const doc = await materializeYdocAt(documentName, throughUpdateId);
  const { ydoc, stateVector } = encodeYdocState(doc);
  doc.destroy();

  await ydocStore.createSnapshot(documentName, ydoc, stateVector, throughUpdateId, payload.sub);
  send(response, 204, "");
}

// POST /admin/annotation-flush (PLAN.md §13j Phase 3) — forces
// server/annotation-cache.ts's proseJson/bodyText write immediately instead
// of waiting for onStoreDocument's next debounce, called from
// postAnnotation right before flipping DRAFT to LIVE. Without this, a
// reader who opens the annotation the instant it becomes visible could see
// whatever bodyText/proseJson happened to be cached as of the *last* debounce
// — for a brand-new annotation, that's still its creation-time empty
// paragraph, regardless of everything typed since.
//
// `document` here is a Hocuspocus `Document`, which extends `Y.Doc` directly
// (the same assumption handleYdocSnapshot's encodeYdocState(document) call
// above already makes) — reading from it via updateAnnotationCache after
// disconnect is safe since that's a pure in-memory decode, no connection
// needed.
export async function handleFlushAnnotationCache(
  request: IncomingMessage,
  response: ServerResponse,
  instance: Hocuspocus,
): Promise<void> {
  const body = (await readJsonBody(request)) as Partial<{ token: string; documentName: string }>;
  const { token, documentName } = body;
  if (typeof token !== "string" || typeof documentName !== "string") {
    send(response, 400, "Expected token and documentName.");
    return;
  }

  const payload = await verifyYdocToken(token).catch(() => null);
  if (!payload || payload.documentName !== documentName) {
    send(response, 403, "Invalid or mismatched ydoc token.");
    return;
  }

  const connection = await instance.openDirectConnection(documentName);
  let ydocDocument: Y.Doc | null = null;
  try {
    await connection.transact((document) => {
      ydocDocument = document;
    });
  } finally {
    await connection.disconnect();
  }

  if (ydocDocument) {
    await updateAnnotationCache(documentName, ydocDocument);
  }
  send(response, 204, "");
}

// POST /admin/annotation-mark (PLAN.md §12i) — applies a mark carrying
// annotationId over [from, to) in documentName's "default" fragment, via
// the collab server so a read-only reader (§12g) can annotate without a
// writable connection. Row-first-mark-second is the caller's job
// (src/lib/annotation-admin.ts): if this returns applied:false — offsets no
// longer match and no unique fallback occurrence exists — the annotation
// row already inserted simply renders document-level, which the system
// already handles; nothing here needs to undo that insert.
//
// prosemirrorToYXmlFragment diffs the new tree against the fragment's
// current content (the same mechanism y-prosemirror's own live binding
// uses, and the same one handleReplaceDoc above already relies on) rather
// than replacing it outright, so unrelated text, other annotations' marks,
// and item identities elsewhere in the document are undisturbed — only the
// text run(s) in [from, to) actually change.
export async function handleApplyAnnotationMark(
  request: IncomingMessage,
  response: ServerResponse,
  instance: Hocuspocus,
): Promise<void> {
  const body = (await readJsonBody(request)) as Partial<{
    token: string;
    documentName: string;
    annotationId: string;
    from: number;
    to: number;
    quotedText: string;
  }>;
  const { token, documentName, annotationId, from, to, quotedText } = body;
  if (
    typeof token !== "string" ||
    typeof documentName !== "string" ||
    typeof annotationId !== "string" ||
    typeof from !== "number" ||
    typeof to !== "number" ||
    typeof quotedText !== "string" ||
    !quotedText
  ) {
    send(response, 400, "Expected token, documentName, annotationId, from, to and quotedText.");
    return;
  }

  const payload = await verifyYdocToken(token).catch(() => null);
  if (!payload || payload.documentName !== documentName) {
    send(response, 403, "Invalid or mismatched ydoc token.");
    return;
  }

  const connection = await instance.openDirectConnection(documentName);
  let applied = false;
  try {
    await connection.transact((document) => {
      const fragment = document.getXmlFragment("default");
      const json = TiptapTransformer.extensions(docContentExtensions).fromYdoc(document, "default");
      const node = pmDocContentSchema.nodeFromJSON(json);

      // The same verify-then-unique-search rule the reading views' own
      // capture uses (src/lib/annotation-anchors.ts) — shared rather than
      // restated so the two mechanisms can't come to disagree about what
      // "this quote is still here" means (PLAN.md §13o).
      const range = resolveAnchorInDoc(node, from, to, quotedText);
      if (!range) {
        return;
      }

      const markType = pmDocContentSchema.marks.annotation;
      const tr = new Transform(node);
      tr.addMark(range.from, range.to, markType.create({ id: annotationId }));
      prosemirrorToYXmlFragment(tr.doc, fragment);
      applied = true;
    });
  } finally {
    await connection.disconnect();
  }

  send(response, 200, JSON.stringify({ applied }));
}

// Every contiguous run of text carrying markName/attrName === attrValue —
// the live-Node counterpart of tiptap-schema.ts's extractMarkedText, walking
// descendants() instead of a getJSON() snapshot since handleRemoveAnnotationMark
// below needs ranges to call removeMark on, not text. A contiguous annotated
// span can be split into several adjacent text nodes (different bold/italic
// runs, etc.) but never discontiguous, same invariant extractMarkedText
// already relies on — it was applied as one addMark(from, to) call.
function findMarkRanges(node: PMNode, markName: string, attrName: string, attrValue: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let current: { from: number; to: number } | null = null;
  node.descendants((child, pos) => {
    if (!child.isText) return;
    const hasMark = child.marks.some((mark) => mark.type.name === markName && mark.attrs[attrName] === attrValue);
    if (hasMark) {
      if (current && current.to === pos) {
        current.to = pos + child.nodeSize;
      } else {
        if (current) ranges.push(current);
        current = { from: pos, to: pos + child.nodeSize };
      }
    } else if (current) {
      ranges.push(current);
      current = null;
    }
  });
  if (current) ranges.push(current);
  return ranges;
}

// POST /admin/annotation-unmark (PLAN.md §13d) — the reverse of
// handleApplyAnnotationMark: removes every mark instance carrying
// annotationId, wherever it currently sits in the document. Deleting an
// annotation previously left its mark in the ydoc forever (nothing had ever
// called removeMark), so the highlight kept showing on text whose
// annotation was gone — this is what deleteAnnotation now calls to fix
// that, and what a LIVE/RAISED annotation moving back to DRAFT would need
// too (not built — §13k's scope only covers delete). A no-op, not an
// error, when the mark isn't there (already degraded, or never landed).
export async function handleRemoveAnnotationMark(
  request: IncomingMessage,
  response: ServerResponse,
  instance: Hocuspocus,
): Promise<void> {
  const body = (await readJsonBody(request)) as Partial<{ token: string; documentName: string; annotationId: string }>;
  const { token, documentName, annotationId } = body;
  if (typeof token !== "string" || typeof documentName !== "string" || typeof annotationId !== "string") {
    send(response, 400, "Expected token, documentName and annotationId.");
    return;
  }

  const payload = await verifyYdocToken(token).catch(() => null);
  if (!payload || payload.documentName !== documentName) {
    send(response, 403, "Invalid or mismatched ydoc token.");
    return;
  }

  const connection = await instance.openDirectConnection(documentName);
  try {
    await connection.transact((document) => {
      const fragment = document.getXmlFragment("default");
      const json = TiptapTransformer.extensions(docContentExtensions).fromYdoc(document, "default");
      const node = pmDocContentSchema.nodeFromJSON(json);

      const ranges = findMarkRanges(node, "annotation", "id", annotationId);
      if (ranges.length === 0) {
        return;
      }

      const markType = pmDocContentSchema.marks.annotation;
      const tr = new Transform(node);
      for (const range of ranges) {
        tr.removeMark(range.from, range.to, markType.create({ id: annotationId }));
      }
      prosemirrorToYXmlFragment(tr.doc, fragment);
    });
  } finally {
    await connection.disconnect();
  }

  send(response, 204, "");
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("Request body too large."));
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

export function send(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "text/plain" });
  response.end(message);
}
