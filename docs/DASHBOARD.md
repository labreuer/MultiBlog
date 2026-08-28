# /dashboard — cards, Settings tiers, author-color plumbing

The signed-in landing page (`src/app/dashboard/page.tsx`): a header stating who
you are, three collapsible section cards, and Sign out. Everything on it is
self-service — the page never edits anyone but the signed-in user, and every
write re-derives its permission from the session server-side rather than
trusting which fields the form rendered.

## Section cards

Each major section is a native `<details className={styles.card}>` with its
`<h2>` inside the `<summary>` (`src/app/dashboard/page.module.css`). Native
disclosure rather than a client component on purpose: the collapse works in
server-rendered HTML with zero JS state, and a card's default comes down to
whether `open` is present in the JSX — Recent docs starts open, Settings and
Contributor profile start collapsed.

Two consequences worth knowing:

- **A collapsed card's content is rendered, just hidden.** Server work
  (queries, forms) happens either way, expansion is instant — and Playwright's
  actionability checks refuse to touch what's inside. Specs go through
  `openDashboardCard()` (`e2e/fixtures.ts`), which checks `open` first because
  clicking an already-open summary collapses it.
- **The "Recent docs" heading is a link inside a summary.** Clicking the link
  text navigates (to `/docs?authors=<your slug>` — the Authors filter in its
  default ANY mode, which is exactly the section's own `where` clause, so the
  link shows the same rows un-truncated); clicking elsewhere on the row
  toggles. The link renders only for roles `/docs` wouldn't bounce
  (`canManageDocs`).

ContributorPanel used to draw its own `<h2>` and a `border-top` divider; the
card supplies both now, so the panel starts at its first field. Its blurb
editor edits at the size the contributor card *renders* the blurb (0.9rem,
zero paragraph margin — `.blurb` in `ContributorCard.module.css`), not at
article-prose size; the blurb schema is a single paragraph with bold/italic,
so nothing `prose.module.css` restores can occur in it.

## Recent docs

Docs where the signed-in user is on the `DocAuthor` byline, newest
`updatedAt` first, capped at 10. Deliberately a plain `<table>`, not the
admin-table kit: the kit's contract is querystring-driven filters, sort and
pagination (CLAUDE.md "Admin tables are one kit"), and this widget has a fixed
query — the heading's link hands you to the real `/docs` table for anything
more. The Edit link renders unconditionally because byline membership *is*
`canUserEditDoc`'s own-doc rule, so no per-row authz query is needed; the
Author(s) cell reads `doc_metrics.byline`, the same string_agg of
`admin_initials` the `/docs` table shows.

## Settings

One combined write per Save (`src/app/actions/account-settings.ts`, the
`updateContributorProfile` shape), always keyed on the session user. Three
tiers, enforced twice — the form renders only what the viewer's tier allows,
and the action re-checks when the optional fields are present (a COMMENTER's
form omits them entirely rather than sending empty strings, which would trip
the server check):

| tier | may change | predicate (`src/lib/authz.ts`) |
|---|---|---|
| any signed-in user | name (trim-to-null, like the admin-side `updateUserName`) | — |
| AUTHOR+ | own `adminInitials`, own `color` | `canEditAuthorIdentity` / `AUTHOR_IDENTITY_ROLES` |
| EDITOR+ | nothing extra — *sees* the roster of EDITOR+ colors | `canViewAuthorColorRoster` / `COLOR_ROSTER_ROLES` |

Both role sets coincide with existing ones (`BYLINE_ELIGIBLE_ROLES`,
`TAG_CURATOR_ROLES`) and are stated independently for role-checks.ts's usual
non-delegation reason: they answer a different question, and a delegation
would couple the two.

The roster deliberately stops at EDITOR+ rather than listing every AUTHOR+
color: authors may be many, and avoiding collisions with all of them is more
work than a color is worth. The roster's point is the short list a person can
realistically coordinate with — the handful of editors and admins — not
global uniqueness.

