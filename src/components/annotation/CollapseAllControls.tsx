"use client";

import { useMemo } from "react";
import type { AnnotationNodeData } from "./AnnotationNode";
import {
  collapseCards,
  expandCards,
  idsInSubtree,
  isCollapsed,
  newestInSubtree,
  useCollapseState,
} from "@/lib/collapsed-annotations";
import styles from "./CollapseAllControls.module.css";

type Props = {
  /** The first card of every thread the surface lists. */
  roots: readonly AnnotationNodeData[];
};

// docs/ANNOTATIONS.md, "Collapsing a card" — every thread on the page at once.
// The two are not mirror images: "Collapse all" closes each thread's first
// card, which hides everything under it, while "Expand all" forgets every
// card in those threads, replies included, so nothing is left closed further
// down to be found later.
export default function CollapseAllControls({ roots }: Props) {
  const state = useCollapseState();
  const ids = useMemo(() => roots.flatMap(idsInSubtree), [roots]);
  const anyOpen = roots.some((root) => !isCollapsed(state, root.id));
  const anyClosed = ids.some((id) => state.collapsed.has(id));

  return (
    <span className={styles.controls}>
      <button
        type="button"
        className={styles.control}
        disabled={!anyOpen}
        onClick={() => collapseCards(roots.map((root) => ({ id: root.id, seen: newestInSubtree(root) })))}
      >
        Collapse all
      </button>
      <button type="button" className={styles.control} disabled={!anyClosed} onClick={() => expandCards(ids)}>
        Expand all
      </button>
    </span>
  );
}
