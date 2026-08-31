"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AnchoredLinkPart, AnchoredLinkView } from "@/lib/anchored-link-data";
import styles from "./AnchoredLinkBanner.module.css";

// docs/ANCHORED_LINKS.md — what a ?sel= page shows about the link it landed
// on: this surface's passages as jump handles, every *other* readable group
// as a link that carries ?sel= onward. Shared by both reading surfaces; the
// import from anchored-link-data is type-only, so the server module behind
// it never reaches the client bundle.
//
// The per-target visibility filter already ran on the server
// (anchoredLinkForViewer): whatever `link.groups` holds is what this viewer
// may see, and an omitted group is acknowledged nowhere — this component
// renders what it is handed and adds no second check, TagChips' stance.
//
// A part whose range no longer resolves is still *listed* (the quote is a
// real column and still reads), it is just painted nowhere — so its jump
// finds no element and quietly does nothing, the doc-link behavior.

type Props = {
  link: AnchoredLinkView;
  /** Which of the link's groups is this page, if any. */
  currentTarget: { kind: "doc" | "file"; id: string };
  /**
   * The PDF surface's replacement for the DOM-query jump — quads live in a
   * canvas-positioned layer, not on elements a selector can find. Supplying
   * it also hands over on-load jumping (the surface knows when the viewer
   * is ready; this component would only be guessing).
   */
  onJumpToPart?: (part: AnchoredLinkPart) => void;
  /** Extra class on the root — the PDF surface positions the banner absolutely. */
  className?: string;
};

function jumpViaDom(anchorId: string): boolean {
  // The QuoteThreadHeader.jumpToQuote pattern verbatim, keyed on the segment
  // attribute the highlight plugin emits. ~= because overlapping parts share
  // pre-split segments carrying every id that applies.
  const targets = document.querySelectorAll<HTMLElement>(`[data-anchored-link-ids~="${anchorId}"]`);
  if (targets.length === 0) return false;
  targets[0].scrollIntoView({ behavior: "smooth", block: "center" });
  targets.forEach((el) => {
    el.classList.add("pulse");
    window.setTimeout(() => el.classList.remove("pulse"), 1200);
  });
  return true;
}

export default function AnchoredLinkBanner({ link, currentTarget, onJumpToPart, className }: Props) {
  const [dismissed, setDismissed] = useState(false);

  const currentGroup =
    link.groups.find((group) => group.target.kind === currentTarget.kind && group.target.id === currentTarget.id) ??
    null;
  const otherGroups = link.groups.filter((group) => group !== currentGroup);
  const firstAnchorId = currentGroup?.parts[0]?.anchorId ?? null;

  // On-load scroll-to-first, doc mode only (the PDF surface runs its own on
  // `ready`). The read-only editor mounts after hydration, so the first
  // queries can legitimately find nothing — retry briefly, then jump once.
  useEffect(() => {
    if (onJumpToPart || !firstAnchorId) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (jumpViaDom(firstAnchorId) || tries >= 10) {
        window.clearInterval(timer);
      }
    }, 300);
    return () => window.clearInterval(timer);
    // Keyed on the link identity: a client-side nav to a different ?sel=
    // remounts the effect for the new first part.
  }, [onJumpToPart, firstAnchorId]);

  if (dismissed || link.groups.length === 0) return null;

  return (
    <aside className={`${styles.banner} ${className ?? ""}`} data-testid="anchored-link-banner">
      <div className={styles.headerRow}>
        <span className={styles.title}>Linked passages</span>
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => setDismissed(true)}
          aria-label="Dismiss linked passages"
        >
          ✕
        </button>
      </div>
      {currentGroup && currentGroup.parts.length > 0 && (
        <ul className={styles.partList}>
          {currentGroup.parts.map((part) => (
            <li key={part.anchorId}>
              <button
                type="button"
                className={styles.partButton}
                onClick={() => (onJumpToPart ? onJumpToPart(part) : void jumpViaDom(part.anchorId))}
                title="Jump to this passage"
              >
                <span className={styles.partQuote}>{part.quotedText}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {otherGroups.length > 0 && (
        <p className={styles.alsoReferenced}>
          Also referenced:{" "}
          {otherGroups.map((group, index) => (
            <span key={`${group.target.kind}:${group.target.id}`}>
              {index > 0 && ", "}
              <Link href={group.href}>{group.label}</Link>
            </span>
          ))}
        </p>
      )}
    </aside>
  );
}
