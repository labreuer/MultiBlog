# MultiBlog — Styling Conventions

This documents what's actually been decided/established in the codebase, not an
aspirational design system. Most of the app (admin table, editor, moderation queue,
history views) is still plainly-styled inline React `style` objects with no unifying
palette — that's fine and not a gap to close. The conventions below are the ones that
are real (used more than once, or deliberately chosen) as of 2026-07-21.

## Approach: CSS Modules by default, inline styles only for genuinely dynamic values

This previously said the reverse (inline as the norm, a stylesheet only once a
pseudo-class or media query forced the issue) and credited that policy to CLAUDE.md's
Conventions section, which doesn't actually say that — CLAUDE.md only points here for
"CSS Modules vs. inline," it doesn't prescribe a default. Inline-first also isn't
standard practice: it skips the cascade, can't be shared or deduped by the bundler, and
loses the pseudo-class/media-query runway immediately, as the exceptions below show.
**Default to a CSS Module (co-located; same name as the component/page, unless it's
meant to be shared across several — see `AdminTable.module.css` below); reserve inline
`style={{...}}` for values that are genuinely computed per-instance** — a color read
from data, a measured width — not for fixed rules.

Most of the existing surface (admin tables, editor, moderation queue, history views)
still carries inline styles written under the old policy and isn't being migrated
retroactively just for this — that's a separate, larger cleanup, not a correction to
make in passing. `components/AdminTable.module.css`, `components/CommentsTable.module.css`,
and `app/comments/page.module.css` are the first modules created under the corrected
default (not pseudo-class/media-query driven, unlike everything below); the rest predate
it. The first two are a deliberate pair, not a single file, and illustrate the "same name
as the component, unless shared" clause above concretely:

- `AdminTable.module.css` is named for the shared *concept* (styling common to the admin
  tables — `PostsTable`, `UsersTable`, `CommentsTable`) rather than after one component,
  even though `CommentsTable` is currently its only consumer — see the TODO at the bottom
  before assuming it already applies everywhere that name suggests. Holds what's judged
  generic: cell/header padding, sortable-column cursor, the soft-deleted-row `opacity`,
  the shared delete/restore icon button, table margins, the filter-row layout, the
  multi-select filter dropdown, and the pagination bar.
- `CommentsTable.module.css` is co-located and named for `CommentsTable.tsx` in the usual
  way, holding only what's judged comment-moderation-specific and unlikely to ever
  generalize: the Approve/Pend/Spam colors (comment-status semantics that will never
  apply to a post or a user row), the bulk-action toolbar, and the querystring help panel.

The dividing line was "would this style also make sense on `PostsTable`/`UsersTable` if
they adopted the same pattern?" — not "is this reused more than once" (nothing here
*is* reused yet, since `AdminTable.module.css` has one consumer). A style with a plausible
future consumer among the other admin tables goes in the shared file; a style that
encodes something specific to comment moderation doesn't, no matter how tempting it is to
lump every table-adjacent style into one file:

| File | Needs a stylesheet for |
|---|---|
| `PostEditor.module.css` | `:hover` (toolbar/quote menu), `@media` (mobile toolbar) |
| `styles/prose.module.css` | shared across editor + public rendering; `.quote-highlight.pulse` keyframe animation; reads the per-thread `--thread-color` custom property (see Color palette) |
| `app/page.module.css`, `app/authors/[id]/page.module.css`, `app/[slug]/page.module.css` | `:hover`-only underline on post-title links |
| `components/CommentSection.module.css`, `CommentNode.module.css`, `CommentForm.module.css` | none needed a pseudo-class directly, but were pulled into modules alongside `QuoteThreadHeader` for consistency when that pass happened (see git history 2026-07-20) |
| `components/QuoteThreadHeader.module.css` | state-dependent color pairs (`.arrowActive`/`.arrowDetached` etc.) previously done as inline conditional values; `.arrowActive`/`.barActive` also read `--thread-color` |
| `components/PostSettingsPanel.module.css` | same state-dependent-class rationale as `QuoteThreadHeader` — `.draggableRow`/`.dragOver` toggle on drag state, `.checkboxRow` conditionally combines them; no pseudo-class/media-query is used, but juggling three conditional classes per row as inline `style` objects would be worse than the module |

Numeric constants that also drive non-CSS geometry (e.g. `QuoteThreadHeader`'s
`HEAD_WIDTH`/`HEAD_HEIGHT`, used in both the SVG `viewBox` and a CSS `width`) stay as
JS constants passed via inline `style`, not hardcoded into the module — splitting a
value that two systems depend on invites drift.

## Global baseline (`globals.css`)

- `--foreground: #171717` / `--background: #ffffff` (dark mode: `#ededed` / `#0a0a0a`,
  via `prefers-color-scheme`). Only `body` actually consumes these; most pages don't
  yet respect dark mode beyond this.
