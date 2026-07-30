"use client";

import { useState, useTransition } from "react";
import { createDocLink, updateDocLink, deleteDocLink } from "@/app/actions/doc-links";
import type { DocLinkMark, DocLinkInput } from "@/lib/doc-link-anchor";
import styles from "./DocLinkPopover.module.css";

type Props = {
  docId: string;
  top: number;
  left: number;
  mark: DocLinkMark;
  userColor: string;
  // §14h — the group currently selected in the dropdown, if any. Only
  // consulted in create mode (linkId absent); editing an existing link
  // never moves it to a different group.
  activeGroupId: string | null;
  // §14j — present means this popover is editing an existing link rather
  // than creating one: Save calls updateDocLink instead of createDocLink,
  // a Delete button appears, and the group note (which group a *new* link
  // would join) doesn't apply.
  linkId?: string;
  initialText?: string | null;
  initialOverrideColor?: string | null;
  onCreated?: (link: DocLinkInput) => void;
  onUpdated?: (patch: { text: string | null; overrideColor: string | null }) => void;
  onDeleted?: () => void;
  onCancel: () => void;
};

// PLAN.md §14i/§14j — selecting text in a read-mode column opens this in
// create mode; clicking existing linked text opens it in edit mode (§14j's
// single-hit case, or a chooser selection). Offset 0.5em right/down from
// the selection's own end coordinates (the module's .popover transform).
export default function DocLinkPopover({
  docId,
  top,
  left,
  mark,
  userColor,
  activeGroupId,
  linkId,
  initialText,
  initialOverrideColor,
  onCreated,
  onUpdated,
  onDeleted,
  onCancel,
}: Props) {
  const [text, setText] = useState(initialText ?? "");
  const [overrideColor, setOverrideColor] = useState(initialOverrideColor ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isEditing = Boolean(linkId);

  function handleSave() {
    setError(null);
    startTransition(async () => {
      if (linkId) {
        const result = await updateDocLink(linkId, {
          text: text.trim() || null,
          overrideColor: overrideColor || null,
        });
        if (result.error) {
          setError(result.error);
          return;
        }
        onUpdated?.({ text: text.trim() || null, overrideColor: overrideColor || null });
        return;
      }

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
      onCreated?.({
        id: result.id,
        mark,
        groupId: result.groupId,
        color: overrideColor || userColor,
        mine: true,
        text: text.trim() || null,
        overrideColor: overrideColor || null,
      });
    });
  }

  function handleDelete() {
    if (!linkId) return;
    setError(null);
    startTransition(async () => {
      await deleteDocLink(linkId);
      onDeleted?.();
    });
  }

  const quoted = mark.text.length > 80 ? `${mark.text.slice(0, 80)}…` : mark.text;

  return (
    <div data-testid="doc-link-popup" className={styles.popover} style={{ top, left }}>
      <p className={styles.quotedText}>{isEditing ? "Editing link over" : "Linking"}: “{quoted}”</p>
      {!isEditing && (
        <p className={styles.groupNote}>
          {activeGroupId ? "Added to the selected group." : "A new doc link group will be created."}
        </p>
      )}
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
        {isEditing && (
          <button type="button" onClick={handleDelete} disabled={pending}>
            Delete
          </button>
        )}
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
