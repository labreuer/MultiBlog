"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createDocLink, updateDocLink, deleteDocLink } from "@/app/actions/doc-links";
import type { DocLinkMark, DocLinkInput } from "@/lib/doc-link-anchor";
import styles from "./DocLinkPopover.module.css";

const DEBOUNCE_MS = 600;

type Props = {
  docId: string;
  // The caller positions this popover through it — floating-ui writes
  // left/top straight onto the element (useSelectionPopover), and only the
  // caller knows the anchor and the bounds to clamp into.
  elementRef?: React.Ref<HTMLDivElement>;
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
  // Fires on every successful save — the explicit Save button and the
  // debounced autosave alike — to keep the caller's app state in sync.
  // Never closes the popover itself: it fires from a background autosave
  // too, and a background save closing the popover out from under a
  // still-editing user would be worse than the bug this replaced.
  onUpdated?: (patch: { text: string | null; overrideColor: string | null }) => void;
  // Fires only after the explicit Save button succeeds in edit mode — the
  // caller's cue to close the popover, since onUpdated alone no longer does.
  onSaved?: () => void;
  onDeleted?: () => void;
  onCancel: () => void;
  // Fired on every checkbox/swatch change, ahead of Save/the debounced
  // autosave — lets the caller (SideBySideDocBody, editing mode only) paint
  // the doc's highlight in the color being picked without waiting for a
  // round trip.
  onColorPreview?: (overrideColor: string | null) => void;
};

// PLAN.md §14i/§14j — selecting text in a read-mode column opens this in
// create mode; clicking existing linked text opens it in edit mode (§14j's
// single-hit case, or a chooser selection). Offset 0.5em right/down from
// the selection's own end coordinates (the module's .popover transform).
export default function DocLinkPopover({
  docId,
  elementRef,
  mark,
  userColor,
  activeGroupId,
  linkId,
  initialText,
  initialOverrideColor,
  onCreated,
  onUpdated,
  onSaved,
  onDeleted,
  onCancel,
  onColorPreview,
}: Props) {
  const [text, setText] = useState(initialText ?? "");
  // Split from whether the override is *active*: unchecking the box clears
  // the persisted override but leaves the swatch showing whatever color was
  // last picked, so re-checking it doesn't lose that choice.
  const [overrideChecked, setOverrideChecked] = useState(Boolean(initialOverrideColor));
  const [colorValue, setColorValue] = useState(initialOverrideColor || userColor);
  const overrideColor = overrideChecked ? colorValue : "";
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const isEditing = Boolean(linkId);

  // Debounced autosave for an already-saved link, matching PLAN.md §14i's
  // "subsequent edits debounce-save, as specified" and DocLinkGroupPanel's
  // own pattern — without this, picking a color and clicking away (rather
  // than hitting Save) silently discarded the edit. Never runs in create
  // mode: there's no row yet to autosave into, and creation always goes
  // through the explicit Save button below (§14i: "the first Save creates
  // the row"). fieldsRef (not the state closures) is what flush() reads,
  // for the same reason DocLinkGroupPanel's does — a setTimeout callback
  // otherwise closes over whatever text/overrideChecked/colorValue were
  // *before* the keystroke that scheduled it.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fieldsRef = useRef({
    text: initialText ?? "",
    overrideChecked: Boolean(initialOverrideColor),
    colorValue: initialOverrideColor || userColor,
  });
  // Coalesces concurrent callers onto one in-flight request. Clicking Save
  // while a field still has focus fires a native blur first — which also
  // calls flush() via onBlur below — so the click and the blur can each
  // trigger their own flush() within the same tick. Without this, both fire
  // separate updateDocLink requests and only the click's own promise
  // resolving to true is what closes the popover (handleSave's `onSaved?.()`
  // below) — a race, not a guarantee. Sharing one promise means every caller
  // in that window observes the same, single, real result.
  const flushingRef = useRef<Promise<boolean> | null>(null);

  function flush(): Promise<boolean> {
    if (!isEditing || !linkId) return Promise.resolve(false);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (flushingRef.current) return flushingRef.current;
    const id = linkId;
    const current = fieldsRef.current;
    const patch = {
      text: current.text.trim() || null,
      overrideColor: current.overrideChecked ? current.colorValue : null,
    };
    setStatus("saving");
    const promise = (async () => {
      const result = await updateDocLink(id, patch);
      flushingRef.current = null;
      if (result.error) {
        setStatus("error");
        setError(result.error);
        return false;
      }
      setStatus("saved");
      onUpdated?.(patch);
      return true;
    })();
    flushingRef.current = promise;
    return promise;
  }

  function scheduleSave() {
    if (!isEditing) return;
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
        // component left to report the result to (matches
        // DocLinkGroupPanel's own unmount flush).
        void flush();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only runs its cleanup on unmount
  }, []);

  function handleSave() {
    setError(null);
    startTransition(async () => {
      if (linkId) {
        if (await flush()) onSaved?.();
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
    <div ref={elementRef} data-testid="doc-link-popup" className={styles.popover}>
      <p className={styles.quotedText}>{isEditing ? "Editing link over" : "Linking"}: “{quoted}”</p>
      {!isEditing && (
        <p className={styles.groupNote}>
          {activeGroupId ? "Added to the selected group." : "A new group will be created."}
        </p>
      )}
      <textarea
        className={styles.textInput}
        placeholder="Optional note"
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          fieldsRef.current = { ...fieldsRef.current, text: e.target.value };
          scheduleSave();
        }}
        onBlur={() => void flush()}
        disabled={pending}
      />
      <label className={styles.colorRow}>
        <input
          type="checkbox"
          aria-label="Override color"
          title="Override color"
          checked={overrideChecked}
          disabled={pending}
          onChange={(e) => {
            const checked = e.target.checked;
            setOverrideChecked(checked);
            fieldsRef.current = { ...fieldsRef.current, overrideChecked: checked };
            onColorPreview?.(checked ? colorValue : null);
            scheduleSave();
          }}
        />
        <input
          type="color"
          className={overrideChecked ? undefined : styles.colorInputInactive}
          title="Override color"
          value={colorValue}
          disabled={pending}
          onChange={(e) => {
            setColorValue(e.target.value);
            setOverrideChecked(true);
            fieldsRef.current = { ...fieldsRef.current, colorValue: e.target.value, overrideChecked: true };
            onColorPreview?.(e.target.value);
            scheduleSave();
          }}
          onBlur={() => void flush()}
        />
      </label>
      <div className={styles.buttonRow}>
        {/* Label reflects the background autosave's status too (not just
            this button's own pending click) — but only the label, and never
            `disabled`. A layout change here (an inserted/removed status
            element, or a `disabled` flip) landing between mousedown and
            mouseup of the same click gesture — which is exactly when the
            blur-triggered autosave fires, since blur precedes click —
            silently swallows that click: a disabled button never fires one,
            same as one whose position just moved out from under the pointer.
            Changing only the text inside an already-stable button avoids
            both. flush() already coalesces concurrent calls onto one shared
            promise, so `pending`-only disabling loses nothing. */}
        <button type="button" onClick={handleSave} disabled={pending} className={styles.submit}>
          {pending || status === "saving" ? "Saving…" : "Save"}
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
