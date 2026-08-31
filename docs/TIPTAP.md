# TipTap / ProseMirror

Traps in TipTap v3, y-prosemirror and ProseMirror itself, in roughly the order you meet
them. The anchoring strategies built *on top* of this stack are [COLLAB.md](COLLAB.md); this
file is about the editor library.

## The schema lives in one file, and has two halves with three variants each

`src/lib/tiptap-schema.ts` is shared by the editor, Hocuspocus doc-seeding, and public
rendering, so the three cannot drift. **Change it only there.**

It holds *two* schemas, each with mark-layered variants stacked on it rather than a parallel
definition. Picking the wrong one silently drops marks on decode or render:

| | base | + author highlight | + annotation mark |
|---|---|---|---|
| body | `contentExtensions` | `authorHighlightExtensions` | `docContentExtensions` (doc side only, PLAN.md §12i) |
| title | `titleExtensions` | `titleAuthorHighlightExtensions` | — |

The title is a separate Yjs fragment (PLAN.md §3d), which is why it has its own schema at
all. Anything decoding a *doc's* ydoc wants `docContentExtensions` — `server/doc-cache.ts`
and `src/lib/ydoc-render.ts` both do.

## Never add StarterKit's own extensions beside it

TipTap v3's StarterKit already bundles Link, Bold and Italic (among others) and undo/redo.
Never add any of those **alongside StarterKit** in the same schema, and pass
`undoRedo: false` when combining StarterKit with the `Collaboration` extension —
`Collaboration` owns the history stack instead.

`undoRedo` stays *on* wherever there is no `Collaboration`. `blurbExtensions` is the one
schema in this codebase where that inversion applies.

### A link opens from its bubble, not from a click

`EDITOR_LINK_OPTIONS` (`src/lib/tiptap-schema.ts`) turns Link's `openOnClick` off in both
live editors, and `src/components/LinkBubble.tsx` — favicon, href, copy/edit/remove, shown
while the caret is in a link — is where following one moved to. A click in a link now places
the caret, which is what the browser was already promising: the UA gives `<a>` `cursor: auto`,
and inside a `contenteditable` that resolves to the I-beam, so the navigation the click plugin
bolted on never had an affordance — and with it on, there was no way to click *into* link text
to edit it. `"whenNotEditable"` is not a middle ground in the installed build: it is mapped
straight to `true`, and the click plugin already stands down in a read-only view.

For a link into one of this site's own docs — `/doc/<id-or-slug>`, relative or absolute on
this origin — the bubble adds a second block: the doc's title, then its authors with the last
edit at the right, what the reading route's byline shows. Fetched by `previewLinkedDoc`
(`src/app/actions/docs.ts`) the first time the bubble shows for that link and kept for half a
minute, through the reading route's own gate, and with the route's own answers: a doc the
viewer may not read shows "You don't have permission to read this doc." in the block's place
(the route renders Forbidden there rather than a 404, so the bubble reveals nothing following
the link wouldn't), and a doc that doesn't exist adds nothing.

### The link popover is a form: title over URL

`LinkControls.tsx`'s popover is two boxes, each prefixed by an icon saying which is which (Aa,
link). The title is the link's text and nothing else. **The URL box is the one that searches** —
paste a URL or type a doc title, recent docs on empty — the Google Docs / Confluence
arrangement, chosen over a title-that-also-searches because the two jobs collide exactly when
text is selected: a search typed into the title box would overwrite the selection's text, and
that text is the one thing the author has already decided. A pick fills the URL box, and the
title box only if it is empty; **a pick fills, Save applies**, so either box can still be
adjusted (the old one-box picker saved on pick and offered no way to change the text). The result
list sits *between* the URL box and the button row in flow, shown only while the URL box has
focus, rather than floating over the buttons where a mouse could never reach Save; the list and
the button row both `preventDefault` their mousedown so a click on either doesn't blur the box
and pull the list — or the button — out from under the click. The URL box opens focused with
its contents selected, since both the search and the paste happen there and the usual reason to
edit a link is to swap its URL. Save marks the range in place when the title still matches its
text (so inner marks survive) and replaces the text otherwise; on a bare caret it inserts the
title, or the URL itself, as the link's text.

