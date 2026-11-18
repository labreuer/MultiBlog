import Link from "next/link";
import { wikiPagePath, type WikiOwner } from "@/lib/wiki-address";
import type { WikiListPage } from "@/lib/wiki-pages";
import styles from "./wiki.module.css";

/**
 * A namespace's pages as a reader's list (docs/WIKI.md "Labels"): each page's
 * name, with its variant after the `~`, linked to its address, and its
 * visibility. The list is one namespace's addresses, and without the variant
 * its entries would read alike.
 */
export default function PageList({ owner, pages }: { owner: WikiOwner; pages: WikiListPage[] }) {
  return (
    <ul className={styles.pages}>
      {pages.map((page) => {
        const name = page.wikiName!;
        return (
          <li key={page.id} className={styles.page}>
            <Link href={wikiPagePath({ owner, name, variant: page.wikiVariant })}>
              {page.wikiVariant ? `${name}~${page.wikiVariant}` : name}
            </Link>
            <span className={styles.visibility}>{page.visibility}</span>
          </li>
        );
      })}
    </ul>
  );
}
