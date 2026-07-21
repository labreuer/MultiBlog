# MultiBlog — Styling Conventions

This documents what's actually been decided/established in the codebase, not an
aspirational design system. Most of the app (admin table, editor, moderation queue,
history views) is still plainly-styled inline React `style` objects with no unifying
palette — that's fine and not a gap to close. The conventions below are the ones that
are real (used more than once, or deliberately chosen) as of 2026-07-20.

## Approach: inline styles by default, CSS Modules for anything stateful

Per CLAUDE.md's Conventions section: **inline styles are the norm; CSS Modules only
where media queries or pseudo-classes (`:hover`, `:focus`) are needed** — plain
`style={{...}}` can't express those. Existing modules and why each needed one:

| File | Needs a stylesheet for |
|---|---|
| `PostEditor.module.css` | `:hover` (toolbar/quote menu), `@media` (mobile toolbar) |
| `styles/prose.module.css` | shared across editor + public rendering; `.quote-highlight.pulse` keyframe animation; reads the per-thread `--thread-color` custom property (see Color palette) |
| `app/page.module.css`, `app/authors/[id]/page.module.css`, `app/[slug]/page.module.css` | `:hover`-only underline on post-title links |
| `components/CommentSection.module.css`, `CommentNode.module.css`, `CommentForm.module.css` | none needed a pseudo-class directly, but were pulled into modules alongside `QuoteThreadHeader` for consistency when that pass happened (see git history 2026-07-20) |
| `components/QuoteThreadHeader.module.css` | state-dependent color pairs (`.arrowActive`/`.arrowDetached` etc.) previously done as inline conditional values; `.arrowActive`/`.barActive` also read `--thread-color` |

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
| Diff view: insertion / deletion | `#0a5` on `#d4f7d4` / `#c00` on `#fbdada` | `history/[revisionNumber]/page.tsx` — not part of the palette above, ad hoc and only used there |

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