**Placement is `@floating-ui/dom`'s — except the side, which is chosen for the tallest the
popover can be** (the form plus the result list at its max height, `LIST_MAX_HEIGHT_REM`,
applied inline so the arithmetic and the CSS are one number), never for its live height. Live
height is what the stock `flip()` middleware reads, and that bug has already been paid for here:
fitted live, the box flipped above the selection when the recent docs landed and back below on a
pick — a box the author was typing into walked. So `flip()` is left out and a small custom
middleware, `sideForTallest`, makes the call. The rest is the library's: `computePosition` lays
a bottom-placed box out from the anchor down and a top-placed one from the anchor up, so the
edge nearest the text holds still and growth lands on the far edge (flipped above, the box grows
upward and collapses back toward the selection); `shift()` is the horizontal slide; `autoUpdate`
re-places on ancestor scroll/resize and, via ResizeObserver, on the box's own size changes — no
listeners of ours, and no reflow bookkeeping. Its answer lands in a microtask, before the newly
portaled box first paints, so nothing provisional is ever shown. The side is stamped on the
popover as `data-placement`, which is what lifts the list to the top of a flipped popover
(`[data-placement^="top"]`, EditorChrome.module.css): whatever sits above the list moves when it
grows, and above the selection that should be nothing the author is typing into. The hand-rolled
`placePopover` version and a tippy.js attempt live in git history; TODO.md tracks moving the
other popovers (still on `src/lib/popover-placement.ts`) to floating-ui.

The selection stays visible under the open popover. A document has one DOM selection, and the
URL box taking focus takes it — ProseMirror's `state.selection` is untouched (Save resolves the
range from it live), only the paint goes. `BlurredSelection`
(`src/lib/blurred-selection-extension.ts`), registered in both live editors, decorates
`state.selection` with class `selection` while the editor is blurred; `prose.module.css` paints
it as a selection-blue wash off `--link`. It fires on *every* blur, not only this popover's, and
that includes composing an annotation — where the same range already carries
`.pending-annotation`. ProseMirror merges same-range inline decorations onto one span with both
classes, so a `.selection.pending-annotation` rule hands that span the pending look alone; the two
never stack. The extension is inert on a non-editable editor, so the reading views and
`AnnotationBodyReader` are untouched.

**Not `@tiptap/extensions`' stock `Selection`**, which paints the same decoration but also clears
the DOM selection on blur and re-applies the state selection to the DOM a frame after focus —
neither is needed for the paint, and DOM-selection writes from a plugin are one more thing to
reason about under the editor's selection-driven annotate widget. The dependency stays transitive
(StarterKit's); nothing imports it directly. **What any such decoration does change**: the focus
transaction re-renders the decorated text, and ProseMirror then re-asserts its state selection
over the DOM's. Real gestures focus first and select second, so users never see it; a script that
sets a DOM range *before* focusing an editable editor has it replaced by the stale one — which is
why `e2e/fixtures.ts`' `selectTextIn` focuses the editor before selecting (the
`margin-rail-widths.spec.ts` annotate-marker case broke when it didn't).

### `[[` drops a doc reference at the caret

The other half of linking, the Obsidian / Roam / Notion gesture: Ctrl-K is for linking text
you already have, `[[` is for a reference you have no text for yet. `DocRefMenu.tsx` (mounted
beside both live editors' `EditorContent`, not in the toolbar — the annotation editor's toolbar
is hidden by default) opens a menu of readable docs under the `[[` — recent docs at first,
filtering as you keep typing — and Enter or a click replaces `[[` and the query with the doc's
title, linked to `/doc/<slug>`. The query is transient by construction, which is exactly what
the popover's title box could never assume (its section above on why the search moved to the
URL box).

It is built on `@tiptap/suggestion` (pinned exactly, like every `@tiptap/*` — the peer dep is
the exact core version), the utility under TipTap's own Mention. Suggestion owns the trigger —
a `[[` in the text node before the caret, `allowSpaces` so titles with spaces stay one query,
`allowedPrefixes: null` so `word[[` counts as well as ` [[` — the query and its range, a
decoration around them (`doc-ref-query`, unstyled), Escape, the debounced and abortable `items`
fetch, and the composition state an IME puts the view in. Its Escape is an *exit that remembers
the dismissed range*: typing on in the same `[[` doesn't reopen the menu, and a later `[[`
does. Ours on top: `allow`, which keeps a closed `[[a]]` (Suggestion's match runs to the caret
and would carry the `]]` in its query) and a code block from being a context; the list, rendered
from what its `render` callbacks hand over; ArrowUp/Down/Enter in `onKeyDown`, which also
stands down mid-composition; and placement, which takes Suggestion's `clientRect` as the anchor
but still runs it through `placePopover` rather than Suggestion's floating-ui `mount` (once per
`[[`, for the tallest the menu can be) — the link popover has since moved to `@floating-ui/dom`
directly, and TODO.md's migration item brings this menu along, sharing `sideForTallest` rather
than adopting `mount`'s own update loop. Suggestion's plugin is *prepended*, ahead of the keymaps,
for the same reason `LinkControls`' Ctrl-K is: Enter must reach the menu before the base keymap
splits the paragraph.

