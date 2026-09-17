"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { Editor } from "@tiptap/react";
import { convertCommentBody } from "@/app/actions/comments";
import { newPendingAnchorId, type PendingQuoteHint } from "@/lib/comment-quote-pending";
import { docsEqual } from "@/lib/diff";
import { useCommentQuote, type QuoteRequest } from "./comment-quote-context";
import {
  commentBodyValueToInput,
  emptyCommentBodyValue,
  isCommentBodyValueEmpty,
  rememberCommentBodyMode,
  type CommentBodyMode,
  type CommentBodyValue,
} from "@/lib/comment-body-value";
import CommentEditor from "./CommentEditor";
import CommentQuotePicker from "./CommentQuotePicker";
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
  /**
   * PLAN.md §23h — registers this composer with the page's quote context under
   * this key, so a "Quote" gesture elsewhere on the page can land here.
   * Absent: no registration, no gesture.
   */
  composerKey?: string;
};

/** The Markdown form of a quotation: every line prefixed, as a block of its own. */
function markdownQuote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line.trim()}` : ">"))
    .join("\n");
}

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
  composerKey,
}: Props) {
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switching, startSwitch] = useTransition();
  // PLAN.md §23h (Phase 4) — the off-page picker, a panel under this composer.
  const [pickerOpen, setPickerOpen] = useState(false);
  const quoteContext = useCommentQuote();
  const editorRef = useRef<Editor | null>(null);
  // A quote delivered to a rich composer whose editor has not been created
  // yet (useEditor creates it in an effect after mount — a reply form opened
  // *by* the gesture is exactly this case) waits here and is inserted when
  // the editor arrives.
  const queuedRequests = useRef<QuoteRequest[]>([]);

  // The latest value, for the gesture callback registered once below.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // PLAN.md §23h — the quote gesture landing here. Markdown: a `> ` block at
  // the end of the box and nothing else; the matcher re-finds it. Rich: an
  // anchored blockquote with a placeholder id, and the hint that says what the
  // placeholder points at rides in the value (and so in the draft).
  const insertQuote = useCallback((request: QuoteRequest) => {
    const current = valueRef.current;
    if (current.mode === "markdown") {
      const existing = current.markdown.replace(/\s+$/, "");
      // An *unbound* hint: the box has no ids to bind one to, but the
      // matcher must still be told which target to load when it is not on
      // the page (the picker's). For an on-page target it merely repeats a
      // candidate the capture already has.
      const hint: PendingQuoteHint = { id: null, target: request.target, text: request.text };
      onChangeRef.current({
        mode: "markdown",
        markdown: `${existing ? `${existing}\n\n` : ""}${markdownQuote(request.text)}\n\n`,
        pending: [...(current.pending ?? []), hint],
      });
      return;
    }
    const editor = editorRef.current;
    if (!editor) {
      queuedRequests.current.push(request);
      return;
    }
    const anchorId = newPendingAnchorId();
    const hint: PendingQuoteHint = { id: anchorId, target: request.target, text: request.text };
    if (request.from !== undefined && request.to !== undefined) {
      hint.from = request.from;
      hint.to = request.to;
    }
    const paragraphs = request.text
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));
    editor
      .chain()
      .focus("end")
      .insertContent([{ type: "blockquote", attrs: { anchorId }, content: paragraphs }, { type: "paragraph" }])
      .run();
    onChangeRef.current({ mode: "rich", json: editor.isEmpty ? null : editor.getJSON(), pending: [...(current.pending ?? []), hint] });
  }, []);

  const onEditorReady = useCallback(
    (editor: Editor | null) => {
      editorRef.current = editor;
      if (!editor) return;
      const waiting = queuedRequests.current.splice(0);
      for (const request of waiting) insertQuote(request);
    },
    [insertQuote],
  );

  useEffect(() => {
    if (!quoteContext || !composerKey) return;
    return quoteContext.register({ key: composerKey, insertQuote });
  }, [quoteContext, composerKey, insertQuote]);

  // The rich editor is mounted once per *external* content change and keyed
  // to remount on the next: a restored draft, a mode switch. Its own
  // keystrokes (and the quote gesture's insert) come back through onChange
  // and must not remount it — those leave the editor's document equal to the
  // value, so a value the live editor does not already hold is, by
  // elimination, external. docsEqual rather than identity, since a JSON
  // round-trip (the draft store) changes identity and nothing else.
  const [editorKey, setEditorKey] = useState(0);
  const richJson = value.mode === "rich" ? value.json : null;
  useEffect(() => {
    if (value.mode !== "rich") return;
    const editor = editorRef.current;
    if (!editor) return;
    const held = editor.isEmpty ? null : editor.getJSON();
    if (held === richJson) return;
    if (held !== null && richJson !== null && docsEqual(held, richJson)) return;
    setEditorKey((k) => k + 1);
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
    <div
      className={styles.wrap}
      onFocusCapture={() => {
        if (quoteContext && composerKey) quoteContext.markActive(composerKey);
      }}
    >
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
          onChange={(json) =>
            onChange({ mode: "rich", json, pending: valueRef.current.mode === "rich" ? valueRef.current.pending : undefined })
          }
          ariaLabel={ariaLabel}
          disabled={disabled || switching}
          autoFocus={autoFocus}
          onEditorReady={onEditorReady}
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
        {quoteContext && composerKey && !pickerOpen && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            disabled={disabled}
            className={`${styles.modeButton} ${styles.pickerButton}`}
          >
            Quote from elsewhere…
          </button>
        )}
      </div>
      {pickerOpen && quoteContext && (
        <CommentQuotePicker hostPostId={quoteContext.postId} onQuote={insertQuote} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}
