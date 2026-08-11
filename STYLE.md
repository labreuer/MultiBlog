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
make in passing. `components/table/AdminTable.module.css`, `components/CommentsTable.module.css`,
and `app/comments/page.module.css` are the first modules created under the corrected
default (not pseudo-class/media-query driven, unlike everything below); the rest predate
it. The first two are a deliberate pair, not a single file, and illustrate the "same name
as the component, unless shared" clause above concretely:

- `table/AdminTable.module.css` is named for the shared *concept* (styling common to the
  admin tables) rather than after one component. It was written that way while
  `CommentsTable` was still its only consumer; every admin table uses it now, and it moved
  into `components/table/` alongside the kit that owns it (see the admin-table kit section
  below). Holds what's judged generic: cell/header padding, sortable-column cursor, the
  soft-deleted-row `opacity`, the shared delete/restore icon button, table margins, the
  filter-row layout, the multi-select filter dropdown, the pagination bar, the row-status
  border, the bulk toolbar, and the querystring help panel.
- `CommentsTable.module.css` is co-located and named for `CommentsTable.tsx` in the usual
  way, holding only what's judged comment-moderation-specific and unlikely to ever
  generalize: the Approve/Pend/Spam colors and matching status text colors (comment-status
  semantics that will never apply to a post or a user row), plus `.postColumn`'s
  claim-the-slack width trick. It originally also held the bulk-action toolbar and the
  querystring help panel; both turned out to generalize after all and moved to the shared
  file when every table grew them (PLAN.md §16d) — the "would this also make sense on
  `PostsTable`?" test called those two wrong, which is worth remembering as evidence the
  test is a judgment call rather than a rule.

The dividing line was "would this style also make sense on `PostsTable`/`UsersTable` if
they adopted the same pattern?" — not "is this reused more than once" (nothing here
*is* reused yet, since `AdminTable.module.css` had one consumer at the time). A style with a plausible
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
| `app/doc/[slug]/page.module.css` | the doc reading view (PLAN.md §12n). No pseudo-class or media query — created because the alternative was a fresh set of fixed-value inline `style` objects, which the default above rules out. Also carries a state-dependent class pair (`.container` plus `.containerScrubbable`, the latter reserving room for the pinned scrub footer only when it renders), and a `.byline` mirroring `app/[slug]/page.module.css`'s rather than restating those six declarations inline |
| `components/DocEditor.module.css`, `DocSettingsPanel.module.css` | doc-side siblings of `PostEditor.module.css`/`PostSettingsPanel.module.css` (PLAN.md §12k) — `@media` (narrow container) and the same `.draggableRow`/`.dragOver` state pair, respectively. Trimmed to only what `DocEditor`/`DocSettingsPanel` themselves need: the toolbar/editor-frame/caret rules a doc's editor also uses live in `PostEditor.module.css` still, since `CollabEditorBody` (which owns them) is reused unmodified rather than forked. `DocEditor.module.css` also gained the `[data-empty]::before` + `attr(data-placeholder)` title placeholder (PLAN.md §12n, added 2026-07-29) — the same `content: attr(...)` trick a plain `::before` rule needs, which inline `style` can't express |

Numeric constants that also drive non-CSS geometry (e.g. `QuoteThreadHeader`'s
`HEAD_WIDTH`/`HEAD_HEIGHT`, used in both the SVG `viewBox` and a CSS `width`) stay as
JS constants passed via inline `style`, not hardcoded into the module — splitting a
value that two systems depend on invites drift.

## Global baseline (`globals.css`)

- Every color in the app is a token defined once in `globals.css`, driven by
  the OS's `prefers-color-scheme` via CSS `light-dark()` — see the Dark theme
  section below for the full model. `--foreground`/`--background` are the
  longest-standing tokens; every other role (surfaces, borders, status
  colors, the link color, the anchor-highlight tints) has its own. There is
  no untokenized color left in `src/` outside `globals.css` itself,
  `lib/author-colors.ts` (the author palette + the `NEUTRAL_THREAD_COLOR`
  fallback), `lib/safe-css.ts` (a validation regex), `manifest.ts`, and
  `layout.tsx`'s `viewport.themeColor` — see the grep guard in the Dark
  theme section for the enforced allow-list.