What is typed right after a pick is kept out of the link: Link is inclusive while autolink is
on, and the sentence the reference was dropped into continues right after it, so the next
character would otherwise join the link. Clearing the stored marks on the pick is **not** enough
here — ProseMirror drops stored marks on any step, and `AuthorHighlight`'s `appendTransaction`
adds its steps in the same dispatch — so a second, tiny plugin remembers where the link ends
(`plainAt`) and its own `appendTransaction` strips the link mark from whatever lands there next,
then forgets.

### Why `@tiptap/extension-document`/`-paragraph`/`-text` are still declared deps

They are for schemas built **without** StarterKit at all, so nothing is double-registered:

- **`titleExtensions`** (`CollabTitleField.tsx`) — the title editor.
- **`blurbExtensions`** (`ContributorPanel.tsx`, PLAN.md §17f) — the contributor blurb.

Both are constrained to `content: "paragraph"` so a second block is structurally impossible.
`blurbExtensions` also declares `@tiptap/extension-bold`/`-italic` directly for the same
reason: StarterKit has no option to keep only `document`/`text` and drop everything else, so
building the schema from scratch is the only way to get "exactly one paragraph, a couple of
marks, nothing else".

> **Pin every one of these to the same exact version as `@tiptap/core`** when installing.
> `^3.28.0` resolves to 3.29.0, whose peer dep is `@tiptap/core@3.29.0` exactly, and npm
> fails the install.

## Enter is two keys, decided by whether the virtual keyboard is docked

`VirtualKeyboardEnter` (`src/lib/virtual-keyboard-enter-extension.ts`), registered in both live
body editors, remaps the block keys to a phone messenger's while the on-screen keyboard is up —
because a virtual keyboard has no Shift-Enter, so the soft break is otherwise unreachable there.
While it is docked: **Enter inserts a hard break; Enter with a hard break already right before
the caret deletes it and splits the paragraph for real** (the Slack/WhatsApp double-Enter,
deliberately *loose* — any break counts, whoever typed it, which keeps the rule stateless at the
cost that two adjacent breaks cannot be typed with Enter in this mode; Enter-space-Enter is the
nearest approximation); **Backspace at the start of a non-empty textblock joins into the
previous non-empty textblock and leaves a hard break at the seam**, so a second Backspace
finishes the merge — two Backspaces undo two Enters, and either mode's text edits naturally in
the other. Inside a list item the extension stands down entirely (Enter stays `splitListItem`,
Backspace its lift/join — remapped, list structure would be unreachable from a phone), and in a
code block `setHardBreak` fails and falls through to the stock chain. The title and blurb
editors are left out: their schemas have no `hardBreak` node and no HardBreak extension, so
there is no `setHardBreak` command to call and both keys are already no-ops.

Visibility is `src/lib/virtual-keyboard.ts`: `innerHeight − visualViewport.height × scale ≥
100px` (the `× scale` cancels pinch-zoom; URL-bar movement moves both heights together). Not
pointer-modality tracking — that failed structurally on an iPad with a hardware keyboard, where
every tap said "touch" and no keystroke could say otherwise — and not
`navigator.virtualKeyboard`, which is Chromium-on-Android only and reports geometry only under
an `overlaysContent` opt-in that changes page layout. The blind spots all degrade to stock
Enter, never to a stuck remap: iPadOS's floating/split keyboard docks nothing, Android
Chrome < 108 resized both viewports together, and a browser without `visualViewport` never
installs the listener. The file has the full comparison; verified on a real iPad 2026-08-30.

Two traps this arrangement depends on:

- **Same-priority keymaps run in reverse registration order** — `ExtensionManager` *reverses*
  the extension list before its stable priority sort — so an extension's place in the Enter
  chain at the default 100 depends on where the `useEditor` array happens to list it. The
  extension pins `priority: 101` to sit ahead of core `Keymap`'s `splitBlock` and `ListItem`'s
  `splitListItem` by number instead of by position. `DocRefMenu`'s Enter still wins over it,
  by being a *prepended plugin* rather than a keymap (its section above).
