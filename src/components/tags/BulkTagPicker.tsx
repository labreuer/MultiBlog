"use client";

import { useRef, useState } from "react";
import { createTag, loadTagOptions } from "@/app/actions/tags";
import type { TagOption } from "@/lib/tag-data";
import { useCloseOnOutsideClick } from "@/components/use-close-on-outside-click";
import TagTermPicker from "./TagTermPicker";
import styles from "./TagChips.module.css";

// The bulk "+ tag" in `/docs`' and `/files`' toolbar (docs/TAGS.md, "Tagging
// from /docs and /files") — a BulkToolbar "picker" control. It only chooses a
// term, minting one if asked, and hands its id to `apply`; the toolbar then
// runs `bulkTagObjects` over the applicable rows and paints each row's outcome.
//
// **The vocabulary is fetched each time it opens**, so a term minted from this
// picker, or anywhere else, is offered the next time without a page refresh.
// It is one query for a control an admin opens on purpose.
//
// **Nothing is shown as already applied.** Across a selection a term is on
// some rows and not others, and applying it again where it already is is a
// no-op (`applyTags`' dedup), so every term stays offered.
export default function BulkTagPicker({
  apply,
  pending,
}: {
  apply: (tagId: string) => void;
  pending: boolean;
}) {
  const [options, setOptions] = useState<TagOption[] | null>(null);
  const [canTag, setCanTag] = useState(true);
  const [draft, setDraft] = useState("");
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDetailsElement>(null);
  useCloseOnOutsideClick(panelRef);

  async function load() {
    setError(null);
    try {
      const state = await loadTagOptions();
      setCanTag(state.canTag);
      setOptions(state.options);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load tags.");
    }
  }

  function choose(tagId: string) {
    setDraft("");
    if (panelRef.current) panelRef.current.open = false;
    apply(tagId);
  }

  async function create(name: string) {
    setError(null);
    setMinting(true);
    try {
      const tag = await createTag(name);
      choose(tag.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the tag.");
    } finally {
      setMinting(false);
    }
  }

  return (
    <details
      ref={panelRef}
      className={styles.tagger}
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) void load();
      }}
    >
      <summary className={styles.taggerSummary} aria-label="Tag the selected rows">
        + tag
      </summary>
      <div className={styles.taggerPanel}>
        {options === null && !error && <p className={styles.taggerHeading}>Loading…</p>}
        {options !== null && !canTag && <p className={styles.taggerError}>You can&apos;t apply tags.</p>}
        {options !== null && canTag && (
          <TagTermPicker
            options={options}
            draft={draft}
            onDraftChange={setDraft}
            pending={pending || minting}
            onPick={choose}
            onCreate={(name) => void create(name)}
          />
        )}
        {error && <p className={styles.taggerError}>{error}</p>}
      </div>
    </details>
  );
}
