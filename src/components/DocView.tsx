"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { JSONContent } from "@tiptap/react";
import DocReadingBody from "./DocReadingBody";
import DocScrubBar, { type ScrubbedState } from "./DocScrubBar";
import type { AnnotationAnchorInput } from "@/lib/annotation-highlight-extension";
import { docTitleOrFallback } from "@/lib/doc-title";
import { useLiveTabTitle } from "@/lib/use-live-tab-title";

type Props = {
  docId: string;
  initialTitle: string;
  initialBodyJSON: JSONContent;
  staticBody: ReactNode;
  // Byline + date — static, server-rendered (page.tsx), so it doesn't need
  // to react to scrubbing the way the title/body do.
  byline: ReactNode;
  // Gates both the title's link-to-editor and the scrub bar itself — the
  // latter matches GET /api/doc/[id]/replay's own gating, so a reader who
  // can't edit never even sees a scrub bar that would 403 the moment it
  // fetched.
  canEdit: boolean;
  // The viewer's own color (PLAN.md §13f) — resolved server-side (page.tsx
  // already calls auth()) and threaded down rather than read from
  // useSession() inside DocReadingBody, so the pending-selection decoration's
  // color is stable at editor-construction time instead of racing the
  // client-side session fetch.
  userColor: string;
  // PLAN.md §13o — passed straight through to DocReadingBody, which is where
  // the live tracking happens. Derived by page.tsx from the same thread
  // fetch AnnotationSection renders, so the highlight and the card can never
  // disagree about which annotations exist.
  annotationAnchors: AnnotationAnchorInput[];
  // The ?at= scrub position this page was opened at, validated server-side
  // (src/lib/scrub-url.ts) and passed straight through to the scrub bar,
  // which is the only thing here that can turn a ydoc_update id into a
  // rendered revision. Null on an ordinary visit.
  initialScrubUpdateId: string | null;
};

// Owns the one piece of state DocScrubBar, the title, and DocReadingBody need
// to share: which historical title/body (if any) is currently overriding
// the live ones. A server component (page.tsx) can't hold this itself,
// hence the wrapper.
export default function DocView({
  docId,
  initialTitle,
  initialBodyJSON,
  staticBody,
  byline,
  canEdit,
  userColor,
  annotationAnchors,
  initialScrubUpdateId,
}: Props) {
  const [scrubbed, setScrubbed] = useState<ScrubbedState | null>(null);
  // Raw text from the live tap, null until its first render; the fallback is
  // applied once, below.
  const [liveTitle, setLiveTitle] = useState<string | null>(null);
  // Bumped on "return to live" (PLAN.md §12) so DocScrubBar's slider seeks
  // back to the end instead of sitting at whatever historical position it
  // was left at while the body it drives has already snapped back to live.
  const [resetSignal, setResetSignal] = useState(0);

  // Scrubbing freezes the view exactly while it's showing something other
  // than the live end — not merely while a scrub bar is mounted, which is
  // why this isn't just `scrubbed !== null` (the mount-time seed already
  // pushes a `live: true` state before any drag). It is also the whole of
  // what `?at=` has to do: the bar opens at that position and reports
  // `live: false`, and the freeze follows from that alone.
  const scrubFrozen = scrubbed !== null && !scrubbed.live;

  // History pinned by the scrub bar wins; then the live tap (frozen by the
  // same rule as the body, so it never moves above held text); then the scrub
  // bar's live-end replay; then the server's cache. PLAN.md §12n, "The title
  // follows the fragment live".
  const title = docTitleOrFallback(
    scrubFrozen && scrubbed ? scrubbed.title : (liveTitle ?? scrubbed?.title ?? initialTitle),
  );

  // The tab, which generateMetadata composed from that same cache.
  useLiveTabTitle(title);

  // Only meaningful while scrub-frozen — a selection-only freeze has no
  // scrub position to report, and a live scrub position is already stale by
  // the time postAnnotation would use it, so the server's own tail lookup
  // (PLAN.md §12p/§13) is the better answer there.
  const scrubUpdateId = scrubFrozen ? (scrubbed?.updateId ?? null) : null;

  const handleReturnToLive = () => {
    setScrubbed(null);
    setResetSignal((n) => n + 1);
  };

  return (
    <>
      <h1>{canEdit ? <Link href={`/doc/${docId}/edit`}>{title}</Link> : title}</h1>
      {byline}
      <DocReadingBody
        docId={docId}
        initialBodyJSON={initialBodyJSON}
        staticBody={staticBody}
        overrideBodyJSON={scrubbed?.bodyJSON ?? null}
        userColor={userColor}
        onLiveTitle={setLiveTitle}
        scrubFrozen={scrubFrozen}
        scrubUpdateId={scrubUpdateId}
        onReturnToLive={handleReturnToLive}
        annotationAnchors={annotationAnchors}
      />
      {canEdit && (
        <DocScrubBar
          docId={docId}
          onScrub={setScrubbed}
          resetSignal={resetSignal}
          initialUpdateId={initialScrubUpdateId}
        />
      )}
    </>
  );
}
