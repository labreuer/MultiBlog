"use client";

import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { EditorContent, type Editor, type JSONContent } from "@tiptap/react";
import { useLiveDocContent } from "@/lib/use-live-doc-content";
import { useSelectionPopover } from "@/lib/use-selection-popover";
import { AnnotationClick } from "@/lib/annotation-click-extension";
import { activatePseudoBordersForThread } from "@/lib/pseudo-border";
import { flashHighlight } from "@/lib/flash-highlight";
import { NEUTRAL_THREAD_COLOR } from "@/lib/author-colors";
import AnnotationPopover from "./annotation/AnnotationPopover";
import { useDocPresence } from "./annotation/doc-presence-context";
import { useMarginNotes, useRegisterMarginNotesEditor } from "./margin-notes/margin-notes-context";
import proseStyles from "@/styles/prose.module.css";
import styles from "./DocReadingBody.module.css";

type Props = {
  docId: string;
  initialBodyJSON: JSONContent;
  staticBody: ReactNode;
  // See useLiveDocContent's identical option — DocScrubBar (PLAN.md §12).
  overrideBodyJSON?: JSONContent | null;
  // The viewer's own color (PLAN.md §13f), resolved server-side and passed
  // down rather than read here via useSession() — see DocView.tsx.
  userColor: string;
  // True while DocView's scrub bar sits anywhere but the live end (PLAN.md
  // §12) — one of the two independent reasons this view freezes, the other
  // being a held selection, tracked below via `selection.pending`.
  scrubFrozen?: boolean;
  // Clicking FROZEN — clears the scrub override and reports it back up so
  // DocView can also reset the scrub bar's own slider position.
  onReturnToLive?: () => void;
};

// Clicking an annotation-highlighted span jumps to (and briefly tints) its
// entry in AnnotationSection below, plus a persistent author-colored
// pseudo-border — the doc-side mirror of AnnotatableArticle's quote-
// indicator badge click. AnnotationList already tags each entry's root div
// with data-thread-id/data-thread-color (same attributes CommentEntryList
// uses), so this needs no data of its own beyond the clicked mark's id.
// Module scope, not a component closure: it reads nothing but the DOM at
// click time, so there's no per-render state for useLiveDocContent's
// once-only useEditor construction (see use-live-doc-content.ts) to go
// stale over — unlike AnnotatableArticle's onIndicatorClick, which reads
// `threads` and so is rebound via that editor's own [threads] deps array.
function jumpToAnnotationEntry(ids: string[]) {
  const id = ids[0];
  if (!id) return;
  const targets = document.querySelectorAll<HTMLElement>(`[data-thread-id="${id}"]`);
  if (targets.length === 0) return;
  const color = targets[0].dataset.threadColor ?? NEUTRAL_THREAD_COLOR;
  targets[0].scrollIntoView({ behavior: "smooth", block: "center" });
  targets.forEach((target) => flashHighlight(target, color));
  activatePseudoBordersForThread(id, color);
}

const annotationClickExtensions = [AnnotationClick.configure({ onHit: jumpToAnnotationEntry })];

// The reading view at /doc/[slug] (PLAN.md §12g): live doc content, where
// selecting text offers to annotate it.
//
// Was `LiveDocBody`, which served this surface *and* a /side-by-side column by
// branching on a `selectionUi` flag (PLAN.md §14p). Splitting them is what
// lets this file state plainly that it shows annotations and nothing else —
// where before, whether it rendered an AnnotationPopover depended on a prop,
// and its pending-selection state was shared with a doc-link popover whose
// positioning convention silently diverged from this one's.
export default function DocReadingBody({
  docId,
  initialBodyJSON,
  staticBody,
  overrideBodyJSON,
  userColor,
  scrubFrozen = false,
  onReturnToLive,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Declared here so both hooks below can take it as an input — see
  // useLiveDocContent's note on why it owns neither end of that.
  const editorRef = useRef<Editor | null>(null);
  const { setAwareness } = useDocPresence();
  const marginNotes = useMarginNotes();

  const selection = useSelectionPopover({ editorRef, containerRef, userColor });

  // The view's other freeze reason (PLAN.md §12) — any non-empty selection,
  // not merely one whose popover happens to be open, since the two are set
  // together by `selection.capture`.
  const frozen = scrubFrozen || selection.pending !== null;

  const { editor, ready, synced, error, frozenUpdates } = useLiveDocContent({
    docId,
    initialBodyJSON,
    ariaLabel: "Post body",
    overrideBodyJSON,
    frozen,
    editorRef,
    setAwareness,
    extensions: annotationClickExtensions,
    onSelectionUpdate: selection.capture,
    onContentPushed: (liveEditor) => {
      selection.reresolve(liveEditor);
      // Content arrives here through setContent with `emitUpdate: false`, so
      // the editor's own "update" event never fires and the margin-notes
      // layout would keep every card at the position the *previous* body put
      // it. This is that layout's only signal on this surface — a remote
      // keystroke reflows the article, which moves every anchor below it.
      marginNotes?.notifyContentChanged();
    },
  });

  const frozenUpdateCount = useSyncExternalStore(
    frozenUpdates.subscribe,
    frozenUpdates.getSnapshot,
    frozenUpdates.getSnapshot,
  );

  // Lets AnnotationSection's cards sit level with the text they mark
  // (PLAN.md §18). Same ready-gating as AnnotatableArticle's: until then this
  // editor is display:none behind the SSR'd static body.
  useRegisterMarginNotesEditor(editor, ready);

  function handleUnfreeze() {
    selection.clear();
    onReturnToLive?.();
  }

  if (error) {
    return <p style={{ color: "var(--error)" }}>{error}</p>;
  }

  return (
    <div ref={containerRef} className={`${styles.container} ${frozen ? styles.frozen : ""}`}>
      {synced && <span data-testid="live-doc-synced" style={{ display: "none" }} />}
      {frozen && (
        <div className={styles.flagTrack}>
          <button
            type="button"
            className={styles.flag}
            title="switch to live view"
            aria-label={
              frozenUpdateCount > 0
                ? `Switch to live view (${frozenUpdateCount} update${frozenUpdateCount === 1 ? "" : "s"} arrived while frozen)`
                : "Switch to live view"
            }
            onClick={handleUnfreeze}
          >
            FROZEN{frozenUpdateCount > 0 && ` (+${frozenUpdateCount})`}
          </button>
        </div>
      )}
      <div style={{ display: ready ? "none" : "block" }}>{staticBody}</div>
      <div className={proseStyles.prose} style={{ display: ready ? "block" : "none" }}>
        <EditorContent editor={editor} />
      </div>
      {selection.pending && selection.placement && (
        <AnnotationPopover
          elementRef={selection.popoverRef}
          docId={docId}
          top={selection.placement.top}
          left={selection.placement.left}
          from={selection.pending.from}
          to={selection.pending.to}
          quotedText={selection.pending.quotedText}
          onPosted={() => selection.clear()}
          onCancel={() => selection.clear()}
        />
      )}
    </div>
  );
}