- `body` font: `Arial, Helvetica, sans-serif` — the sitewide default. Individual page
  containers currently override this (see Typography below); nothing has unified it.
- `* { margin: 0; padding: 0; box-sizing: border-box; }` — a hard reset. Anything
  rendering list/blockquote content needs to restore spacing explicitly (see
  `prose.module.css`, and the CLAUDE.md gotcha about it).
- Links: `a { color: var(--link); text-decoration: none; }`, `a:hover { text-decoration:
  underline; }` — sitewide default for **every** link except post titles (below).

## Color palette

| Token | Light | Dark | Role | Where |
|---|---|---|---|---|
| `--background` | `#ffffff` | `#0a0a0a` | Page background | `body` |
| `--surface` | `#ffffff` | `#1e1e1e` | Elevated panel/popover background | `SiteHeader`'s nav dropdown, `EditorChrome`'s quote menu, every annotation/doc-link popover, `AdminTable`'s sticky filter dropdown |
| `--surface-muted` | `#f6f6f6` | `#161616` | Recessed panel background | `AdminTable`'s bulk toolbar, `DocLinkGroupPanel`, `OwnDraftsList` |
| `--surface-hover` | `#f0f0f0` | `#2b2b2b` | Hover state on an elevated surface | `EditorChrome`'s quote-menu item hover, `DocLinkChooser`'s candidate hover |
| `--foreground` | `#171717` | `#ededed` | Body text | `globals.css`, `.prose`, post title links (deliberate override of the default link color) |
| `--text-secondary` | `#666666` | `#a0a0a0` | Secondary/meta text (dates, bylines, empty states) | pervasive |
| `--text-muted` | `#999999` | `#8a8a8a` | Muted/placeholder text, and the `--thread-color`/`--doc-link-color` fallback | detached-thread notices, the doc editor's "Untitled" placeholder, collab-caret fallback |
| `--border-subtle` | `#eeeeee` | `#242424` | Light divider (between list/article rows, under a byline) | every post-listing `<article>`, both reading views' byline rule |
| `--border` | `#d4d4d4` | `#3d3d3d` | Standard panel/input border | most `1px solid` rules in the app — collapses the old `#ccc`/`#ddd`/`#e0e0e0` |
| `--border-strong` | `#999999` | `#6a6a6a` | Heavier border where more presence is needed | `AdminTable`'s `.actionButton`, `SiteHeader`'s nav separator glyphs, dashed drop-target outlines |
| `--link` | `#3366cc` | `#7aa7ff` | Default link color | `globals.css`, sitewide. `#3366cc` fails AA (~3.4:1) on the dark background; `#7aa7ff` is ~9:1 |
| `--accent-wash` / `--accent-outline` | `#eaf1ff` / `#8888aa` | `#16233d` / `#6b7fb0` | Drag-over / selected-state highlight | `AdminTable`/`PostSettingsPanel`/`DocSettingsPanel` `.dragOver`, `YdocDebug`'s snapshot dot |
| `--success` | `#00aa55` | `#3ddc84` | Success text/status | `CommentsTable`'s Approved status, diff insertions, publish-history "(current)" |
| `--warning` / `--warning-text` | `#d4a017` / `#8a6d00` | `#e0b13a` / `#e5c351` | Warning border / warning text | row-status "saving" border / `CommentsTable`'s Pending status text — separate tokens because `#d4a017` alone fails AA as text |
| `--danger` | `#cc0000` | `#ff6b6b` | Danger/delete action | soft-delete controls, `CommentsTable`'s Spam status, diff deletions |
| `--error` | `crimson` | `#ff7b7b` | Form validation error text | every form's error paragraph |
| `--fill-success` / `--fill-warning` / `--fill-danger` | `#d4f5d4` / `#faf3c0` / `#f8d4d4` | dark-tinted equivalents | Moderation action fills, diff insertion/deletion backgrounds | `CommentsTable.module.css` `.approve`/`.pend`/`.spam`, `history/[eventId]/page.tsx` |
| `--shadow-color` | `rgba(0,0,0,.15)` | `rgba(0,0,0,.6)` | Popover box-shadow | every fixed-position popover |
| `--on-author-color` | `#ffffff` (both) | | Text/glyph on a solid `User.color` fill | quote-indicator badge, `Avatar`'s initials fallback, collab-caret name label — scheme-independent on purpose |
| `--shade-target` | `#000000` | `#ffffff` | The "shade toward" endpoint for a hover built with `color-mix()` | `.quote-indicator:hover` — "darken on hover" becomes "lighten on hover" on dark without duplicating the rule |
| `--anchor-tint*` (`-weak`/plain/`-active`/`-pulse`) | 18%/26%/45%/60% | 34%/44%/62%/80%, via `calc(base% + var(--dark) * delta%)` | The alpha strength for every quote/annotation/doc-link highlight tint | `prose.module.css`'s 12 `color-mix()` sites, `AuthorHighlightStyles.tsx`, `AnnotatableArticle.tsx`'s flash |

