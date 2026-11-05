"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { useEditorState, type Editor } from "@tiptap/react";
import { NodeSelection, type EditorState } from "@tiptap/pm/state";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { IconX } from "@tabler/icons-react";
import { searchCitable, type CiteCandidate } from "@/app/actions/references";
import { useChipSurface, useSeedChipContext } from "@/lib/entity-chips/chip-surface";
import { CITATION, citationKind, type CitationData, type CitationItem, type CitedWork } from "@/lib/entity-chips/kinds/citation";
import { chipRenderingIn, entityChipKey } from "@/lib/entity-chips/node";
import { ENTITY_CHIP } from "@/lib/entity-chips/types";
import { popoverBoundsElement } from "@/lib/popover-placement";
import { splitLocator } from "./CiteMenu";
import styles from "./CitePopover.module.css";

// docs/CITATIONS.md, "The popover" — what a citation says beyond which works:
// each work's page, the words before and after it, whether its author is
// left out, whether the citation is narrative, and further works. Opened by
// selecting a citation in an editor that can be typed in (a click, or the
// arrow keys onto it), and Enter moves into it.
//
// Every edit is one attribute set on the chip's `data` (AttrStep), validated
// as every other way in validates it, so the chip keeps its instance id and
// its place, and the anchors on it ask the kind whether the new fields
// continue the old ones. A text field writes when it is left or Enter is
// pressed, rather than on each keystroke: validation trims, and would eat
// the space being typed.
//
// Open while the editor has focus and its selection is the chip, and after
// that while focus is in the popover: `pinned` is the chip a press inside it
// kept open as the editor's blur lands.

const POPOVER_GAP = 4;
const SEARCH_DEBOUNCE_MS = 200;

/** The citation the editor's selection is, by instance id. */
function selectedCitation(state: EditorState): string | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return null;
  const { node } = selection;
  return node.type.name === ENTITY_CHIP && node.attrs.kind === CITATION && typeof node.attrs.iid === "string" ? node.attrs.iid : null;
}

/** The citation with this instance id, where it is and what it holds; null once it is gone or refused. */
function findCitation(state: EditorState, iid: string): { pos: number; data: CitationData } | null {
  let found: { pos: number; data: CitationData } | null = null;
  state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === ENTITY_CHIP && node.attrs.iid === iid && node.attrs.kind === CITATION) {
      const data = citationKind.validate(node.attrs.data);
      if (data) found = { pos, data };
    }
    return !found;
  });
  return found;
}

type Open = {
  iid: string;
  pos: number;
  data: CitationData;
  label: string;
  works: (CitedWork | undefined)[];
};

/** A text field that writes when it is left or Enter is pressed, and Escape puts back. */
function FieldInput({ label, value, onCommit, inputRef }: { label: string; value: string; onCommit: (value: string) => void; inputRef?: Ref<HTMLInputElement> }) {
  const [draft, setDraft] = useState(value);
  // A new value from the document (a collaborator, or this field's own write normalized) replaces the draft.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  const id = useId();
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <label className={styles.field} htmlFor={id}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        id={id}
        ref={inputRef}
        className={styles.input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape" && draft !== value) {
            // The first Escape puts the field back; the next closes the popover.
            e.stopPropagation();
            setDraft(value);
          }
        }}
      />
    </label>
  );
}

