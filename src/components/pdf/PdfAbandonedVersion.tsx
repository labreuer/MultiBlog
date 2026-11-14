"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import LocalTime from "@/components/LocalTime";
import { pdfPath } from "@/lib/file-version";
import { pageFromHash, stampFragment } from "@/lib/pdf-open-params";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Addresses" — what an abandoned version's address answers
// with, to whoever may read the file: which version it was, that it was
// abandoned and when, and a link to the latest. Its bytes and its page text
// are gone, so there is nothing to show; its number is never reused, so the
// address never comes to mean other bytes.
//
// **The link carries the fragment over.** `/pdf/book/v/2#sheet=49` offers
// `/pdf/book#sheet=49&v=2`: on this address the link named version 2 by being
// here, and on the latest's it has to say so, or it would be read as the
// first version's (`stampFragment`). The latest's viewer then reads it as it
// reads any link that names an abandoned version. A fragment that names no
// page, a card's name, goes over as it is, since a card's link finds its note
// from any address of the file.
//
// A client component for that alone: the server never sees a fragment.

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

type Props = { slug: string; title: string; number: number; abandonedAt: string | null; latestNumber: number | null };

export default function PdfAbandonedVersion({ slug, title, number, abandonedAt, latestNumber }: Props) {
  // Empty on the server and on the first paint, so the link is the bare address until the fragment can be read.
  const hash = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => "",
  );
  const fragment = hash.replace(/^#/, "");
  const carried = fragment === "" ? "" : `#${pageFromHash(fragment) ? stampFragment(fragment, number) : fragment}`;
  return (
    <main className={styles.gone} data-testid="pdf-abandoned-version">
      <h1>
        {title}, version {number}
      </h1>
      <p>
        Version {number} of this file was abandoned
        {abandonedAt && (
          <>
            {" "}
            on <LocalTime value={abandonedAt} />
          </>
        )}
        . It was uploaded and never became the latest, and its pages were removed.
      </p>
      <p>
        <Link href={`${pdfPath(slug)}${carried}`} data-testid="pdf-abandoned-latest">
          Open the latest version{latestNumber !== null ? `, version ${latestNumber}` : ""}
        </Link>
      </p>
    </main>
  );
}