`--dark` (`0`/`1`, flipped by the same `prefers-color-scheme` query) is the one non-color
switch — `light-dark()` only accepts `<color>` arguments, so a percentage that needs to shift
with scheme goes through `calc()` against `--dark` instead. See the Dark theme section.

Quote-thread coloring was originally one fixed muted amber (`#b8935a`, itself toned down
from an earlier, more saturated `#fff3b0`/`#d4a017` — see git history), the same for every
thread. It's now **one real color per thread** — the thread-opener's `User.color`, or a
seeded fallback for anonymous commenters (PLAN.md §10 item 13) — carried as an inline
`--thread-color` custom property rather than a CSS Modules class, since there's one value
per *thread instance*, not a small fixed set of states. `--text-muted` is what renders when
that property is left unset: either a decoration span shared by threads of different colors
(a single span can only paint one background, so an ambiguous overlap goes neutral rather
than picking one author arbitrarily) or, coincidentally, the same shade used for the
unrelated "detached" state. `QuoteThreadHeader.module.css` used to fall back to a separate
literal (`#b8935a`) here instead of the shared muted gray — that inconsistency is gone; both
now fall back to `--text-muted`.

## Dark theme

OS-driven only (`prefers-color-scheme`) — no toggle, no `data-theme`, no persisted
preference. Every color token above is declared once, as
`light-dark(<light-value>, <dark-value>)`, on `:root { color-scheme: light dark; }`. That's
what lets a single declaration carry both values instead of a `@media` block per token: the
UA resolves `light-dark()` against the element's *used* `color-scheme`, so setting it on
`:root` (or later, `<html>`) flips every consumer at once.

- **`light-dark()` accepts `<color>` arguments only** — `light-dark(26%, 44%)` is invalid.
  The five anchor-tint percentages therefore go through a separate mechanism: a numeric
  `--dark: 0` (flipped to `1` inside the one remaining `@media (prefers-color-scheme: dark)`
  block in `globals.css`), read via `calc(base% + var(--dark) * delta%)`. That block is the
  *only* scheme-conditional CSS left in the app — everything else is a plain `light-dark()`
  token.
- **A future toggle is a one-line change, not a redesign**: add
  `html[data-theme="dark"] { color-scheme: dark; --dark: 1; }` (and the light equivalent).
  `color-scheme` inherits and `light-dark()` resolves against the consuming element's used
  value, not `:root`'s literally, so this flips every token below it with no other edits.
- **Any rule that sets `background` must also set `color`.** A background-only rule
  (`CommentsTable`'s `.approve`/`.pend`/`.spam`, `AdminTable`'s `.dropdownPanel`/
  `.bulkToolbar`) inverts into unreadable light-on-light the moment the foreground flips
  independently of it. Every surface token pairing in this codebase follows this rule now;
  keep it that way for anything new.