Initials are deliberately not unique — any AUTHOR+ can claim any string.
Not a problem by design (decided 2026-08-27): `admin_initials` appears only
on admin surfaces (`/docs`' byline string_agg, the roster), where ambiguity
is a mild inconvenience among colleagues; published blog posts show the full
author name.

The Save button deliberately isn't the `/users` table's per-field autosave: a
color input fires per drag movement while its picker is open, and
`UsersTable.ColorCell` needs a native `"change"` listener to avoid saving on
every one of those — a Save button sidesteps the whole problem, and is also
what makes the live color sample below free.

### After a save, the session JWT is refreshed

`handleSave` calls `useSession().update({})` (the `{}` matters — an
argument-less `update()` is a GET and never sets `trigger: "update"`; see
`SessionRefresh.tsx`'s notes) before `router.refresh()`. Without it the JWT —
which baked name/role/color in at sign-in — keeps the old values until the
next full /dashboard load, because SessionRefresh runs once per mount and has
already fired by the time Save is pressed. Your own collab caret would keep
painting the old color.

### The color sample

The live preview under the picker repaints per drag movement (the controlled
input updates state on every `input` event; nothing hits the server until
Save). Both halves reuse the real rendering precisely so they cannot drift:

- The highlighted run is painted with `authorHighlightBackground()`
  (`src/lib/author-colors.ts`) — the exact rule `AuthorHighlightStyles` emits
  per author, theme-aware via `--anchor-tint`. If the formula ever changes,
  both call sites change together.
- The mock comment's marker is `QuoteThreadHeader` itself, with a `preview`
  prop that renders the same pixels minus the interactivity (no
  `role="button"`, no aria-label promising a jump with nowhere to go, cursor
  reset). A restyle of the real header drags the sample along for free; a
  copied-geometry sample would drift the first time.

## Where an author color is cached

There is no single policy — `User.color` is copied into four places with
different staleness windows:

1. **The session JWT** — baked at sign-in; refreshed by SessionRefresh once
   per /dashboard mount and by the Settings save path above. Everything
   reading `session.user.color` (your own caret, composers) sees this copy.
2. **`/api/users/colors`** — auth-gated dynamic route, reads Postgres per
   request, no cache headers. Always fresh.
3. **`useAuthorColors`'s per-mount cache** — each author id fetched once per
   editor mount into a ref, never re-validated; someone else's color change
   repaints your open editor only on reload. Seeds "self" from layer 1.
4. **Static post pages** — `/[slug]` (`revalidate = 60`) bakes thread colors
   into the HTML: the opener's live `User.color`, or `colorForSeed(email)`
   for anonymous commenters (a pure hash, stored nowhere, stable by
   construction). Up to 60s stale.

Not caches, though they look adjacent: `doc_link.overrideColor` is a stored
*choice*, and the dashboard's own form/roster/preview read the DB per request.

## e2e notes

`e2e/dashboard-settings.spec.ts` covers the three tiers with a user of each
role. Lessons already paid for, encoded there and in the fixtures:

- Reach inside a card only after `openDashboardCard()` (collapsed = hidden).
- The site header greets the signed-in user *by name* (a `/dashboard` link),
  so a page-wide `getByText(user.name)` strict-modes against it — scope to
  the card, and don't give a test user a name their own email contains (the
  "Signed in as *email*" line matches too).
- Raw `mouse.move`/`down` drags don't auto-scroll the way `click()` does;
  the cards made /dashboard tall enough that `avatar-crop.spec.ts`'s slider
  drag needed a `scrollIntoViewIfNeeded()` first. Any future coordinate-based
  gesture on this page needs the same.
- `dark-mode.spec.ts`'s near-white scan reads *data*: a listed contributor
  who picks a very light author color trips it on `/` (the avatar fallback
  paints raw `User.color`). A local failure there may be your own account's
  color, not a regression — and that is accepted, not a bug to fix at the
  source: near-white is a legitimate author color (a highlight wash reads
  fine light), so there is deliberately no luminance clamp in
  `updateAccountSettings`/`updateUserColor` (decided 2026-08-27). The
  fallback's *initials* stay legible either way — Avatar picks black or
  white per fill (`onAuthorColor`, `src/lib/author-colors.ts`).
