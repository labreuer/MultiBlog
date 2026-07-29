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
import { docContentExtensions, pmDocContentSchema } from "../src/lib/tiptap-schema";
import { ydocStore, UNAVAILABLE, markDegraded, clearDegraded, isDegraded, encodeYdocState } from "./ydoc-store";
import { updateDocCache } from "./doc-cache";

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
  await attributeUpdate(update, connection);
}

export async function ydocOnStoreDocument({
  documentName,
  document,
}: onStoreDocumentPayload<YdocContext>): Promise<void> {
  if (isDegraded(documentName)) {
    warnDegradedOnce(documentName, "onStoreDocument");
    return;
  }
  const { ydoc, stateVector } = encodeYdocState(document);
  await ydocStore.storeState(documentName, ydoc, stateVector);
  // PLAN.md §12d — a no-op for every non-doc ydoc (including /ydoc-debug's).
  await updateDocCache(documentName, document);
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

  document.transact(() => {
    if (!clients.has(key)) {
      clients.set(key, connection.context.userId);
    }
  });
}

// POST /admin/ydoc-snapshot — the new-stack twin of collab-admin.ts's
// replace-doc endpoint (PLAN.md §11d). Reads the current high-water mark in
// ydoc_update *before* encoding the live document, which is what guarantees
// the snapshot blob contains everything at or before that mark: anything that
// lands in between shows up after it in the log and survives a future
// truncation rather than being silently lost.
export async function handleYdocSnapshot(
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

  const lastUpdate = await prisma.ydocUpdate.findFirst({
    where: { ydocId: documentName },
    orderBy: { id: "desc" },
  });
  if (!lastUpdate) {
    send(response, 404, "This document has no update history to snapshot yet.");
    return;
  }

  const connection = await instance.openDirectConnection(documentName);
  let ydoc: Uint8Array;
  let stateVector: Uint8Array;
  try {
    await connection.transact((document) => {
      const encoded = encodeYdocState(document);
      ydoc = encoded.ydoc;
      stateVector = encoded.stateVector;
    });
  } finally {
    await connection.disconnect();
  }

  await ydocStore.createSnapshot(documentName, ydoc!, stateVector!, lastUpdate.id, payload.sub);
  send(response, 204, "");
}

// Every from..from+quotedText.length window whose text matches quotedText
// exactly — the fallback search PLAN.md §12i describes for when the
// original offsets no longer land where they used to. O(document size ×
// quotedText length): fine for an occasional annotation submission, not a
// per-keystroke path — same "don't over-optimize a rare operation" stance
// as the replay slider (§11h). Doesn't attempt to match across a block
// boundary (a paragraph break costs more than one position, so a naive
// from+len window undercounts there) — an annotated phrase spanning a
// paragraph break simply won't be found by the fallback; it still degrades
// to document-level rather than erroring.
function findQuoteOccurrences(node: PMNode, quotedText: string): { from: number; to: number }[] {
  const occurrences: { from: number; to: number }[] = [];
  const size = node.content.size;
  const len = quotedText.length;
  for (let from = 0; from + len <= size; from++) {
    if (node.textBetween(from, from + len, " ") === quotedText) {
      occurrences.push({ from, to: from + len });
    }
  }
  return occurrences;
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

      let range: { from: number; to: number } | null = null;
      if (from >= 0 && to <= node.content.size && to > from && node.textBetween(from, to, " ") === quotedText) {
        range = { from, to };
      } else {
        const occurrences = findQuoteOccurrences(node, quotedText);
        if (occurrences.length === 1) {
          range = occurrences[0];
        }
      }
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

function send(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "text/plain" });
  response.end(message);
}
