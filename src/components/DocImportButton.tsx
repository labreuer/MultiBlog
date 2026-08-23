"use client";

import { useActionState, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { importMarkdownDocAction, type ImportMarkdownState } from "@/app/actions/docs";

const initialState: ImportMarkdownState = {};

// Whether the browser exposes a clipboard read at all. The subscribe function
// never fires — the answer can't change for the life of the page.
const subscribeNever = () => () => {};
const hasClipboardRead = () => typeof navigator.clipboard?.readText === "function";
const noClipboardRead = () => false;

// The client half of /docs' Markdown import, beside "+ New doc": a file picker
// and a paste box, sharing one <form> and one server action.
//
// The paste box is a TEXTAREA, and navigator.clipboard.readText() is only a
// feature-detected shortcut on top of it — it can't be the mechanism, for four
// reasons set out in docs/DOC_IMPORT.md §7. Read that before reaching for the
// Clipboard API here.
//
// `className` is /docs' own `.newDocButton` (page.module.css), passed down
// rather than restated: these read as sitewide links next to "+ New doc", and a
// copy of those rules in a second module is a copy that drifts.
export default function DocImportButton({ className }: { className?: string }) {
  const [state, formAction, pending] = useActionState(importMarkdownDocAction, initialState);
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [pasteOpen, setPasteOpen] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // useSyncExternalStore, not a mount effect: `navigator` doesn't exist while a
  // client component renders on the SERVER, and its separate server snapshot is
  // exactly the "false there, real value in the browser" shape that needs — with
  // no set-state-in-effect for react-hooks to reject (docs/DOC_IMPORT.md §7).
  const canReadClipboard = useSyncExternalStore(subscribeNever, hasClipboardRead, noClipboardRead);

  useEffect(() => {
    if (pasteOpen) {
      textareaRef.current?.focus();
    }
  }, [pasteOpen]);

  async function readClipboard() {
    setNotice(null);
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setMarkdown(text);
        return;
      }
      setNotice("The clipboard is empty — paste into the box instead.");
    } catch {
      // Every failure arrives as this one rejection with nothing to tell them
      // apart by, and they share a remedy — so offer it rather than guessing.
      setNotice("Couldn't read the clipboard — paste into the box instead.");
    }
    textareaRef.current?.focus();
  }

  function closePastePanel() {
    setPasteOpen(false);
    setMarkdown("");
    setNotice(null);
  }

  return (
    <form action={formAction} ref={formRef}>
      {/* flex-end as well as /docs' own space-between, or these buttons jump
          leftward when the panel opens — docs/DOC_IMPORT.md §9. */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "1.5em" }}>
        <input
          ref={fileRef}
          type="file"
          name="file"
          accept=".md,.markdown,.mdown,.mkd,.txt,text/markdown"
          hidden
          // requestSubmit(), never submit() — the latter bypasses the submit
          // event, so React never sees it and the action never runs.
          onChange={(event) => {
            if (event.target.files?.length) {
              formRef.current?.requestSubmit();
            }
          }}
        />
        <button
          type="button"
          className={className}
          disabled={pending}
          // type="button" so this doesn't submit the still-fileless form. The
          // value is cleared HERE, not after a submit: `change` only fires on a
          // value that differs, so re-picking the same file after a rejected
          // import would otherwise do nothing (docs/DOC_IMPORT.md §8).
          onClick={() => {
            if (fileRef.current) {
              fileRef.current.value = "";
              fileRef.current.click();
            }
          }}
        >
          {pending ? "Importing…" : "↧ Import Markdown"}
        </button>
        <button
          type="button"
          className={className}
          disabled={pending}
          aria-expanded={pasteOpen}
          onClick={() => (pasteOpen ? closePastePanel() : setPasteOpen(true))}
        >
          ⎗ Paste Markdown
        </button>
      </div>

      {/* Rendered only while open, so the textarea doesn't exist — and so
          isn't submitted — the rest of the time (docs/DOC_IMPORT.md §8). */}
      {pasteOpen && (
        <div
          style={{
            marginTop: "0.75em",
            display: "flex",
            flexDirection: "column",
            gap: "0.5em",
            // 70vw, NOT a percentage: the containing block is the form, whose
            // own width is decided by its contents, so a percentage collapses
            // this box to the width of the buttons above it — docs/DOC_IMPORT.md §9.
            width: "min(40em, 70vw)",
          }}
        >
          <textarea
            ref={textareaRef}
            name="markdown"
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            rows={10}
            aria-label="Markdown to import"
            placeholder="Paste Markdown here…"
            style={{
              font: "inherit",
              fontFamily: "monospace",
              padding: "0.5em",
              color: "var(--foreground)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "1em", alignItems: "center" }}>
            <button type="submit" disabled={pending || !markdown.trim()}>
              {pending ? "Importing…" : "Create doc"}
            </button>
            {canReadClipboard && (
              <button type="button" className={className} disabled={pending} onClick={readClipboard}>
                Read clipboard
              </button>
            )}
            <button type="button" className={className} disabled={pending} onClick={closePastePanel}>
              Cancel
            </button>
          </div>
          {notice && <p style={{ color: "var(--text-secondary)", margin: 0, textAlign: "right" }}>{notice}</p>}
        </div>
      )}

      {state.error && (
        <p style={{ color: "var(--error)", margin: "0.5em 0 0", textAlign: "right" }}>{state.error}</p>
      )}
    </form>
  );
}
