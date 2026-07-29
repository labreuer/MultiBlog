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
import type { Role } from "../src/generated/prisma/enums";
import { prisma } from "../src/lib/prisma";
import { verifyYdocToken } from "../src/lib/ydoc-token";
import { ydocStore, UNAVAILABLE, markDegraded, clearDegraded, isDegraded, encodeYdocState } from "./ydoc-store";

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

export async function ydocOnAuthenticate({ token, documentName }: onAuthenticatePayload): Promise<YdocContext> {
  const payload = await verifyYdocToken(token).catch(() => null);
  if (!payload) {
    throw new Error("Invalid or expired ydoc token.");
  }
  if (payload.documentName !== documentName) {
    throw new Error("Token does not match this document.");
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
