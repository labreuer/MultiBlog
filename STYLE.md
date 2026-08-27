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
- `* { margin: 0; padding: 0; box-sizing: border-box; }` — a hard reset, and it strips
  default list and blockquote styling *everywhere*. `src/styles/prose.module.css` restores
  it for rendered post content, so **any new surface rendering post content needs its
  `.prose` class** or lists and quotes arrive unstyled.
  - The `box-sizing` half also **breaks pdfjs**, and the symptom is a ~2% *scale* error
    rather than a layout one. `PdfViewer.module.css` restores `content-box` for
    `.pdfViewer` and its descendants; don't "tidy" that away. Mechanism, and the related
    border-box/padding-box trap in coordinate capture: [docs/PDF.md](docs/PDF.md) §5.
- `body { height: 100vh; height: 100dvh }` — load-bearing, not cosmetic. A flex item's
  `flex-grow`/`flex-shrink` only has a budget to work with if its flex *container* has a
  definite (not `min-height`-only) main size: `min-height` lets the container's own size
  fall back to its content's, which defeats grow/shrink on children entirely. This is what
  lets `DocEditor.module.css`'s `.container` — and everything nested under it,
  `.editorFrame` → `.editorContent` — actually fill "the viewport minus the global
  `SiteHeader`" instead of silently reverting to content-based sizing and producing an
  always-present page scrollbar. `PostPublisher.module.css` has no equivalent budget to
  manage: nothing in it is a live editing surface any more (PLAN.md §15c).
- `body` also gets an implicit `overflow-y: auto`, as a side effect of its
  `overflow-x: hidden`, which makes `documentElement` the effective scroller. Use
  `window.scrollY`, **not** `body.scrollTop`, when checking scroll position or behavior.
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
| `--frozen` / `--frozen-text` | `#1c5bd6` / `#ffffff` | `#4d86e0` / `#ffffff` | The frozen reading view's border and FROZEN flag fill/text | `DocReadingBody.module.css`. A solid fill, not text on the page, so it's darker-on-light/lighter-on-dark by request rather than this table's usual brighter-on-dark-for-legibility rule; white on `#4d86e0` is ~3.3:1, below AA — accepted for a 0.7rem all-caps badge, not extended to body text |
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
  see the em-vs-rem note under Measuring and sizing in JS below — but centering itself is flexbox's job now,
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
The existing breakpoints (900px, 480px, 1180px) are for *reflowing* layouts, not overflow.

## Measuring and sizing in JS

### Relative to the neighbour, not the root — `em`, not `rem`

