import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { prisma } from "@/lib/prisma";
import { docContentExtensions, pmDocContentSchema, titleAuthorHighlightExtensions } from "@/lib/tiptap-schema";
import { titleTextFromJSON } from "@/lib/ydoc-render";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { resolveUpdateIdForSnapshot } from "@/lib/ydoc-version";
import { ydocStore } from "../../server/ydoc-store";
import { materializeYdocAt } from "@/lib/ydoc-snapshot";
import { docBlocks, type DocBlock } from "@/lib/doc-text";
import { chipInputsForBody } from "@/lib/entity-chips/context";
import { chipStylesOf } from "@/lib/entity-chips/settings";
import { chipMarkdowns, chipsIn } from "@/lib/entity-chips/renderings";
import { chipLabelsIn, type ChipLabels } from "@/lib/entity-chips/text";
import type { ChipInputs } from "@/lib/entity-chips/types";

// docs/MCP.md §6 — a doc as the MCP server reads it: from its stored `ydoc`
// row, the state the collab server keeps, never a replay of the update log.
// An agent needs the text, not the text exactly as of one log entry, and
// anything it then changes goes through the collab server, where Yjs merges
// it with whatever else has happened.
//
// When nobody has the doc open the row *is* the doc; while someone types, it
// trails them by the store debounce (two seconds of quiet, ten at most).
// `loadDocStateNow` is the read that closes that gap, for the diff page.
//
// Server-only (Prisma, and the store through ydoc-version).

export type DocState = {
  json: JSONContent;
  /** The title fragment's text; "" for a doc with none. */
  title: string;
  node: PMNode;
  /** The top-level blocks, each one's text with its entity chips as their labels. */
  blocks: DocBlock[];
  /**
   * The doc's entity chips as a reader of this state sees them
   * (docs/ENTITY_CHIPS.md, MCP item 1), computed once over the whole doc, since
   * a label can depend on the chips around it: `labels` for text and for
   * matching a quote (`flattenForMatch(node, chips.labels)`), `markdown` for
   * the Markdown writer, and the `inputs` both came from. All empty for a doc
   * with no chip.
   */
  chips: { labels: ChipLabels; markdown: ReadonlyMap<string, string>; inputs: ChipInputs };
  /**
   * The exact version of the bytes read: the `ydoc_update` whose state they
   * are. Null only for a doc with no update log at all.
   */
  version: bigint | null;
};

async function stateOf(doc: Y.Doc): Promise<Omit<DocState, "version">> {
  const json = TiptapTransformer.extensions(docContentExtensions).fromYdoc(doc, "default") as JSONContent;
  const content = Array.isArray(json.content) && json.content.length > 0 ? json : { type: "doc", content: [{ type: "paragraph" }] };
  const node = pmDocContentSchema.nodeFromJSON(content);
  const titleFragment = doc.getXmlFragment("title");
  const title =
    titleFragment.length > 0
      ? titleTextFromJSON(TiptapTransformer.extensions(titleAuthorHighlightExtensions).fromYdoc(doc, "title") as JSONContent)
      : "";
  // The labels are the targets' current ones, whichever version of the doc
  // this is: a label is not part of a version.
  // The style is the doc's at this version: it lives in the ydoc.
  const inputs = await chipInputsForBody(content, chipStylesOf(doc));
  const labels = chipLabelsIn(node, inputs);
  const markdown = chipMarkdowns(chipsIn(node), inputs.styles, inputs.context);
  return { json: content, title, node, blocks: docBlocks(node, labels), chips: { labels, markdown, inputs } };
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
    const state = await stateOf(doc);
    const version = row ? (await resolveUpdateIdForSnapshot(ydocId, Y.encodeSnapshot(Y.snapshot(doc)))).updateId : null;
    return { ...state, version };
  } finally {
    doc.destroy();
  }
}

/**
 * The doc as it is now: the `ydoc` row with the log's later rows applied to
 * it (docs/FORKS.md, "A doc as it is now"). What a diff's side with no
 * version reads, so that it is never older than a version the scrub bar has
 * handed out, which `loadDocState`'s stored row alone can be while someone
 * types.
 *
 * One store pass writes the row's bytes and its `last_update_id` together,
 * after its appends have landed, so the bytes hold every log row up to that
 * id, and the rows past it are the seconds since. A null `last_update_id` (a
 * doc just created, or a row no store pass has stamped) applies the whole
 * log, which is correct and costs the log's length. Applying a row the bytes
 * already hold changes nothing, so the two reads need no transaction.
 *
 * Not a replay of the log alone: that would cost the doc's history on every
 * read, and a row that failed to append is in the stored bytes and not in the
 * log.
 *
 * `version` is the last row applied, or the row's own stamp when there were
 * none: null only for a doc with no log row and no stamp.
 */
export async function loadDocStateNow(docId: string): Promise<DocState> {
  const ydocId = ydocIdForDoc(docId);
  const row = await prisma.ydoc.findUnique({ where: { id: ydocId }, select: { ydoc: true, lastUpdateId: true } });
  const doc = new Y.Doc();
  try {
    let version: bigint | null = null;
    if (row) {
      Y.applyUpdate(doc, new Uint8Array(row.ydoc));
      version = row.lastUpdateId;
      for (const update of await ydocStore.updatesAfter(ydocId, row.lastUpdateId)) {
        Y.applyUpdate(doc, update.update);
        version = update.id;
      }
    }
    return { ...(await stateOf(doc)), version };
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
    return await stateOf(doc);
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
