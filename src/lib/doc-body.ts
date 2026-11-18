import type * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { extractText } from "@/lib/diff";
import type { DiffBlock } from "@/lib/doc-diff";
import { docBlocks, type DocBlock } from "@/lib/doc-text";
import { chipKind } from "@/lib/entity-chips/registry";
import { chipsIn, chipTargets } from "@/lib/entity-chips/renderings";
import { chipStylesOf } from "@/lib/entity-chips/settings";
import { chipLabelsIn } from "@/lib/entity-chips/text";
import type { ChipContext, ChipStyles } from "@/lib/entity-chips/types";
import { docContentExtensions, pmDocContentSchema, titleAuthorHighlightExtensions } from "@/lib/tiptap-schema";

// A doc's Y.Doc read as a doc: its body, its title and its chip styles, and
// from them the blocks a diff compares. **The one way a Y.Doc becomes blocks,
// for the server and the browser alike**: `stateOf` (src/lib/doc-state.ts)
// reads every doc through `docBodyOf`, and the diff page's sliders build a
// version in the reader's browser through `versionBlocks`
// (src/lib/doc-version.worker.ts). A second copy of either would let a diff
// slid to differ from the same address reloaded (docs/FORKS.md, "Sliders on
// the diff page").
//
// Browser-safe: it reads a Y.Doc it is handed, and loads nothing.

export type DocBody = {
  /** The body as ProseMirror JSON; one empty paragraph for a doc with none. */
  json: JSONContent;
  node: PMNode;
  /** The title fragment's text; "" for a doc with none. */
  title: string;
  /** The doc's chip styles at this state: they live in the ydoc. */
  styles: ChipStyles;
};

/** Throws when the Y.Doc doesn't decode under the doc schema. Never destroys `doc`. */
export function docBodyOf(doc: Y.Doc): DocBody {
  const decoded = TiptapTransformer.extensions(docContentExtensions).fromYdoc(doc, "default") as JSONContent;
  const json = Array.isArray(decoded.content) && decoded.content.length > 0 ? decoded : { type: "doc", content: [{ type: "paragraph" }] };
  const titleFragment = doc.getXmlFragment("title");
  const title =
    titleFragment.length > 0
      ? extractText(TiptapTransformer.extensions(titleAuthorHighlightExtensions).fromYdoc(doc, "title") as JSONContent)
      : "";
  return { json, node: pmDocContentSchema.nodeFromJSON(json), title, styles: chipStylesOf(doc) };
}

/** A doc's blocks as the diff reads them. */
export function diffBlocks(blocks: readonly DocBlock[]): DiffBlock[] {
  return blocks.map((block) => ({ text: block.text, type: block.node.type.name, heading: block.heading !== null }));
}

/**
 * What stands between a body and its blocks, when the records are whatever a
 * browser holds:
 *
 * - `unknown-kind`: the body holds a chip of a kind this bundle doesn't know;
 * - `missing`: its chips name records `context` lacks, listed per chip kind.
 */
export type VersionRefusal = { ok: false; reason: "unknown-kind" } | { ok: false; reason: "missing"; missing: Record<string, string[]> };

/**
 * `body`'s blocks, labelled from `context`, **only when `context` holds the
 * record of every target the body's chips name**. A server loads those
 * records whole, with no viewer rule (`loadChipContext`); a browser has what
 * the chip-context endpoint would answer this viewer. A label computed from
 * part of them differs from the server's: a person the viewer can't be
 * answered for reads as unknown, and a missing work shifts every numbered
 * citation after it. So anything short of every record is a refusal, and the
 * caller has the server build the side instead.
 */
export function versionBlocks(body: DocBody, context: ChipContext): { ok: true; blocks: DiffBlock[] } | VersionRefusal {
  const chips = chipsIn(body.node);
  if (chips.some((chip) => chipKind(chip.kind) === null)) return { ok: false, reason: "unknown-kind" };
  const missing: Record<string, string[]> = {};
  for (const [kind, ids] of Object.entries(chipTargets(chips))) {
    const held = context[kind];
    const lacking = ids.filter((id) => typeof held !== "object" || held === null || !Object.hasOwn(held, id));
    if (lacking.length > 0) missing[kind] = lacking;
  }
  if (Object.keys(missing).length > 0) return { ok: false, reason: "missing", missing };
  const labels = chipLabelsIn(body.node, { styles: body.styles, context });
  return { ok: true, blocks: diffBlocks(docBlocks(body.node, labels)) };
}