/** "Add a work": the library searched as the `[@` menu searches it, a page included ("radner 49"). */
function AddWork({ exclude, onPick }: { exclude: readonly string[]; onPick: (candidate: CiteCandidate, locator: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; candidates: CiteCandidate[] }>({ query: "", candidates: [] });
  const id = useId();
  useEffect(() => {
    const { words } = splitLocator(query);
    if (!words) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchCitable(words)
        .catch(() => [])
        .then((candidates) => {
          if (!cancelled) setResults({ query, candidates });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);
  const shown = splitLocator(query).words && results.query === query ? results.candidates.filter((c) => !exclude.includes(c.work.id)) : [];
  return (
    <div className={styles.add}>
      <label className={styles.field} htmlFor={id}>
        <span className={styles.fieldLabel}>Add a work</span>
        <input id={id} className={styles.input} value={query} placeholder="Author, title or key, and a page" onChange={(e) => setQuery(e.target.value)} />
      </label>
      {shown.length > 0 && (
        <ul className={styles.results} aria-label="Works to add">
          {shown.map((candidate) => (
            <li key={candidate.work.id}>
              <button
                type="button"
                className={styles.result}
                onClick={() => {
                  onPick(candidate, splitLocator(query).locator);
                  setQuery("");
                }}
              >
                {candidate.entry}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function CitePopover({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const surface = useChipSurface();
  const seed = useSeedChipContext();
  const [pinned, setPinned] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const open = useEditorState({
    editor,
    selector: ({ editor: e }): Open | null => {
      if (disabled || !e.isEditable) return null;
      const iid = e.isFocused ? selectedCitation(e.state) : pinned;
      const found = iid ? findCitation(e.state, iid) : null;
      if (!iid || !found) return null;
      const works = (entityChipKey.getState(e.state)?.inputs.context[CITATION] ?? {}) as Record<string, CitedWork>;
      return { iid, pos: found.pos, data: found.data, label: chipRenderingIn(e.state, iid)?.label ?? "", works: found.data.items.map((item) => works[item.refId]) };
    },
  });

  // Enter on a selected citation moves into the popover, rather than replacing the chip with a line break.
  useEffect(() => {
    if (disabled) return;
    const dom = editor.view.dom;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const iid = selectedCitation(editor.state);
      if (!iid) return;
      // The popover is already drawn, the chip being selected in a focused editor.
      event.preventDefault();
      event.stopPropagation();
      setPinned(iid);
      firstFieldRef.current?.focus();
    };
    dom.addEventListener("keydown", onKeyDown, true);
    return () => dom.removeEventListener("keydown", onKeyDown, true);
  }, [editor, disabled]);

  // A press anywhere outside the popover ends its hold: in the editor the selection decides again, and anywhere else closes it.
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) setPinned(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [pinned]);

  const openIid = open?.iid ?? null;
  const openPos = open?.pos ?? null;
  useLayoutEffect(() => {
    if (openIid === null || openPos === null) return;
    const popover = popoverRef.current;
    const chip = editor.view.nodeDOM(openPos);
    if (!popover || !(chip instanceof HTMLElement)) return;
    const boundary = popoverBoundsElement(editor.view.dom);
    const update = () => {
      if (!chip.isConnected) {
        popover.style.visibility = "hidden";
        return;
      }
      void computePosition(chip, popover, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [offset(POPOVER_GAP), flip({ crossAxis: false, boundary, fallbackStrategy: "initialPlacement" }), shift({ crossAxis: true, boundary })],
      }).then(({ x, y }) => {
        Object.assign(popover.style, { left: `${x}px`, top: `${y}px`, visibility: "" });
      });
    };
    return autoUpdate(chip, popover, update);
  }, [editor, openIid, openPos]);

  if (!open || !surface) return null;

  /** Writes the citation's fields, as its kind stores them; a value the kind refuses changes nothing. */
  const write = (next: CitationData) => {
    const data = citationKind.validate(next);
    const at = findCitation(editor.state, open.iid);
    if (!data || !at) return;
    editor.view.dispatch(editor.state.tr.setNodeAttribute(at.pos, "data", data));
  };
  const writeItem = (index: number, change: Partial<CitationItem>) => {
    const items = open.data.items.map((item, i) => {
      if (i !== index) return item;
      const merged: CitationItem = { ...item, ...change };
      // An emptied field is no field, as validation stores it.
      for (const key of ["locator", "prefix", "suffix"] as const) if (!merged[key]?.trim()) delete merged[key];
      if (!merged.suppressAuthor) delete merged.suppressAuthor;
      return merged;
    });
    write({ ...open.data, items });
  };
  // A control that is about to go (a removed work's button, a picked result) hands focus to the
  // popover first, or it falls to <body> and Escape no longer reaches the popover.
  const keepFocus = () => popoverRef.current?.focus();
  /** Back to the editor, with the citation still selected. */
  const close = () => {
    setPinned(null);
    const at = findCitation(editor.state, open.iid);
    if (at) editor.chain().focus().setNodeSelection(at.pos).run();
    else editor.commands.focus();
  };

  const narrative = open.data.form === "narrative";
  // Pandoc's narrative form holds one work, with its author shown and nothing before it (docs/CITATIONS.md, "The chip").
  const narrativeAllowed = open.data.items.length === 1 && !open.data.items[0].prefix && !open.data.items[0].suppressAuthor;

  return createPortal(
    <div
      ref={popoverRef}
      className={styles.popover}
      role="dialog"
      aria-label={`Citation ${open.label}`}
      tabIndex={-1}
      data-cite-popover={open.iid}
      // Before the editor's blur is drawn, so the popover is still here to take the focus: a press
      // lands first, and a focus moved by script or by a key follows the blur in the same task.
      onPointerDownCapture={() => setPinned(open.iid)}
      onFocusCapture={() => setPinned(open.iid)}
      onBlur={(e) => {
        if (!popoverRef.current?.contains(e.relatedTarget as Node | null)) setPinned(null);
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
    >
      <div className={styles.header}>
        <span className={styles.label}>{open.label}</span>
        <button type="button" className={styles.done} onClick={close}>
          Done
        </button>
      </div>
      <fieldset className={styles.form}>
        <legend className={styles.fieldLabel}>Shown</legend>
        <label>
          <input type="radio" name={`form-${open.iid}`} checked={!narrative} onChange={() => write({ items: open.data.items })} /> In parentheses
        </label>
        <label title={narrativeAllowed ? undefined : "A citation in the sentence names one work, with its author and nothing before it."}>
          <input
            type="radio"
            name={`form-${open.iid}`}
            checked={narrative}
            disabled={!narrativeAllowed}
            onChange={() => write({ items: open.data.items, form: "narrative" })}
          />{" "}
          In the sentence
        </label>
      </fieldset>
      {open.data.items.map((item, index) => {
        const work = open.works[index];
        const name = work ? work.short?.trim() || `${work.names || work.title} ${work.year ?? "n.d."}` : "unknown work";
        return (
          <fieldset key={item.refId} className={styles.work} aria-label={work ? work.key : item.refId}>
            <div className={styles.workHeader}>
              <span className={styles.workName} title={work?.title}>
                {name}
                {work && <span className={styles.workKey}> @{work.key}</span>}
              </span>
              {open.data.items.length > 1 && (
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove ${work?.key ?? "this work"}`}
                  title="Remove this work"
                  onClick={() => {
                    keepFocus();
                    write({ items: open.data.items.filter((_, i) => i !== index) });
                  }}
                >
                  <IconX size={14} />
                </button>
              )}
            </div>
            <div className={styles.fields}>
              <FieldInput label="Before" value={item.prefix ?? ""} onCommit={(value) => writeItem(index, { prefix: value })} />
              <FieldInput
                label="Page"
                value={item.locator ?? ""}
                onCommit={(value) => writeItem(index, { locator: value })}
                inputRef={index === 0 ? firstFieldRef : undefined}
              />
              <FieldInput label="After" value={item.suffix ?? ""} onCommit={(value) => writeItem(index, { suffix: value })} />
            </div>
            {!narrative && (
              <label className={styles.check}>
                <input type="checkbox" checked={item.suppressAuthor === true} onChange={(e) => writeItem(index, { suppressAuthor: e.target.checked })} /> Leave out
                the author
              </label>
            )}
          </fieldset>
        );
      })}
      {!narrative && (
        <AddWork
          exclude={open.data.items.map((item) => item.refId)}
          onPick={(candidate, locator) => {
            keepFocus();
            seed(CITATION, candidate.work.id, candidate.work);
            write({ items: [...open.data.items, { refId: candidate.work.id, ...(locator ? { locator } : {}) }] });
          }}
        />
      )}
    </div>,
    document.body,
  );
}
