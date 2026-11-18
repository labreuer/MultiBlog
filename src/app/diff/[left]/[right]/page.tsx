import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { gated, titleWhenOk } from "@/lib/route-access";
import { docTitleOrFallback } from "@/lib/doc-title";
import { gateDiffPair, readDiffPair } from "@/lib/diff-pair";
import { diffPath, parseDiffSide } from "@/lib/diff-side";
import { signInPath } from "@/lib/sign-in-redirect";
import DiffView from "@/components/DiffView";
import styles from "./page.module.css";

// docs/FORKS.md "Diffs" — a word diff from the left side to the right: two
// docs, or one doc at two versions. Each side is a doc id, or `<id>@<update
// id>` for the doc at that version (src/lib/diff-side.ts). This page decides
// who may see the pair and reads each side's blocks; the reader's browser
// compares them, in a worker. It opens no collab connection, and a side with
// no version is the doc as it was when read.
//
// **The gate and the read are src/lib/diff-pair.ts's, which the route a
// slider asks (`/api/diff/[left]/[right]`) calls too.** Neither is written
// here: this answers the gate's refusals and hands the read to `DiffView`,
// which draws it and every pair the sliders name after it.

// Wrapped once at module scope: `generateMetadata` and the page share one pass.
const loadDiffPair = gated(gateDiffPair);

export async function generateMetadata({ params }: { params: Promise<{ left: string; right: string }> }): Promise<Metadata> {
  const { left, right } = await params;
  return titleWhenOk(await loadDiffPair(left, right), ({ left: a, right: b }) =>
    a.doc.id === b.doc.id
      ? `Diff: ${docTitleOrFallback(a.doc.title)}`
      : `Diff: ${docTitleOrFallback(a.doc.title)} → ${docTitleOrFallback(b.doc.title)}`,
  );
}

/**
 * Where sign-in sends a reader back to. The segments arrive percent-encoded
 * (`@` as `%40`), so two sides that parse are written out again from their
 * parse and not encoded a second time; anything else goes back as it came,
 * to be a 404 once signed in.
 */
function returnPath(left: string, right: string): string {
  const leftSide = parseDiffSide(left);
  const rightSide = parseDiffSide(right);
  return leftSide && rightSide ? diffPath(leftSide, rightSide) : `/diff/${left}/${right}`;
}

// Dynamic, as every per-viewer gated page is: the gate reads the session.
export default async function DiffPage({ params }: { params: Promise<{ left: string; right: string }> }) {
  const { left, right } = await params;
  // Free: generateMetadata already ran this for the same request.
  const access = await loadDiffPair(left, right);
  if (access.status === "signed-out") redirect(signInPath(returnPath(left, right)));
  if (access.status === "redirect") redirect(access.to);
  if (access.status === "not-found") notFound();
  if (access.status === "forbidden") {
    return (
      <main className={styles.forbidden}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to see this diff.</p>
      </main>
    );
  }
  return <DiffView initial={await readDiffPair(access.value)} />;
}
