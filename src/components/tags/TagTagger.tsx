"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTag, loadTaggerState, tagObject, untagObject, type TaggerState } from "@/app/actions/tags";
import { useCloseOnOutsideClick } from "@/components/use-close-on-outside-click";
import type { AnchorTarget } from "@/lib/anchors";
import TagTermPicker from "./TagTermPicker";
import styles from "./TagChips.module.css";

// PLAN.md §20d — pick an existing term, mint a new one, or take your own tag
// back off.
//
// **Its state is fetched on first open, not on page render.** The vocabulary is
// the whole tag table and "your tags here" is a per-viewer read, and paying
// for either on every doc, post and PDF render — for a control most readers
// never touch — would be a query nobody asked for. It also keeps the page
// component free of anything session-shaped, which is what lets the post page
// stay statically generated (TagChips' header).
//
// **Every gate is on the server.** `loadTaggerState` and each action re-ask
// `canUserTagTarget` independently, so a client that keeps this mounted after a
// role change, or calls an action directly, gets the same refusal. Nothing here
// is a security boundary; it is an affordance.
//
// **Mint and apply are one gesture**, because from the tagger's side they are
// one intention: typing a term that doesn't exist yet and pressing Add creates
// it and applies it. `createTag` is find-first for exactly this reason
// (§20c's app-level dedup), so two people typing the same new term at the same
// moment get one term, not an error for the slower one.

export default function TagTagger({
  target,
  onChange,
}: {
  target: AnchorTarget;
  /**
   * Fired after a term is applied or retracted, for a caller that draws this
   * object's tags from *client* state — the doc editor's Settings panel,
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
        setError(e instanceof Error ? e.message : "Couldn't load tags.");
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
        setError(e instanceof Error ? e.message : "Failed to update tags.");
      }
    });
  }

  const options = state?.options ?? [];
  const chips = state?.applied ?? [];
  const applied = new Set(chips.map((c) => c.id));
  // The subset this viewer may take back off — §20c's rule, arriving as a
  // field on each chip rather than as a second list to keep in step.
  const own = chips.filter((c) => c.ownAssignmentId !== null);

  return (
    <details
      ref={panelRef}
      className={styles.tagger}
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && state === null) refreshState();
      }}
    >
      <summary className={styles.taggerSummary} aria-label="Add or remove tags">
        + tag
      </summary>
      <div className={styles.taggerPanel}>
        {state === null && <p className={styles.taggerHeading}>Loading…</p>}

        {state !== null && !state.canTag && <p className={styles.taggerError}>You can&apos;t tag this.</p>}

        {state?.canTag && (
          <>
            <TagTermPicker
              options={options}
              applied={applied}
              draft={draft}
              onDraftChange={setDraft}
              pending={pending}
              onPick={(tagId) => run(() => tagObject(tagId, target.kind, target.id))}
              onCreate={(name) =>
                run(async () => {
                  const tag = await createTag(name);
                  await tagObject(tag.id, target.kind, target.id);
                })
              }
            />

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
                        aria-label={`Remove tag ${tag.name}`}
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
