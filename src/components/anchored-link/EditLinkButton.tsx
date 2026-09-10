"use client";

import { useId, useState, useTransition } from "react";
import { openAnchoredLinkForEditing } from "@/app/actions/anchored-links";
import { editAffordance } from "@/lib/anchored-link-editing";
import { notifyAnchoredLinkChanged } from "@/lib/anchored-link-tray-events";
import { useOpenLink } from "./open-link-store";
import styles from "./EditLinkButton.module.css";

// docs/ANCHORED_LINKS.md, "Editing a minted link" — the one Edit affordance,
// mounted wherever a creator meets their own minted link: the banner on a
// ?sel= page, the landing route's excerpt page, and a /links row. It
// renders what the open-link store says (anchored-link-editing.ts decides
// the four states), so it needs no prop but the link's id — and, since the
// caller has already established that this viewer is the creator, it adds
// no second check of its own (TagChips' stance; the action refuses anyway).
//
// Disabled means disabled *with the reason as visible text*, never a
// tooltip alone: a disabled button takes no hover or focus, and a title
// never shows on a phone. The reason is the same string the server refuses
// with, so the two cannot drift.

type Props = {
  linkId: string;
  /** After a successful open — a /links row navigates to the landing page, where the tray is. */
  onOpened?: () => void;
  className?: string;
};

export default function EditLinkButton({ linkId, onOpened, className }: Props) {
  const open = useOpenLink();
  const affordance = editAffordance(
    open === undefined
      ? undefined
      : open === null
        ? null
        : { id: open.id, minted: open.minted, partCount: open.parts.length },
    linkId,
  );
  const hintId = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  if (affordance.state === "unknown") return null;
  if (affordance.state === "open-here") {
    return (
      <span className={`${styles.status} ${className ?? ""}`} data-testid="edit-link-open-here">
        Open in your tray
      </span>
    );
  }
  const blocked = affordance.state === "blocked";

  function handleClick() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await openAnchoredLinkForEditing(linkId);
        if (result.error) {
          setError(result.error);
          return;
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't open this link for editing.");
        return;
      }
      // The store re-reads and the tray appears; the surfaces re-paint the
      // link's passages dashed, the in-progress look.
      notifyAnchoredLinkChanged();
      onOpened?.();
    });
  }

  return (
    <span className={`${styles.wrap} ${className ?? ""}`} data-testid="edit-link">
      <button
        type="button"
        className={styles.button}
        disabled={blocked || busy}
        aria-describedby={blocked ? hintId : undefined}
        onClick={handleClick}
      >
        Edit link
      </button>
      {blocked && (
        <span id={hintId} className={styles.hint}>
          {affordance.reason}
        </span>
      )}
      {error && <span className={styles.error}>{error}</span>}
    </span>
  );
}
