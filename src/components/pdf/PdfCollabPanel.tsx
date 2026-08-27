import styles from "./PdfPanes.module.css";

// PLAN.md §19 — the Collab tab of /pdf/[slug]'s side panel.
//
// **A deliberate stub, not an unfinished component.** The tab ships empty so
// the strip is the shape it will keep; filling it is its own piece of work
// (TODO.md, "The PDF side panel's Collab tab is a stub").
//
// The obvious occupants are Phase 4's presence pieces, which live in the chrome
// around the viewer: `PdfFollowBar`'s reader list and follow control, squeezed
// into the toolbar, and whatever the left-hand `PdfPresenceRail` can say in
// words rather than as marks down the edge. Nothing here presumes that — it is
// where to start looking, not a decision.

export default function PdfCollabPanel() {
  return (
    <div className={styles.pane}>
      <p className={styles.placeholder}>Nothing here yet.</p>
    </div>
  );
}
