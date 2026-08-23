"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Editor } from "@tiptap/react";
import { attachIndexeddb } from "@/lib/ydoc-persistence";
import { getCollabUrl } from "@/lib/collab-url";
import { UNTITLED_DOC } from "@/lib/doc-title";
import { useMediaQuery } from "@/lib/use-media-query";
import { useEditorAnnotationWidget } from "@/lib/use-editor-annotation-widget";
import CollabEditorBody, { type AuthorStat } from "./CollabEditorBody";
import CollabTitleField from "./CollabTitleField";
import DocSettingsPanel, { type EligibleUser } from "./DocSettingsPanel";
import EditorAnnotationRail from "./annotation/EditorAnnotationRail";
import AnnotationPopover from "./annotation/AnnotationPopover";
import { useDocPresence } from "./annotation/doc-presence-context";
import type { AnnotationEntry } from "./annotation/AnnotationList";
import { annotationAnchorInputs } from "@/lib/annotation-highlight-extension";
import { useRegisterMarginNotesEditor } from "./margin-notes/margin-notes-context";
import { EDITOR_SCROLL_ATTRIBUTE } from "./editor-scroll";
import type { DocVisibility } from "@/generated/prisma/enums";
import styles from "./DocEditor.module.css";

// PLAN.md §18f — the marker sits *beside* the document, so this floor is
// about one thing only: whether a gutter to put it in actually exists.
// Below it there is none, and the marker would clamp back over the text it
// is meant to stay out of the way of — which is the whole point of the
// marker, so the honest answer at those widths is no marker at all.
//
// Derived, not picked. `.container` is `max-width: 800px` with 1rem padding,
// centred, so the text box's right edge sits at `(W + 800) / 2 - 16`; the
// marker needs `MARKER_GAP + ANNOTATE_MARKER_SIZE + MARKER_GAP` (44px) of
// clear space to its right. Solving gives W ≥ 856. 900px is the nearest
// width STYLE.md already documents, and clears it comfortably.
//
// This is deliberately *not* the "iPhone 12 Pro Max portrait" (428px) the
// feature was specced against: that number was chosen as the width above
// which there'd be room beside the document, and measurement says there
// isn't any until 856. Between the two, everything still works — a doc's
// annotations are composed from its reading view (/doc/[slug]), which has
// its own selection popover and no width floor.
const ANNOTATION_WIDGET_MEDIA_QUERY = "(min-width: 900px)";

type Props = {
  docId: string;
  slug: string;
  initialTitle: string;
  visibility: DocVisibility;
  createdAt: Date;
  userId: string;
  userName: string;
  userColor: string;
  authorIds: string[];
  eligibleUsers: EligibleUser[];
  initialDeleted: boolean;
  // Rendered beside the editor, above the margin-notes breakpoint only
  // (PLAN.md §18c). Server-built like the reading view's, and pre-filtered
  // there to quote-anchored threads — which mark still exists is then decided
  // per measurement against the live document, since this is the surface
  // where that changes under you.
  annotations: AnnotationEntry[];
};

type ConnectionStatus = "connecting" | "connected" | "disconnected";

