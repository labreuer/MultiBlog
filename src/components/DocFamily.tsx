import Link from "next/link";
import LocalTime from "@/components/LocalTime";
import type { DocFamily as Family, FamilyEntry, FamilyLink } from "@/lib/doc-family";
import styles from "./DocFamily.module.css";

// docs/FORKS.md "A doc's family" — the doc this one was forked from, the
// docs forked from it, and for a wiki page the other pages with its name
// (docs/WIKI.md "The family line"), under the byline in the doc view and
// under the name in a PUBLIC page's public render, as loadDocFamily
// (src/lib/doc-family.ts) has already narrowed them to what this viewer may
// see. Rendering adds nothing to that: a held-back parent is said in words,
// with no link and no name, in the surface's own words.
//
// The docs are `<Link>`s. **The diffs are plain `<a>`s**, as the scrub bar's
// are and for its reason: this page's `?at=` is written with replaceState
// after Next's router has kept the page, so Back from a client navigation
// restores a page whose bar never loaded under a URL that names a position
// (DocScrubBar.tsx).

/** Where the line is shown: a doc's view, a wiki page's doc view, or a PUBLIC page's public render. */
export type FamilySurface = "doc" | "wiki" | "public";

/** A held-back parent, by surface: the public render's reader is told only that it isn't public. */
const HIDDEN_PARENT: Record<FamilySurface, string> = {
  doc: "a doc you can't read",
  wiki: "a page you can't read",
  public: "a page that isn't public",
};

/** An entry's diffs in parentheses, after `lead`: "diff: " for a parent's and a fork's, nothing for Same name's one. */
function Diffs({ links, lead }: { links: FamilyLink[]; lead: string }) {
  if (links.length === 0) return null;
  return (
    <span data-kind="family-diffs">
      {` (${lead}`}
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

function List({ kind, label, entries, more, lead }: { kind: string; label: string; entries: FamilyEntry[]; more: boolean; lead: string }) {
  if (entries.length === 0) return null;
  return (
    <div data-kind={kind}>
      <span className={styles.label}>{label}:</span>{" "}
      <ul className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.id}>
            <Link href={entry.path}>{entry.title}</Link>
            <Diffs links={entry.diffs} lead={lead} />
          </li>
        ))}
        {more && <li className={styles.more}>and more</li>}
      </ul>
    </div>
  );
}

export default function DocFamily({ family, surface }: { family: Family; surface: FamilySurface }) {
  const { parent } = family;
  return (
    <aside className={styles.family} aria-label={surface === "doc" ? "This doc's family" : "This page's family"}>
      {parent && (
        <div data-kind="forked-from">
          <span className={styles.label}>Forked from:</span>{" "}
          {"entry" in parent ? <Link href={parent.entry.path}>{parent.entry.title}</Link> : HIDDEN_PARENT[surface]}
          {family.forkedAt && (
            <>
              {", "}
              <LocalTime value={family.forkedAt} precision="date" />
            </>
          )}
          <Diffs links={"entry" in parent ? parent.entry.diffs : parent.diffs} lead="diff: " />
        </div>
      )}
      <List kind="forks" label="Forks" entries={family.forks} more={family.moreForks} lead="diff: " />
      <List kind="same-name" label="Same name" entries={family.sameName} more={family.moreSameName} lead="" />
    </aside>
  );
}
