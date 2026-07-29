"use client";

import type { JSONContent } from "@tiptap/react";
import type { ReactNode } from "react";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
import LiveDocBody from "@/components/LiveDocBody";
import proseStyles from "@/styles/prose.module.css";
import styles from "./SideBySideColumn.module.css";

type Props = {
  docId: string;
  initialTitle: string;
  initialBodyJSON: JSONContent;
  staticBody: ReactNode;
  side: "left" | "right";
  userColor: string;
};

const ARIA_LABELS = {
  left: "Left doc body",
  right: "Right doc body",
} as const;

// PLAN.md §14f — DocPresenceProvider gets one instance *per column*, as
// siblings: it's a React context, so two nest fine, and the bug the single-
// page-instance version guards against is one instance with two writers.
// LiveDocBody calls useDocPresence() unconditionally and throws outside a
// provider, so wrapping here is both cheaper and safer than loosening that
// hook's contract.
export default function SideBySideColumn({ docId, initialTitle, initialBodyJSON, staticBody, side, userColor }: Props) {
  return (
    <DocPresenceProvider>
      <div className={styles.column} data-side={side}>
        <h2 className={styles.title}>{initialTitle}</h2>
        <div className={styles.scroller}>
          <LiveDocBody
            docId={docId}
            initialBodyJSON={initialBodyJSON}
            staticBody={<div className={`${proseStyles.prose} ${proseStyles.noAnnotations}`}>{staticBody}</div>}
            userColor={userColor}
            ariaLabel={ARIA_LABELS[side]}
            selectionUi="none"
            suppressAnnotations
          />
        </div>
      </div>
    </DocPresenceProvider>
  );
}
