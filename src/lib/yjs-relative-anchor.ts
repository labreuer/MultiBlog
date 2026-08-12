import * as Y from "yjs";
import { ySyncPluginKey, absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from "y-prosemirror";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";

// y-prosemirror's own `ProsemirrorMapping` type (dist/src/lib.d.ts) isn't
// re-exported from the package's public entry point, only from an internal
// path this codebase otherwise never reaches into — this is that type's
// actual shape, restated rather than imported from an unsupported deep path.
type ProsemirrorMapping = Map<Y.AbstractType<unknown>, PMNode | PMNode[]>;

// COLLAB.md §5 — this codebase's first app-level Y.RelativePosition code.
// Everywhere else a relative position is used, it's entirely inside
// y-prosemirror's own internals (CollaborationCaret's awareness cursor).
//
// The constraint that makes this safe, stated once here rather than at
// every call site: a RelativeRange is never serialized and never stored.
// A durable relative position needs `gc: false` on the Y.Doc, or a later
// garbage collection can strand it pointing at nothing; this codebase runs
// `gc: true` everywhere (PLAN.md §12h), on purpose, because the doc
// annotation mark is content and never needs a relative position to begin
// with. COLLAB.md §5 draws the same line: the GC hazard needs the anchored
// item both deleted *and* collected, which a range that lives in one
// client's memory for the seconds it takes to compose a selection never
// survives to see. Do not thread a RelativeRange through a server action,
// a database column, or React state that outlives the composing session.
export type RelativeRange = { from: Y.RelativePosition; to: Y.RelativePosition };

// The one thing that makes either conversion possible: a real y-prosemirror
// binding, which only exists when the editor is bound through the
// `Collaboration` extension (ySyncPlugin). Both reading views in this
// codebase push content with `setContent` instead (§12g) and have no
// binding at all — `null` is the honest answer there, not a bug to work
// around, and every caller has to handle it.
function syncState(editor: Editor): { type: Y.XmlFragment; doc: Y.Doc; binding: { mapping: ProsemirrorMapping } } | null {
  const state = ySyncPluginKey.getState(editor.state);
  return state?.binding ? state : null;
}

/**
 * Captures [from, to) as a pair of relative positions against the editor's
 * live Yjs binding — resolvable later even if concurrent edits have moved
 * the text, without a text search. Returns null on an editor with no
 * Collaboration binding (COLLAB.md §5's stated precondition).
 */
export function captureRelativeRange(editor: Editor, from: number, to: number): RelativeRange | null {
  const sync = syncState(editor);
  if (!sync) return null;
  const { type, binding } = sync;
  return {
    from: absolutePositionToRelativePosition(from, type, binding.mapping),
    to: absolutePositionToRelativePosition(to, type, binding.mapping),
  };
}

/**
 * Resolves a previously captured range against the *current* document —
 * this is the payoff: no re-verification pass, no quote search, correct
 * even after concurrent edits landed between capture and resolution.
 * Returns null when either end no longer resolves (its content was
 * deleted) or the editor has no binding.
 */
export function resolveRelativeRange(editor: Editor, range: RelativeRange): { from: number; to: number } | null {
  const sync = syncState(editor);
  if (!sync) return null;
  const { type, doc, binding } = sync;
  const from = relativePositionToAbsolutePosition(doc, type, range.from, binding.mapping);
  const to = relativePositionToAbsolutePosition(doc, type, range.to, binding.mapping);
  if (from === null || to === null || to <= from) return null;
  return { from, to };
}
