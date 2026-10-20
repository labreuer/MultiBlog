"use client";

import { useLayoutEffect, useRef } from "react";
import type { AnnotationNodeData } from "./AnnotationNode";
import { annotationAnchorName } from "@/lib/annotation-anchor-name";
import { revealCards } from "@/lib/collapsed-annotations";

// The ids from `node` down to the card whose permalink is `fragment`, or an
// empty list when no card under it has that permalink.
function pathToFragment(node: AnnotationNodeData, fragment: string): string[] {
  if (annotationAnchorName(node.displayName, node.createdAt) === fragment) return [node.id];
  for (const reply of node.replies) {
    const below = pathToFragment(reply, fragment);
    if (below.length > 0) return [node.id, ...below];
  }
  return [];
}

/**
 * docs/ANNOTATIONS.md, "Collapsing a card" — arriving at a permalink opens
 * the way to it: every card from its thread's first down to the one the
 * fragment names, since a card inside a collapsed one is not on the page for
 * the browser to find. A reveal, so nothing is written.
 *
 * Called by the list that owns the threads, and answered once per fragment
 * per mount of that list. A mount is an arrival — a full load, or a
 * client-side navigation back to the page — while the list stays mounted as
 * its cards re-render with fresh data or move between the rail and the list
 * below, which is when a card the reader has closed again must not spring
 * back open. A fragment no card has yet is not counted as answered, so the
 * card is still found if it arrives with later data. A layout effect, so the
 * card the browser has just scrolled to is not drawn collapsed for a frame.
 */
export function useRevealForFragment(roots: readonly AnnotationNodeData[]) {
  const answered = useRef<string | null>(null);
  useLayoutEffect(() => {
    const answer = () => {
      const fragment = window.location.hash.slice(1);
      if (fragment === "" || fragment === answered.current) return;
      for (const root of roots) {
        const path = pathToFragment(root, fragment);
        if (path.length === 0) continue;
        answered.current = fragment;
        revealCards(path);
        return;
      }
    };
    answer();
    window.addEventListener("hashchange", answer);
    return () => window.removeEventListener("hashchange", answer);
  }, [roots]);
}
