"use client";

import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { CITATION, citationKind, type CitationForm } from "@/lib/entity-chips/kinds/citation";
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

const CITATION_OPTIONS: { value: CitationForm; label: string }[] = [
  { value: "short", label: "Abbreviation — (BU p. 49)" },
  { value: "author-date", label: "Author and date — (Barfield 1957, p. 49)" },
  { value: "numeric", label: "Number — [3, p. 49]" },
];

/** The citation form of the doc behind `ydoc`, as a select that writes it (docs/CITATIONS.md, "Labels"). */
export function CitationStyleSelect({ ydoc, disabled, className }: { ydoc: Y.Doc; disabled?: boolean; className?: string }) {
  const [form, setForm] = useState<CitationForm>(() => citationKind.parseStyle(chipStylesOf(ydoc)[CITATION]).form);
  useEffect(() => observeChipStyles(ydoc, (styles) => setForm(citationKind.parseStyle(styles[CITATION]).form)), [ydoc]);

  return (
    <select
      aria-label="How citations are shown"
      className={className}
      value={form}
      disabled={disabled}
      onChange={(event) => {
        const chosen = CITATION_OPTIONS.find((option) => option.value === event.target.value);
        if (!chosen) return;
        setForm(chosen.value);
        // The default is stored as no entry, as a mention's is.
        ydoc.transact(() => setChipStyle(ydoc, CITATION, chosen.value === "short" ? null : { form: chosen.value }));
      }}
    >
      {CITATION_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
