import type * as Y from "yjs";
import type { Extensions } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { materializeYdocAt } from "../ydoc-snapshot";
import { resolveAnchorInDoc } from "./resolve";

// PLAN.md §13o — what a ydoc-backed anchor actually stores, and the one place
// a `quoted_text` is ever written.
//
// **Server-only.** It reaches Postgres through `materializeYdocAt`, which is
// why `src/lib/anchors/index.ts` deliberately does not re-export it: the pure
// half of this library (resolve, target, selector, types) is imported by
// `annotation-highlight-extension.ts`, which ships to the browser, and a
// barrel that mixed the two would drag PrismaClient into the client bundle.
// Same split `avatar.ts`/`avatar-url.ts` already makes.
//
// PLAN.md §20h moved it here from src/lib/annotation-anchor-capture.ts. The
// only change is the name: it was never annotation-specific — every argument
// is about a ydoc and a range — and a `tag_anchor` row with a `DOC_RANGE`
// selector (PR 2) establishes its quote through this same call. The
// invariant below is what §20b means by "one integrity checker covers every
// anchor row in the system."
//
// **Resolved against the state `ydocUpdateId` names, not the live one.** That
// is the whole point of stamping it: the stored triple (anchorFrom, anchorTo,
// quotedText) is then true *by construction* of a document state anyone can
// reconstruct — replay to that update id and textBetween(from, to) is
// quotedText, forever, no matter what the doc does afterwards. Resolving
// against "now" instead would store a triple describing a state nothing
// records, which is exactly what makes COLLAB.md §7's materialize-and-diff
// repair unbuildable after the fact.
//
// The staleness that would normally make this a bad trade doesn't apply:
// `ydocOnChange` appends a `ydoc_update` row per Yjs update, not per store
// debounce, so the log's tail is within a websocket round trip of live — a
// different guarantee entirely from `Doc.proseJson`, which lags by seconds and
// must never be used to decide *where* anything is (CLAUDE.md, COLLAB.md's
// cross-cutting hazard).
//
// **The client's `quotedText` is a hint, never the stored value.** It is used
// only to verify — and if the document moved under the selection, to re-find —
// the range; what lands in the column is this process's own textBetween at
// whatever range that resolves to. So §12i's "the selected text is a request
// field only, never a column" still governs the trust boundary: a client that
// names text which isn't in the stamped state gets no anchor at all, not an
// anchor of its choosing. A client that names text which *is* there gets an
// annotation on that passage — indistinguishable from having selected it,
// which is why that residual isn't worth closing.
//
// Null means document-level: the annotation still posts, with no anchor. That
// is a state every surface already renders (§12h), not a failure.
export async function captureAnchorInYdoc(opts: {
  /** The ydoc the offsets are into — a doc's, or an annotation's own (§13p). */
  ydocId: string;
  /** The version stamp being written alongside; the state to resolve against. */
  throughUpdateId: bigint;
  /** Which schema decodes that ydoc — doc bodies and annotation bodies differ. */
  extensions: Extensions;
  schema: Schema;
  from: number;
  to: number;
  /** The client's own reading of its selection. Verification input only. */
  quotedText: string;
}): Promise<{ from: number; to: number; quotedText: string } | null> {
  const { ydocId, throughUpdateId, extensions, schema, from, to, quotedText } = opts;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || !quotedText.trim()) {
    return null;
  }

  let doc: Y.Doc | null = null;
  try {
    doc = await materializeYdocAt(ydocId, throughUpdateId);
    const json = TiptapTransformer.extensions(extensions).fromYdoc(doc, "default");
    const node = schema.nodeFromJSON(json);
    const range = resolveAnchorInDoc(node, from, to, quotedText);
    if (!range) return null;
    return { ...range, quotedText: node.textBetween(range.from, range.to, " ") };
  } catch (err) {
    // Best-effort, same stance applyAnnotationMark takes on an unreachable
    // collab server: the annotation row is valid either way, and posting
    // document-level is a state the reader already understands. Logged
    // because "my annotation lost its quote" is otherwise indistinguishable
    // from a rendering bug.
    console.error(`[anchor] couldn't resolve an anchor in ${ydocId}@${throughUpdateId}:`, err);
    return null;
  } finally {
    doc?.destroy();
  }
}
