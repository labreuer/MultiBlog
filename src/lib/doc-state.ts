import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { prisma } from "@/lib/prisma";
import { docContentExtensions, pmDocContentSchema, titleAuthorHighlightExtensions } from "@/lib/tiptap-schema";
import { titleTextFromJSON } from "@/lib/ydoc-render";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { resolveUpdateIdForSnapshot } from "@/lib/ydoc-version";
import { materializeYdocAt } from "@/lib/ydoc-snapshot";
import { docBlocks, type DocBlock } from "@/lib/doc-text";

// docs/MCP.md §6 — a doc as the MCP server reads it: from its stored `ydoc`
// row, the state the collab server keeps, never a replay of the update log.
// An agent needs the text, not the text exactly as of one log entry, and
// anything it then changes goes through the collab server, where Yjs merges
// it with whatever else has happened.
//
// When nobody has the doc open the row *is* the doc; while someone types, it
// trails them by the store debounce (two seconds of quiet, ten at most).
//
// Server-only (Prisma, and the store through ydoc-version).

export type DocState = {
  json: JSONContent;
  /** The title fragment's text; "" for a doc with none. */
  title: string;
  node: PMNode;
  blocks: DocBlock[];
  /**
   * The exact version of the bytes read: the `ydoc_update` whose state they
   * are. Null only for a doc with no update log at all.
   */
  version: bigint | null;
};

function stateOf(doc: Y.Doc): Omit<DocState, "version"> {
  const json = TiptapTransformer.extensions(docContentExtensions).fromYdoc(doc, "default") as JSONContent;
  const content = Array.isArray(json.content) && json.content.length > 0 ? json : { type: "doc", content: [{ type: "paragraph" }] };
  const node = pmDocContentSchema.nodeFromJSON(content);
  const titleFragment = doc.getXmlFragment("title");
  const title =
    titleFragment.length > 0
      ? titleTextFromJSON(TiptapTransformer.extensions(titleAuthorHighlightExtensions).fromYdoc(doc, "title") as JSONContent)
      : "";
  return { json: content, title, node, blocks: docBlocks(node) };
}

/**
 * The doc as stored now, with its version.
 *
 * The version comes from `resolveUpdateIdForSnapshot` over the decoded doc's
 * own Yjs snapshot, walking forward from the row's checkpoint — called
 * **without** `headDoc`, whose fast path answers with the log's tail, which
 * is wrong exactly when the row trails it (someone typing).
 */
export async function loadDocState(docId: string): Promise<DocState> {
  const ydocId = ydocIdForDoc(docId);
  const row = await prisma.ydoc.findUnique({ where: { id: ydocId }, select: { ydoc: true } });
  const doc = new Y.Doc();
  try {
    if (row) Y.applyUpdate(doc, new Uint8Array(row.ydoc));
    const state = stateOf(doc);
    const version = row ? (await resolveUpdateIdForSnapshot(ydocId, Y.encodeSnapshot(Y.snapshot(doc)))).updateId : null;
    return { ...state, version };
  } finally {
    doc.destroy();
  }
}

/**
 * The doc rebuilt at `version`, one replay — what anchoring, changes since a
 * version, reverting an edit, and checking a passage named by its ends do
 * (docs/MCP.md §7). Never used to read a doc as it is.
 */
export async function loadDocStateAt(docId: string, version: bigint): Promise<Omit<DocState, "version">> {
  const doc = await materializeYdocAt(ydocIdForDoc(docId), version);
  try {
    return stateOf(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Whether `version` is a row in this doc's own log, at or before its tail —
 * an anchor's stamp is validated this way (docs/MCP.md §7, and §17's item 2
 * for the UI's own path), so a version from another doc or from the future
 * can't become one.
 */
export async function isDocVersion(docId: string, version: bigint): Promise<boolean> {
  const row = await prisma.ydocUpdate.findFirst({
    where: { id: version, ydocId: ydocIdForDoc(docId) },
    select: { id: true },
  });
  return row !== null;
}

/** The newest entry in the doc's log: what the export's catalog reports, and an anchor's default stamp. */
export async function docLogTail(docId: string): Promise<bigint | null> {
  const row = await prisma.ydocUpdate.findFirst({
    where: { ydocId: ydocIdForDoc(docId) },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  return row?.id ?? null;
}