- **Browsers below the `light-dark()` floor** (Safari <17.5, Chrome <123, Firefox <120) don't
  fail gracefully. Custom properties parse permissively, so the declarations are *stored*;
  the break is at substitution, where "invalid at computed-value time" takes the *inherited*
  value for an inherited property (`color` silently inherits — harmless) or the *initial*
  value otherwise (`background` silently becomes `transparent`, `border` silently
  disappears). `globals.css` guards against this with an `@supports not (color:
  light-dark(#000, #fff))` block restating every token's light value directly — delete it as
  a unit once the floor is comfortable. `color-scheme` itself is supported far earlier
  (Chrome 81/Safari 13/Firefox 96), so without the guard an unsupporting browser would render
  dark native form controls on top of a broken light page.
- **The grep guard** — this should return nothing outside the allow-listed files named in
  the Global baseline section above:
  ```
  rg -n -e '#[0-9a-fA-F]{3,8}\b' -e '\b(white|black|crimson|silver|gray|grey|green|red|blue)\b' \
     -g 'src/**/*.{css,ts,tsx}' -g '!src/app/globals.css' -g '!src/lib/author-colors.ts' \
     -g '!src/lib/safe-css.ts' -g '!src/app/manifest.ts' -g '!src/app/layout.tsx' src
  ```
  The one intentional literal inside `prose.module.css` is the `#ffc800` amber fallback on
  `.annotation-highlight` (three sites) — a deliberate "no author color arrived yet" signal,
  not an oversight.

Known limitations of the "per-scheme alpha only" approach (author colors and the
`AUTHOR_COLOR_PALETTE` are unchanged; only the highlight *alpha* strengthens on dark — no
luminance/contrast computation was added):

1. **Perceived emphasis varies by author color.** A 44%-alpha wash of a dark palette entry
   (e.g. `#845ef7`) reads noticeably fainter over `#0a0a0a` than a light one (`#fab005`) at
   the same alpha, and the ordering reverses on light backgrounds. If this ever needs
   correcting, clamp lightness at consumption time — `oklch(from var(--thread-color)
   clamp(0.55, l, 0.8) c h)` — rather than editing the palette.
2. **White-on-author-color contrast is unchanged and unfixed.** `.quote-indicator`,
   `Avatar`'s initials fallback, and the collab-caret name label all paint `--on-author-color`
   (fixed white) over an arbitrary `User.color`; a light palette entry can be as low as
   ~1.8:1. Pre-existing, orthogonal to dark mode — not something this pass addressed.
3. **Stacked highlights get heavier on dark** (a span carrying both a quote highlight and an
   annotation mark composites two strengthened tints), which can cut into text contrast.
4. `--anchor-tint-pulse`'s collapse (55%/70% → one 60%→80% token) weakens the doc-link pulse
   flash relative to before (Δ15 vs. the old Δ25). If it reads too thin in practice, the fix
   is a sixth token used only at that one site, not a broader retune.

## Typography

Two competing font stacks are in play, both deliberate:

- **Reading surfaces** (article body, comments heading): serif —
  `Georgia, "Iowan Old Style", "Palatino Linotype", serif` — set on `.prose` (shared
  editor/render typography, `prose.module.css`), the post `<h1>` (`[slug]/page.module.css`
  `.title`), and the comments `<h2>` (`CommentSection.module.css` `.heading`). Chosen for
  reading comfort; `.prose` also sets `font-size: 1.125rem; line-height: 1.5`.
- **UI chrome** (nav, forms, byline metadata): system sans-serif —
  `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` on page containers — or
  simply inherits the global `Arial, Helvetica, sans-serif` body default where no
  container override exists (most admin/editor pages).

Because `prose.module.css` is shared by the live TipTap editor and the public
rendering, the serif treatment applies to both — editing and reading now look the same
by design, not by accident.

## Layout patterns

