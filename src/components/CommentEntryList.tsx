"use client";

import { useState } from "react";
import CommentNode, { hasNonDeletedDescendant, type CommentNodeData } from "./CommentNode";
import QuoteThreadHeader from "./QuoteThreadHeader";
import type { ThreadStatus } from "@/generated/prisma/enums";

export type CommentEntry = {
  threadId: string;
  quotedText: string;
  anchorFrom: number | null;
  status: ThreadStatus;
  context: string | null;
  color: string;
  root: CommentNodeData;
};

type SortMode = "datetime" | "quoteIndex";

type Props = {
  entries: CommentEntry[];
  postId: string;
  userName: string | null;
  viewerId: string | null;
  isAdmin: boolean;
};

export default function CommentEntryList({ entries, postId, userName, viewerId, isAdmin }: Props) {
  const [sortMode, setSortMode] = useState<SortMode>("datetime");

  const sorted = [...entries].sort((a, b) => {
    if (sortMode === "quoteIndex") {
      const aIndex = a.anchorFrom ?? Infinity;
      const bIndex = b.anchorFrom ?? Infinity;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime();
  });

  return (
    <>
      <div style={{ margin: "12px 0" }}>
        <label style={{ fontSize: "0.85rem", color: "#555" }}>
          Sort by:{" "}
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
            <option value="datetime">Comment date</option>
            <option value="quoteIndex">Quoted text position</option>
          </select>
        </label>
      </div>

      {sorted.map((entry) => {
        // A deleted root with no live descendants renders nothing (see
        // CommentNode) — its quoted-text header would otherwise be left
        // dangling above empty space with no comment underneath it.
        const rootRendersNothing =
          entry.root.deletedByUserId !== null && !hasNonDeletedDescendant(entry.root);

        return (
          // data-thread-id (not id) since sorting can scatter a thread's entries
          // apart, and every one of them needs to be reachable — AnnotatableArticle's
          // onIndicatorClick uses querySelectorAll to scroll to and flash all of them.
          <div key={entry.root.id} data-thread-id={entry.threadId} style={{ marginTop: 24 }}>
            {entry.quotedText && !rootRendersNothing && (
              <QuoteThreadHeader
                threadId={entry.threadId}
                quotedText={entry.quotedText}
                status={entry.status}
                context={entry.context}
                color={entry.color}
              />
            )}
            <CommentNode
              comment={entry.root}
              postId={postId}
              userName={userName}
              viewerId={viewerId}
              isAdmin={isAdmin}
            />
          </div>
        );
      })}
    </>
  );
}
