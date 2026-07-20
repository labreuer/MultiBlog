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
| `styles/prose.module.css` | shared across editor + public rendering; `.quote-highlight.pulse` keyframe animation |
| `app/page.module.css`, `app/authors/[id]/page.module.css`, `app/[slug]/page.module.css` | `:hover`-only underline on post-title links |
| `components/CommentSection.module.css`, `CommentNode.module.css`, `CommentForm.module.css` | none needed a pseudo-class directly, but were pulled into modules alongside `QuoteThreadHeader` for consistency when that pass happened (see git history 2026-07-20) |
| `components/QuoteThreadHeader.module.css` | state-dependent color pairs (`.arrowActive`/`.arrowDetached` etc.) previously done as inline conditional values |

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
| Quote-thread marker (active) | `#b8935a` (muted amber) | `QuoteThreadHeader.module.css`, `prose.module.css` `.quote-indicator` |
| Quote-thread marker (detached) | `#999` | `QuoteThreadHeader.module.css` |
| Quote highlight background | `#f2e8c8` (muted pale gold), pulses to `#e0c481` | `prose.module.css` |
| Error text | `crimson` | form validation errors |
| Diff view: insertion / deletion | `#0a5` on `#d4f7d4` / `#c00` on `#fbdada` | `history/[revisionNumber]/page.tsx` — not part of the palette above, ad hoc and only used there |

The amber/gold quote-thread colors were deliberately muted from an earlier, more
saturated version (`#fff3b0`/`#d4a017`) to read as minimalist rather than loud — see
git history for the before/after.

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

- **Centered reading column**: `max-width: 680px; margin: 0 auto;` — used by every
  public-facing page (`page.tsx`, `[slug]/page.tsx`, `authors/[id]/page.tsx`,
  `search/page.tsx`). Not yet a shared component/class; each page repeats it.
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
