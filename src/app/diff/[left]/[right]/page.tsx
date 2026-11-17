import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { gated, titleWhenOk } from "@/lib/route-access";
import { canUserReadDoc, canUserSeeDocHistory, canUserSeeDocVersion } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { isDocVersion, loadDocStateAt, loadDocStateNow } from "@/lib/doc-state";
import { diffPath, parseDiffSide, sideOrder, type DiffSide, type SideOrder } from "@/lib/diff-side";
import type { DiffBlock } from "@/lib/doc-diff";
import { SCRUB_PARAM } from "@/lib/scrub-url";
import { signInPath } from "@/lib/sign-in-redirect";
import DocDiff from "@/components/DocDiff";
import LocalTime from "@/components/LocalTime";
import styles from "./page.module.css";

// docs/FORKS.md "Diffs" — a word diff from the left side to the right: two
// docs, or one doc at two versions. Each side is a doc id, or `<id>@<update
// id>` for the doc at that version (src/lib/diff-side.ts). This page decides
// who may see the pair and reads each side's blocks; the reader's browser
// compares them, in a worker (`DocDiff`). It opens no collab connection, and
// a side with no version is the doc as it was when the page loaded.

const DOC_SELECT = { id: true, slug: true, title: true, visibility: true, deletedByUserId: true } as const;

/**
 * The pair gate, in the order docs/FORKS.md's "Who may see one" gives:
 *
 * 1. both sides parse, or the page is a 404;
 * 2. each doc is read by id alone, so a slug is a 404, and a deleted one is
 *    refused by hand, since canUserReadDoc doesn't consider deletion;
 * 3. if either side is unreadable, so is the whole page, and the title
 *    answers the same way rather than naming half a pair;
 * 4. **a version needs canUserSeeDocVersion, asked before the version itself
 *    is looked for**, so a reader without the history gets Forbidden whatever
 *    the id;
 * 5. then a version that isn't in its doc's log is a 404, never replaced by
 *    the doc as it is now. In the other order, Forbidden against 404 would
 *    tell that reader which ids are in the log.
 *
 * The same doc on both sides is allowed: nothing here opens a Y.Doc in the
 * browser.
 */
const loadDiffPair = gated(async (user, left: string, right: string) => {
  const leftSide = parseDiffSide(left);
  const rightSide = parseDiffSide(right);
  if (leftSide === null || rightSide === null) return "not-found";
  const sides = [leftSide, rightSide] as const;

  const [leftDoc, rightDoc] = await Promise.all(
    sides.map((side) => prismaIncludingDeleted.doc.findUnique({ where: { id: side.docId }, select: DOC_SELECT })),
  );
  if (!leftDoc || leftDoc.deletedByUserId !== null || !rightDoc || rightDoc.deletedByUserId !== null) return "not-found";

  const readable = await Promise.all([leftDoc, rightDoc].map((doc) => canUserReadDoc(user.id, user.role, doc)));
  if (!readable.every(Boolean)) return "forbidden";

  const versioned = sides.filter((side): side is DiffSide & { updateId: bigint } => side.updateId !== null);
  const visible = await Promise.all(versioned.map((side) => canUserSeeDocVersion(user.id, user.role, side.docId, side.updateId)));
  if (!visible.every(Boolean)) return "forbidden";
  const inLog = await Promise.all(versioned.map((side) => isDocVersion(side.docId, side.updateId)));
  if (!inLog.every(Boolean)) return "not-found";

  // Whether the doc's own reading view would honour `?at=` for this viewer:
  // a version may also be visible as a fork's first state, to a viewer the
  // parent's scrub bar is not for.
  const [leftHistory, rightHistory] = await Promise.all(
    sides.map((side) => (side.updateId === null ? false : canUserSeeDocHistory(user.id, user.role, side.docId))),
  );
  return {
    left: { side: leftSide, doc: leftDoc, history: leftHistory },
    right: { side: rightSide, doc: rightDoc, history: rightHistory },
  };
});

type GatedSide = { side: DiffSide; doc: { id: string; slug: string; title: string }; history: boolean };

type LoadedSide =
  | { ok: true; title: string; blocks: DiffBlock[]; at: Date | null }
  /** The store was unavailable, or the ydoc didn't decode under the doc schema. */
  | { ok: false };

/**
 * A side's text and its title as of that side. No version is
 * `loadDocStateNow`, the stored row with the log's later rows applied; a
 * version is `loadDocStateAt`, one replay. Neither comes from `prose_json`,
 * which trails the log while someone types.
 *
 * Either read can throw, once the gate has passed: the page then says so in
 * that side's place, and is not a 500.
 */
