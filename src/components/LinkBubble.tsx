"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getMarkRange } from "@tiptap/core";
import { useEditorState, type Editor } from "@tiptap/react";
import { IconCheck, IconCopy, IconLinkOff, IconLock, IconPencil, IconWorld } from "@tabler/icons-react";
import { previewLinkedDoc } from "@/app/actions/docs";
import type { LinkedDocPreview } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { relativeTime } from "@/lib/relative-time";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { popoverBoundsElement, type PopoverAnchor } from "@/lib/popover-placement";
import styles from "./EditorChrome.module.css";

// The bubble under whichever link the caret is in — one line: the target
// site's favicon, the href, and copy / edit / remove. It is what gives a
// link its navigation back now that openOnClick is off (tiptap-schema.ts,
// EDITOR_LINK_OPTIONS): a click in a link places the caret like a click
// anywhere else, and the href here is a real <a> for when you do mean to
// follow it.
//
// Visibility is derived, never toggled: the caret is inside a link and the
// editor has focus. Both come out of the editor's own transactions —
// TipTap's FocusEvents extension dispatches one on focus and on blur — so
// one useEditorState selector answers for both and there is no listener
// bookkeeping to get wrong. The bubble prevents default on mousedown, so
// clicking anything in it never takes focus from the editor: a blur would
// hide the bubble before its click landed, and on a phone would also
// dismiss the keyboard.
//
// For a link into one of this site's own docs, a second block under the
// row: the doc's title, then its authors with the last edit right-aligned
// — what the reading route's byline shows. Fetched the first time the
// bubble shows for that link (previewLinkedDoc, through the reading
// route's own gate) and kept for a short while; nothing is fetched for any
// other link. A doc the viewer may not read says so in the block's place —
// the reading route draws the same line, Forbidden rather than 404 — and a
// doc that doesn't exist adds nothing.
//
// position: fixed and portaled to <body> for the same reasons as
// LinkControls' popover — placed in viewport coordinates by floating-ui
// (strategy: "fixed"), clear of every clipping ancestor and of the phone
// toolbar's edge mask.

const BUBBLE_GAP = 4;
const COPIED_MS = 1500;
// How long a fetched preview is trusted before the caret's return to the
// same link refetches it. Long enough that arrowing back and forth across a
// link's edge, or a copy's blur-and-refocus (copyText), never refetches;
// short enough that a title being edited in another tab isn't wrong for
// long.
const PREVIEW_TTL_MS = 30_000;
// A doc's reading URL, and its editor's.
const DOC_PATH = /^\/doc\/([^/]+)(?:\/edit)?\/?$/;

type LinkAtCaret = { href: string; from: number; to: number };
type PreviewEntry = { data: LinkedDocPreview | null; receivedAt: number };

// TipTap's own isActive is the test — the same one the toolbar button and
// Ctrl-K use — so the bubble and the popover agree about what "in a link"
// means (notably: not at a link's very first position, where the marks
// belong to the text before it).
function linkAtCaret(editor: Editor): LinkAtCaret | null {
  if (!editor.isActive("link")) return null;
  const { state } = editor;
  const type = state.schema.marks.link;
  const range = type ? getMarkRange(state.selection.$from, type) : undefined;
  const href: unknown = editor.getAttributes("link").href;
  if (!range || typeof href !== "string" || !href) return null;
  return { href, from: range.from, to: range.to };
}

// Under the link's start when the caret is on that line; for a link that
// wraps, under the caret's own line, so the bubble stays beside where you
// are rather than a line or two up. coordsAtPos throws for a position the
// document no longer has (a collaborator's edit landing mid-render).
function anchorFor(editor: Editor, link: LinkAtCaret): PopoverAnchor | null {
  try {
    const caret = editor.view.coordsAtPos(editor.state.selection.from);
    const start = editor.view.coordsAtPos(link.from);
    const line = Math.abs(start.top - caret.top) < 2 ? start : caret;
    return { top: line.top, bottom: line.bottom, left: line.left };
  } catch {
    return null;
  }
}

function absoluteHref(href: string): string {
  try {
    return new URL(href, window.location.href).href;
  } catch {
    return href;
  }
}