- `body` font: `Arial, Helvetica, sans-serif` — the sitewide default. Individual page
  containers currently override this (see Typography below); nothing has unified it.
- `* { margin: 0; padding: 0; box-sizing: border-box; }` — a hard reset. Anything
  rendering list/blockquote content needs to restore spacing explicitly (see
  `prose.module.css`, and the CLAUDE.md gotcha about it).
- Links: `a { color: #3366cc; text-decoration: none; }`, `a:hover { text-decoration:
  underline; }` — sitewide default for **every** link except post titles (below).

## Color palette

| Role | Value | Where |
|---|---|---|
| Default link | `#3366cc` | `globals.css`, sitewide |
| Post title (home/author listings) | `#000` (black), underline only on `:hover` | `page.module.css` `.titleLink` — deliberate override of the default link color |
| Body text | `#171717` (`--foreground`) | `globals.css` |
| Secondary/meta text (dates, bylines, empty states) | `#666` | pervasive — `page.tsx`, `search/page.tsx`, `CommentNode`, history/comments admin pages, etc. |
| Muted/placeholder text | `#999` | detached-thread notices, collab-cursor fallback color, "nothing to show" states |
| Light divider (between list/article rows) | `1px solid #eee` | every post-listing `<article>` (`page.tsx`, `authors/[id]/page.tsx`, `search/page.tsx`) |
| Stronger border (panels, table headers, comment-admin rows) | `1px solid #ddd` | `PostsTable.tsx`, `SiteHeader.tsx`, admin comments/history pages |
| Nested-reply rail | `2px solid #e0e0e0` | `CommentNode.module.css` `.nested` |
| Quote-thread marker/highlight/badge (active) | `var(--thread-color, #999)` — see note below | `QuoteThreadHeader.module.css`, `prose.module.css` `.quote-highlight`/`.quote-indicator` |
| Quote-thread marker (detached) | `#999`, fixed (not `--thread-color`-driven) | `QuoteThreadHeader.module.css` |
| Quote highlight background / pulse | `color-mix(in srgb, var(--thread-color, #999) 25%, transparent)`, pulses to 55% | `prose.module.css` |
| Comment-form buttons | `#333` (Post comment) / `#666` (Cancel) | `CommentForm.module.css` `.submit`/`.cancel` |
| Error text | `crimson` | form validation errors |
| Danger/delete action | `#c00` (text/border, no fill) | `PostsTable.tsx`/`UsersTable.tsx` delete icon buttons, `PostSettingsPanel.module.css` `.deleteButton` — consistent across every soft-delete control in the admin/editor UI |
| Diff view: insertion / deletion | `#0a5` on `#d4f7d4` / `#c00` on `#fbdada` | `history/[revisionNumber]/page.tsx` — not part of the palette above, ad hoc and only used there |
| Drag-over highlight | `#eef4ff` background, `1px dashed #88a` outline | `PostSettingsPanel.module.css` `.dragOver` — ad hoc, only reordering UI so far |
| Moderation action buttons (Approve / Pend / Spam) | light fill per action — `#d4f5d4` / `#faf3c0` / `#f8d4d4` — with a shared `1px solid #999` border and `2px` padding | `CommentsTable.module.css` `.approve`/`.pend`/`.spam` (the colors — comment-status-specific) + `AdminTable.module.css` `.actionButton` (the border/padding wrapper — generic), used together by `ActionCell` — same neutral-gray border on all three so the fill color alone (not the border) carries the meaning |

Quote-thread coloring was originally one fixed muted amber (`#b8935a`, itself toned down
from an earlier, more saturated `#fff3b0`/`#d4a017` — see git history), the same for every
thread. It's now **one real color per thread** — the thread-opener's `User.color`, or a
seeded fallback for anonymous commenters (PLAN.md §10 item 13) — carried as an inline
`--thread-color` custom property rather than a CSS Modules class, since there's one value
per *thread instance*, not a small fixed set of states. The `#999` fallback above is what
renders when that property is left unset: either a decoration span shared by threads of
different colors (a single span can only paint one background, so an ambiguous overlap
goes neutral rather than picking one author arbitrarily) or, coincidentally, the same shade
used for the unrelated "detached" state.

## Typography

Two competing font stacks are in play, both deliberate:

- **Reading surfaces** (article body, comments heading): serif —
  `Georgia, "Iowan Old Style", "Palatino Linotype", serif` — set on `.prose` (shared
  editor/render typography, `prose.module.css`), the post `<h1>` (`[slug]/page.module.css`
  `.title`), and the comments `<h2>` (`CommentSection.module.css` `.heading`). Chosen for
  reading comfort; `.prose` also sets `font-size: 1.125rem; line-height: 1.7`.
