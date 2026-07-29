"use client";

import type { JSONContent } from "@tiptap/react";
import type { ReactNode } from "react";
import SideBySideColumn from "./SideBySideColumn";
import styles from "./SideBySideView.module.css";

export type SideBySideDoc = {
  docId: string;
  initialTitle: string;
  initialBodyJSON: JSONContent;
  staticBody: ReactNode;
};

type Props = {
  left: SideBySideDoc;
  right: SideBySideDoc;
  userColor: string;
};

// PLAN.md §14f/§14h — the page shell: a group bar strip (added in Phase 6)
// above two independently-scrolling columns. Phase 2 ships just the grid and
// the two read-only columns.
export default function SideBySideView({ left, right, userColor }: Props) {
  return (
    <div className={styles.columns}>
      <SideBySideColumn {...left} side="left" userColor={userColor} />
      <SideBySideColumn {...right} side="right" userColor={userColor} />
    </div>
  );
}
