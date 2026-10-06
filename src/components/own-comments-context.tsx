"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useSession } from "next-auth/react";
import { getOwnCommentIds } from "@/app/actions/comments";

// Which comments on the post page are the viewer's own, for CommentNode's Edit
// and Delete. A client island for the reason TagChips and PostEditLink are
// (CLAUDE.md): the page is statically generated, so nothing viewer-shaped can
// be in its server render, and the alternative — shipping each commenter's
// user id for the browser to compare — puts that id beside a display name in
// the page source (getOwnCommentIds says why that matters).
//
// SSR and a signed-out reader get the empty set, and so no own-comment
// controls; a signed-in reader gets them once the answer arrives. It is asked
// again when the session changes or when a refresh brings a different set of
// comments (one the viewer just posted, say), and an earlier answer for the
// same viewer stands until then, so the viewer's existing cards don't lose
// their controls while it is in flight.
//
// An affordance, not a gate: deleteComment and editComment decide ownership
// again on the server.

const EMPTY: ReadonlySet<string> = new Set();
const OwnCommentIds = createContext<ReadonlySet<string>>(EMPTY);

export function OwnCommentsProvider({
  postId,
  commentIds,
  children,
}: {
  postId: string;
  /** Every comment id on the page, joined: a change is what prompts asking again. */
  commentIds: string;
  children: ReactNode;
}) {
  const { data: session } = useSession();
  const viewerId = session?.user?.id ?? null;
  const [answer, setAnswer] = useState<{ viewerId: string; ids: ReadonlySet<string> } | null>(null);

  useEffect(() => {
    if (!viewerId) return;
    let current = true;
    getOwnCommentIds(postId).then(
      (ids) => {
        if (current) setAnswer({ viewerId, ids: new Set(ids) });
      },
      // No controls is the safe failure: the cards still read correctly.
      () => {},
    );
    return () => {
      current = false;
    };
  }, [postId, viewerId, commentIds]);

  const own = answer && answer.viewerId === viewerId ? answer.ids : EMPTY;
  return <OwnCommentIds.Provider value={own}>{children}</OwnCommentIds.Provider>;
}

export function useIsOwnComment(commentId: string): boolean {
  return useContext(OwnCommentIds).has(commentId);
}
