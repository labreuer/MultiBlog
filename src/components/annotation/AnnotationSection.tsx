import { auth } from "@/lib/auth";
import { getOwnDraftAnnotations, type AnnotationThread } from "@/lib/annotation-data";
import NewAnnotationComposer from "./NewAnnotationComposer";
import OwnDraftsList from "./OwnDraftsList";
import AnnotationPresenceIndicator from "./AnnotationPresenceIndicator";
import AnnotationList from "./AnnotationList";
import AnnotationColorStyles from "./AnnotationColorStyles";
import { buildAnnotationEntries } from "./annotation-entries";
import styles from "./AnnotationSection.module.css";

// The doc-side sibling of CommentSection (PLAN.md §13c) — un-shared from it
// now that an annotation body is becoming its own collaborative document
// rather than a plain textarea (§12i's "one view-model feeds the shared
// presentation" no longer holds once the two sides stop having the same
// rendering problem).
//
// The thread → entry transform lives in annotation-entries.ts now that the
// doc *editor* renders its own annotation rail from the same data (§18c).
// `threads` is a prop rather than this component's own fetch (PLAN.md §13o):
// the reading page also needs them, to hand DocReadingBody the anchors it
// tracks and draws. Fetching in both places would be a second identical
// query, and — worse — two answers that could disagree about which
// annotations exist, so the highlight and the card it belongs to would be
// derived from different snapshots. Same shape [slug]/page.tsx already uses
// for a post's comment threads.
export default async function AnnotationSection({ docId, threads }: { docId: string; threads: AnnotationThread[] }) {
  const session = await auth();
  // Every doc route this renders from already requires a session
  // (canUserReadDoc) — the `?? []` is just to keep this typed without a
  // throw, never an expected runtime path.
  const ownDrafts = session?.user ? await getOwnDraftAnnotations(docId, session.user.id) : [];

  const entries = buildAnnotationEntries(threads);

  return (
    <section className={styles.section} data-comment-section>
      {/* Colors the reading/editing view's annotation highlights by their
          author, same as AuthorHighlightStyles does for attributed body
          text — a <style> tag's attribute-selector rules apply document-wide
          regardless of where it sits in the tree, so rendering it here
          (rather than up in DocReadingBody, which has no reason to know about
          annotation authorship) is fine. */}
      <AnnotationColorStyles
        colors={Object.fromEntries(threads.filter((t) => t.quotedText !== "").map((t) => [t.id, t.color]))}
      />
      <h2 className={styles.heading}>Annotations</h2>
      <AnnotationPresenceIndicator />
      <NewAnnotationComposer target={{ kind: "doc", id: docId }} />
      <OwnDraftsList drafts={ownDrafts} />

      {threads.length === 0 ? (
        <p className={styles.empty}>No annotations yet.</p>
      ) : (
        <AnnotationList entries={entries} docId={docId} />
      )}
    </section>
  );
}