Sizing something as "half of the heading it sits next to" needs `em` (relative to the
*immediate parent's* font-size), not `rem` (relative to the *root* font-size). `rem` gives
you "half of whatever the root/site-header text renders at", which is a different — usually
smaller — number than the actual surrounding `h1`/`h2`.

The now-deleted `PostEditBadge.tsx`'s `(edit)`/`(edited)` link learned this the hard way:
`0.5rem` came out as a *quarter* of the `h1` on the single-post page (32px) and a *third* of
the `h2` in listings (24px), both because it was computing against the root's 16px instead of
either heading's own size. Worth keeping in mind for anything sized the same way later, even
though that component is gone (PLAN.md §15: a published post no longer surfaces a
live-staleness signal at all, by decision — see §15h).

### `ResizeObserver` — read the element, not the entry

When matching one element's width to another's (e.g. `PostsTable`'s search box tracking the
Title column's width), use the observed element's own `getBoundingClientRect().width` inside
the callback, **not** the callback's own `entries[0].contentRect.width`.

`contentRect` is always the *content* box — padding and border excluded — regardless of the
element's `box-sizing`. So on a padded `<th>` it under-reports by the padding, and copying
that value straight into another element's CSS `width` (itself `box-sizing: border-box` from
the global reset) makes it visibly narrower than the element it is supposed to match.

## Custom scrollbars, and anything positioned beside one

Added 2026-08-22, after the two marker rails flanking the PDF viewer
(`src/components/pdf/`, PLAN.md §19) turned out not to line up with the scrollbar between
them. Two independent causes, and the engine facts below are the generalisable half —
nothing here is pdfjs-specific, and the same rules govern any rail, minimap, or tick strip
drawn beside a scrolling box.

Numbers are measured, not quoted: a plain 400px scroller in a **headed** browser,
screenshotted and read back pixel by pixel, using the fact that at `scrollTop: 0` the
thumb's top edge *is* the track's top edge and at maximum scroll its bottom edge *is* the
track's bottom. That recovers the track without ever identifying an arrow glyph.

### The DOM reports thickness and nothing else

`offsetWidth - clientWidth` (vertical) and `offsetHeight - clientHeight` (horizontal) are
the only scrollbar dimensions available. Arrow-button height, thumb length and thumb
position have **no** API: no CSS property, no readable pseudo-element
(`getComputedStyle(el, "::-webkit-scrollbar-button")` returns the element's own style for
an unstyled pseudo), and no hit-testing path, since scrollbar parts aren't in the hit-test
tree.

**The obvious heuristic is wrong.** A button is not square. Measured on Windows 10:

| Engine | Thickness | Buttons (each end) | Track, of a 400px box |
| --- | --- | --- | --- |
| Chromium, default | 15px | **18px** | 364px |
| Chromium, `scrollbar-width: thin` | 10px | 12px | 376px |
| Firefox, default | 17px | 17px | 366px |
| Firefox, `scrollbar-width: thin` | 8px | 8px | 384px |
| WebKit | 0 (overlay) | none | 400px |

An overlay drawn at `top: <fraction>%` of the full box therefore pinches against the track
symmetrically — worst at the ends, exactly zero in the middle. At Chromium's default that
is 18px of error at fraction 0 and 1, ~9px at 0.25 and 0.75. It reads as "the markers drift
apart towards the ends", which is not obviously a scrollbar problem.

### The fix is to remove the inset, not to measure it

**Declaring any `::-webkit-scrollbar` rule makes Chromium and WebKit stop painting native
parts** and draw a buttonless track instead. Measured with a rule in place: buttons 0/0,
track == `clientHeight`, and the thumb's top within **0.0px** of
`track x scrollTop / scrollHeight` at every scroll position — so an overlay positioned by
plain fraction needs no inset at all.

Three consequences to weigh before reaching for it:

- **`scrollbar-width` and `scrollbar-color` override the pseudos in Chromium.** Setting
  either one silently reinstates the native scrollbar, buttons included. This is the trap:
  `scrollbar-width: thin` looks like a refinement to add later and undoes the whole thing.
- **Firefox is not fixable this way.** Gecko ignores the pseudos and has no way to drop its
  buttons. Its thumb is also shorter than proportional (32px where the proportional length
  is 36.6px), so its top travels further and drifts a further ~5px at the extremes even
  once the button inset is accounted for.
- **Safari's overlay scrollbar becomes a permanent gutter.** Styling the pseudos is what
  materialises it; there is no way to keep the overlay *and* drop the buttons elsewhere.

If none of that is acceptable, the remaining option is to hide the native scrollbar
outright (`scrollbar-width: none` plus `::-webkit-scrollbar { display: none }`, as
`SiteHeader.module.css`'s `.scroller` already does for a different reason) and make the
overlay itself the scroll control — exact on every engine, at the cost of implementing
drag, click-to-scroll and keyboard by hand.

### Insetting a thumb moves it

A scrollbar part ignores `margin`, so the way to slim a thumb inside a wider bar is a
transparent border plus `background-clip: content-box`. That shifts the **visible** thumb
down from its box by exactly the border width — a constant offset, invisible on its own and
obvious the moment something else is positioned against the box. A 12px bar with a 2px
inset put the native thumb a constant 2px below a fraction-positioned overlay. Prefer a
narrower bar whose thumb fills it edge to edge.

### An overlay beside a scroller is sized by the client box, not the border box

A flex sibling of a scrolling container stretches to that container's **border** box, but
the vertical scrollbar's track ends at its **client** box. The difference is whatever the
horizontal scrollbar takes — so as soon as content overflows sideways, fraction 1.0 sits
below the track's end and every marker drifts proportionally (measured at up to 9px on a
400px rail). Pin the overlay to `clientHeight`, which — unlike the button inset — is a
number the DOM does report.

Height is the only thing JS should supply here; the row/column layout stays CSS's, the same
split the margin-note rails use (CLAUDE.md, PLAN.md §18). Setting an explicit cross-size
needs **no `align-self` override**: `stretch` applies only while the cross size is `auto`,
so a definite height simply wins. Leave the height unset until the first measurement
arrives and the element stays full-height rather than collapsing for a frame.

### Regression coverage

**There is none, and there can't be locally.** Headless Playwright reports scrollbar
thickness **0** on all three engines — they use overlay scrollbars with no buttons — so no
spec in `npm run e2e` can observe any of this, including the 18px misalignment it was
written to fix. Same blind spot as the SSR/locale class in CLAUDE.md's Gotchas: the
environment the check runs in is the one environment where the bug doesn't exist. A
standing guard would need a headed project in `playwright.config.ts`, which nothing else in
the suite currently justifies. Verify by hand, headed, or with a throwaway pixel probe.

## Breakpoints and centred-column widths

Four reflow breakpoints, each with one job:

| Breakpoint | Reflows |
| --- | --- |
| `max-width: 480px` | Touch targets and padding (editor toolbar, `DocEditor`) |
| `max-width: 900px` | `/side-by-side`'s two doc columns stack (PLAN.md §14f); the landing page's contributor rail drops below the posts (§17l) |
| `min-width: 1180px` | Comments/annotations move from below the article into a margin rail (§18) |
| `(orientation: landscape) and (max-height: 500px)` | The doc editor drops every piece of stacked chrome, and its rail becomes a scrolling queue — marking the cards whose passage is on screen rather than aligning to them (§18c, §18f) |

The fourth is the only one that asks about **height**, and the only one scoped
to a single route. A phone held sideways has width to spare and about 390px of
height, so the editor spends the site header, the title, the connection badge,
the "View and Annotate" link and the settings panel on room to write.
`max-height: 500px` clears every phone in landscape (the tallest is around
430px) and excludes every iPad, whose landscape height is 834. It catches a
desktop window dragged unusually short too, which is deliberate — the trade is
about available height, and a 400px-tall window has a phone's problem.

The width it buys back is spent on a row that is **wider than the phone and
scrolls sideways as one piece**: the editor column, a 44px gutter, and the rail
at its full desktop 340px. This is the "Narrow viewports and horizontal
overflow" rule above rather than an exception to it — the scroller is
`.container`, not the page, because `html, body { overflow-x: hidden }` would
clip a page-level overflow unreachably.

Three consequences worth knowing before touching it.

- The 44px gutter is **derived, not chosen**: `MARKER_GAP +
  ANNOTATE_MARKER_SIZE + MARKER_GAP` from `use-editor-annotation-widget.ts`,
  whose preferred marker position is `frameRect.right + MARKER_GAP`. A gutter
  of exactly that lands the annotate marker between the text and the rail with
  no clamping, which is what lets an annotation be *written* here and not only
  read. `ANNOTATION_WIDGET_MEDIA_QUERY` has a second clause for the same
  reason: its 900px floor asks whether a centred 800px column leaves a gutter,
  and in this mode the gutter is reserved instead of inferred.
- The site header is hidden from `globals.css` rather than from the editor's
  own module, because it belongs to the root layout;
  `body:has([data-doc-editor-column])` is what keeps that off every other
  route.
- The rail engaging at 844px makes the doc editor the one surface whose
  margin-notes threshold is *not* `MARGIN_NOTES_MEDIA_QUERY` — it passes
  `EDITOR_MARGIN_NOTES_MEDIA_QUERY` to `MarginNotesProvider`, and the reading
  views deliberately do not, since their 340px rail comes out of a fixed
  reading measure rather than an elastic editor.

**`viewport-fit: cover` was tried here and reverted, on a device reading.**
Safari's default letterboxes the page inside the display's safe area — measured
at roughly 48 CSS px of black down each edge on a notched iPhone in landscape,
and in this mode those strips are the most obvious thing on screen. `cover`
hands them to the page, and the route declared it with the content padded back
inside the safe area by `env(safe-area-inset-*)`. On a real phone the sensor
housing obscured text regardless, and the mechanism is worth keeping rather
than the attempt: padding a **scroll container** by the insets only offsets
where its content *starts*: scrolled content passes straight through the padding
region, and this row is a scroll container by design. Protecting it would take a
non-scrolling wrapper holding the insets, and the strips are not worth that. So
the letterboxing stays, and it is Safari's, not ours.

The 1180px one is written **mobile-first** — single column by default, two columns
inside `@media (min-width: 1180px)` — where the other two are max-width. That is not
drift: `src/lib/margin-notes-layout.ts`'s `MARGIN_NOTES_MEDIA_QUERY` is matched at
runtime by the positioning hook, and a `max-width: 1179px` mirror in CSS would be the
same rule spelled as its off-by-one complement, which is exactly how the two drift apart
later. Anything else keying JS off a breakpoint should do the same.

Four centred-column widths now, and they are one decision rather than four:

- **680px** — listings.
- **800px** — full text (`/[slug]`, `/doc/[slug]`, `DocEditor`). This is *the* reading
  measure and never changes; every wider number below is 800 plus something.
- **1040px** — a listings-width main column plus the landing page's 280px contributor
  rail and its gap (§17l).
- **1180px** — 800 + 2.5rem + a 340px margin-notes rail (§18). Also the breakpoint it is
  applied inside, so the rail engages exactly when this width fits and the reading column
  is untouched at every narrower one. It was a 1200px threshold over a 1180px layout until
  an iPad measured 1194 in landscape and fell six pixels short of twenty pixels of slack.

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
