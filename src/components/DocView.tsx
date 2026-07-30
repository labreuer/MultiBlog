"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { JSONContent } from "@tiptap/react";
import DocReadingBody from "./DocReadingBody";
import DocScrubBar, { type ScrubbedState } from "./DocScrubBar";

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
};

// Owns the one piece of state DocScrubBar, the title, and DocReadingBody need
// to share: which historical title/body (if any) is currently overriding
// the live ones. A server component (page.tsx) can't hold this itself,
// hence the wrapper.
export default function DocView({ docId, initialTitle, initialBodyJSON, staticBody, byline, canEdit, userColor }: Props) {
  const [scrubbed, setScrubbed] = useState<ScrubbedState | null>(null);

  const title = scrubbed?.title ?? initialTitle;

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
      />
      {canEdit && <DocScrubBar docId={docId} onScrub={setScrubbed} />}
    </>
  );
}
