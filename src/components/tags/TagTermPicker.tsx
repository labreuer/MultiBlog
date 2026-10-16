"use client";

import type { TagOption } from "@/lib/tag-data";
import styles from "./TagChips.module.css";

// The find-or-add half of a tagger: a search box over the vocabulary, the
// matching terms as one-click buttons, and "Create …" when nothing matches
// exactly. TagTagger wraps it for one object, BulkTagPicker for a table's
// selection, so the two cannot drift on how a term is found or minted. What
// picking or creating *does* is the caller's.
//
// The draft is the caller's state, so it can clear the box once its own work
// has succeeded rather than the moment the button is pressed.
export default function TagTermPicker({
  options,
  applied,
  draft,
  onDraftChange,
  pending,
  onPick,
  onCreate,
}: {
  options: TagOption[];
  /** Terms already on the object: listed, but disabled, with a title saying why. */
  applied?: ReadonlySet<string>;
  draft: string;
  onDraftChange: (draft: string) => void;
  pending: boolean;
  onPick: (tagId: string) => void;
  onCreate: (name: string) => void;
}) {
  const query = draft.trim().toLowerCase();
  const matches = options.filter((o) => o.name.toLowerCase().includes(query)).slice(0, 12);
  // An exact case-insensitive hit means "apply that one", not "mint a
  // near-duplicate" — the same comparison `tag_name_lower_key` enforces in
  // Postgres, so the button never offers to create something the database is
  // about to refuse.
  const exact = options.find((o) => o.name.toLowerCase() === query);
  const canCreate = query.length > 0 && !exact;

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (exact) onPick(exact.id);
          else if (draft.trim()) onCreate(draft.trim());
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="Find or add a tag …"
          aria-label="Find or add a tag"
          className={styles.taggerInput}
          disabled={pending}
        />
        {canCreate && (
          <button type="submit" disabled={pending} className={styles.taggerCreate}>
            Create &ldquo;{draft.trim()}&rdquo;
          </button>
        )}
      </form>

      {matches.length > 0 && (
        <ul className={styles.taggerList}>
          {matches.map((option) => {
            const isApplied = applied?.has(option.id) ?? false;
            return (
              <li key={option.id}>
                <button
                  type="button"
                  onClick={() => onPick(option.id)}
                  // Already applied by *somebody*. Deliberately disabled
                  // rather than hidden: "this term is already on this
                  // object" is the answer to the question being asked, and
                  // hiding it would read as the term not existing.
                  disabled={pending || isApplied}
                  title={isApplied ? "Already applied here" : undefined}
                >
                  {option.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
