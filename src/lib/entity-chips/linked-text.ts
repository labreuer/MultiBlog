import type { JSONContent } from "@tiptap/core";
import { mergeRuns } from "../inline-markdown";
import { chipKind } from "./registry";
import { chipRenderings, chipsInJSON } from "./renderings";
import { ENTITY_CHIP, type ChipContext, type ChipStyles } from "./types";

// docs/ENTITY_CHIPS.md, step 1, item 9 — what a post-side surface gets in a
// chip's place. A post, and the landing page's preamble, are rendered with a
// schema that has no chip node and throws on one, so every path that carries
// a doc's content to either goes through here: each chip becomes its label as
// text, linked where its chip kind sends a post's reader.

/** What a post's link keeps of the chip it stands for: the link mark's `chip` attribute. */
export type PostChipRef = {
  kind: string;
  iid: string;
  /** The ids of the records the chip pointed at, as its kind lists them. */
  targets: string[];
};

function refOf(chip: { kind: string; iid: string; data: Record<string, unknown> }): PostChipRef {
  const kind = chipKind(chip.kind);
  const data = kind?.validate(chip.data) ?? null;
  return { kind: chip.kind, iid: chip.iid, targets: kind && data !== null ? kind.targets(data) : [] };
}

/**
 * `doc` with every chip replaced by its label as text:
 *
 * - a live chip's label carries a link to the rendering's `postHref`, with
 *   the chip recorded on the link;
 * - a deleted or unknown one is struck through and unlinked;
 * - a chip with nothing to show is dropped, a text node being unable to be
 *   empty;
 * - a label with formatting (`runs`) is a text node per run, each with the
 *   run's marks beside the link, but code, which the schema allows no other
 *   mark beside: a code run is plain text there, still linked.
 *
 * A `chip` attribute already on a link in `doc` is cleared first. Only this
 * function may say that a link stands for a chip, and a doc's own links never
 * do.
 */
export function chipsToLinkedText(doc: JSONContent, styles: ChipStyles, context: ChipContext): JSONContent {
  const chips = chipsInJSON(doc);
  const renderings = chipRenderings(chips, styles, context);
  let next = 0;

  const convert = (node: JSONContent): JSONContent[] => {
    if (node.type === ENTITY_CHIP) {
      const index = next++;
      const rendering = renderings[index];
      if (rendering.label === "") return [];
      const marks =
        rendering.status === "live" && rendering.postHref
          ? [{ type: "link", attrs: { href: rendering.postHref, chip: refOf(chips[index]) } }]
          : rendering.status === "live"
            ? []
            : [{ type: "strike" }];
      const runs = mergeRuns(
        (rendering.runs ?? [{ text: rendering.label }]).map((run) => ({
          text: run.text,
          marks: (run.marks ?? []).filter((mark) => mark !== "code" && !marks.some((chipMark) => chipMark.type === mark)),
        })),
      );
      return runs.map((run) => {
        const all = [...(run.marks ?? []).map((mark) => ({ type: mark })), ...marks];
        return { type: "text", text: run.text, ...(all.length > 0 ? { marks: all } : {}) };
      });
    }

    const { marks: rawMarks, content: rawContent, ...rest } = node;
    const marks = rawMarks?.map((mark) =>
      mark.type === "link" && mark.attrs?.chip != null ? { ...mark, attrs: { ...mark.attrs, chip: null } } : mark,
    );
    const content = rawContent?.flatMap(convert);
    return [
      {
        ...rest,
        ...(marks !== undefined ? { marks } : {}),
        ...(content !== undefined ? { content } : {}),
      },
    ];
  };

  return convert(doc)[0] ?? doc;
}