- **Playwright cannot shrink `visualViewport`**, so a spec can never reach the docked-keyboard
  state through real geometry. `window.__multiblogSetVirtualKeyboard(true | false | null)`
  forces the verdict (null returns to measurement), and is exposed unconditionally *because*
  `npm run e2e` runs the production build — a `NODE_ENV` gate would hide the hook from the one
  consumer it exists for.

## `setContent` takes an options object in v3, where v2 took a boolean

```ts
editor.commands.setContent(json, { emitUpdate: false })  // v3
editor.commands.setContent(json, false)                  // v2 — type error
```

The v2 form is a type error (`Type 'false' has no properties in common with type
'SetContentOptions'`) but reads as obviously-correct against any pre-v3 example or answer, so
it is worth recognizing rather than re-deriving. `LiveDocBody.tsx` uses the v3 form to push
live Yjs updates into a non-`Collaboration` editor without re-emitting them.

## `Collaboration` binds through `@tiptap/y-tiptap`, not `y-prosemirror`

A separate package — Tiptap's own fork.
`node_modules/@tiptap/extension-collaboration/dist/index.js` imports every one of
`ySyncPlugin`, `ySyncPluginKey`, `absolutePositionToRelativePosition` and
`relativePositionToAbsolutePosition` from it.

Reading a Collaboration-bound editor's sync-plugin state —
`ySyncPluginKey.getState(editor.state)`, e.g. to reach the y-prosemirror binding's
`ProsemirrorMapping` for a relative-position conversion — needs the key imported from
`@tiptap/y-tiptap`, or `PluginKey.getState()`'s identity match **silently fails**: it doesn't
throw, it returns `undefined`, indistinguishable from "this editor has no Collaboration
binding at all."

`src/lib/yjs-relative-anchor.ts` shipped with the wrong import for one review cycle (PLAN.md
§18f). Every selection on `/doc/[slug]/edit` silently failed to capture, caught only by
manual testing — not by `npx tsc`, `eslint`, or the e2e suite, since nothing exercises that
page's *selecting* text, only typing into it.

`y-prosemirror` itself stays a real dependency: `server/ydoc-hooks.ts` uses it correctly for
stateless Yjs↔ProseMirror conversion server-side, which never touches a `PluginKey`. The trap
is specifically about plugin-state lookups against a live client-side `Editor`.

## `onFirstRender` is not "the doc has synced"

With the collab server unreachable it fires right away against the still-empty fragment, so
anything that treats empty-means-empty (a title-changed comparison) sees `""` as real
content.

`HocuspocusProvider`'s own `onSynced`/`onStatus` is the signal for that — see
`use-live-doc-content.ts`'s `synced` (read-only taps) and `DocEditor.tsx`'s
`connectionStatus` (the write side).

`onFirstRender` also fires *during* `useEditor`'s render, so calling a parent `setState` from
it trips React's "state update on a component that hasn't mounted yet". Report upward from an
effect instead (`CollabTitleField.tsx`).

## `CollaborationCaret` has no per-field awareness key

Every instance writes `awareness.cursor`. Two of them on one provider — e.g. body and title
editors sharing a `Y.Doc` — therefore render each other's positions against the wrong
fragment. **Only the body editor gets one**; the title field syncs text without remote
carets.

### The default render is overridden

`CollaborationCaret`'s default `render` shows an always-visible name label. `renderCaret` in
`CollabEditorBody.tsx` draws just a colored bar instead, with the name in a CSS `:hover`-only
tooltip (`.collabCaret`/`.collabCaretLabel` in `DocEditor.module.css`, shared by every
`CollabEditorBody` consumer).

The local user's own cursor was never affected either way — y-prosemirror's cursor plugin
filters out the local clientID before `render` is ever called.

## `document.querySelector('.tiptap')` matches the **title** editor first

The body editor is `querySelectorAll('.tiptap')[1]`. Relevant to the editing-latency
benchmark and content-setting recipes in [BROWSER_PANE.md](BROWSER_PANE.md) and
PERFORMANCE.md, which target `.tiptap`.

Both editors also carry an `aria-label` on their contenteditable — `Title` and `Post body` —
which is what the e2e suite keys off instead of DOM order.

## ProseMirror drops custom attributes where inline decorations overlap

The quote-highlight extension pre-splits ranges into non-overlapping segments, which is why
the attribute is `data-thread-ids`, plural.

## `authorHighlight` marks accumulate in a doc forever

Per-author color-coding (`src/lib/author-highlight-extension.ts`) lives in a doc's working
Yjs state and **nothing ever removes them from the doc itself**. A doc has no save step to
hook a reset into (PLAN.md §12k), unlike the old post editor's `clearAuthorHighlights`, which
doesn't exist any more.

