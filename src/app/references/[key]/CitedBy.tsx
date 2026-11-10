"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { referenceCitedBy } from "@/app/actions/references";
import { pdfPageHref } from "@/lib/entity-chips/kinds/citation";
import type { ReferenceCitedBy } from "@/lib/reference-cited-by";
import styles from "./page.module.css";

// docs/CITATIONS.md, "Pages" — the part of a reference's page that depends on
// who is looking: the docs and notes citing the work, and its PDF. The page
// is public and reads no session, so this asks the server once signed in, as
// TagChips keeps the post page static. The server answers through each
// list's read rule.
//
// A published post links here with the page it cited in the fragment,
// `#p=49`, and the PDF is offered at that page: a fragment rather than a
// query string, since a page that reads searchParams can never be cached.
//
// On a list's page (`/references/<key>,<key>,…`) there is one per work, with
// its `position` in the list as written: the fragment holds each work's page
// by place, `#p=12,,3`, and this one reads its own.

function subscribeHash(notify: () => void) {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
}

/** The page a link names, `#p=49`, or on a list the page at `position`, `#p=12,,3`; null for none. */
function citedPage(hash: string, position: number | undefined): string | null {
  const whole = new URLSearchParams(hash.replace(/^#/, "")).get("p");
  const value = whole === null ? null : position === undefined ? whole : (whole.split(",")[position] ?? null);
  return value?.trim() ? value.trim() : null;
}

export default function CitedBy({
  referenceId,
  referenceKey,
  headingLevel = 2,
  position,
}: {
  referenceId: string;
  referenceKey: string;
  /** "Cited in docs" and "Cited in notes": an `<h3>` under a list's per-work `<h2>`. */
  headingLevel?: 2 | 3;
  /** The work's place in a list's address, for its page in `#p=`; absent on a single work's page, which reads the whole of it. */
  position?: number;
}) {
  const { status } = useSession();
  const [answer, setAnswer] = useState<ReferenceCitedBy | null>(null);
  // Empty on the server and on the first paint, so nothing here depends on the fragment until after hydration.
  const page = citedPage(useSyncExternalStore(subscribeHash, () => window.location.hash, () => ""), position);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    void referenceCitedBy(referenceId)
      .catch(() => null)
      .then((found) => {
        if (!cancelled) setAnswer(found);
      });
    return () => {
      cancelled = true;
    };
  }, [status, referenceId]);

  if (!answer) return null;
  const { docs, notes, file, more } = answer;
  const pdfHref = file ? (pdfPageHref(file, page ?? undefined) ?? `/pdf/${file.slug}`) : null;
  const atPage = file && page && pdfPageHref(file, page) !== null;
  const Heading = headingLevel === 3 ? "h3" : "h2";

  // On a list the work's own section is the named region, and twenty regions of one name would tell a screen reader nothing.
  return (
    <section className={styles.citedBy} aria-label={position === undefined ? "Where you can read it" : undefined}>
      {file && pdfHref && (
        <p className={styles.pdf}>
          PDF: <a href={pdfHref}>{file.title}</a>
          {atPage && <>, at p. {page}</>}
        </p>
      )}
      {docs.length > 0 && (
        <>
          <Heading>Cited in docs</Heading>
          <ul className={styles.citing}>
            {docs.map((doc) => (
              <li key={doc.href}>
                <Link href={doc.href}>{doc.title}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {notes.length > 0 && (
        <>
          <Heading>Cited in notes</Heading>
          <ul className={styles.citing}>
            {notes.map((note) => (
              <li key={note.href}>
                <Link href={note.href}>
                  {note.writer} on {note.on}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {(docs.length > 0 || notes.length > 0) && (
        <p className={styles.searchAll}>
          <Link href={`/search?cites=${encodeURIComponent(referenceKey)}`}>{more ? "Everything that cites it" : "Search what cites it"}</Link>
        </p>
      )}
    </section>
  );
}