- **UI chrome** (nav, forms, byline metadata): system sans-serif —
  `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` on page containers — or
  simply inherits the global `Arial, Helvetica, sans-serif` body default where no
  container override exists (most admin/editor pages).

Because `prose.module.css` is shared by the live TipTap editor and the public
rendering, the serif treatment applies to both — editing and reading now look the same
by design, not by accident.

## Layout patterns

- **Centered reading column**: `max-width: ...px; margin: 0 auto;` — not yet a shared
  component/class; each page repeats it. Two widths, kept deliberately separate:
  - `800px` on pages showing full post text — `[slug]/page.module.css` (public post
    display) and `PostEditor.module.css` (editor).
  - `680px` on listing/excerpt pages — `page.tsx` (home), `authors/[id]/page.tsx`,
    `search/page.tsx`. These show post previews, not full text, so they weren't widened
    alongside the two full-text surfaces above.
- **Post-listing article block**: `padding: 1.5rem 0; border-bottom: 1px solid #eee;`
  — repeated verbatim across home, author, and search listings.
- **Vertical centering of small elements next to a heading** (e.g. the `(edit)`/
  `(edited)` badge beside a post title): prefer `display: flex; align-items: center`
  on the heading container over `vertical-align: middle`. The latter centers against
  the parent's *x-height*, not its actual box, so it drifts whenever the heading's
  font or line-height changes — this caused a real regression (fixed 2026-07-20) where
  the badge sat visibly low next to the serif `<h1>`/`<h2>` titles. Font-size is still
  set with `em` (not `rem`) so the badge scales with whichever heading it's next to —
  see the em-vs-rem gotcha in CLAUDE.md — but centering itself is flexbox's job now,
  not font metrics.
- **Headerless label/value table** (`PostSettingsPanel.module.css` `.detailsTable`, added
  2026-07-21): a plain `<table>` with no `<thead>`, one `<tr>` per field, label in the
  first `<td>` (`white-space: nowrap`, right-padded) and the value/control in the
  second. Used when several label+value rows need their values to start at a common
  x-position — flexbox rows (`.fieldRow`, tried first) only align a *single* row's own
  label/value pair, not siblings' columns against each other.
- **`white-space: nowrap` on narrow auto-sized table columns** (`PostsTable.tsx`'s
  `nowrapTd`/`nowrapSortableTh` JS constants, added 2026-07-21; the same pair
  independently added to `UsersTable.tsx` for its `createdAt` column; `CommentsTable.tsx`
  now gets the same pair as `AdminTable.module.css`'s `.nowrapCell`/
  `.nowrapSortableHeaderCell` for its Created-at/Status-changed columns instead of its own
  JS constants): a plain `<table>` with no fixed column widths shrinks a column until its
  content wraps, and the browser's default line-breaking treats both a space (any
  multi-word header/value, e.g. "Created at", "Luke Breuer") and a hyphen (a `yyyy-MM-dd`
  date) as valid break points — so a 9-column admin table routinely splits a date or a
  name across two lines well before it's actually out of room. Forcing the column to
  claim whatever width its content needs instead is applied per-column, not table-wide,
  so free-text columns (Title, Comment) stay wrappable. Different rationale from the
  headerless label/value table's `nowrap` above — that one aligns a label's own single-line
  width, this one stops content from breaking at all.
- **Buttons sized to match an adjacent input's box model**: `PostEditor.module.css`
  `.actionButton` matches `.changelogInput`'s `padding`/`font-size`/`box-sizing` rather
  than setting an explicit `height` — a `<button>` and `<input>` with the same font-size,
  padding, and (default 1px) border compute the same rendered height without one, and an
  explicit height on a flex/inline sibling is brittle across zoom levels and font
  fallbacks in a way matching the box model isn't.
- **Symmetric whitespace above/below a block**: match the block's own `margin-top` to
  whatever's providing space below it, rather than leaving the reset's implicit 0 above
  and a sibling's `margin-top` below. `.revisionNote`'s `margin-top: 12px` was added to
  equal `PostSettingsPanel`'s `.details { margin-top: 12px }` sitting right after it.
- **Native `<details>`/`<summary>` for a collapsible panel** (`PostSettingsPanel.tsx`):
  no custom open/close state, animation, or ARIA wiring needed — the browser provides
  keyboard support and the `toggle` event for free. Reach for a JS-driven collapse only
  when `<details>`'s default (no open/close animation, can't be controlled purely by
  external state without an effect syncing `open`) doesn't fit.