// A much smaller sibling of PostEditor (PLAN.md §12k): no save/publish/
// schedule (a doc has no revisions — it auto-persists through the collab
// server itself, PLAN.md §12d), no revision diff, no title autosave — the
// title is a cache doc-cache.ts writes server-side from the "title"
// fragment, not something this component pushes. What's left is close to
// /ydoc-debug's editing mode (YdocDebug.tsx's EditView): provider wiring,
// attachIndexeddb for offline durability, CollabTitleField/CollabEditorBody
// reused unmodified, plus DocSettingsPanel for byline and visibility.
export default function DocEditor({
  docId,
  slug,
  initialTitle,
  visibility,
  createdAt,
  userId,
  userName,
  userColor,
  authorIds,
  eligibleUsers,
  initialDeleted,
  annotations,
}: Props) {
  const [title, setTitle] = useState(initialTitle);
  const [deleted, setDeleted] = useState(initialDeleted);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  // Distinct from `connectionStatus === "connected"`: the provider reports
  // "connected" at websocket-open, before authentication and before the
  // initial sync has delivered the document (syncStep2). "🟢 Live" waits for
  // this flag so it means "the content in front of you is the document", not
  // "a socket exists" — docs/playwright-flakiness.html, class 2. The provider
  // only ever emits `synced` on the true transition, so the false direction
  // is ours to handle in onStatus below.
  const [synced, setSynced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorStats, setAuthorStats] = useState<AuthorStat[]>([]);
  // CollabEditorBody's onEditorReady, finally used for something: the
  // annotation rail is a sibling of the editor, not a child, so this is how
  // it gets something to measure against.
  const [bodyEditor, setBodyEditor] = useState<Editor | null>(null);
  // A ref alongside the state above — useEditorAnnotationWidget's handlers
  // run off editor events (outside React's render cycle) and would
  // otherwise close over whichever `bodyEditor` was current when first
  // wired, same reason use-live-doc-content.ts's editorRef exists.
  const editorRef = useRef<Editor | null>(null);
  useEffect(() => {
    editorRef.current = bodyEditor;
  }, [bodyEditor]);
  // The click-outside-closes and popover-bounds region for the selection
  // widget — .mainColumn rather than a wrapping div, so nothing here alters
  // DocEditor.module.css's flex-height chain (STYLE.md's flex-grow trap).
  const containerRef = useRef<HTMLDivElement>(null);
  const { setAwareness } = useDocPresence();
  // Scoped to this column rather than a bare document.querySelector — see
  // the hook's own note on why it takes this as a callback.
  const getFrame = useCallback(
    () => containerRef.current?.querySelector<HTMLElement>(`[${EDITOR_SCROLL_ATTRIBUTE}]`) ?? null,
    [],
  );
  const widget = useEditorAnnotationWidget({ editorRef, containerRef, getFrame, userColor });
  const wideEnoughForWidget = useMediaQuery(ANNOTATION_WIDGET_MEDIA_QUERY);

  // No separate `ready` flag to gate on, unlike the reading views: this
  // editor is visible from the moment it exists — there's no static copy for
  // it to hide behind — so having an editor at all *is* being measurable.
  useRegisterMarginNotesEditor(bodyEditor, bodyEditor !== null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ydoc = useMemo(() => new Y.Doc(), [docId]);

  useEffect(() => {
    let cancelled = false;
    let instance: HocuspocusProvider | null = null;
    let detachIndexeddb: (() => void) | null = null;

    // Same reconnect fix as PostEditor.tsx: `token` as a function is called
    // on every connection attempt, not just the first, so a long-idle tab's
    // reconnect gets a freshly-minted token instead of retrying the
    // original 2-minute-expired one forever. The first call reuses the
    // token already fetched below (lineage has to come from that same
    // response before the provider is even constructed — see the
    // attachIndexeddb call); only a later call hits the network again.
    let firstToken: string | null = null;
    async function fetchToken(): Promise<string> {
      if (firstToken !== null) {
        const t = firstToken;
        firstToken = null;
        return t;
      }
      const res = await fetch(`/api/doc/${docId}/token`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to authenticate for live editing.");
      const { token } = (await res.json()) as { token: string };
      return token;
    }

    (async () => {
      try {
        const res = await fetch(`/api/doc/${docId}/token`, { method: "POST" });
        if (!res.ok) {
          throw new Error("Failed to authenticate for live editing.");
        }
        const { token, lineage, documentName } = (await res.json()) as {
          token: string;
          lineage: number;
          documentName: string;
        };
        if (cancelled) return;
        firstToken = token;

        // Lineage has to be known before connecting — see PLAN.md §11e for why
        // attaching first (or caching the lineage) would let a stale local
        // copy merge into a re-seeded document.
        detachIndexeddb = attachIndexeddb(ydoc, documentName, lineage);

        instance = new HocuspocusProvider({
          url: getCollabUrl(),
          name: documentName,
          document: ydoc,
          token: fetchToken,
          onStatus: ({ status }) => {
            setConnectionStatus(status);
            if (status !== "connected") setSynced(false);
          },
          onSynced: () => setSynced(true),
          onAuthenticationFailed: ({ reason }) => setError(`Live editing unavailable: ${reason}`),
        });
        setProvider(instance);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to connect.");
      }
    })();

    return () => {
      cancelled = true;
      instance?.destroy();
      detachIndexeddb?.();
      ydoc.destroy();
    };
  }, [docId, ydoc]);

  // PLAN.md §13i — publishes this connection's awareness onto
  // DocPresenceProvider (edit/page.tsx wraps DocEditor in one, alongside
  // AnnotationMoveProvider), the same channel the reading view's read-only
  // tap already exposes there, so "someone is writing an annotation" works
  // between the editor and readers without a second channel.
  useEffect(() => {
    setAwareness(provider?.awareness ?? null);
    return () => setAwareness(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setAwareness is a context setter (stable)
  }, [provider]);

  // Resolved fresh for display (the "Annotating: ..." header and the
  // fallback anchorFrom/anchorTo AnnotationPopover never actually falls back
  // to here, since resolveAnchor below is always supplied) — not read from
  // any state the widget hook holds, for the same reason submit time
  // resolves fresh: showing a stale position while someone else edits above
  // the selection would be exactly the bug Phase 3 exists to avoid.
  const widgetAnchor = widget.pending && bodyEditor ? widget.resolveAnchor(bodyEditor) : null;

  // PLAN.md §13o — derived from the entries this page already has rather than
  // taken as a second prop: the rail and the highlight are two views of one
  // list, and letting them arrive separately is how they would come to
  // disagree.
  const annotationAnchors = useMemo(() => annotationAnchorInputs(annotations), [annotations]);

  return (
    <div className={styles.container}>
      {/* data-doc-editor-column is the `:has()` scope for the height-floor
          rule in EditorChrome.module.css — see DocSettingsPanel's <details>. */}
      <div className={styles.mainColumn} data-doc-editor-column="" ref={containerRef}>
        {provider ? (
          <CollabTitleField
            ydoc={ydoc}
            userId={userId}
            userName={userName}
            userColor={userColor}
            editable={!deleted}
            className={`${styles.titleInput} ${deleted ? styles.titleInputDisabled : ""}`}
            placeholder={UNTITLED_DOC}
            onTitleChange={setTitle}
            onEditorReady={() => {}}
          />
        ) : (
          // Same fallback text/color as the placeholder above, so the swap
          // from this pre-connection div to the live editor doesn't flip an
          // untitled doc's title between two different grays.
          <div className={`${styles.titleInput} ${styles.titleInputDisabled}`}>
            {title || <span style={{ color: "var(--text-muted)" }}>{UNTITLED_DOC}</span>}
          </div>
        )}
        <p className={styles.statusLine}>
          {connectionStatus === "connected"
            ? synced
              ? "🟢 Live"
              : "🔵 Connected"
            : connectionStatus === "connecting"
              ? "🟡 Connecting…"
              : "🔴 Disconnected"}
          {authorStats.length > 0 && " ("}
          {authorStats.map((author, i) => (
            <span key={author.authorId}>
              {i > 0 && ", "}
              <span style={{ color: author.color }}>{author.name}</span>
            </span>
          ))}
          {authorStats.length > 0 && ")"}
        </p>
        {provider ? (
          <CollabEditorBody
            provider={provider}
            ydoc={ydoc}
            userId={userId}
            userName={userName}
            userColor={userColor}
            editable={!deleted}
            onEditorReady={setBodyEditor}
            onAuthorStats={setAuthorStats}
            onSelectionUpdate={widget.capture}
            onContentUpdate={widget.reresolve}
            annotationAnchors={annotationAnchors}
          />
        ) : (
          <p>Connecting to live editor…</p>
        )}
        {/* Stage one (PLAN.md §18f): a marker beside the document, not a
            panel over it. Selecting text in an editor is mostly not a
            request to annotate — it's how you bold a word or move a
            sentence — so this says only that annotating is possible, and
            costs nothing until clicked. */}
        {wideEnoughForWidget && widget.pending && !widget.expanded && widget.marker && (
          <button
            type="button"
            className={styles.annotateMarker}
            style={{ top: widget.marker.top, left: widget.marker.left }}
            onClick={widget.expand}
            title="Annotate this selection"
            aria-label="Annotate this selection"
            data-testid="annotate-marker"
          >
            {/* Inline, currentColor, no fill — the marker inherits the
                hover/focus colours above, and a monochrome outline stays
                quiet where an emoji glyph would not. */}
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path
                d="M2.5 3.5h11v7.5h-6l-3 2.5v-2.5h-2z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        {/* Stage two: the composer, opened where the marker was. `autoOpen`
            because the marker already asked the question its "Annotate"
            button would ask again. */}
        {wideEnoughForWidget && widget.pending && widget.expanded && widget.popoverPlacement && widgetAnchor && (
          <AnnotationPopover
            elementRef={widget.popoverRef}
            docId={docId}
            top={widget.popoverPlacement.top}
            left={widget.popoverPlacement.left}
            from={widgetAnchor.from}
            to={widgetAnchor.to}
            quotedText={widget.pending.quotedText}
            // PLAN.md §13o — the one surface that still writes a mark. It
            // can: this editor already holds a writable connection to the
            // document, so anchoring costs no privilege the author doesn't
            // already have, and a mark cannot drift the way the reading
            // views' stored offsets can.
            anchorMode="mark"
            allowMoveToBottom={false}
            autoOpen
            resolveAnchor={() => (editorRef.current ? widget.resolveAnchor(editorRef.current) : null)}
            onPosted={() => widget.clear()}
            onCancel={() => widget.clear()}
          />
        )}
        {error && <p className={styles.errorMessage}>{error}</p>}
        <p className={styles.docNote}>
          <Link href={`/doc/${slug}`}>View and Annotate</Link>
        </p>
        <DocSettingsPanel
          docId={docId}
          visibility={visibility}
          createdAt={createdAt}
          authorIds={authorIds}
          eligibleUsers={eligibleUsers}
          deleted={deleted}
          onDeletedChange={setDeleted}
        />
      </div>
      <div className={styles.rail}>
        <EditorAnnotationRail entries={annotations} docId={docId} />
      </div>
    </div>
  );
}
