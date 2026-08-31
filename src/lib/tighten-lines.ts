import type { Editor } from "@tiptap/core";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

// The toolbar's "reduce space between lines" operation (EditorToolbar's
// "tighten" tool). One press applies both rules once, against a snapshot of
// the selection as it was — deliberately not cascading:
//
//   1. every run of 2+ adjacent non-empty paragraphs becomes one paragraph,
//      the originals' contents joined by hard breaks;
//   2. every run of N adjacent empty paragraphs becomes N-1 (so a lone
//      empty paragraph disappears);
//
// and a pair made adjacent by rule 2 does NOT merge until the next press —
// each press tightens by exactly one level, which is why the selection is
// re-established afterwards: pressing again is the expected gesture.
//
// "Empty" includes whitespace-only: such a paragraph looks empty, and
// hard-break-merging it into a neighbour would append invisible junk.
//
// Paragraph adjacency is judged by position continuity, so any other node —
// a heading, a code block, a blockquote or list-item boundary — is a barrier
// runs never cross; paragraphs that are siblings *inside* a selected
// blockquote or list item merge with each other as usual. A paragraph only
// partially covered by the selection participates fully (this is a
// block-level operation, like the list and quote toggles).

type Para = {
  pos: number;
  node: PMNode;
  // For the one structural guard below: an empty paragraph that is its
  // parent's only child can't be deleted without leaving the parent (a
  // blockquote, a list item — all "block+") with no content at all.
  parentChildCount: number;
};

/**
 * Applies one tightening pass to `tr` over [from, to] (defaulting to the
 * transaction's current selection) and re-selects the affected blocks.
 * Returns whether anything changed. Pure over ProseMirror state — no view,
 * no editor — so the rules above are unit-testable as a table
 * (tighten-lines.test.ts).
 */
export function applyTighten(tr: Transaction, rangeFrom?: number, rangeTo?: number): boolean {
  const from = rangeFrom ?? tr.selection.from;
  const to = rangeTo ?? tr.selection.to;
  if (to <= from) return false;

  const doc = tr.doc;
  const schema = doc.type.schema;
  const paragraphType = schema.nodes.paragraph;
  const hardBreakType = schema.nodes.hardBreak;
  if (!paragraphType) return false;

  // Every paragraph the selection touches, in document order. Not descending
  // into them: their inline content is irrelevant here beyond textContent.
  const paras: Para[] = [];
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (node.type === paragraphType) {
      paras.push({ pos, node, parentChildCount: parent?.childCount ?? 2 });
      return false;
    }
    return true;
  });
  if (paras.length === 0) return false;

  // Group into runs of adjacent siblings. Two paragraphs are adjacent iff
  // one ends exactly where the next begins — any intervening node, or an
  // enclosing boundary's own tokens, breaks the chain, which is the whole
  // barrier rule in one comparison.
  const runs: Para[][] = [];
  for (const para of paras) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    if (prev && prev.pos + prev.node.nodeSize === para.pos) run.push(para);
    else runs.push([para]);
  }

  const isEmpty = (node: PMNode) => node.textContent.trim().length === 0;

  // Edits against the *original* document, ascending and non-overlapping.
  // `br: true` replaces the two structure tokens between adjacent paragraphs
  // (close-p, open-p) with a hard break — joining them without rebuilding
  // either paragraph's content, so AuthorHighlight sees only the break as
  // inserted (not two whole paragraphs re-attributed to the presser) and
  // Yjs carries the smallest possible change.
  const edits: { from: number; to: number; br: boolean }[] = [];
  for (const run of runs) {
    let i = 0;
    while (i < run.length) {
      const empty = isEmpty(run[i].node);
      let j = i;
      while (j + 1 < run.length && isEmpty(run[j + 1].node) === empty) j += 1;
      if (empty) {
        // N empties -> N-1: delete the first, unless it is its parent's
        // only child (see Para.parentChildCount).
        const victim = run[i];
        if (victim.parentChildCount > 1) {
          edits.push({ from: victim.pos, to: victim.pos + victim.node.nodeSize, br: false });
        }
      } else if (hardBreakType) {
        for (let k = i; k < j; k += 1) {
          const boundary = run[k + 1].pos;
          edits.push({ from: boundary - 1, to: boundary + 1, br: true });
        }
      }
      i = j + 1;
    }
  }
  if (edits.length === 0) return false;

  // The operand, expanded to whole blocks — re-selected below so the next
  // press acts on the same (now tighter) region.
  const first = paras[0];
  const last = paras[paras.length - 1];
  const selFrom = Math.min(from, first.pos);
  const selTo = Math.max(to, last.pos + last.node.nodeSize);

  // Last-to-first, so each edit's original coordinates are still valid on
  // the partially-transformed document — no mapping needed while applying.
  const stepsBefore = tr.steps.length;
  for (let e = edits.length - 1; e >= 0; e -= 1) {
    const edit = edits[e];
    if (edit.br && hardBreakType) tr.replaceWith(edit.from, edit.to, hardBreakType.create());
    else tr.delete(edit.from, edit.to);
  }

  const mapping = tr.mapping.slice(stepsBefore);
  const mappedFrom = mapping.map(selFrom, 1);
  const mappedTo = mapping.map(selTo, -1);
  tr.setSelection(TextSelection.between(tr.doc.resolve(mappedFrom), tr.doc.resolve(mappedTo)));
  tr.scrollIntoView();
  return true;
}

function stopUndoCapture(state: EditorState): void {
  // Collaboration editors: y-tiptap's UndoManager merges undo items landed
  // within its captureTimeout (~500ms), so without this fence the operation
  // would glue itself onto typing done just before it (and typing done just
  // after would glue onto it) — breaking "one press, one undo, exactly".
  // Editors without Collaboration have no such plugin state, and there a
  // single transaction is already a single undo step. Must be
  // @tiptap/y-tiptap's key, not y-prosemirror's — yjs-relative-anchor.ts
  // explains the identical object-identity trap.
  const pluginState = yUndoPluginKey.getState(state) as { undoManager?: { stopCapturing(): void } } | undefined;
  pluginState?.undoManager?.stopCapturing();
}

/**
 * The toolbar entry point: one pass over the current selection, dispatched
 * as one transaction and fenced into its own undo item on both sides.
 */
export function tightenLines(editor: Editor): void {
  if (editor.state.selection.empty) return;
  stopUndoCapture(editor.state);
  editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      if (dispatch) applyTighten(tr);
      // Always true: "nothing qualified" shouldn't mark the chain (and its
      // focus()) as failed.
      return true;
    })
    .run();
  stopUndoCapture(editor.state);
}
