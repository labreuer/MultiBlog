import type { JSONContent } from "@tiptap/core";
import type { ChipStyles } from "@/lib/entity-chips/types";
import { stripMarksFromDoc } from "@/lib/tiptap-schema";

// docs/FORKS.md "What it takes, and what stays" — what a fork is seeded with,
// from the parent's state at the fork point. Pure, so fork-seed.test.ts can
// hold the strip without a database.
//
// **The `annotation` strip here is the only guard against copying a parent's
// notes.** createDocWithContent seeds through docContentExtensions, which has
// the mark, so a body that still carried it would be accepted. An editor-made
// annotation is a mark whose `id` is one of the parent's annotation rows: a
// copied one would light up the parent's notes in the fork's editor, on rows
// that resolve against another doc.

/** The parts of a `DocState` a seed is made from. */
export type ForkSource = {
  json: JSONContent;
  title: string;
  chips: { inputs: { styles: ChipStyles } };
};

export type ForkSeed = {
  /** The parent's body: `authorHighlight` marks kept, so inherited text still shows who wrote it; `annotation` marks removed. */
  body: JSONContent;
  /** The parent's title as plain text; "" for none. */
  title: string;
  /** The parent's chip styles at the version, so the fork's labels read as the parent's did. */
  chipStyles: ChipStyles;
};

export function forkSeed(state: ForkSource): ForkSeed {
  return {
    body: stripMarksFromDoc(state.json, ["annotation"]),
    title: state.title,
    chipStyles: state.chips.inputs.styles,
  };
}
