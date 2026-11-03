import { InputRule, createChainableState, type Command } from "@tiptap/core";
import type { NodeType, ResolvedPos } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { findWrapping } from "@tiptap/pm/transform";

// docs/TIPTAP.md "A list starts at a line break". A paragraph whose lines are
// joined by hard breaks (Shift+Enter, or Enter with a virtual keyboard
// docked) reads as several lines, and starting a list on one of them makes a
// list of that line, not of the whole paragraph: the lines above it stay a
// paragraph, and so do the lines below a selection. Both ways in do it — the
// toggles (toolbar, Mod-Shift-7/8, the numbering picker) through
// `startingAtLine`, and a marker typed at a line's start through
// `atLine`. Inside a list nothing is split: a toggle there converts or
// lifts the list, and a line break in an item is the item's own.

function inListItem($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).type.name === "listItem") return true;
  return false;
}

/** The hard break nearest `$pos` in its paragraph, on the side asked for: before it (`b < pos`) or at or after it (`b >= pos`). */
function nearestBreak($pos: ResolvedPos, side: "before" | "after"): number | null {
  if ($pos.parent.type.name !== "paragraph") return null;
  const start = $pos.start();
  let found: number | null = null;
  $pos.parent.forEach((child, offset) => {
    if (child.type.name !== "hardBreak") return;
    const pos = start + offset;
    if (side === "before" ? pos < $pos.pos : pos >= $pos.pos && found === null) found = pos;
  });
  return found;
}

/** Turns the hard break at `pos` into a paragraph boundary. */
function splitAt(tr: Transaction, pos: number): void {
  tr.delete(pos, pos + 1).split(pos);
}

/**
 * Splits the selection's paragraph(s) at the hard breaks bounding the lines
 * it touches, so that only those lines are left in the block a list toggle
 * wraps, and re-selects them. A selection ending at a line's very start
 * leaves that line out. False, with `tr` untouched, when there is nothing to
 * split: no hard break on either side, a selection inside a list, or one that
 * isn't text (a cell or node selection).
 */
export function splitAtLineEdges(tr: Transaction): boolean {
  const selection = tr.selection;
  if (!(selection instanceof TextSelection)) return false;
  const { $from, $to, empty } = selection;
  if (inListItem($from) || inListItem($to)) return false;

  let from = $from.pos;
  let to = !empty && $to.nodeBefore?.type.name === "hardBreak" ? $to.pos - 1 : $to.pos;
  const after = nearestBreak(tr.doc.resolve(to), "after");
  const before = nearestBreak($from, "before");
  if (after === null && before === null) return false;

  // The later split first, so the earlier one's position still holds. Each
  // maps the selection toward the lines it keeps: a caret just before the
  // lower break stays on the upper side (-1), one just after the upper break
  // lands on the lower side (+1).
  if (after !== null) {
    const step = tr.steps.length;
    splitAt(tr, after);
    const mapping = tr.mapping.slice(step);
    from = mapping.map(from, -1);
    to = mapping.map(to, -1);
  }
  if (before !== null) {
    const step = tr.steps.length;
    splitAt(tr, before);
    const mapping = tr.mapping.slice(step);
    from = mapping.map(from, 1);
    to = mapping.map(to, 1);
  }
  tr.setSelection(TextSelection.create(tr.doc, from, to));
  return true;
}

/**
 * A list toggle (`toggleBulletList`, `toggleOrderedList`) that first splits
 * the lines it is about to wrap out of their paragraph. Only when dispatching,
 * so a dry run (`can()`) answers for the unsplit document, which wraps exactly
 * when the split one does; and only when the list can wrap here at all, so a
 * toggle that will fail leaves no split behind it in a chain.
 */
export function startingAtLine(toggle: () => Command, listType: () => NodeType): () => Command {
  return () => (props) => {
    const { tr, dispatch } = props;
    const range = tr.selection.$from.blockRange(tr.selection.$to);
    if (dispatch && range && findWrapping(range, listType())) splitAtLineEdges(tr);
    return toggle()(props);
  };
}

/**
 * `rule` — a list's marker rule, anchored at its paragraph's start — for the
 * line the marker is typed on, wherever that line falls in its paragraph: the
 * hard breaks either side of it become paragraph boundaries, and then `rule`'s
 * own handler wraps the line's new paragraph, deciding everything it decides
 * at a paragraph's start (the numbering, a join). So a marker typed on a line
 * of `a⏎b⏎⏎c` lists that line alone, as the toggle does, and the lines
 * below it stay text. TipTap's input rules read a hard break as "\n" and the
 * package's patterns are anchored at "^", so without this a marker after a
 * break stays text and one on a first line wraps every line below it too.
 * Inside a list item the rule is the package's: a break in an item is the
 * item's own.
 */
export function atLine(rule: InputRule): InputRule {
  const find = rule.find;
  if (!(find instanceof RegExp) || !find.source.startsWith("^")) {
    throw new Error(`atLine needs a rule anchored at "^", not ${String(find)}`);
  }
  return new InputRule({
    find: (text) => {
      const lineStart = text.lastIndexOf("\n") + 1;
      const match = find.exec(text.slice(lineStart));
      return match ? { index: lineStart + match.index, text: match[0] } : null;
    },
    handler: (props) => {
      const { state, range } = props;
      // The finder hands over only the matched text; the handler wants the
      // rule's own groups (a start number, a marker).
      const match = find.exec(props.match[0]);
      if (!match) return null;
      const $start = state.doc.resolve(range.from);
      const before = $start.nodeBefore?.type.name === "hardBreak" ? range.from - 1 : null;
      // Neither after a break nor at the paragraph's start: the finder's
      // window (500 characters) began mid-line.
      if (before === null && $start.parentOffset > 0) return null;
      const splittable = $start.parent.type.name === "paragraph" && !inListItem($start);
      if (!splittable) return before === null ? rule.handler({ ...props, match }) : null;

      const after = nearestBreak(state.doc.resolve(range.to), "after");
      if (before === null && after === null) return rule.handler({ ...props, match });
      const tr = state.tr;
      // The later split first, so the earlier one's position still holds;
      // the one below the marker moves nothing in its range.
      if (after !== null) splitAt(tr, after);
      if (before !== null) splitAt(tr, before);
      // The break above gone, two boundary tokens in its place.
      const shift = before === null ? 0 : 1;
      // The caret sat at the marker's end, so right before the break below,
      // and mapping carries a position at a split forward across it: it
      // would land at the start of the next line's paragraph. Back at the
      // marker's end, it follows the handler's delete into the new item.
      tr.setSelection(TextSelection.create(tr.doc, range.to + shift));
      // A chainable state reads `doc` from the transaction only when its `tr`
      // is next asked for, and a rule may read `state.doc` before that, so
      // the handler gets a fresh one over the same transaction.
      return rule.handler({
        ...props,
        state: createChainableState({ state, transaction: tr }),
        range: { from: range.from + shift, to: range.to + shift },
        match,
      });
    },
    undoable: rule.undoable,
  });
}
