"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { tagObjectMany } from "@/app/actions/tags";
import type { TagOption } from "@/lib/tag-data";
import styles from "./TagChips.module.css";

// PLAN.md §20m — the post editor's offer to carry its source doc's terms
// across, one at a time or all at once.
//
// **It copies; the doc keeps its tags.** Applying a term here is a fresh act
// of tagging by this viewer on the post — a new `tag_assignment` — not a
// re-pointing of the doc's. The doc is still about that subject after
// publication, and retracting someone else's reading of it would be a
// moderation power (`canUserRemoveAssignment`) rather than a publishing one.
//
// **Deliberately not the byline's behaviour.** `createPostFromDoc` seeds the
// post's authors from the doc's automatically (§15d); tags are offered instead,
// because a doc's tags are a working filing system and a post's are public
// taxonomy, and the two are not the same list often enough to copy by default.
//
// **Why there is a bulk action rather than n calls to `tagObject`.** "Add all"
// is one gesture: one permission check, one transaction, one revalidation. The
// client-side loop would be n round trips and a half-filled strip if the
// fourth failed.
//
// The offer disappears as it is used — `tagsNotYetOn` subtracts what is
// already on the post — so an untagged doc, and a doc whose terms have all
// come across, grow no permanent furniture here.

export default function DocTagOffer({
  postId,
  docTitle,
  tags,
}: {
  postId: string;
  /** The post's *source* doc, from `post.docId` — see the note in PostPublisher. */
  docTitle: string;
  tags: TagOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // The empty case lives here rather than in the caller so there is one place
  // that decides what "nothing to offer" looks like.
  if (tags.length === 0) return null;

  function apply(tagIds: string[]) {
    setError(null);
    startTransition(async () => {
      try {
        await tagObjectMany(tagIds, "post", postId);
        // The post's chips and this row are both server-rendered on this page,
        // and `tagObjectMany`'s revalidatePath cannot reach either: a draft has
        // no public path (`pathForTarget` returns null) and /post/[id]/edit is
        // never one of the paths it names. The refresh is what moves a term
        // from this row into the strip above it.
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't add those tags.");
      }
    });
  }

  return (
    // `data-doc-tag-offer` is the spec's handle, on the DocSettingsPanel
    // precedent: the label below is prose and will be reworded, and a test
    // that locates this row by reading it would break on the rewording rather
    // than on the behaviour.
    <div className={`${styles.strip} ${styles.offer}`} data-doc-tag-offer>
      {/* **Not "From doc …"** — the status line four elements up already says
          that, about `selectedDocId`. This row is about `post.docId`, and the
          two disagree the moment "Change doc…" is touched, so wording them
          alike would read as one fact stated twice and be wrong half the
          time. It still names the doc for exactly that reason. */}
      <span className={styles.label}>Doc &ldquo;{docTitle}&rdquo;</span>
      <ul className={styles.chips}>
        {tags.map((tag) => (
          <li key={tag.id}>
            <button
              type="button"
              className={styles.offerChip}
              onClick={() => apply([tag.id])}
              disabled={pending}
              // Named the way TagTagger names its removal buttons, and for the
              // same reason: "+ Kant" is the visible affordance but not a
              // usable accessible name, and it is what a spec reaches for.
              aria-label={`Add tag ${tag.name} from the doc`}
            >
              + {tag.name}
            </button>
          </li>
        ))}
      </ul>
      {tags.length > 1 && (
        <button
          type="button"
          className={styles.offerAll}
          onClick={() => apply(tags.map((tag) => tag.id))}
          disabled={pending}
        >
          Add all {tags.length}
        </button>
      )}
      {error && <p className={styles.taggerError}>{error}</p>}
    </div>
  );
}
