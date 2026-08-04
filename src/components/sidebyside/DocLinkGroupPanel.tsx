"use client";

import { useEffect, useRef, useState } from "react";
import { createDocLinkGroup, updateDocLinkGroup, deleteDocLinkGroup } from "@/app/actions/doc-links";
import styles from "./DocLinkGroupPanel.module.css";

const DEBOUNCE_MS = 600;

export type SavedGroupFields = { name: string | null; text: string | null; overrideColor: string | null };

type Props = {
  // null = an unsaved "New Group" draft — the first debounced
  // save creates the row (§14i: not created eagerly, since the dropdown
  // that spawned it only lists groups with a link to either doc, and an
  // eagerly-created empty group would be invisible in that same list).
  groupId: string | null;
  initialName: string | null;
  initialText: string | null;
  initialOverrideColor: string | null;
  // The viewer's own author color, used as the swatch's default when this
  // group has no override yet — never as a *persisted* value, only as what
  // the picker opens on. It must be a chromatic color: the previous default,
  // "#999999", is achromatic (R=G=B, HSV saturation exactly 0), and the hue
  // slider in the native color picker cannot change an achromatic value —
  // gray is gray at every hue. So dragging the rainbow slider on a fresh
  // group produced no new value, hence no `input`/`change` event, hence no
  // React onChange, hence overrideChecked stayed false and the debounced
  // save wrote override_color: null. Every AUTHOR_COLOR_PALETTE entry has
  // saturation > 0.47, which is why DocLinkPopover — defaulting to this same
  // userColor — never had the bug. See PLAN.md §14e.
  userColor: string;
  // Display? — only meaningful once the group exists (a draft has no
  // links yet to show or hide).
  visible: boolean;
  onToggleVisible: (visible: boolean) => void;
  onCreated: (groupId: string, fields: SavedGroupFields) => void;
  onUpdated: (fields: Partial<SavedGroupFields>) => void;
  onDeleted: () => void;
  // Fired on every checkbox/swatch change, ahead of the debounced save —
  // lets both columns repaint the group's links in the color being picked
  // without waiting on the round trip.
  onColorPreview: (overrideColor: string | null) => void;
};

// PLAN.md §14h — the collapsible panel a dropdown selection opens: editable
// name/text/override_color, Display?, delete, debounced save. One
// DEBOUNCE_MS constant, flushed on blur and unmount — without the flush,
// navigating away (or picking a different group) loses the last edit, the
// same class of race postAnnotation's bounded retry loop exists for.
export default function DocLinkGroupPanel({
  groupId,
  initialName,
  initialText,
  initialOverrideColor,
  userColor,
  visible,
  onToggleVisible,
  onCreated,
  onUpdated,
  onDeleted,
  onColorPreview,
}: Props) {
  const [name, setName] = useState(initialName ?? "");
  const [text, setText] = useState(initialText ?? "");
  // Split from whether the override is *active*: unchecking the box clears
  // the persisted override but leaves the swatch showing whatever color was
  // last picked, so re-checking it doesn't lose that choice.
  const [overrideChecked, setOverrideChecked] = useState(Boolean(initialOverrideColor));
  const [colorValue, setColorValue] = useState(initialOverrideColor || userColor);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupIdRef = useRef(groupId);
  useEffect(() => {
    groupIdRef.current = groupId;
  }, [groupId]);

  // Mirrors of the three fields' state, updated synchronously in each
  // onChange handler below rather than read from `name`/`text`/
  // `overrideColor` directly — those are `const`s closed over by whichever
  // render's `flush` a given setTimeout callback captured, which is
  // whatever they were *before* the very keystroke that just scheduled
  // this save. Reading through a ref instead means flush() always sees
  // the latest typed value regardless of which render's closure is
  // actually invoked.
  const fieldsRef = useRef({
    name: initialName ?? "",
    text: initialText ?? "",
    overrideChecked: Boolean(initialOverrideColor),
    colorValue: initialOverrideColor || userColor,
  });

  async function flush() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const current = fieldsRef.current;
    const fields: SavedGroupFields = {
      name: current.name.trim() || null,
      text: current.text.trim() || null,
      overrideColor: current.overrideChecked ? current.colorValue : null,
    };
    setStatus("saving");
    if (!groupIdRef.current) {
      const result = await createDocLinkGroup({ name: fields.name ?? undefined, text: fields.text ?? undefined, overrideColor: fields.overrideColor ?? undefined });
      if ("error" in result) {
        setStatus("error");
        setError(result.error);
        return;
      }
      groupIdRef.current = result.id;
      setStatus("saved");
      onCreated(result.id, fields);
      return;
    }
    const result = await updateDocLinkGroup(groupIdRef.current, fields);
    if (result.error) {
      setStatus("error");
      setError(result.error);
      return;
    }
    setStatus("saved");
    onUpdated(fields);
  }

  function scheduleSave() {
    setError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void flush();
    }, DEBOUNCE_MS);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        // Best-effort flush on unmount — fire and forget, since there's no
        // component left to report the result to.
        void flush();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only runs its cleanup on unmount
  }, []);

  async function handleDelete() {
    if (!groupIdRef.current) {
      onDeleted();
      return;
    }
    await deleteDocLinkGroup(groupIdRef.current);
    onDeleted();
  }

  return (
    <div className={styles.panel} data-testid="doc-link-group-panel">
      <div className={styles.row}>
        <input
          className={styles.nameInput}
          placeholder="Group name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            fieldsRef.current = { ...fieldsRef.current, name: e.target.value };
            scheduleSave();
          }}
          onBlur={() => void flush()}
        />
        <input
          type="checkbox"
          aria-label="Override color"
          title="Override color"
          checked={overrideChecked}
          onChange={(e) => {
            const checked = e.target.checked;
            setOverrideChecked(checked);
            fieldsRef.current = { ...fieldsRef.current, overrideChecked: checked };
            onColorPreview(checked ? colorValue : null);
            scheduleSave();
          }}
        />
        <input
          type="color"
          className={overrideChecked ? undefined : styles.colorInputInactive}
          value={colorValue}
          onChange={(e) => {
            setColorValue(e.target.value);
            setOverrideChecked(true);
            fieldsRef.current = { ...fieldsRef.current, colorValue: e.target.value, overrideChecked: true };
            onColorPreview(e.target.value);
            scheduleSave();
          }}
          onBlur={() => void flush()}
          title="Override color"
        />
      </div>
      <textarea
        className={styles.textInput}
        placeholder="Optional description"
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          fieldsRef.current = { ...fieldsRef.current, text: e.target.value };
          scheduleSave();
        }}
        onBlur={() => void flush()}
      />
      <div className={styles.footer}>
        <label>
          <input type="checkbox" checked={visible} disabled={!groupId} onChange={(e) => onToggleVisible(e.target.checked)} /> Display?
        </label>
        <span>{status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? "Error" : ""}</span>
        {/* Only for an unsaved draft (§14i) — name/text/override_color are
            all nullable columns, so a group with none of them set is a
            legitimate row, not an error state. Once a group exists, every
            field already auto-saves on its own onChange; there's nothing
            left for an explicit Save to do. */}
        {!groupId && (
          <button type="button" onClick={() => void flush()} disabled={status === "saving"}>
            Save
          </button>
        )}
        <button type="button" className={styles.deleteButton} onClick={handleDelete} disabled={!groupId}>
          Delete
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
