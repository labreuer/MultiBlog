import Link from "next/link";
import type { TagLink } from "@/lib/tag-data";
import styles from "./TagChips.module.css";

// PLAN.md §20d, §20n — the chips themselves, and nothing else: no label, no
// tagger, no session. TagStrip wraps it on the object pages; /docs' and
// /files' Tags cells render it bare. One component so the table's chips are
// the strip's chips rather than a lookalike that drifts from them.
export default function TagChipList({ chips }: { chips: TagLink[] }) {
  return (
    <ul className={styles.chips}>
      {chips.map((chip) => (
        <li key={chip.slug}>
          <Link
            href={`/tag/${chip.slug}`}
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
  );
}

/**
 * /docs' and /files' Tags cell. `null` is a row whose tags its page withheld —
 * a PRIVATE one only the ADMIN "show all" override lists — and draws a muted
 * dash that says so on hover, since a blank cell would claim "untagged".
 */
export function TagListCell({ tags, noun }: { tags: TagLink[] | null; noun: string }) {
  if (tags === null) {
    return (
      <span title={`Tags hidden: you can't read this PRIVATE ${noun}`} style={{ color: "var(--text-muted)" }}>
        —
      </span>
    );
  }
  return tags.length > 0 ? <TagChipList chips={tags} /> : null;
}
