import type { Node as PMNode } from "@tiptap/pm/model";

// docs/ENTITY_CHIPS.md, step 1, item 9 — a published post holds each chip as
// its label, as linked text, with the chip recorded on the link's `chip`
// attribute (linked-text.ts). The label is frozen at publish, so two
// publishes of one doc can hold different words for the same chip: its
// person was renamed in between, or the post was published in another style.
//
// A comment thread's quote is carried from one publish to the next by
// comparing text (anchor-remap.ts), and a relabelled chip inside the quote
// is not a change to what was quoted. These helpers let that comparison see
// a chip as the entity it stands for.
//
// Pure, and over the post-side schema: the nodes here are text with a link
// mark, never an `entityChip`.

/** One chip's label in a post: the run of text carrying its link. */
export type PostChipRun = { from: number; to: number; iid: string; identity: string };

type ChipRef = { kind?: unknown; iid?: unknown; targets?: unknown };

function refOf(node: PMNode): { iid: string; identity: string } | null {
  for (const mark of node.marks) {
    if (mark.type.name !== "link") continue;
    const chip = mark.attrs.chip as ChipRef | null | undefined;
    if (!chip || typeof chip.iid !== "string" || typeof chip.kind !== "string") continue;
    const targets = Array.isArray(chip.targets) ? chip.targets.filter((t): t is string => typeof t === "string") : [];
    return { iid: chip.iid, identity: `${chip.kind}:${targets.join(",")}` };
  }
  return null;
}

/** Every chip's run in `doc`, in order. Adjacent text nodes of one chip, split by another mark, are one run. */
export function postChipRuns(doc: PMNode): PostChipRun[] {
  const runs: PostChipRun[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const ref = refOf(node);
    if (!ref) return;
    const last = runs.at(-1);
    if (last && last.iid === ref.iid && last.to === pos) last.to = pos + node.nodeSize;
    else runs.push({ from: pos, to: pos + node.nodeSize, ...ref });
  });
  return runs;
}

/**
 * A range's text with each chip it holds whole written as the entity it
 * stands for, in place of its label: equal for two publishes that differ
 * only in what a chip is called. Null when the range cuts through a chip's
 * label, or holds no chip: then there is only the text to go by.
 */
export function identityTextBetween(doc: PMNode, from: number, to: number, runs: readonly PostChipRun[]): string | null {
  const inside = runs.filter((run) => run.from < to && run.to > from);
  if (inside.length === 0 || inside.some((run) => run.from < from || run.to > to)) return null;
  let text = "";
  let at = from;
  for (const run of inside) {
    // U+FFFC brackets an identity, so no ordinary text can spell one.
    text += `${doc.textBetween(at, run.from, " ")}￼${run.identity}￼`;
    at = run.to;
  }
  return (text + doc.textBetween(at, to, " ")).trim();
}

/**
 * Where a quote's end went in the next publish, for an end that sat exactly
 * on a chip's edge: the same edge of the same chip there, by instance id. A
 * position mapping can't say, since a relabelled chip is a replacement of
 * the text the end touches, and maps the end to the wrong side of it.
 */
export function mapChipEdge(
  pos: number,
  edge: "from" | "to",
  oldRuns: readonly PostChipRun[],
  newRuns: readonly PostChipRun[],
): number | null {
  const run = oldRuns.find((candidate) => candidate[edge] === pos);
  if (!run) return null;
  const now = newRuns.filter((candidate) => candidate.iid === run.iid);
  return now.length === 1 ? now[0][edge] : null;
}