- **Centered reading column**: `max-width: ...px; margin: 0 auto;` — not yet a shared
  component/class; each page repeats it. Three widths, kept deliberately separate:
  - `800px` on pages showing full post text — `[slug]/page.module.css` (public post
    display) and `PostEditor.module.css` (editor).
  - `680px` on listing/excerpt pages — `authors/[id]/page.tsx`, `search/page.tsx`. These
    show post previews, not full text, so they weren't widened alongside the two
    full-text surfaces above.
  - `1040px` on the landing page (`page.module.css` `.layout`, PLAN.md §17l) — not a
    fourth, drifted number: it's a two-column CSS grid (`minmax(0, 1fr) 280px`) built
    for the contributor sidebar, and the main column inside it still lands at roughly
    680px; the extra width is the 280px sidebar plus its `2.5rem` gap. Collapses to a
    single column under 900px, with the sidebar (second in DOM order) simply flowing
    below the post list rather than needing an `order` override.
- **Post-listing article block**: `padding: 1.5rem 0; border-bottom: 1px solid #eee;`
  — repeated verbatim across home, author, and search listings.
- **Avatar with a generic-standin fallback** (`ContributorCard.module.css` `.avatarFallback`,
  PLAN.md §17e): when `User.image` is unset, a 40px circle filled with `User.color`
  (already `#rrggbb`-validated on write) showing `User.adminInitials` — no separate
  silhouette asset, since both columns already exist and are already treated as
  general-purpose elsewhere (the admin table just calls the latter "Initials"). The `<img>`
  branch reuses the `eslint-disable-next-line @next/next/no-img-element` precedent
  `UsersTable.tsx`'s own Image column set first: arbitrary remote avatar URLs, not a fixed
  asset set `next/image` could optimize without a `remotePatterns` entry per provider.
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

## Narrow viewports and horizontal overflow

Added 2026-08-11, after a wide admin table turned out to be unreachable on a phone —
columns past the right edge were clipped with no scrollbar in either direction. Two
separate causes, in two files; both halves are needed and neither is obvious from the
other's symptom.

### `body > main { width: 100%; min-width: 0 }` (`globals.css`)

`body` is a column flex container (it needs a definite height so the editor's
`flex-grow` children have a budget — see the Global baseline section), so every page's
`<main>` is a flex item. Every page also gives it `margin: <n>rem auto` inline. Left
alone, main sizes itself to its *content* rather than to the viewport, and because
`body` carries `overflow-x: hidden` the excess is silently clipped instead of becoming
a scrollbar. Anything inside main then lays out against that inflated width, so a
scroll container inside it has nothing to overflow — which is why the table wrapper
below does nothing without this rule.

- **`width: 100%`** — cross-axis `auto` margins suppress a flex item's default
  `align-self: stretch`, so main falls back to fit-content, which floors at its
  content's min-content width. Measured in Chromium at a 390px viewport: main 775px.