- **Multi-select filter dropdown** (`CommentsTable.tsx`'s `MultiSelectDropdown`, used for
  `status`/`threadStatus`): also a bare `<details>`/`<summary>`, styled (`.dropdownWrapper`/
  `.dropdownSummary`/`.dropdownPanel`/`.dropdownOption`, moved to `AdminTable.module.css`)
  as a bordered pill (`1px solid #ccc`, `border-radius: 4`) with the current selection
  summarized in the `<summary>` text itself rather than a separate label. In
  `AdminTable.module.css` despite `MultiSelectDropdown` itself still being a private
  function local to `CommentsTable.tsx`, not an exported component — the CSS was judged
  generic enough (any admin table could plausibly grow a multi-select filter) to place by
  the "would this also make sense on `PostsTable`/`UsersTable`" test rather than waiting
  for the component itself to be extracted first. `<details>` doesn't close on an outside
  click on its own, so a `mousedown` listener on `document` sets `.open = false` directly
  on a ref to the element whenever the click target falls outside it — the one piece of
  state here not left to the browser, since nothing else needs to react to open/closed.
- **Centered empty-state row inside a table** (`CommentsTable.tsx`, "no comments matching
  the criteria"): a single `<tr>` with one `<td colSpan={<column count>}>` combining
  `AdminTable.module.css`'s `.cell` (the shared padding/vertical-align) and `.emptyRow`
  (`text-align: center` and `#666`, the standard secondary/meta color above) — both
  generic enough that `PostsTable`/`UsersTable` could reuse them as-is. Keeps the table's
  header and column widths in place instead of swapping the whole table out for a `<p>`,
  so filters/sort/pagination controls around it stay usable while the result set is empty.
- **Page-level breathing room** (`/comments`): the `<h1>` gets `margin-bottom: 1em`
  (`.heading` in `app/comments/page.module.css`) and the main comments table gets
  `margin-top: 1em` / `margin-bottom: 1em` (folded into `AdminTable.module.css`'s `.table`,
  alongside the `width`/`border-collapse` every admin table already sets the same way) —
  plain fixed spacing around the two biggest visual blocks on the page, not tied to any
  sibling's own margin the way the "symmetric whitespace" pattern above is.

## TODO

- **Migrate `PostsTable.tsx` and `UsersTable.tsx` onto `AdminTable.module.css`.** Despite
  the name, it's only wired into `CommentsTable.tsx` today — a deliberate scoping
  decision (see the Approach section above), not yet a real shared abstraction. It now
  holds only what's genuinely generic (`.cell`/`.headerCell`/`.sortableHeaderCell`/
  `.nowrapCell`/`.nowrapSortableHeaderCell`, `.table`, `.row`/`.rowDeleted`, `.iconButton`/
  `.iconButtonDanger`/`.iconButtonMuted`, `.emptyRow`, `.actionButton`, `.dateFormatRow`/
  `.showDeletedRow`) — the comment-moderation-specific styles (`.approve`/`.pend`/`.spam`
  colors, the filter dropdown, the bulk toolbar, the help panel) already live in the
  separate, co-located `CommentsTable.module.css` instead, so they're not a migration
  concern. Bringing the other two tables onto the shared file still means reconciling
  real differences, not just swapping imports:
  - `PostsTable`'s `<table>` has no margin at all (the spacing comes from the search
    input above it, though `width: 100%`/`border-collapse: collapse` already match);
    `UsersTable`'s has `margin-top: 1em` but no `margin-bottom`; `AdminTable.module.css`'s
    `.table` currently has both. Pick one convention.
  - **Inspect `<tfoot>` usage before copying either one.** `UsersTable` wraps its
    date-format/show-deleted controls in `<tfoot><tr><td colSpan={11}>`;
    `PostsTable` (and `CommentsTable`, following it) uses plain sibling `<p>`/`<div>`
    elements after `</table>` instead — `.dateFormatRow`/`.showDeletedRow` in
    `AdminTable.module.css` assume the latter. These aren't equivalent — figure out
    which is actually right (semantically, `<tfoot>` is meant for summary rows *of the
    table's own data*, not unrelated controls like a page-size dropdown) rather than
    defaulting to whichever two of the three tables currently agree.
  - Neither table has the "always render headers, centered empty-row" behavior
    `CommentsTable` has (`.emptyRow`) — both still bail out to a bare `<p>No
    posts/users yet.</p>` before the table renders at all. Decide whether that's worth
    changing for consistency, or left alone as a deliberate difference (nothing forces
    all three tables to handle "no rows" identically).
  - `PostsTable`/`UsersTable` have no pagination or moderation-style multi-action
    buttons today. `.paginationBar` moved to `AdminTable.module.css` on the same "would
    this generalize" test as the filter dropdown above — either table could plausibly
    paginate someday. `CommentsTable.module.css`'s `.approve`/`.pend`/`.spam` colors stay
    comments-only regardless, though `.actionButton` (the generic border/padding
    wrapper, in `AdminTable.module.css`) is available if either table ever grows its own
    colored multi-action buttons.