async function loadSide({ side, doc }: GatedSide): Promise<LoadedSide> {
  try {
    const [state, row] = await Promise.all([
      side.updateId === null ? loadDocStateNow(doc.id) : loadDocStateAt(doc.id, side.updateId),
      side.updateId === null ? null : prisma.ydocUpdate.findUnique({ where: { id: side.updateId }, select: { createdAt: true } }),
    ]);
    return {
      ok: true,
      title: docTitleOrFallback(state.title),
      blocks: state.blocks.map((block) => ({ text: block.text, type: block.node.type.name, heading: block.heading !== null })),
      at: row?.createdAt ?? null,
    };
  } catch (err) {
    console.error(`[diff] couldn't read doc ${doc.id}${side.updateId === null ? "" : ` at ${side.updateId}`}:`, err);
    return { ok: false };
  }
}

export async function generateMetadata({ params }: { params: Promise<{ left: string; right: string }> }): Promise<Metadata> {
  const { left, right } = await params;
  return titleWhenOk(await loadDiffPair(left, right), ({ left: a, right: b }) =>
    a.doc.id === b.doc.id
      ? `Diff: ${docTitleOrFallback(a.doc.title)}`
      : `Diff: ${docTitleOrFallback(a.doc.title)} → ${docTitleOrFallback(b.doc.title)}`,
  );
}

function SideHeader({
  gatedSide,
  loaded,
  loadedAt,
  order,
}: {
  gatedSide: GatedSide;
  loaded: LoadedSide;
  loadedAt: Date;
  /** "Earlier" or "Later" when the pair has an order, and nothing when it has none. */
  order: "Earlier" | "Later" | null;
}) {
  const { side, doc, history } = gatedSide;
  // The doc at this version where its reading view honours `?at=` for this
  // viewer, and the doc as it is now otherwise.
  const href = side.updateId !== null && history ? `/doc/${doc.slug}?${SCRUB_PARAM}=${side.updateId}` : `/doc/${doc.slug}`;
  return (
    <div className={styles.side}>
      <Link href={href} className={styles.sideTitle}>
        {loaded.ok ? loaded.title : docTitleOrFallback(doc.title)}
      </Link>
      {loaded.ok ? (
        <span className={styles.when}>
          {order && <span className={styles.order}>{order}</span>}
          {side.updateId === null ? (
            <>
              when this page loaded, <LocalTime value={loadedAt} />
            </>
          ) : loaded.at ? (
            <>
              as it was at <LocalTime value={loaded.at} />
            </>
          ) : (
            "at an earlier version"
          )}
        </span>
      ) : (
        <span className={styles.when}>
          Couldn&apos;t read this doc&apos;s text. <a href="">Reload</a> to try again.
        </span>
      )}
    </div>
  );
}

const ORDER_LABELS: Record<SideOrder, { left: "Earlier" | "Later"; right: "Earlier" | "Later" }> = {
  "left-earlier": { left: "Earlier", right: "Later" },
  "right-earlier": { left: "Later", right: "Earlier" },
};

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
  const { left: leftGated, right: rightGated } = access.value;
  const loadedAt = new Date();
  const [leftLoaded, rightLoaded] = await Promise.all([loadSide(leftGated), loadSide(rightGated)]);
  const order = sideOrder(leftGated.side, rightGated.side);
  const labels = order ? ORDER_LABELS[order] : null;
  const swapped = diffPath(rightGated.side, leftGated.side);

  return (
    <main className={styles.container}>
      <div className={styles.titleRow}>
        <h1>Diff</h1>
        <Link href={swapped}>Swap sides</Link>
      </div>
      <div className={styles.sides}>
        <SideHeader gatedSide={leftGated} loaded={leftLoaded} loadedAt={loadedAt} order={labels?.left ?? null} />
        <SideHeader gatedSide={rightGated} loaded={rightLoaded} loadedAt={loadedAt} order={labels?.right ?? null} />
      </div>
      {order === "right-earlier" && (
        <p className={styles.orderNote} data-kind="later-on-left">
          The later version is on the left, so text marked removed was added since, and text marked added was removed.{" "}
          <Link href={swapped}>Swap sides</Link>
        </p>
      )}
      {leftLoaded.ok && rightLoaded.ok && <DocDiff left={leftLoaded.blocks} right={rightLoaded.blocks} />}
    </main>
  );
}