// The /doc/<id-or-slug> of a link into this site, or null for any other
// link. "This site" is same-origin once resolved against the page, so
// "/doc/x", the full http://this-host/doc/x, and a bare "x" typed on a page
// under /doc/ all count, and the production host's URL pasted into a dev
// slot doesn't (nothing here could answer for it anyway). Decoded, which
// for a real slug or id — ASCII letters, digits and hyphens — changes
// nothing; a segment that doesn't decode isn't a doc.
function internalDocParam(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const match = DOC_PATH.exec(url.pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

// The icon for `href`'s site: its origin's /favicon.ico — the location
// browsers have probed unprompted since the beginning, so nearly every
// site serves one — with the globe as the fallback for a site that only
// declares its icon elsewhere via <link rel="icon"> (the <img>'s onError).
// A link into this site uses the document's own <link rel="icon"> instead,
// since Next content-hashes that URL and /favicon.ico needn't be what the
// site actually serves (docs/FAVICON.md). Fetched by the browser, straight
// from the site: no server-side fetch of a user-supplied URL (CLAUDE.md's
// SSRF rule for avatars applies here too), and no third-party icon service
// to hand every linked host to. Anything other than http(s) gets the globe.
function faviconFor(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin === window.location.origin) {
    const own = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href;
    if (own) return own;
  }
  return `${url.origin}/favicon.ico`;
}

// The Clipboard API needs a secure context, which a phone testing against
// the dev box's LAN address (docs/DEV_SLOTS.md) doesn't have — there
// navigator.clipboard is simply absent, and the deprecated execCommand
// route through a scratch textarea is the only one left. The textarea takes
// focus for the duration, so the caller refocuses the editor afterwards.
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied, or otherwise unavailable: try the fallback.
    }
  }
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  scratch.select();
  scratch.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  scratch.remove();
  return copied;
}

