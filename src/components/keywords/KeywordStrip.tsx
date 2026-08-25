"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { canApplyKeywords } from "@/lib/role-checks";
import type { AnchorTarget } from "@/lib/anchors";
import type { KeywordChip } from "@/lib/keyword-data";
import KeywordTagger from "./KeywordTagger";
import styles from "./KeywordChips.module.css";

// PLAN.md §20d — the strip itself: server-fetched chips, plus a tagger for
// whoever may use one.
//
// A client component so it can read `useSession()`, which is what lets the
// public post page stay statically generated (see KeywordChips' header). The
// chips still server-render — a client component's first paint is SSR'd like
// any other — so a reader with JavaScript off, or a crawler, sees the same
// links; only the tagger needs the browser.
//
// The role check here is an **affordance, not a gate**: it decides whether to
// draw the control. Every action re-asks on the server, and the per-*object*
// half of the rule (canUserTagTarget) lives there too, since a role alone
// cannot say whether this particular PRIVATE doc is yours.

export default function KeywordStrip({ target, chips }: { target: AnchorTarget; chips: KeywordChip[] }) {
  const { data: session } = useSession();
  const mayTag = !!session?.user && canApplyKeywords(session.user.role);

  // Nothing to show and nothing to offer. An untagged object shouldn't grow a
  // permanently empty strip for a reader who can't do anything with it.
  if (chips.length === 0 && !mayTag) return null;

  return (
    <div className={styles.strip}>
      {chips.length > 0 && <span className={styles.label}>Keywords</span>}
      {chips.length > 0 && (
        <ul className={styles.chips}>
          {chips.map((chip) => (
            <li key={chip.id}>
              <Link
                href={`/keyword/${chip.slug}`}
                className={styles.chip}
                // The count is a hover detail rather than a visible badge: on
                // most objects it is 1, and a strip of "(1)"s is noise. It
                // matters only when several people independently reached for
                // the same term, which is the signal worth being able to find.
                title={chip.taggerCount === 1 ? undefined : `Applied by ${chip.taggerCount} people`}
              >
                {chip.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {mayTag && <KeywordTagger target={target} />}
    </div>
  );
}
