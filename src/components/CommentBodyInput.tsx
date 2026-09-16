"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { JSONContent } from "@tiptap/core";
import { convertCommentBody } from "@/app/actions/comments";
import {
  commentBodyValueToInput,
  emptyCommentBodyValue,
  isCommentBodyValueEmpty,
  rememberCommentBodyMode,
  type CommentBodyMode,
  type CommentBodyValue,
} from "@/lib/comment-body-value";
import CommentEditor from "./CommentEditor";
import styles from "./CommentBodyInput.module.css";

type Props = {
  value: CommentBodyValue;
  onChange: (value: CommentBodyValue) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  autoFocus?: boolean;
  /** The markdown textarea's `required`, for the form's own HTML validation. */
  required?: boolean;
};

// PLAN.md §23m — the two front doors, behind one control. Markdown is the
// textarea the form always had; rich is CommentEditor. The value is owned by
// the parent (a form, or CommentNode's inline edit), which is what lets a
// draft be restored into either.
//
// **Switching modes with content in the box goes through the server**
// (`convertCommentBody`), in both directions. The browser never runs the
// Markdown parser: parsed there, an HTML token becomes a real node — the
// opposite of the server's literal-text reading of the same characters — so
// a client-side preview or conversion would show a commenter something the
// server then refuses to store. An empty box switches instantly.
export default function CommentBodyInput({
  value,
  onChange,
  ariaLabel,
  placeholder,
  disabled = false,
  rows = 3,
  autoFocus = false,
  required = false,
}: Props) {
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switching, startSwitch] = useTransition();

  // The rich editor is mounted once per *external* content change and keyed
  // to remount on the next: a restored draft, a mode switch. Its own
  // keystrokes come back through onChange and must not remount it, so the
  // last JSON it emitted is remembered and a value that is not that object
  // is, by elimination, external.
  const lastEmitted = useRef<JSONContent | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const richJson = value.mode === "rich" ? value.json : null;
  useEffect(() => {
    if (value.mode !== "rich") return;
    if (richJson !== lastEmitted.current) {
      lastEmitted.current = richJson;
      setEditorKey((k) => k + 1);
    }
  }, [value.mode, richJson]);

  function switchTo(mode: CommentBodyMode) {
    if (mode === value.mode || disabled || switching) return;
    setSwitchError(null);
    rememberCommentBodyMode(mode);
    if (isCommentBodyValueEmpty(value)) {
      onChange(emptyCommentBodyValue(mode));
      return;
    }
    startSwitch(async () => {
      const result = await convertCommentBody(commentBodyValueToInput(value), mode);
      if ("error" in result) {
        setSwitchError(result.error);
        return;
      }
      onChange("markdown" in result ? { mode: "markdown", markdown: result.markdown } : { mode: "rich", json: result.json });
    });
  }

  return (
    <div className={styles.wrap}>
      {value.mode === "markdown" ? (
        <textarea
          value={value.markdown}
          onChange={(e) => onChange({ mode: "markdown", markdown: e.target.value })}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={disabled || switching}
          rows={rows}
          required={required}
          autoFocus={autoFocus}
          className={styles.textarea}
        />
      ) : (
        <CommentEditor
          key={editorKey}
          initialContent={value.json}
          onChange={(json) => {
            lastEmitted.current = json;
            onChange({ mode: "rich", json });
          }}
          ariaLabel={ariaLabel}
          disabled={disabled || switching}
          autoFocus={autoFocus}
        />
      )}
      <div className={styles.modeRow} role="group" aria-label="Comment format">
        <button
          type="button"
          onClick={() => switchTo("markdown")}
          aria-pressed={value.mode === "markdown"}
          disabled={disabled || switching}
          className={styles.modeButton}
        >
          Markdown
        </button>
        <button
          type="button"
          onClick={() => switchTo("rich")}
          aria-pressed={value.mode === "rich"}
          disabled={disabled || switching}
          className={styles.modeButton}
        >
          Rich text
        </button>
        {switching && <span className={styles.modeNote}>Converting…</span>}
        {switchError && <span className={styles.modeError}>{switchError}</span>}
      </div>
    </div>
  );
}
