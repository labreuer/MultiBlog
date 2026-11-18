import Link from "next/link";
import type { DocVisibility } from "@/generated/prisma/enums";
import { ownerSegment, wikiNamespacePath, type WikiAddress } from "@/lib/wiki-address";
import styles from "./wiki-address-line.module.css";

// docs/WIKI.md "Telling a wiki page from a doc" — the line above a wiki page's
// title, in its doc view and its editor, so a wiki page can't be mistaken for
// a doc: Wiki › its namespace › its name and variant, as stored, with its
// spaces, and who can read it. A doc that isn't a wiki page has no such
// line, which is the tell. PUBLIC stands out, since a page's text then
// reaches anyone, signed out.
//
// No hooks, so it renders on the server in the doc view and in the browser
// in the editor alike.

export default function WikiAddressLine({ address, visibility }: { address: WikiAddress; visibility: DocVisibility }) {
  return (
    <p className={styles.line} data-wiki-address="">
      <Link href="/wiki">Wiki</Link>
      <span className={styles.separator} aria-hidden="true">
        ›
      </span>
      <Link href={wikiNamespacePath(address.owner)}>{ownerSegment(address.owner)}</Link>
      <span className={styles.separator} aria-hidden="true">
        ›
      </span>
      <span>{address.variant ? `${address.name}~${address.variant}` : address.name}</span>
      <span className={styles.separator} aria-hidden="true">
        ·
      </span>
      {visibility === "PUBLIC" ? (
        <span className={styles.public}>PUBLIC: anyone can read this, signed out</span>
      ) : (
        <span>{visibility}</span>
      )}
    </p>
  );
}