What keeps them out of *published* content is `postContentFromYdoc`
(`src/lib/post-content.ts`), which strips `authorHighlight` and `annotation` from a snapshot
before it is ever written to `Post.proseJson` (PLAN.md §15b). The live doc a reader edits and
the copy a post publishes are different JSON from that point on.

---

# ProseMirror

## Object-spread with a conditional override silently keeps stale array data

> **Note on framing.** This was found when `stripMarkFromDoc` fed a `revisions.doc` column,
> with `saveDraft` / `publishPost` / `clearAuthorHighlights` around it. None of that exists
> any more — posts are immutable snapshots of a doc (PLAN.md §15), and there is no `Revision`
> model. The function survives, reached through `stripMarksFromDoc` from
> `src/lib/post-content.ts` and `src/lib/front-page.ts`, so **both structural lessons still
> apply to it**; only the blast radius changed, from "a spurious revision" to "an unstripped
> mark in `Post.proseJson` or on the front page". The source comments in
> `src/lib/tiptap-schema.ts` still describe the old machinery.

**The bug:** `stripMarkFromDoc` (`src/lib/tiptap-schema.ts`), which recursively removes one
mark type from a ProseMirror JSON doc before it is persisted, looked like this:

```ts
export function stripMarkFromDoc(doc: JSONContent, markName: string): JSONContent {
  function strip(node: JSONContent): JSONContent {
    const marks = node.marks?.filter((mark) => mark.type !== markName);
    const content = node.content?.map(strip);
    return {
      ...node,
      ...(marks !== undefined ? { marks } : {}),
      ...(content !== undefined ? { content } : {}),
    };
  }
  return strip(doc);
}
```

The fixed version destructures `marks`/`content` out of the base spread, and only re-adds
`marks` when filtering left something:

```ts
export function stripMarkFromDoc(doc: JSONContent, markName: string): JSONContent {
  function strip(node: JSONContent): JSONContent {
    const { marks: rawMarks, content: rawContent, ...rest } = node;
    const marks = rawMarks?.filter((mark) => mark.type !== markName);
    const content = rawContent?.map(strip);
    return {
      ...rest,
      ...(marks !== undefined && marks.length > 0 ? { marks } : {}),
      ...(content !== undefined ? { content } : {}),
    };
  }
  return strip(doc);
}
```

### The problem, in two layers

**1. A later spread can override a key, but it cannot remove one.**
`{...node, ...(marks !== undefined ? { marks } : {}) }` spreads the entire original `node`
first — including its *unfiltered* `marks` array — and only conditionally spreads a second
object on top. As long as `marks` is defined (which it is whenever `node.marks` was, since
`.filter()` always returns an array), that override fires and everything looks fine.

But the moment the override condition is written more narrowly (see point 2), any node whose
filtered marks come back empty falls through to `...node`'s original, unfiltered `marks` —
the exact array `strip()` was supposed to remove entries from.

This is what actually broke first: a fix for problem 2 was applied by narrowing
`marks !== undefined` to `marks !== undefined && marks.length > 0`, *without* also cutting
`node`'s original `marks` out of the base spread. So on a text node whose *only* mark was the
one being stripped — the common case: freshly-typed text tagged with exactly one
`authorHighlight` mark and nothing else — the filtered-to-empty array no longer triggered the
override, and the raw, unstripped mark leaked straight through. Confirmed by dumping the
stored row from Postgres directly:
`{"text": "...", "type": "text", "marks": [{"type": "authorHighlight", ...}]}` — the mark the
function exists to remove, still there.

**2. `marks: []` is not what ProseMirror emits.**
Even before that regression, the original code always kept a `marks` key on the output node
whenever the input had one, even when filtering emptied it. ProseMirror's own `Node#toJSON()`
never does this: a node with zero marks simply omits the key
(`if (this.marks.length) obj.marks = ...`).

So a doc that had gone through `stripMarkFromDoc` was structurally different — *by key count,
not content* — from the same doc produced fresh by a live editor's `getJSON()` a moment
later. `docsEqual` (`src/lib/diff.ts`) does a structural, key-set-aware comparison
specifically to survive Postgres jsonb losing key order on read-back, but it still requires
both sides to have the *same set of keys*, so this mismatch made it report "different" for
what was actually identical content.

### The fix, in full

Destructure `marks` and `content` out of the base object before spreading (so there is no
stale array left for a skipped conditional to leak), **and** only re-add the `marks` key when
the filtered result is non-empty (so the output matches ProseMirror's own convention of
omitting it rather than serializing `[]`).
