"use client";

import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { MENTION, mentionKind, type MentionStyle } from "@/lib/entity-chips/kinds/mention";
import { MENTION_OPTIONS, mentionOption, mentionOptionFor } from "@/lib/entity-chips/kinds/mention-options";
import { chipStylesOf, observeChipStyles, setChipStyle } from "@/lib/entity-chips/settings";

// docs/ENTITY_CHIPS.md, "Styling" — how this doc shows its entity chips. The
// choice is written into the doc's own ydoc, through the editor's
// connection, so every open editor and reading view relabels at once and the
// next store relabels the cache. Nothing here calls a server action.

/** The mention form of the doc behind `ydoc`, as a select that writes it. */
export function MentionStyleSelect({ ydoc, disabled, className }: { ydoc: Y.Doc; disabled?: boolean; className?: string }) {
  const [style, setStyle] = useState<MentionStyle>(() => mentionKind.parseStyle(chipStylesOf(ydoc)[MENTION]));
  useEffect(() => observeChipStyles(ydoc, (styles) => setStyle(mentionKind.parseStyle(styles[MENTION]))), [ydoc]);

  return (
    <select
      aria-label="How mentions are shown"
      className={className}
      value={mentionOptionFor(style)}
      disabled={disabled}
      onChange={(event) => {
        const chosen = mentionOption(event.target.value);
        if (!chosen) return;
        setStyle(chosen.style);
        // The default is stored as no entry at all, so a doc that never
        // chose keeps following the default.
        ydoc.transact(() => setChipStyle(ydoc, MENTION, chosen.value === "name" ? null : chosen.style));
      }}
    >
      {MENTION_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