- **`min-width: 0`** — WebKit only. A flex item's `min-width: auto` is a content-based
  automatic minimum; per [CSS Sizing](https://www.w3.org/TR/css-sizing-3/) that applies
  to the **main** axis, which for a column container is vertical, so on `width` it
  should resolve to `0`. iOS Safari applies it on the cross axis anyway, flooring main
  at min-content *even with `width: 100%` set*, after which main's own inline
  `max-width` caps the result. Measured on an iPhone: `body` 390px, `main` **1000px** —
  i.e. exactly its `max-width`.

The general `min-width: 0` flexbox trap is very widely documented, but almost always
for **row** containers, where the automatic minimum is on `width` legitimately.
`DocColumn.module.css` carries the same note for the grid-item version.

**This cannot be reproduced locally.** Chromium and Playwright's WebKit both size main
to 390px without `min-width: 0`; only a real iOS device shows 1000px. Verify a change
here on a phone, not in the browser pane or a WebKit Playwright project.

The per-page inline `max-width` still caps main on wide screens and the `auto` margins
still centre it, so desktop layout is unchanged.

### `.tableScroll` (`AdminTable.module.css`)

Wraps the `<table>` — and *only* the table — in an `overflow-x: auto` box, so a table
too wide for the viewport scrolls in place. Scoped that tightly on purpose:
`ColumnPicker`'s and `AuthorFilterPanel`'s `position: absolute` panels live in
`.filterRow` above it, and an `overflow-x: auto` ancestor becomes a clipping ancestor
for them (CSS can't leave one axis visible while the other isn't, so `overflow-x: auto`
also computes `overflow-y: auto`). `popover-placement.ts` documents the same trap for
`/side-by-side`.

Its table also gets `min-width: min-content` — belt and braces rather than a diagnosed
fix. A table in a scroll container has no business being squeezed below the width its
cells need, and saying so outright means the behaviour doesn't rest on `width: 100%`
overflowing its container, which is engine-dependent enough not to rely on. Free when
the table already fits, since `min-content` is below `100%` then.

### Regression coverage

`e2e/admin-table.spec.ts`'s "a narrow viewport scrolls the table instead of clipping
it" drives all five tables at 390px and asserts main never exceeds the viewport, the
wrapper really scrolls, and the page itself doesn't scroll sideways. It guards the
`width: 100%` half only — verified to fail without it (main 945px vs a 390px viewport).
The `min-width: 0` half is untestable locally, per above.

### Adding a new wide surface

Anything that can exceed the viewport (a table, a code block, a diagram) belongs in its
own `overflow-x: auto` container. Don't reach for a `@media` breakpoint: `overflow-x`
is self-activating and needs no width threshold, which is why this section defines none.
The existing breakpoints (900px, 480px) are for *reflowing* layouts, not overflow.

## The admin-table kit (`components/table/`)

Every admin table — `/posts`, `/docs`, `/users`, `/comments`, `/annotations`, and
`/site-settings` for the row-status border alone — now renders through one kit
(PLAN.md §16). `AdminTable.module.css` moved into `components/table/` alongside it and is
genuinely shared rather than aspirationally named. This section's earlier TODO listed four
conventions to reconcile before that could happen; all four are settled, and the answers
are worth keeping because they'll come up again:

- **Table margins:** `.table` carries `margin: 1em 0`. `PostsTable` previously had none
  (its spacing came from the search input above it) and `UsersTable` had only a
  `margin-top`; the shared rule wins and neither special case survived.
- **`<tfoot>` vs. sibling elements:** siblings after `</table>`. `UsersTable`'s
  `<tfoot><tr><td colSpan={11}>` wrapper around its date-format/show-deleted controls is
  gone. Semantically a `<tfoot>` is for summary rows *of the table's own data*, not page
  controls, and `.dateFormatRow`/`.showDeletedRow` always assumed the sibling form.
- **Empty state:** every table now renders its header row plus a centered `.emptyRow`
  (`text-align: center`, `#666`) instead of bailing to a bare `<p>No posts yet.</p>`. With
  filters and pagination present this stopped being a matter of taste: the controls that
  produced an empty result have to stay on screen to undo it.
- **Pagination and multi-action buttons:** `.paginationBar` and `.actionButton` are in the
  shared file and used by all of them. `CommentsTable.module.css` keeps only what encodes
  comment-moderation semantics — the `.approve`/`.pend`/`.spam` fills, the status text
  colors, and `.postColumn`'s width trick.

Two additions the kit brought with it:

- **Row status** (`.rowStatusCell` + `.rowStatusEdited`/`.rowStatusSaving`/`.rowStatusError`/
  `.rowStatusSaved`, PLAN.md §16f): a 3px left border on a row's first `<td>` — transparent
  when idle, `#999` edited, `#d4a017` saving, `#c00` error, `#0a5` saved. It replaces the
  `savedPulse` keyframe animation that `UsersTable.module.css` and
  `SiteSettingsTable.module.css` each held a copy of (both files are gone). The colors are
  the established palette above rather than new ones; the transparent idle border is load-
  bearing, since without it a row would shift 3px sideways the first time it was touched.
- **`.searchInput`, `.bulkToolbar`, `.bulkDangerSpacing`, and the `.help*` panel rules**
  moved from `CommentsTable.module.css` into the shared file when the kit's `SearchBox`,
  bulk toolbar and `FilterHelp` became components every table uses.
