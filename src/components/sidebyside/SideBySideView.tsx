"use client";

import type { JSONContent } from "@tiptap/react";
import type { ReactNode } from "react";
import DocColumn from "./DocColumn";
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
  userId: string;
  userName: string;
  userColor: string;
};

// PLAN.md §14f/§14h — the page shell: a group bar strip (added in Phase 6)
// above two independently-scrolling columns, each able to switch between
// read and write mode on its own (§14g).
export default function SideBySideView({ left, right, userId, userName, userColor }: Props) {
  return (
    <div className={styles.columns}>
      <DocColumn {...left} side="left" userId={userId} userName={userName} userColor={userColor} />
      <DocColumn {...right} side="right" userId={userId} userName={userName} userColor={userColor} />
    </div>
  );
}
