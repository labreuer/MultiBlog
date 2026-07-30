"use client";

import { useRouter } from "next/navigation";
import type { ReadableDoc } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import styles from "./CompareWithPicker.module.css";

type Props = {
  docId: string;
  otherDocs: ReadableDoc[];
};

// PLAN.md §14k — the "Compare with…" entry point to /side-by-side, near the
// byline. A <select> rather than a link list: readableDocsFor can return
// every doc a reader has access to, and a picker degrades better than a
// wall of links at that size. Chosen over a two-checkbox control on /docs
// (§12f) because /docs is gated on canManageDocs and an AUTHORIZED reader
// (the role §12e exists for) never sees it — this control has to work from
// the one doc page that role does reach.
export default function CompareWithPicker({ docId, otherDocs }: Props) {
  const router = useRouter();
  if (otherDocs.length === 0) return null;

  return (
    <label className={styles.picker}>
      Compare with…
      <select
        aria-label="Compare with…"
        defaultValue=""
        onChange={(e) => {
          const otherId = e.target.value;
          if (otherId) router.push(`/side-by-side/${docId}/${otherId}`);
        }}
      >
        <option value="" disabled>
          Choose a doc…
        </option>
        {otherDocs.map((d) => (
          <option key={d.id} value={d.id}>
            {docTitleOrFallback(d.title)}
          </option>
        ))}
      </select>
    </label>
  );
}
