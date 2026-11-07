"use client";

import { useEffect, useState } from "react";
import { entityChipKey } from "@/lib/entity-chips/node";
import { PENDING_CHIP } from "@/lib/entity-chips/renderings";
import type { ChipLabels } from "@/lib/entity-chips/text";
import { useMarginNotes } from "./margin-notes-context";

// docs/ENTITY_CHIPS.md, step 1, item 11 — a card's quote beside the passage it
// quotes. The quote's chips are shown by the labels stored on its anchor
// (src/lib/anchors/chips.ts), which a rename reaches only when its refresh
// has run, while the body next to the card is labelled from the accounts as
// they are. This hands a card list the labels that body is drawing, by
// instance id, so the two never disagree on one page.

function sameLabels(a: ChipLabels | undefined, b: ChipLabels): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [iid, label] of b) if (a.get(iid) !== label) return false;
  return true;
}

/**
 * Each chip's label as the page's own editor is drawing it, for
 * `quoteWithChipLabels` to prefer over a stored one. Undefined until that
 * editor has mounted, and on a page with none: the stored labels then stand,
 * which is also what the server rendered.
 *
 * A chip the editor has no record for is left out, so a card keeps its
 * stored name rather than flashing a placeholder: one still being fetched,
 * and one drawn before the editor was given anything to label it from.
 */
export function useLiveChipLabels(): ChipLabels | undefined {
  const editor = useMarginNotes()?.editor ?? null;
  const [labels, setLabels] = useState<ChipLabels | undefined>(undefined);

  useEffect(() => {
    if (!editor) return;
    // The plugin replaces this map exactly when a chip or its inputs change,
    // so every other transaction costs one comparison.
    let seen: unknown = null;
    const read = () => {
      if (editor.isDestroyed) return;
      const byIid = entityChipKey.getState(editor.state)?.byIid;
      if (byIid === seen) return;
      seen = byIid;
      const next = new Map<string, string>();
      for (const [iid, rendering] of byIid ?? []) {
        if (rendering !== PENDING_CHIP && rendering.status !== "unknown") next.set(iid, rendering.label);
      }
      setLabels((previous) => (sameLabels(previous, next) ? previous : next));
    };
    read();
    editor.on("transaction", read);
    return () => {
      editor.off("transaction", read);
    };
  }, [editor]);

  return editor ? labels : undefined;
}