export default function LinkBubble({
  editor,
  disabled,
  suppressed,
  onEdit,
}: {
  editor: Editor;
  disabled?: boolean;
  /** True while LinkControls' popover is open, which supersedes the bubble. */
  suppressed: boolean;
  onEdit: () => void;
}) {
  const { link, focused } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ link: linkAtCaret(e), focused: e.isFocused }),
  });
  // The href whose copy most recently succeeded, for the check mark: keyed
  // by href rather than a boolean so moving to another link clears it.
  const [copiedHref, setCopiedHref] = useState<string | null>(null);
  // An icon URL that failed to load, so the globe is shown for it instead
  // of a broken image.
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  // Fetched doc previews by route param, kept for the editor's lifetime
  // (this component never unmounts while its editor lives; it returns null
  // instead). State rather than a ref because the render reads it, and
  // written only from a response — never synchronously in an effect.
  const [previews, setPreviews] = useState<Record<string, PreviewEntry>>({});
  const previewsInFlightRef = useRef(new Set<string>());
  const bubbleRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const visible = !disabled && !suppressed && focused && link !== null;
  // Derived only once visible, which is also what keeps `window` out of the
  // server render: focused is never true there.
  const docParam = visible && link ? internalDocParam(link.href) : null;
  const preview = docParam !== null ? previews[docParam] : undefined;

  // The preview is fetched the first time the bubble shows for a given doc
  // link — not when the doc is linked, and not for every link in the
  // document — then kept for PREVIEW_TTL_MS. Keyed by the route param rather
  // than the href, so an absolute and a relative link to one doc share an
  // answer, and an answer can't land under the wrong link. A stale entry
  // stays on screen while its refetch is out; the bubble would otherwise
  // blink empty and back. In-flight params are a ref because `previews` is
  // a dependency here: one answer landing re-runs this for whatever link
  // the caret is in by then, and without the guard a request already out
  // for it would go out again.
  useEffect(() => {
    if (docParam === null) return;
    const entry = previews[docParam];
    if (entry && Date.now() - entry.receivedAt < PREVIEW_TTL_MS) return;
    const inFlight = previewsInFlightRef.current;
    if (inFlight.has(docParam)) return;
    inFlight.add(docParam);
    void previewLinkedDoc(docParam)
      .catch(() => null)
      .then((data) => {
        inFlight.delete(docParam);
        setPreviews((prev) => ({ ...prev, [docParam]: { data, receivedAt: Date.now() } }));
      });
  }, [docParam, previews]);

  // floating-ui owns placement, as on LinkControls' popover. The bubble
  // hangs under the link's line (offset: BUBBLE_GAP on both axes), and the
  // stock flip() moves it above when the room below runs out — here
  // flip-on-growth is *intended*, unlike the link popover's walking-box
  // bug: nothing in the bubble has focus, so a doc preview landing and
  // flipping the bubble above the line pulls it out from under nobody.
  // shift() slides it back inside its bounds on both axes — crossAxis
  // because an anchor whose line scrolls out of view would otherwise drag
  // the bubble off-screen with it. autoUpdate re-places on ancestor
  // scroll/resize and, via ResizeObserver, when a doc preview lands and the
  // bubble grows — no hand-listed `preview` dep, no listeners of ours, and
  // no hidden-first-frame trick: computePosition's answer lands in a
  // microtask, before the newly mounted bubble first paints. `link` is
  // identity-stable across transactions that don't change it, because
  // useEditorState hands back the previous selection when it compares
  // equal.
  useLayoutEffect(() => {
    if (!visible || !link) return;
    const bubble = bubbleRef.current;
    if (!bubble) return;
    let lastRect = new DOMRect(0, 0, 0, 0);
    const reference = {
      // Live coordinates each call — the link scrolls with the editor's own
      // text box. A width-0 rect on the anchor line; anchorFor answering
      // null (a collaborator's edit mid-render) holds the last rect rather
      // than jumping somewhere wrong.
      getBoundingClientRect: () => {
        const anchor = anchorFor(editor, link);
        if (anchor) lastRect = new DOMRect(anchor.left, anchor.top, 0, anchor.bottom - anchor.top);
        return lastRect;
      },
      contextElement: editor.view.dom,
    };
    const boundary = popoverBoundsElement(editor.view.dom);
    const update = () => {
      if (!anchorFor(editor, link)) {
        // Nothing resolvable to hang from: hide rather than point at air.
        bubble.style.visibility = "hidden";
        return;
      }
      void computePosition(reference, bubble, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [
          offset({ mainAxis: BUBBLE_GAP, crossAxis: BUBBLE_GAP }),
          flip({ crossAxis: false, boundary, fallbackStrategy: "initialPlacement" }),
          shift({ crossAxis: true, boundary }),
        ],
      }).then(({ x, y }) => {
        Object.assign(bubble.style, { left: `${x}px`, top: `${y}px`, visibility: "" });
      });
    };
    return autoUpdate(reference, bubble, update);
  }, [visible, editor, link]);

  if (!visible || !link) return null;

  const href = link.href;
  const iconSrc = faviconFor(href);
  const showIcon = iconSrc !== null && failedIcon !== iconSrc;
  const isCopied = copiedHref === href;

  const copy = async () => {
    const ok = await copyText(absoluteHref(href));
    editor.commands.focus();
    if (!ok) return;
    setCopiedHref(href);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopiedHref(null), COPIED_MS);
  };

  const remove = () => editor.chain().focus().extendMarkRange("link").unsetLink().run();

  // Named authors only, as AuthorByline shows; a byline of unnamed accounts
  // leaves the line to the edit time.
  const authors =
    preview?.data?.status === "ok" ? preview.data.authors.flatMap((a) => (a.name ? [a.name] : [])).join(", ") : "";

  return createPortal(
    <div
      ref={bubbleRef}
      className={styles.linkBubble}
      role="group"
      aria-label="Link"
      // True from the first paint of a doc link's bubble until its preview
      // lookup has answered (an answer of "no such doc" included). A live
      // region's honest state, and the one signal e2e can wait on: the
      // alternative — matching the server action's POST by body — depends on
      // Playwright having captured the body, which it hasn't once the request
      // finished before it looked, i.e. exactly under load (link-bubble.spec).
      aria-busy={docParam !== null && preview === undefined}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className={styles.linkBubbleRow}>
        <span className={styles.linkBubbleIcon} aria-hidden="true">
          {showIcon ? (
            // eslint-disable-next-line @next/next/no-img-element -- an arbitrary third-party origin's favicon: next/image would need an images.remotePatterns entry per host, and a 16px icon has nothing to optimize.
            <img
              src={iconSrc}
              alt=""
              width={16}
              height={16}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setFailedIcon(iconSrc)}
            />
          ) : (
            <IconWorld size={16} />
          )}
        </span>
        <a className={styles.linkBubbleHref} href={absoluteHref(href)} target="_blank" rel="noopener noreferrer" title={href}>
          {href}
        </a>
        <button
          type="button"
          className={styles.linkBubbleButton}
          aria-label={isCopied ? "Copied" : "Copy link"}
          title={isCopied ? "Copied" : "Copy link"}
          onClick={copy}
        >
          {isCopied ? <IconCheck size={16} /> : <IconCopy size={16} />}
        </button>
        <button
          type="button"
          className={styles.linkBubbleButton}
          aria-label="Edit link"
          title="Edit link (Ctrl+K / ⌘K)"
          onClick={onEdit}
        >
          <IconPencil size={16} />
        </button>
        <button type="button" className={styles.linkBubbleButton} aria-label="Remove link" title="Remove link" onClick={remove}>
          <IconLinkOff size={16} />
        </button>
      </div>
      {preview?.data?.status === "forbidden" && (
        <div className={styles.linkBubblePreview}>
          <span className={styles.linkBubbleForbidden}>
            <IconLock size={14} aria-hidden="true" />
            You don&apos;t have permission to read this doc.
          </span>
        </div>
      )}
      {preview?.data?.status === "ok" && (
        <div className={styles.linkBubblePreview}>
          <div className={styles.linkBubbleTitle} title={docTitleOrFallback(preview.data.title)}>
            {docTitleOrFallback(preview.data.title)}
          </div>
          <div className={styles.linkBubbleMeta}>
            {authors && (
              <span className={styles.linkBubbleAuthors} title={authors}>
                {authors}
              </span>
            )}
            {/* Relative, against when the answer arrived rather than now
                (the picker's rows do the same, for the same reason: Date.now()
                off the render path). The full local timestamp on hover is
                toLocaleString in a client component, which CLAUDE.md's
                hydration rule permits for exactly this case — the value
                arrived by a client-side fetch and is never in the SSR HTML. */}
            <time
              className={styles.linkBubbleEdited}
              dateTime={preview.data.updatedAt}
              title={new Date(preview.data.updatedAt).toLocaleString()}
            >
              Edited {relativeTime(preview.data.updatedAt, preview.receivedAt)}
            </time>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
