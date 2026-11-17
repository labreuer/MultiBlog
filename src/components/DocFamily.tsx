import Link from "next/link";
import LocalTime from "@/components/LocalTime";
import type { DocFamily as Family, FamilyLink } from "@/lib/doc-family";
import styles from "./DocFamily.module.css";

// docs/FORKS.md "A doc's family" — the doc this one was forked from and the
// docs forked from it, under the byline in the doc view, as loadDocFamily
// (src/lib/doc-family.ts) has already narrowed them to what this viewer may
// see. Rendering adds nothing to that: a held-back parent is said in words,
// with no link and no name.
//
// The docs are `<Link>`s. **The diffs are plain `<a>`s**, as the scrub bar's
// are and for its reason: this page's `?at=` is written with replaceState
// after Next's router has kept the page, so Back from a client navigation
// restores a page whose bar never loaded under a URL that names a position
// (DocScrubBar.tsx).

function Diffs({ links }: { links: FamilyLink[] }) {
  if (links.length === 0) return null;
  return (
    <span data-kind="family-diffs">
      {" (diff: "}
      {links.map((link, i) => (
        <span key={link.href}>
          {i > 0 && ", "}
          <a href={link.href}>{link.label}</a>
        </span>
      ))}
      {")"}
    </span>
  );
}

export default function DocFamily({ family }: { family: Family }) {
  const { parent, forks } = family;
  return (
    <aside className={styles.family} aria-label="This doc's family">
      {parent && (
        <div data-kind="forked-from">
          <span className={styles.label}>Forked from:</span>{" "}
          {"entry" in parent ? <Link href={parent.entry.path}>{parent.entry.title}</Link> : "a doc you can't read"}
          {family.forkedAt && (
            <>
              {", "}
              <LocalTime value={family.forkedAt} precision="date" />
            </>
          )}
          <Diffs links={"entry" in parent ? parent.entry.diffs : parent.diffs} />
        </div>
      )}
      {forks.length > 0 && (
        <div data-kind="forks">
          <span className={styles.label}>Forks:</span>{" "}
          <ul className={styles.list}>
            {forks.map((fork) => (
              <li key={fork.id}>
                <Link href={fork.path}>{fork.title}</Link>
                <Diffs links={fork.diffs} />
              </li>
            ))}
            {family.moreForks && <li className={styles.more}>and more</li>}
          </ul>
        </div>
      )}
    </aside>
  );
}
