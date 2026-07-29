"use client";

import { useState, useTransition } from "react";
import { createDocLink } from "@/app/actions/doc-links";
import type { DocLinkMark, DocLinkInput } from "@/lib/doc-link-anchor";
import styles from "./DocLinkPopover.module.css";

type Props = {
  docId: string;
  top: number;
  left: number;
  mark: DocLinkMark;
  userColor: string;
  // §14h/Phase 6 — the group currently selected in the dropdown, if any.
  // DocColumn doesn't have that concept yet (Phase 5 only), so this is
  // always null for now and every save creates a brand-new group.
  activeGroupId: string | null;
  onCreated: (link: DocLinkInput) => void;
  onCancel: () => void;
};

// PLAN.md §14i — selecting text in a read-mode column opens this. Offset
// 0.5em right/down from the selection's own end coordinates (the module's
// .popover transform), carrying optional text and an override color. Save
// creates the group (if none is selected) and the link in one transaction;
// Cancel always shows, since this component only ever handles the "new
// link" case — editing an existing one is the click-routing work in §14j
// (Phase 7), not this popover's concern yet.
export default function DocLinkPopover({ docId, top, left, mark, userColor, activeGroupId, onCreated, onCancel }: Props) {
  const [text, setText] = useState("");
  const [overrideColor, setOverrideColor] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await createDocLink({
        docId,
        mark,
        groupId: activeGroupId ?? undefined,
        text: text.trim() || undefined,
        overrideColor: overrideColor || undefined,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onCreated({
        id: result.id,
        mark,
        groupId: result.groupId,
        color: overrideColor || userColor,
        mine: true,
      });
    });
  }

  const quoted = mark.text.length > 80 ? `${mark.text.slice(0, 80)}…` : mark.text;

  return (
    <div data-testid="doc-link-popup" className={styles.popover} style={{ top, left }}>
      <p className={styles.quotedText}>Linking: “{quoted}”</p>
      <p className={styles.groupNote}>
        {activeGroupId ? "Added to the selected group." : "A new doc link group will be created."}
      </p>
      <textarea
        className={styles.textInput}
        placeholder="Optional note"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={pending}
      />
      <label className={styles.colorRow}>
        Color override
        <input
          type="color"
          value={overrideColor || userColor}
          onChange={(e) => setOverrideColor(e.target.value)}
          disabled={pending}
        />
        {overrideColor && (
          <button type="button" onClick={() => setOverrideColor("")} disabled={pending}>
            Clear
          </button>
        )}
      </label>
      <div className={styles.buttonRow}>
        <button type="button" onClick={handleSave} disabled={pending} className={styles.submit}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
