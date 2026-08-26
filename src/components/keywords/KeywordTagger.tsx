"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createKeyword, loadTaggerState, tagObject, untagObject, type TaggerState } from "@/app/actions/keywords";
import { useCloseOnOutsideClick } from "@/components/use-close-on-outside-click";
import type { AnchorTarget } from "@/lib/anchors";
import styles from "./KeywordChips.module.css";

// PLAN.md §20d — pick an existing term, mint a new one, or take your own tag
// back off.
//
// **Its state is fetched on first open, not on page render.** The vocabulary is
// the whole keyword table and "your tags here" is a per-viewer read, and paying
// for either on every doc, post and PDF render — for a control most readers
// never touch — would be a query nobody asked for. It also keeps the page
// component free of anything session-shaped, which is what lets the post page
// stay statically generated (KeywordChips' header).
//
// **Every gate is on the server.** `loadTaggerState` and each action re-ask
// `canUserTagTarget` independently, so a client that keeps this mounted after a
// role change, or calls an action directly, gets the same refusal. Nothing here
// is a security boundary; it is an affordance.
//
// **Mint and apply are one gesture**, because from the tagger's side they are
// one intention: typing a term that doesn't exist yet and pressing Add creates
// it and applies it. `createKeyword` is find-first for exactly this reason
// (§20c's app-level dedup), so two people typing the same new term at the same
// moment get one term, not an error for the slower one.

export default function KeywordTagger({
  target,
  onChange,
}: {
  target: AnchorTarget;
  /**
   * Fired after a term is applied or retracted, for a caller that draws this
   * object's keywords from *client* state — the doc editor's Settings panel,
   * which is out of reach of both `revalidatePath` and the `router.refresh()`
   * below. An object page's chips are server-rendered and need none of it.
   * PLAN.md §20k.
   */
  onChange?: () => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<TaggerState | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const panelRef = useRef<HTMLDetailsElement>(null);
  useCloseOnOutsideClick(panelRef);

  function refreshState() {
    startTransition(async () => {
      try {
        setState(await loadTaggerState(target.kind, target.id));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load keywords.");
      }
    });
  }

  function run(work: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await work();
        setDraft("");
        // Both, and in this order: the action's revalidatePath refreshes the
        // server-rendered chips beside this panel, and refreshState refreshes
        // the panel's own view of what is applied. Neither can be derived from
        // the other — the chips don't know which assignment is yours, and this
        // panel doesn't render the chips.
        setState(await loadTaggerState(target.kind, target.id));
        router.refresh();
        onChange?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update keywords.");
      }
    });
  }

  const options = state?.options ?? [];
  const chips = state?.applied ?? [];
  const applied = new Set(chips.map((c) => c.id));
  // The subset this viewer may take back off — §20c's rule, arriving as a
  // field on each chip rather than as a second list to keep in step.
  const own = chips.filter((c) => c.ownAssignmentId !== null);
  const query = draft.trim().toLowerCase();
  const matches = options.filter((o) => o.name.toLowerCase().includes(query)).slice(0, 12);
  // An exact case-insensitive hit means "apply that one", not "mint a
  // near-duplicate" — the same comparison `keyword_name_lower_key` enforces in
  // Postgres, so the button never offers to create something the database is
  // about to refuse.
  const exact = options.find((o) => o.name.toLowerCase() === query);
  const canCreate = query.length > 0 && !exact;

  return (
    <details
      ref={panelRef}
      className={styles.tagger}
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && state === null) refreshState();
      }}
    >
      <summary className={styles.taggerSummary} aria-label="Add or remove keywords">
        + keyword
      </summary>
      <div className={styles.taggerPanel}>
        {state === null && <p className={styles.taggerHeading}>Loading…</p>}

        {state !== null && !state.canTag && <p className={styles.taggerError}>You can&apos;t tag this.</p>}

        {state?.canTag && (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (exact) {
                  run(() => tagObject(exact.id, target.kind, target.id));
                } else if (draft.trim()) {
                  const name = draft.trim();
                  run(async () => {
                    const keyword = await createKeyword(name);
                    await tagObject(keyword.id, target.kind, target.id);
                  });
                }
              }}
            >
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Find or add a keyword …"
                aria-label="Find or add a keyword"
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
                {matches.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      onClick={() => run(() => tagObject(option.id, target.kind, target.id))}
                      // Already applied by *somebody*. Deliberately disabled
                      // rather than hidden: "this term is already on this
                      // object" is the answer to the question being asked, and
                      // hiding it would read as the term not existing.
                      disabled={pending || applied.has(option.id)}
                      title={applied.has(option.id) ? "Already applied here" : undefined}
                    >
                      {option.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {own.length > 0 && (
              <>
                <p className={styles.taggerHeading}>Your tags here</p>
                <ul className={styles.taggerList}>
                  {own.map((tag) => (
                    <li key={tag.ownAssignmentId}>
                      <button
                        type="button"
                        onClick={() => run(() => untagObject(tag.ownAssignmentId!))}
                        disabled={pending}
                        aria-label={`Remove keyword ${tag.name}`}
                      >
                        {tag.name} ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {error && <p className={styles.taggerError}>{error}</p>}
      </div>
    </details>
  );
}
