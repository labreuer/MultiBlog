# MultiBlog — Architecture Plan

A multi-author blog with post revisions and tree-structured comments that can quote
sections of an article, with an inline indicator showing which passages have comments.

Decisions locked: **Node/TypeScript**, **ProseMirror** editor, **small/hobby scale**,
**self-managed Linode/Ubuntu**.

---

## 1. The one genuinely hard part

Everything here is routine except one thing: **anchoring a comment to a span of article
text so the highlight stays on the right words after the author edits and re-publishes the
post.** Get this right and the rest is plumbing. The whole design below is shaped around it.

The core idea:

- Article content is a ProseMirror document (JSON). Each publish creates an **immutable
  revision** of that doc.
- A comment thread does **not** store "characters 412–438". It stores a position range
  *relative to a specific revision* plus the literal quoted text.
- Comment highlights are rendered as ProseMirror **decorations** (an ephemeral display
  layer), never as marks baked into the author's content. Readers commenting can never
  mutate an author's document or revision history.
- When a new revision is published, we compute the change between old and new docs and
  **remap** every anchor's range forward. Anchors whose text survived move with it; anchors
  whose text was deleted become **detached** and move to a sidebar instead of vanishing.

See §5 for the full mechanism.

---

## 2. Stack

| Concern        | Choice | Why |
|----------------|--------|-----|
| Language       | TypeScript (Node 20+) | Locked. |
| Framework      | **Next.js (App Router)** | Published posts server-render/SSG for SEO; the editor and comment layer hydrate client-side. Remix is a fine leaner alternative. |
| Editor         | **TipTap** (wraps ProseMirror) | You get ProseMirror's model exactly, but schema, marks, and React integration are far less boilerplate. |
| Real-time collab | **Yjs + `y-prosemirror`**, server = **Hocuspocus** | Real-time co-editing in v1 (§3a). Hocuspocus is the TipTap-native Yjs websocket backend with auth + persistence hooks. |
| DB             | **PostgreSQL** | Recursive CTEs for comment trees, JSONB for PM docs, room to grow. SQLite would also work at this scale, but Postgres costs little extra on a box you already run. |
| ORM/migrations | **Prisma** | Great DX and migration story for a solo/small project. Drizzle if you prefer something lighter and closer to SQL. |
| Auth           | **Auth.js** (email/password + optional GitHub/Google OAuth) | Integrates with Next; Lucia is the more hands-on alternative. |
| Sanitization   | DOMPurify + a strict TipTap schema | Mandatory for reader-submitted comment HTML/JSON (XSS). |
| Diff/remap     | `prosemirror-changeset` and/or `prosemirror-recreate` | For revision diffs and anchor remapping (§5). |

---

## 3. Roles & "multi-author"

**Decided:** a post can have multiple authors, and the **listed byline is decoupled from
who actually edited.** `post_authors` is a manual byline list (chosen from user accounts,
so author pages work); edit attribution lives separately in `revisions.editor_id`. You can
credit three co-authors on a post even if only one of them touched a given revision, and
vice-versa.

Roles: `admin` (everything, user mgmt), `editor` (edit/publish any post, moderate
comments), `author` (write/publish own posts, sits on bylines), `commenter` (name+email or
logged-in — see §6).

### 3a. Real-time collaborative editing (in v1)

**Decided:** build real-time co-editing from the start with a CRDT layer — **Yjs +
`y-prosemirror`**, wired through TipTap's Collaboration extension.

- **Transport/server:** a **Hocuspocus** websocket server (the TipTap-native Yjs backend).
  It owns the live shared document, broadcasts updates, and exposes persistence + auth hooks.
- **Live state vs. revisions:** the live document is a Yjs doc, persisted as Yjs updates
  (binary) so a reconnecting client resumes mid-edit. This is **separate** from the
  immutable revision history. **Publishing snapshots the current ProseMirror doc into a new
  `revisions` row** (§4); the Yjs update log is the working state between publishes.
- **Awareness:** Yjs "awareness" gives presence (who's in the doc, cursors/selections) for
  free — useful even with the byline being separate from edit attribution.
- **Attribution:** `revisions.editor_id` at publish records who pressed publish.
  Finer-grained credit — colored per-author highlighting of contributions *since the last
  revision*, Etherpad-style (§3d) — layers on top via an inline `authorHighlight` mark
  carrying the author's `User.color`, applied to newly-typed text and cleared (a real,
  synced transaction) on every save so it always reflects only what's new. It's
  working-session state, not content — stripped before anything reaches `revisions.doc`.
- **Auth:** the Hocuspocus `onConnect`/`onAuthenticate` hook validates the user's session
  (via Auth.js token) and checks they may edit that post before joining the room.
- **`next.config.ts`: `serverExternalPackages: ["yjs"]`.** Next's server compiler builds
  separate bundles per layer (RSC, SSR); without this, each layer gets its own copy of
  yjs's module scope, which trips yjs's own globalThis double-import guard
  ("Yjs was already imported...", [yjs#438](https://github.com/yjs/yjs/issues/438)) even
  though only one yjs version is installed. Marking it external makes every server-side
  layer resolve it through Node's own `require` cache instead. Doesn't affect the browser
  bundle.
- **`editor.getJSON()` needs a JSON round-trip before it can cross a Server Action
  boundary.** ProseMirror builds every non-empty node/mark `attrs` object via
  `Object.create(null)` (`computeAttrs`, prosemirror-model), and `Node`/`Mark#toJSON`
  pass that null-prototype object straight through. React's Server Action argument
  encoder treats any object whose prototype isn't `Object.prototype` as opaque and
  silently substitutes an inert `"$T"` placeholder, which throws the moment server code
  (e.g. Prisma serializing the `doc` for the jsonb column) tries to read it — surfacing
  as "Cannot access toStringTag on the server. You cannot dot into a temporary client
  reference...". Only docs with attrs-bearing marks/nodes (`authorHighlight`,
  `orderedList`'s `start`, heading levels, etc.) hit this, which is why it tracked
  specific content rather than a specific post. `toPlainJSON()`
  (`src/lib/tiptap-schema.ts`) — a `JSON.parse(JSON.stringify(...))` round-trip — forces
  every nested attrs object back to a plain prototype; `PostEditor.tsx` applies it to
  `editor.getJSON()`'s result at all three call sites that reach a server action
  (`handleSaveDraft`, `handlePublish`, `handleSchedule`). A known TipTap+Next.js
  interaction, not specific to this codebase — same root cause and same
  `JSON.parse(JSON.stringify(...))` fix reported in
  [tiptap#4805](https://github.com/ueberdosis/tiptap/issues/4805).

This raises the ops footprint (a second long-running service + websocket proxying — see §7),
which is the main cost of doing it now rather than later. See §3d for the editor UI and
mechanics built on top of this transport layer.

### 3b. User management (`/users`)

**Decided:** an ADMIN-only page for managing every `User` account directly, distinct from
the per-post author/role concerns above — no schema changes needed beyond the soft-delete
columns shared with `posts` (§4), since it's otherwise a UI + server-actions layer over the
existing `users` table.

**Access:** gated by `isAdmin(role)` (`src/lib/authz.ts`) — same shape as `/posts`'s
`canManagePosts` gate (§3c): redirect to sign-in if unauthenticated, an inline "doesn't have
permission" message for a signed-in non-admin. Linked from `SiteHeader` and `/dashboard`
alongside "Manage Posts", admin-only.

**Table** (`UsersTable.tsx`), one row per user: `name`, `email`, `adminInitials`, `role`,
`image`, `moderationPolicy`, `color`, `createdAt`, a link to that user's published posts (via
the existing `/authors/[slug]` page, blank if they have none), a `comments` placeholder column
reserved for future comment-management UI (no data wired up yet), a link to that user's
slug-management page (`/users/[id]/slug`, §4a), and a trailing delete/restore icon column whose
header is the same sortable black-`IconTrash` control as `PostsTable`'s (§3c). No `id` column
— nothing on the page needs a user's raw
id visible, and `NameCell`/`DeleteCell` etc. already thread `row.id` through as a prop rather
than reading it off the DOM. `name` has a `minWidth` (double its previous rendered width, added
2026-07-21) since it's the column most likely to need room for a longer value; `createdAt` is
`white-space: nowrap` so its `yyyy-MM-dd` value can't wrap at the hyphen (`nowrapTd`/
`nowrapSortableTh`, the same pattern `PostsTable.tsx` uses — see STYLE.md).
Sorting reuses `useSortableRows` (shared with `PostsTable`) on the textual/status columns —
`role` sorts by privilege order (ADMIN > EDITOR > AUTHOR > COMMENTER), not alphabetically —
plus the same client-side date-format dropdown as `PostsTable`. Unlike `PostsTable`, there's
no search box.

**Email verification is shown as color, not text**: dark green (`#0a5`) with a tooltip
showing the verification date if `emailVerified` is set, dark red (`#c00`) with no tooltip
otherwise.

**Editable in place:** `name`, `adminInitials`, `role`, `moderationPolicy`, and `color`,
each independently backed by its own server action (`src/app/actions/users.ts`), admin-
gated and validated server-side regardless of what the client UI allows (a client can call
a server action directly, bypassing whatever the `<select>`/`<input>` options suggest). No
create-user flow yet; delete is soft and restorable (below).

- Text fields (`name`, `adminInitials`) save on blur or Enter, not per keystroke.
  `adminInitials` is required (schema: non-nullable) — enforced both client-side (instant
  revert + inline error, no round-trip) and server-side; `name` is nullable, and an emptied
  field saves as `null`.
- `role` and `moderationPolicy` are `<select>` dropdowns that save immediately on change —
  a discrete choice needs no debouncing.
- `color` is a native color picker that saves on the DOM's `change` event, not React's
  `onChange`: React wires `onChange` to the continuous `input` event for this element type,
  which fires on every drag movement and every keystroke in the picker's own hex field,
  while `change` fires exactly once, when the picker closes.
- **Self-lockout guard:** `updateUserRole` refuses to let an admin change *their own* role
  away from ADMIN, so a single admin can't accidentally lock themselves out. It does not
  guard against the last remaining admin among several being demoted by someone else.
- **Soft delete/restore:** the same trailing icon column, delete/restore action shape, and
  shared "Show deleted rows" checkbox mechanism as `/posts` (§3c — see there for the general
  design: dimmed-not-removed row, per-visit `revealedIds` reveal instead of the checkbox
  auto-checking, the hydration-mismatch reason it must default unchecked). `deleteUser`/
  `restoreUser` (`src/app/actions/users.ts`) are ADMIN-only (`requireAdmin`) and, like the
  role guard above, refuse to let an admin delete *their own* account — unconditionally here,
  since unlike a role change there's no harmless variant of deleting yourself.

**Save feedback:** a successful edit pulses the whole row light green
(`UsersTable.module.css`'s `rowSavedPulse` keyframe, `#d3f9d8` fading to transparent, ~1s),
triggered imperatively via a per-row DOM ref rather than React state so a second save on the
same row mid-pulse restarts the animation instead of no-op'ing.

### 3c. Post management (`/posts`)

**Decided:** an admin/editor/author table for managing every `Post` — not the editor itself
(§3a), but the list-and-triage view: what's published/scheduled/draft, how many comments are
pending, how far a draft has diverged from what's live, and (soft) deleting a post without
losing it.

**Access:** gated by `canManagePosts(role)` (ADMIN/EDITOR/AUTHOR, `src/lib/authz.ts`) —
redirect to sign-in if unauthenticated, an inline "doesn't have permission" message for a
signed-in role that can't manage posts. An AUTHOR sees only posts they're a byline author on
(`authors: { some: { userId } }`); ADMIN/EDITOR (`canEditAnyPost`) see every post. Linked from
`SiteHeader` as "Manage Posts."

**Table** (`PostsTable.tsx`), one row per post: Title (→ editor), Author(s) (byline
`adminInitials`, `", "`-joined in `bylineOrder`), Published (→ public post, blank if
unpublished; a scheduled-but-not-yet-due post shows its target date with a countdown
tooltip), Comments (approved count, with a "(in moderation N)" link to that post's moderation
queue when there's anything pending), Revisions ("+N" ahead of the published revision, or
"current" when they match, → history), Last edit by/at, Created at, and a trailing unlabeled
delete/restore icon column (below).

**Sorting & search**: column headers sort the table client-side via the shared
`useSortableRows` hook (also used by `UsersTable`, §3b) — a plain click sorts by just that
column, Ctrl-click adds it as a secondary/tertiary key without disturbing already-sorted
columns' positions (shown via a superscript priority number next to the ▲/▼). A label-less
search box above the table live-filters by title (case-insensitive substring, same
"hobby-scale, no index" approach as the public `/search`), width-matched to the Title column,
applied ahead of the active sort so an already-chosen sort stays applied to the filtered set
— no "no results" message for an empty match set, the table just renders no rows. A
client-side date-format dropdown (`yyyy-MM-dd` default, three alternates) re-renders every
date in the table immediately.

**Soft delete/restore**: the trailing column's `IconTrash`/`IconTrashOff`
(`@tabler/icons-react`) toggle button, no confirmation dialog — the action is its own undo.
`deletePost`/`restorePost` (`src/app/actions/posts.ts`) reuse the same `canUserEditPost` gate
as the editor itself: you can delete what you can edit. A deleted row stays in the table
(dimmed, icon swapped to "restore") instead of disappearing, so undoing a mis-click is one
more click in place rather than a trip elsewhere. The column's header is itself a black
`IconTrash` (deliberately not the row buttons' red — a neutral sort control, not a destructive
one) wrapped in a button matching `DeleteCell`'s own padding/border/background, so its icon's
left edge lines up with the row icons below it; clicking it sorts by deleted status like any
other column (same `UsersTable`, §3b).

**"Show deleted rows" checkbox**: defaults unchecked, persisted per-tab in `sessionStorage`
(`src/lib/use-show-deleted.ts`, shared with `UsersTable`, §3b). Must default to `false`
unconditionally rather than read `sessionStorage` inside the initial `useState`, or the value
computed during SSR (always `false` — no `window` on the server) can disagree with the
client's hydration render (which does have `window` and may see an already-persisted
`true`), producing a genuine content-mismatch hydration error, not just a lint nitpick — the
persisted value is applied one render later instead, from a `useEffect` after mount, once
hydration has already committed against the matching `false` state. Deleting a row while the
checkbox is unchecked keeps just that row visible via a separate per-visit `revealedIds` set
(row ids deleted during the current visit), rather than flipping the shared checkbox: the
checkbox is a pure, honest "show every deleted row" toggle the user controls directly, so
deleting one row can't have the side effect of un-hiding every *other* already-deleted row
the checkbox was intentionally hiding. Toggling the checkbox by hand calls `router.refresh()`;
the reveal-on-delete path does not, since the row's own delete action already refreshes the
table to pick up its new state.

### 3d. The post editor (`/posts/[id]/edit`)

**Decided:** `PostEditor.tsx` is the single surface for writing, saving, publishing, and
managing one post. Real-time collaborative editing itself — the CRDT/Yjs transport layer —
is §3a's concern; this section covers what's built on top of it: the editing surface and
toolbar, save/publish/unpublish/schedule mechanics, author attribution and live-scrubbable
history, the status line(s), and a collapsible Settings panel for the handful of per-post
knobs that don't belong on the main editing surface.

**Editing surface & toolbar:** TipTap v3, immutable append-only revisions, publish, diff +
restore-as-new-revision. The editor is responsive and fills the window height down to a
300px floor rather than growing or shrinking with content. The toolbar covers standard
formatting plus a "Clear formatting" button and a split-button Quote control exposing
`wrapIn`/`lift` directly, for multi-level blockquote nesting (`toggleBlockquote` can only
toggle one level — it can't nest deeper).

**Save/publish/unpublish/schedule mechanics:**

- **No-op revision skip**: `saveDraft`/`publishPost`/`schedulePost` all route through a
  shared `resolveRevision` (`src/app/actions/posts.ts`) that compares the incoming
  title+doc against the latest `Revision` row via `docsEqual` (`src/lib/diff.ts`) — an
  order-independent deep-equal, not the display-oriented word-level `diffText` — before
  creating a new one. Necessary because Postgres `jsonb` doesn't preserve object key order on
  read-back, so a plain `JSON.stringify` compare against the doc as just typed would
  false-positive as "changed" on key order alone; it's also what makes "typed something, then
  undid it" a no-op save, without inspecting the live Yjs doc. See TIPTAP.md for a ProseMirror
  JSON-shape gotcha this equality check is sensitive to.
- **No `status` column**: draft/scheduled/published is derived at read time
  (`derivePostStatus`, `src/lib/post-status.ts`) from `publish_revision_id`/`published_at`
  alone, rather than stored as a separate field that could drift out of sync across
  unpublish/republish/schedule cycles. Used both for display (editor status line, admin
  table) and for real gating logic: `schedulePost`'s scheduling guard (below),
  `unpublishPost`'s draft check and its `PostPublicationEvent` type choice, and
  `submitComment`'s "this post isn't open for comments" check.
- **Scheduling uses no separate column and no background sweep**: `schedulePost` sets
  `publish_revision_id` **immediately** — exactly like an immediate publish — and just sets
  `published_at` to a future date instead of `now()`. Visibility is purely
  `publish_revision_id IS NOT NULL AND published_at <= now()`, expressed as a query-time
  WHERE clause (`publishedPostWhere()` in `src/lib/post-status.ts`) for every public-facing
  query, or the equivalent post-fetch check (`derivePostStatus(post) === "published"`) for
  code that already has the row in hand, like the comment-eligibility check above —
  centralized in those two helpers rather than either condition being repeated ad hoc, since
  forgetting it at even one call site would leak a not-yet-due post early. Thread remapping
  (`remapThreadsToRevision`) happens synchronously inside `schedulePost` itself, at the moment
  `publish_revision_id` changes.
- **Unpublish** (`unpublishPost`): sets `publish_revision_id` to `null` with no new revision;
  `published_at` is left untouched (inert whenever `publish_revision_id` is null — nothing
  reads it in that state, so there's nothing to clean up). Doubles as "cancel schedule" — a
  post is never both published and scheduled at once (`derivePostStatus`), so one action
  unambiguously covers both starting states.
- **Scheduling guard**: `schedulePost` is disallowed only when `derivePostStatus(post) ===
  "published"` (actually live right now) — not merely when `publish_revision_id` is set,
  since a *scheduled* post has that set too. This is what guarantees a live post's served
  content can never go dark while a future edit is pending, while still allowing a reschedule
  of an already-scheduled post.
- **Rescheduling freezes the target until you reschedule again**: because
  `publish_revision_id` is set once, at the moment Schedule/Reschedule is clicked (via the
  same `resolveRevision` no-op-skip used everywhere else), a plain `saveDraft` afterward
  creates a newer revision but does *not* change what a pending schedule will publish — you
  have to click Reschedule again to move the target forward.
- **`PostPublicationEvent`**: an append-only audit log
  (`PUBLISHED|UNPUBLISHED|SCHEDULED|SCHEDULE_CANCELED`, `postId`, `revisionId?`,
  `scheduledFor?`, `actorId?`), written by every action above. Exists because
  `Revision.createdAt` alone can't answer "when did this go live/offline," since state
  transitions like unpublish/reschedule don't always produce a new `Revision` row. No UI
  reads it yet; it's a write-only audit trail, not a source of truth read on any hot path —
  visibility/status derivation never queries it.

**Author attribution & live history** — fulfills the "finer per-author edit credit" idea
noted in §3a:

- **Per-author highlighting**: an `authorHighlight` TipTap mark
  (`src/lib/author-highlight-extension.ts`), not a suggest/accept "tracked changes"
  workflow — an `appendTransaction` plugin tags newly-typed text with the current user's
  id, skipping Yjs-sync-origin transactions (`isChangeOrigin`) so remote edits never get
  mislabeled. Rendered via `User.color` (assigned at sign-up, `src/lib/author-colors.ts`),
  painted through a small dynamically-generated `<style>` tag rather than baked into the
  mark, so a color lookup is one small API call away (`/api/users/colors`) rather than schema
  data. Cleared on every save (`removeMark` transaction in `PostEditor.tsx`) so highlighting
  always reflects only "since the last revision," not the post's whole life — see the
  CLAUDE.md gotcha. Stripped (`stripMarkFromDoc`) before anything reaches `revisions.doc`;
  `contentExtensions` (the shared editor/seed/render schema) never has to know the mark
  exists.
- **Live-scrubbable history** (`/posts/[id]/live-history`, `LiveHistoryViewer.tsx`):
  read-only, and stays live-connected rather than being a one-time snapshot. Hocuspocus's
  `onChange` hook (`server/collab.ts`) appends every raw Yjs update to a new
  `post_collab_updates` row, reset whenever a revision is saved — bounding it to "since the
  last revision" controls how much CRDT history is ever kept around. The viewer fetches that
  log, replays prefixes of it into a scratch `Y.Doc` for the scrub slider, and taps a second,
  otherwise-unused `HocuspocusProvider` connection purely to keep appending new updates as
  they arrive live.
- **Collaborator cursors**: shown as a thin colored bar rather than `CollaborationCaret`'s
  default always-visible name label (`renderCaret` in `CollabEditorBody.tsx`) — the name
  shows in a CSS `:hover`-only tooltip instead. The local user's own cursor is unaffected
  (y-prosemirror excludes the local clientID before `render` runs).

**Status line(s):** the editor shows two separate status paragraphs.

- `.statusLine` — 🟢 Live/🟡 Connecting/🔴 Disconnected, plus `(+X −Y)` (live doc vs. the
  last saved revision, via the existing word-level `diffText`) and `(Name: +N, ...)` per
  contributing/connected author (`collectAuthorHighlightStats`, `src/lib/tiptap-schema.ts`).
  Both figures are debounced ~400ms rather than recomputed per keystroke — see
  PERFORMANCE.md, which also has a real before/after benchmark of this branch's cost.
- `.revisionNote` — shows "`{Published revision #N (bold, linked to the live post) |
  Scheduled for {date} | Unpublished}`. `{EDITED[, TITLE CHANGED] | Currently viewing
  revision #M}`." — the second clause
  disappears entirely once the last-saved revision matches what's published, there's no live
  content diff from it, *and* the title input matches the last-saved title; TITLE CHANGED is
  a separate, independent check (live title state vs. the title the post was last saved with)
  that comma-joins onto EDITED when both apply, rather than being folded into the same
  content-diff signal. Updates live on publish (the existing `router.refresh()` re-derives
  the published revision number from the DB) and live on undo back to a clean state (the
  existing debounced revision-diff, already recomputed on every editor `update` event).

**Title-divergence indicator:** the title `<input>` gets a persistent 2px `#ffd800` border
whenever its live value differs from the currently *published* title (`publishedTitle`,
`null` unless `postStatus === "published"`) — a separate check from TITLE CHANGED above,
which compares against the last-*saved* title rather than the published one. The input has a
2px transparent border by default (rather than none) so the color swap doesn't shift layout.

**Settings panel:** rather than only managing moderation policy, authors, and deletion from
the `/posts` admin table (§3c), the editor also has a collapsible "Settings" panel
(`PostSettingsPanel.tsx`) for per-post knobs that don't belong on the main editing surface.
Built natively via `<details>`/`<summary>` rather than hand-rolled open/close state — see
STYLE.md.

- **Moderation policy override**: a `<select>` of `ModerationPolicy` (INHERIT/ALWAYS/AUTO,
  same enum/semantics as §6), saved immediately via `updatePostModerationPolicy`
  (`src/app/actions/posts.ts`), gated by the same `canUserEditPost` check as saving/
  publishing.
- **Author management**: a checkbox list of every ADMIN/EDITOR/AUTHOR user.
  `updatePostAuthor` adds/removes a single `PostAuthor` row per toggle (rather than
  replacing the whole set), so two editors toggling different authors concurrently can't
  clobber each other; removing the last remaining author is refused. The list sorts
  checked-first by `bylineOrder`, computed once on mount and deliberately **not**
  live-resorted as checkboxes toggle, so a row doesn't jump elsewhere in the list mid-edit.
  Checked rows are drag-and-droppable (native HTML5 DnD, no library) to reorder the byline;
  both a drag-drop and an add/remove call `updatePostAuthorOrder`, which renumbers every
  checked author's `bylineOrder` to match the checkbox list's current on-screen order — so
  `bylineOrder` always reflects what's visible rather than new authors simply appending to
  the end.
- **Soft delete/restore**: a Delete/Undelete button reusing the same `deletePost`/
  `restorePost` actions as the `/posts` table (§3c). Deleting from the editor disables every
  other editing control on the page — title, toolbar, editor content, save/publish/schedule,
  changelog, and the panel's own moderation-policy/author controls — via a `deleted` boolean
  threaded down from `PostEditor`; undeleting re-enables them. The edit page's own post
  lookup uses `prismaIncludingDeleted` rather than the ordinarily soft-delete-filtered
  `prisma` client (§4) — otherwise a freshly-deleted post would 404 on refresh instead of
  showing the Undelete affordance.
- **Created/published timestamps**: shown read-only (`Date.toString()`) alongside the above,
  in a headerless label/value table — see STYLE.md's "Headerless label/value table" layout
  pattern.
- **Revision history table**: a "Revisions:" label (same style as the labels above it)
  introduces a table of every `Revision` — number, title, editor (name, not id), changelog,
  and created-at (`yyyy-MM-dd HH:mm`, zero-padded local time) — sorted by `revisionNumber`,
  positioned directly above the Delete/Undelete button. The currently published row is bold,
  the currently scheduled row is italic (mutually exclusive — a post is never both at once).
  Fetched with a dedicated `prisma.revision.findMany` selecting only those columns, excluding
  `doc`.

---

## 4. Data model

```
users            id, email, name, password_hash | oauth, role, created_at,
                 color                                           -- author-highlight/caret color
                 admin_initials(non-null string)                 -- byline shorthand, §10 item 11
                 moderation_policy('inherit'|'always'|'auto')   -- per-author override
                 deleted_by_user_id NULL, deleted_at NULL         -- soft delete, §3b
posts            id, slug, title, publish_revision_id,
                 created_at, published_at (may be future),       -- no status column, no schedule
                                                                   -- column (§10 item 12): visible iff
                                                                   -- publish_revision_id is set AND
                                                                   -- published_at <= now()
                 moderation_policy('inherit'|'always'|'auto')   -- per-post override
                 deleted_by_user_id NULL, deleted_at NULL         -- soft delete, §3c
post_authors     post_id, user_id, byline_order                 -- manual byline, decoupled
revisions        id, post_id, revision_number, doc JSONB (ProseMirror),
                 title, editor_id, changelog, created_at         -- IMMUTABLE
post_publication_events id, post_id, type(published|unpublished|   -- audit log of publish/unpublish/
                 scheduled|schedule_canceled), revision_id NULL,   -- schedule transitions (§10 item 12) —
                 scheduled_for NULL, actor_id NULL, created_at      -- needed once those transitions can
                                                                     -- happen without a new revision
post_collab      post_id, ydoc BYTEA, updated_at                 -- live Yjs state (working draft)
post_collab_updates id, post_id, created_at, update BYTEA        -- raw Yjs update log, since
                                                                  -- last revision only (§10 item 9)
site_settings    id(singleton), default_moderation_policy, trust_threshold(int, e.g. 3), ...
commenters       id, user_id NULL, email, display_name,          -- identity for a commenter
                 approved_count(int), force_moderate(bool)        -- per-commenter override
comment_threads  id, post_id, anchored_revision_id,
                 anchor_from int, anchor_to int, quoted_text,
                 status(active|detached|resolved), created_at
comments         id, thread_id, parent_comment_id NULL,
                 commenter_id, body JSONB,
                 status(pending|approved|spam|deleted),
                 created_at, edited_at,
                 deleted_by_user_id NULL, deleted_at NULL         -- soft delete, §10 item 15
```

Notes:

- **No `status` enum, no schedule column.** A post is actually visible iff
  `publish_revision_id` is set **and** `published_at <= now()` — the latter
  may hold a future date (a scheduled post), so visibility is a pure
  query-time comparison (`src/lib/post-status.ts`'s `publishedPostWhere`),
  not a stored flag or a background process that flips one. `derivePostStatus`
  derives draft/scheduled/published for display from those same two columns.
  See §10 item 12 for the fuller history (this replaced first a
  `draft|published|archived` status column, then a separate `scheduled_for`
  column backed by a sweep).
- **Revisions are append-only.** Publishing creates a new row; nothing is overwritten.
  "Restore version N" = copy doc N into a new revision. Diff view between any two revisions
  via `prosemirror-changeset`. `editor_id` records who made the revision — separate from the
  `post_authors` byline.
- **Drafts / working state** live in `post_collab.ydoc` (the live Yjs document), persisted
  by Hocuspocus. Edits never pollute revision history; only an explicit **publish** snapshots
  the current doc into a `revisions` row.
- **`post_collab_updates`** is an append-only log of raw Yjs updates for the *current*
  session only — reset (rows deleted) every time a revision is saved, so it never grows past
  "since the last revision" regardless of how long a post has existed (§10 item 9).
- **Comment tree**: `parent_comment_id` self-reference; render the tree with one recursive
  CTE. Plenty fast at hobby scale.
- A **thread** is the unit anchored to a quote; **comments** form the reply tree inside it.
- **Commenter identity** (§6): a `commenter` is keyed by account (`user_id`) when logged in,
  otherwise by email. `approved_count` and `force_moderate` drive the trust model.
- **Soft delete** (`deleted_by_user_id`/`deleted_at`, both nullable): the same two-column
  pattern now covers `comments` (§10 item 15, first), `users` (§3b), and `posts` (§3c). Rather
  than every read site having to remember its own filter, `src/lib/prisma.ts`'s `prisma`
  export is a Prisma Client Extension that auto-excludes soft-deleted `Post`/`User` rows from
  every read operation (`findMany`/`findFirst`/`findUnique`/`count`/`aggregate`/`groupBy`) —
  a query site can't leak a deleted row just by forgetting a manual filter. Write operations
  pass through untouched (restoring a row means writing to one the filter would otherwise
  hide from a read). A second, unextended `prismaIncludingDeleted` export exists for the
  handful of call sites that must see soft-deleted rows on purpose: the `/posts`/`/users`
  admin tables (need to list a deleted row to restore it, §3c/§3b), the delete/restore
  actions' own existence checks, and the slug/email uniqueness checks in `uniquePostSlug`/
  `uniqueUserSlug`/`signUp` (slug and email stay DB-unique even for a soft-deleted row, so
  silently treating one as free would just trade a friendly "already exists" error for a raw
  constraint violation at create time).

### 4a. Mutable slugs

**Decided:** both `posts.slug` and `users.slug` (author-page slugs, `/authors/[slug]`) can be
renamed after creation, with the old slug preserved as a redirect source rather than left to
404.

- **One history table per entity**, not a shared polymorphic one — `PostSlugHistory`/
  `UserSlugHistory` (§4), each `{ slug @unique, <entity>Id, createdAt }`, `onDelete: Cascade`.
  Prisma has no real polymorphic-relation support, so a shared table would trade referential
  integrity for marginal duplication savings.
- **Uniqueness spans live + historical slugs**: `uniquePostSlug`/`changePostSlug`
  (`src/lib/post-slug.ts`) and `uniqueUserSlug`/`changeUserSlug` (`src/lib/user-slug.ts`)
  reject a candidate that's any entity's current slug *or* sitting in its history — otherwise
  a rename could steal a slug still redirecting an old link to someone else.
- **Redirect fallback**: `[slug]/page.tsx` and `authors/[slug]/page.tsx` each fall back to
  their history table on a live-slug miss and `permanentRedirect()` (308) to the entity's
  current slug — only if it's still live (published post; non-soft-deleted user), so a
  history entry for something since unpublished/deleted still 404s.
- **Reserved top-level slugs** (`RESERVED_SLUGS`, `src/lib/slug.ts`) only apply to post
  slugs — `/[slug]` is a top-level route; author slugs live under the nested `/authors/[slug]`,
  with no sibling static routes to collide with.
- **Management UI**: `/posts/[id]/slug` and `/users/[id]/slug` (`SlugManager.tsx`, shared by
  both entity types), linked from `PostSettingsPanel`'s "Url" row and `UsersTable`'s "url"
  column. Saving commits immediately — no confirm/cancel gate; the safety net is a one-click
  **Revert** button on the most recent past-slugs row instead (`revertPostSlug`/
  `revertUserSlug`), matching the app's existing no-confirm-dialog-the-action-is-its-own-undo
  convention (§3b/§3c). A revert consuming a history row younger than
  `REVERT_DISCARD_WINDOW_MS` (60 min, `src/lib/slug.ts`) leaves no trace at all rather than
  recording the abandoned slug.
- **Auto-generated preview**: the management page also shows what `uniquePostSlug`/
  `uniqueUserSlug` would produce today from the entity's title/name — an optional
  `excludePostId`/`excludeUserId` param keeps the entity's own current reservation from
  spuriously colliding with itself — noting a match or offering a one-click "Use this url"
  button on mismatch.
- **UI terminology**: every user-facing label/message says "url", not "slug" (users find it
  more comprehensible) — schema columns, functions, files, and routes are still named `slug`
  throughout; only display text changed.

---

## 5. Quote anchoring & surviving revisions (the mechanism)

**Creating a comment on a quote**
1. Reader selects text in the published article. The client reads the selection's
   ProseMirror positions `{from, to}` in the *current* revision's coordinates, plus the
   plain quoted text.
2. POST creates a `comment_thread` with `anchored_revision_id = current`, `anchor_from`,
   `anchor_to`, `quoted_text`, then the first `comment`.

**Rendering the indicator**
- On a published post we load the current revision's doc + all active threads.
- A ProseMirror plugin builds **decorations**: an inline highlight over each
  `[anchor_from, anchor_to)` range and a small gutter/inline marker (e.g. a count badge)
  where one or more threads land. Clicking opens the thread panel.
- Decorations are display-only, so this never alters stored content.

**Surviving a new revision**
- On publish, compare previous doc → new doc. We don't capture live editing steps from the
  reader's perspective, so we reconstruct the change set between the two stored docs with
  `prosemirror-recreate` (→ steps) and build a `Mapping`.
- For each thread: map `anchor_from`/`anchor_to` through the Mapping.
  - Range still has positive length → update positions, set `anchored_revision_id = new`.
  - Range collapsed (the quoted text was deleted) → set `status = detached`.
- Optional safety net: if mapping looks suspicious, fuzzy-match `quoted_text` against the
  new doc to re-anchor.

**What the reader sees (decided)**
- **Every** comment thread — active or detached — always appears in the comment list at the
  bottom of the post. Detached threads are never hidden.
- **Active** threads also get the inline highlight + indicator next to the quoted passage.
- **Detached** threads have no inline indicator (the text is gone). When the reader clicks
  "jump to quote" on a detached thread, instead of scrolling we show a notice that the
  quoted passage was edited or removed in a later revision, and offer to show the quote in
  the context of the revision it was made against.

This is the standard ProseMirror pattern (decorations + position mapping) and keeps the
content layer and the comment layer cleanly separated.

---

## 6. Commenting, moderation & abuse

**Identity (decided):** Disqus-style. A commenter must at minimum give a **name + email**;
logging in to an account is also allowed (and a logged-in commenter is the same `commenter`
record keyed by `user_id`). Email lets us tie anonymous comments to a stable identity for
the trust model; optional double opt-in verification can come later.

**Moderation policy — three-level cascade (decided).** Each comment's required policy is
resolved as **post override → author override → site default**, where each level is one of
`always` (queue for approval), `auto` (publish immediately), or `inherit` (defer to the
next level up). So the site sets a default, an author can override for all their posts, and
a single post can override again.

**Trust model (decided).** Independently of the cascade, once a commenter has had
`trust_threshold` comments approved (default 3, configurable in `site_settings`), their
later comments auto-approve. A per-commenter `force_moderate` flag overrides this to always
require approval, no matter how many they've had approved.

Resolution order for a new comment: if the commenter is logged in as an `ADMIN` → publish,
skipping spam-checking entirely. Else if `force_moderate` → queue. Else if trusted
(`approved_count >= threshold`) → publish. Else apply the cascade policy.

**`trust_threshold` is inert whenever a comment's resolved cascade policy is `auto`.** The
trust check runs *before* the cascade (above), but an untrusted commenter who fails it still
falls through to the cascade — and if that resolves to `auto`, they publish immediately
anyway, threshold or no. The threshold only ever changes an outcome for a comment whose
resolved policy is `always`: that's the one case where a trusted commenter (publish) and an
untrusted one (queued) actually diverge. So `trust_threshold`'s de facto value is 0 for any
comment resolving to `auto` (aside from `force_moderate`, which still queues regardless of
trust) — raising or lowering it changes nothing until something in the cascade — site
default, an author override, or a post override — resolves to `always` at least some of the
time.

**Editing site-level settings.** `defaultModerationPolicy` and `trustThreshold` (the
`site_settings` singleton, §4) are editable by an ADMIN at `/site-settings`
(`SiteSettingsTable.tsx`, `actions/site-settings.ts`) — a policy `<select>` and a threshold
number input, each admin-gated and saving on change/blur like `/users` (§3b). That page also
lists `site-config.ts`'s build-time constants (e.g. `SITE_TITLE`) read-only, since those apply
site-wide too but change only via a deploy, not from the DB.

**Hardening:** sanitize all comment bodies; restrict the comment editor to a safe schema
(no raw HTML/scripts; links get `rel="nofollow noopener"`). Rate-limit by IP and by
commenter. Consider Akismet given anonymous commenting is allowed.

---

## 7. Deployment on Linode/Ubuntu

- **Two** Node services under **systemd**: the Next.js app and the **Hocuspocus** collab
  websocket server. Both behind **nginx**.
- nginx must **proxy websockets** for the Hocuspocus route (`Upgrade`/`Connection` headers,
  generous read timeout). Keep it on its own path/subdomain (e.g. `collab.example.com`).
- **TLS** via Let's Encrypt / certbot, auto-renew (covers the collab host too → `wss://`).
- **Postgres** on the same box; daily `pg_dump` cron shipped off-box to Linode Object
  Storage (or S3). Test a restore once — a backup you haven't restored isn't a backup.
- Deploy flow: build on server (or build artifact + rsync), run Prisma migrations,
  restart the service. A short `deploy.sh` is enough; no containers needed since you chose
  the self-managed path. (Docker Compose remains an easy later upgrade for reproducibility.)
- Firewall: ufw allow 80/443/22 only; Postgres bound to localhost.

---

## 8. Suggested build order

1. Skeleton: Next.js + Prisma + Postgres + Auth.js; users/roles; deploy the empty shell to
   the Linode end-to-end (nginx+TLS+systemd) so ops is proven early.
2. Posts + TipTap editor (single-user first) + immutable revisions + publish + diff/restore.
3. **Real-time collab:** stand up Hocuspocus, wire Yjs + `y-prosemirror`, presence/awareness,
   auth on connect, persist `post_collab.ydoc`, snapshot-on-publish.
4. Public rendering of published posts (SSG/SSR) with clean slugs.
5. Tree comments (no anchoring yet): threads + recursive replies + moderation cascade + trust.
6. Quote anchoring: selection capture, decoration highlights + indicator, thread panel.
7. Revision survival: remap-on-publish + detached-thread handling (§5).
8. Polish: spam controls, search, RSS, author pages.

Two risky parts to de-risk early with throwaway spikes: **collab persistence/auth (step 3)**
and **anchor remapping across revisions (steps 6–7)**.

---

## 9. Decisions & remaining questions

**Settled**
- Multi-author: posts carry a manual byline (`post_authors`) decoupled from edit
  attribution (`revisions.editor_id`) (§3).
- Concurrency: **real-time collaborative editing in v1** via Yjs + Hocuspocus; live state in
  `post_collab.ydoc`, snapshot to a revision on publish (§3a).
- Commenting identity: name+email minimum, login allowed (§6).
- Moderation: three-level cascade (post → author → site) plus a trust model that
  auto-approves commenters after N approvals, with a per-commenter force-moderate override (§6).
- Editor: TipTap. ORM: Prisma.
- Detached comments: always listed at the bottom; inline indicator only while active; on
  jump, show an "edited/removed in a later revision" notice (§5).

**Defaults I've assumed (say if you want different)**
- Trust threshold = 3 approved comments before auto-approval (configurable site-wide).
- Email is collected but not verified (no double opt-in) in v1.
- Bylines are chosen from real user accounts (so author pages work), not free text.

**Nothing blocking left.** All six original questions plus concurrency are settled. Remaining
calls are tuning (trust threshold, email verification) and can change anytime.

---

## 10. Implementation progress (as of 2026-07-21)

Steps 1–8 of §8 are built and verified locally. Nothing is deployed — the deployment work
from §7 (and step 1's "prove ops early") has not happened; everything runs on the dev box.
Git history carries per-step detail.

**Done**

1. **Skeleton** — Next.js 16 (App Router) + Prisma 6 + local Postgres + Auth.js v5
   credentials auth with roles; forgot-password flow (single-use hashed tokens, 1h expiry,
   enumeration-safe).
2. **Posts & editor** — TipTap v3 editor, immutable append-only revisions, publish,
   diff + restore-as-new-revision. Editor is responsive and fills window height (300px floor).
   Toolbar grew beyond plan: clear-formatting, and a split-button quote dropdown exposing
   `wrapIn`/`lift` for multi-level blockquote nesting (toggleBlockquote can't nest).
3. **Real-time collab** — Hocuspocus v4 server (`server/collab.ts`, port 1234, `npm run
   collab`); short-lived JWT minted by `/api/collab-token` gates connections using the same
   authz as post editing; live state persisted to `post_collab.ydoc`, seeded from the latest
   revision; publish snapshots via `editor.getJSON()` exactly as planned. `npm run dev:all`
   runs web + collab together.
4. **Public rendering** — `/[slug]` with SSG/ISR (`revalidate = 60`), `generateMetadata`,
   reserved-slug guard so post slugs can't shadow app routes. Rendering uses
   `@tiptap/static-renderer` (`generateHTML` needs a DOM and fails server-side).
5. **Tree comments** — Disqus-style identity (name+email or session), three-level moderation
   cascade + trust threshold per §6, moderation queue at `/posts/[id]/comments`. Beyond
   plan: `comments` also records submitter IP and who/when last changed its status.
6. **Quote anchoring** — the article server-renders statically for SEO, then swaps to a
   read-only ProseMirror view after hydration (progressive enhancement). Decoration
   highlights + count badges per §5; selection → floating comment form capturing real PM
   positions; threads deduped by exact anchor range; per-root-comment quote headers with a
   jump-back arrow (pulses the source text); sort control (date vs. article position).
   Overlapping quote ranges are pre-split into non-overlapping segments because ProseMirror
   silently drops one decoration's custom attributes where inline decorations overlap.
7. **Revision survival** — on publish, `src/lib/anchor-remap.ts` groups every ACTIVE
   quote thread by its current `anchoredRevisionId`, diffs that revision's doc against the
   newly-published one with `@fellow/prosemirror-recreate-transform`'s `recreateTransform`
   (a community fork of the `prosemirror-recreate-steps` package this plan originally named —
   same mechanism, actively maintained), and maps each anchor through the resulting
   `Mapping`, biasing the start forward and the end backward so text inserted exactly at a
   boundary doesn't get pulled into the quote. A mapped range that collapses, or whose text
   no longer matches the stored `quotedText` (the §5 "fuzzy-match" safety net, done as an
   exact-match check rather than fuzzy), flips the thread to `DETACHED` and freezes its
   anchor at the last revision it was valid against. Detached threads lose the inline
   highlight/indicator (`page.tsx` only builds decorations for `ACTIVE` threads) but stay
   listed at the bottom with a notice and a "show where it used to appear" toggle that pulls
   an ~80-char-padded snippet from the frozen revision's doc (`getDetachedThreadContext` in
   `comment-data.ts`) — satisfying §5's "show the quote in context of the revision it was
   made against" without a new public revision-viewer route/page. Verified against the
   `my-own-test` post's pre-existing stale anchors (§10 "known gaps" below, now resolved):
   editing text before the "kind"/"kind of" quotes and republishing moved both anchors
   forward by the exact inserted length and re-pinned them to the new revision; deleting the
   "consequat" quote's text and republishing flipped that thread to `DETACHED` with a working
   context snippet, while unrelated ACTIVE threads remapped correctly alongside it.
8. **Polish** — rate limiting, a spam-check seam, search, RSS, and author pages:
   - **Rate limiting** (`src/lib/rate-limit.ts`): reuses `Comment.ipAddress`/`createdAt`
     (already recorded for moderation) rather than a separate table — a rolling 10-minute
     count, capped at 5 by IP and 5 by commenter. Checked in `submitComment` before thread
     creation, so a blocked attempt doesn't leave an orphan thread behind. Thresholds are
     hardcoded, not admin-configurable — consistent with `trustThreshold` also having no
     admin UI yet.
   - **Spam-check seam** (`src/lib/spam-check.ts`): `checkSpam()` stubbed exactly like
     `sendMail()` in `mail.ts` — no `AKISMET_API_KEY` is configured, so it always says "not
     spam" and logs instead of calling out. Wired into `submitComment` ahead of the
     moderation cascade so a real integration only has to fill in the one function body.
   - **Search** (`/search`): in-app substring match over post titles + `extractText(doc)`,
     no search index — the plan's own "small/hobby scale" call means the post count never
     justifies one. Search box lives in `SiteHeader`.
   - **RSS** (`/rss.xml`, a literal-named route-handler folder): last 30 published posts,
     RSS 2.0. Discovery `<link>` added via `layout.tsx`'s `metadata.alternates`.
   - **Author pages** (`/authors/[slug]`): a user's name + their published posts, linked from
     every byline (home, search, and article pages now share one `AuthorByline` component
     instead of three copies of comma-joining logic). `authors`, `search`, and `rss.xml`
     added to the reserved-slug list (`src/lib/slug.ts`) so a post title can't shadow them.
9. **Author attribution & live history** — beyond §8's original 8 steps; fulfills the
   "finer per-author edit credit" idea noted in §3a. Now documented in §3d, once the post
   editor warranted its own architecture section to match §3a-§3c.

10. **Site navigation, admin posts table, and per-post edit affordances** — beyond §8's
    original 8 steps; mostly UI/navigation polish plus one genuinely new piece of logic (the
    edit-status heuristic).
    - **Global site navigation**: `SiteHeader` (title, search, sign-in/out) previously had to
      be rendered by hand on each page and had drifted onto only 4 of them; it now lives once
      in `RootLayout`, so every route gets consistent nav for free. Shows "`{name or email}` /
      Sign out" when signed in, "Log in / Sign up" otherwise, plus a "Manage Posts" link (any
      `canManagePosts` role — ADMIN/EDITOR/AUTHOR) to `/posts`.
    - **Admin posts table** (`/posts`, `PostsTable.tsx`): rebuilt from a bulleted list into a
      table. Now documented in §3c, along with item 11's Author(s)-column/search follow-ups
      below, once `/users` got the equivalent architecture section and `/posts` warranted one
      to match.
    - **Editor status line** (`PostEditor.tsx`): now documented in §3d, alongside item 9's
      author-attribution/live-history bullets, once the post editor warranted its own
      architecture section.
    - **Per-post edit badge on public pages** (`PostEditBadge.tsx`,
      `src/lib/post-edit-status.ts`): logged-in users who can edit a given post (ADMIN/EDITOR
      always; AUTHOR only if listed on that post's byline) see a small "(edit)"/"(edited)"
      link next to its title everywhere it's publicly displayed — home, search, author page,
      and the post itself — going straight to the editor. "edited" vs. "edit" comes from
      comparing `PostCollab.updatedAt` against the latest revision's `createdAt` (see the
      `PostCollab` lifecycle gotcha in CLAUDE.md) rather than an actual diff against the live
      Yjs doc, which would need decoding it and running the same `O(n·m)` `diffText` the
      editor's own status line already uses (see PERFORMANCE.md) — fine for one post at a
      time, not for every row of a list. Badge sizing/positioning conventions are in STYLE.md.
    - **Trade-off, not a bug**: giving the home and author-page listings per-viewer content
      (the edit badge) meant both pages now call `auth()`, which made Next.js treat them as
      fully dynamic — their pre-existing `revalidate = 60` ISR caching is now a no-op. See
      CACHING.md for the detail and a possible fix (split the personalized part out
      client-side) if that caching ever needs restoring.

11. **`User.adminInitials`, an Author(s) column, and posts-table search** — a small follow-up
    round on item 10's admin posts table.
    - **`adminInitials`** (non-nullable `String` on `User`): added via a nullable-column →
      backfill → `SET NOT NULL` migration pair (`add_admin_initials_nullable`,
      `make_admin_initials_required`) instead of `prisma migrate dev`'s interactive
      default-value prompt for adding a required column to a non-empty table — see the
      CLAUDE.md Database note. Backfilled by hand for the two existing users (`LB`, `JD`).
      `signUp` (`src/app/actions/sign-up.ts`) now derives it for new accounts —
      first-letter-of-first-word + first-letter-of-last-word from the name given at sign-up
      (e.g. "Alice Wonderland" → "AW"), falling back to the first two characters of the email
      if no name was given.
    - **Author(s) column, posts-table search, and a null-sort fix** (`/posts`): also now
      documented in §3c (search) and its Table bullet (Author(s) column); the null-sort fix —
      blank (unpublished) rows pinned to the bottom in *both* sort directions, not just
      ascending — is folded into `PostsTable.tsx` without a standalone note, since it was a
      bugfix to the sort comparator rather than a design decision.

12. **Publish mechanics rework** — no-op revision skip, unpublish, scheduled
    publishing, and dropping the `status` column entirely. Now documented in §3d, alongside
    item 9's author-attribution/live-history and item 10's status-line bullets.

13. **Quote-thread color coding, comment-posting UX polish, and a live-update fix** — a
    follow-up round touching both the quote-anchoring mechanism (§5/item 6) and the
    comment-submission flow.
    - **Per-thread color** (`src/lib/comment-data.ts`): each quote thread now carries one
      color, resolved from whoever opened it — a signed-in commenter's real `User.color`,
      or `colorForSeed(email)` (the same palette-seeding helper used at sign-up,
      `src/lib/author-colors.ts`) for an anonymous commenter — not any one reply's author.
      That color is shared across every rendering of the thread: the inline highlight, the
      count badge, the `QuoteThreadHeader` jump-back arrow/bar, and the click-to-pulse
      effect, carried as an inline `--thread-color` CSS custom property consumed by
      `prose.module.css`/`QuoteThreadHeader.module.css` (`color-mix()` for the highlight's
      translucent wash and the pulse's brighter peak) — see STYLE.md.
    - **Overlapping quotes from different authors render gray.** A single ProseMirror
      decoration span can only carry one background, and `quote-highlight-extension.ts`
      already pre-splits overlapping quote ranges into shared non-overlapping segments (the
      item 6 note about attributes being dropped on overlap) — a segment covered by threads
      of different colors now leaves `--thread-color` unset so it falls back to the
      stylesheet's neutral gray instead of arbitrarily picking one author's color; a segment
      covered only by same-colored thread(s) still gets that color.
    - **Live update without a reload.** `AnnotatableArticle`'s `useEditor()` previously had
      no deps array, so the `QuoteHighlight` plugin's `threads` option was captured once at
      first mount and never re-read — a comment posted in the same page session (the server
      action's `revalidatePath` refreshes props without a real navigation) never showed its
      own highlight/badge until an actual page reload. Now keyed on `[threads]`, which
      TipTap's `useEditor` treats as a recreate-the-editor dependency list, so a genuinely
      new `threads` array (i.e. new server data) rebuilds the editor and its decorations
      immediately.
    - **Comment-posting UX**: `CommentForm` no longer shows a "Comment posted." confirmation
      for an auto-approved comment (it now renders nothing) — the immediate highlight/badge
      from the fix above is confirmation enough, and the old message plus a still-visible
      Reply/Cancel link invited an accidental double-post. `CommentNode` hides its own
      Reply/Cancel toggle the same way once a reply auto-approves, via a new `onPosted`
      callback on `CommentForm`; both cases are local component state, so they come back
      only on a real page refresh, not automatically. A comment that lands in moderation
      still shows "Your comment is awaiting moderation." and leaves the form/toggle visible,
      since there's no highlight yet to signal success there.
    - **Quote-selection popup** (`AnnotatableArticle`): now closes itself automatically once
      its comment auto-approves (same `onPosted` mechanism) instead of staying open. Its
      "Close" button was merged into `CommentForm`'s own button row next to "Post comment"
      (same styling, dark grey background instead of near-black, right-aligned), renamed
      "Cancel", via a new optional `onCancel` prop — optional so the top-level and reply
      comment forms, which have no such button, are unaffected. The badge-click-to-flash
      effect (scrolls to and briefly tints the matching comment-list entry) was hardcoded
      pale yellow regardless of author; it now uses the same per-thread color via
      `color-mix()`. The comment textarea now resizes in both directions (`resize: both`),
      not just vertically.

14. **Comment permalinks** — each comment's displayed timestamp
    (`CommentNode.tsx`) is now a self-referencing anchor,
    `<a id="…" href="#…">`, so clicking it (or copying its link) jumps
    straight to that comment. The id is derived from the commenter's display
    name plus their comment's timestamp truncated to the second, not the
    comment's own database id — deliberately human-readable in a shared URL,
    at the cost of not checking for collisions (two comments from the same
    person in the same second, which shouldn't happen in practice).

15. **Soft comment deletion** — `Comment.deletedByUserId`/`deletedAt` (both nullable; no
    `status` cascade involved, and the pre-existing but never-wired-up `CommentStatus.DELETED`
    enum value is left untouched) plus a `deleteComment` server action
    (`src/app/actions/comments.ts`), allowed when `session.user.role === "ADMIN"` or the
    comment is the viewer's own (`commenter.userId === session.user.id`).
    - **UI** (`CommentNode.tsx`): a "Delete" button next to "Reply", shown under the same
      permission check, colored maroon specifically when an admin is deleting *someone else's*
      comment (plain otherwise, including an admin deleting their own) — a deliberate visual
      distinction so admin power reads differently from ordinary self-deletion. Clicking it
      swaps to an inline "Are you sure you want to delete? Yes / No" (dark green / dark red,
      both bold) in place of the button; "No" reverts, "Yes" calls the action and
      `router.refresh()`s.
    - **Collapse rule**: a deleted comment with at least one live descendant anywhere below it
      (not just direct replies — computed recursively, exported as `hasNonDeletedDescendant`)
      renders "[deleted]" in place of its name/timestamp/body/buttons; one with no live
      descendant renders nothing at all, so a deleted leaf doesn't clutter the thread. This
      only applies to a **fresh page load**, though — the viewer who just clicked "Yes"
      themselves sees "[deleted]" immediately as confirmation the click worked, even for a
      leaf comment, via a client-only `justDeleted` flag that overrides the collapse rule for
      that one render tree; it's never set from server data, so it can't survive a real
      navigation and doesn't affect what anyone else sees.
    - **Everything anchored to a fully-collapsed root also disappears.** A quote thread whose
      every comment is deleted (no live comment anywhere in it — equivalent to "no comment in
      the thread has `deletedByUserId === null`", regardless of how many independent root
      comments or reply chains it has) also hides: the `QuoteThreadHeader` above the comment
      list (`CommentEntryList.tsx`, reusing the same `hasNonDeletedDescendant` check against
      the entry's root) and the inline highlight/count-badge in the article itself
      (`[slug]/page.tsx`'s `quoteHighlights` filter, plus its `count` now excludes deleted
      comments too). Both were follow-up fixes, found only after the collapse rule above had
      already shipped and been used for a while — rendering a dangling quote header or a
      highlighted-but-commentless passage once nothing was left under it.
    - **`/posts` comment counts** (item 13's table) also skip `deletedByUserId !== null`
      comments when tallying approved/pending, added alongside the schema fields above.

16. **Comment pseudo-borders** — clicking an inline quote bubble (or loading/following a
    comment permalink) now also leaves a persistent colored bar in the left margin of the
    Comments `<section>`, vertically aligned to the relevant comment's own div, alongside the
    existing transient flash/pulse rather than replacing it.
    - `src/lib/pseudo-border.ts`: a small imperative DOM module, in the same spirit as
      `AnnotatableArticle`'s `flashHighlight` and `QuoteThreadHeader`'s `jumpToQuote` — reads
      real element positions via `getBoundingClientRect()` and inserts/removes plain
      `<div>`s tagged `data-pseudo-border`, rather than routing through React state, since the
      two trigger sites (`AnnotatableArticle`, `CommentEntryList`) sit in separate component
      trees with no shared parent to hold that state.
    - Positioned 2px wide, 2px to the left of the Comments `<section>`'s own left edge (now
      `data-comment-section`, `position: relative`) — it stands in for a `border-left` that
      can't be drawn on the target comment's own div directly, since the whole point is
      moving it outside that (possibly deeply nested) div's box instead of indenting into it.
    - Bubble click (`AnnotatableArticle`'s `onIndicatorClick`): one bar per matching thread
      entry's root comment (a thread can have multiple roots), colored with the thread's
      already-computed color (item 13). Clears every existing bar first.
    - `#bookmark` (the item 14 permalink hash): `CommentEntryList` activates the matching
      comment's bar on mount and on every `hashchange`, clearing first each time (down to zero
      once the hash stops matching anything). Locates the comment by matching the timestamp
      anchor to its nearest ancestor `[data-comment-id]` (added to `CommentNode` on both the
      live and `[deleted]` render branches), and reads that entry's color off a
      `data-thread-color` attribute on the surrounding thread wrapper.
    - Deliberately has no animation and no repositioning on scroll/resize, unlike the existing
      flash/pulse effects — matches the "stays put" ask, and nothing else in this area handles
      resize either.

**Deliberate deviations from §2–§6**

- Comment bodies are **plain text** (`{"text": ...}` JSON), not rich TipTap content — no
  XSS surface, so the DOMPurify/strict-schema work is deferred until rich comments happen.
- Email delivery is a **console-log stub** (`src/lib/mail.ts`) behind a `sendMail()` seam.
- The revision **diff view** (history page) still uses a self-contained word-level LCS text
  diff (`src/lib/diff.ts`), not the ProseMirror-aware diff machinery — that's cosmetic (plain
  text is good enough for a human reading a diff) and unrelated to anchor remapping, which
  now does use real ProseMirror diffing (`@fellow/prosemirror-recreate-transform`, step 7
  above) since positions genuinely need to survive structural edits, not just look diffable.
- With multiple co-authors, moderation overrides combine **most-conservative-wins** (the
  plan's cascade wording assumed a single author).
- General (non-quote) comments live in one per-post thread keyed by `quoted_text = ''`.

**Known gaps**

- **§8 is now fully built at the code level; nothing is deployed yet.** No Linode/nginx/TLS
  (§7), so `.env` secrets are dev-only and there's no real Akismet key to swap into the
  spam-check seam.
- Comment hardening from §6 ("restrict the comment editor to a safe schema... links get
  `rel=nofollow noopener`") is still moot — comment bodies are plain text (deviation above),
  so there's no HTML to sanitize until rich comments happen.
- `restoreRevision` (history page) creates a new revision row but doesn't publish it —
  the author still has to hit Publish afterward, which is when remapping runs. Not a gap
  particular to step 7; that's just what "restore" has always meant here (§8 step 2).
- The "quoted-text position" sort in the comment list compares `anchorFrom` across threads
  that may be anchored to *different* revisions (an active thread's position is in the
  current doc's coordinates; a detached thread's is frozen in an old revision's) — so sort
  order between an active and a detached entry is not meaningful. Pre-existing limitation,
  more visible now that detached threads are a real state instead of a hypothetical one.
- The collab JWT (`signCollabToken`) expires after 2 minutes and a `HocuspocusProvider`
  doesn't fetch a fresh one on reconnect — a long-idle editor or live-history tab can end up
  silently stuck retrying with an expired token until the page is reloaded. Pre-existing
  (not introduced by item 9), just newly relevant now that live-history explicitly promises
  to "stay connected."
- Live-history's scrub slider is indexed by update count, not wall-clock time (each logged
  update — one per dispatch, not per keystroke, since ProseMirror/Yjs batch a whole typed
  burst into one update — is one slider step), so a long pause and a fast typing burst take
  the same one step; the per-step timestamp label is shown to compensate. Replay itself is a
  full re-apply from position 0 on every scrub, not checkpointed — fine at the update-log
  sizes one session between revisions produces, would need periodic snapshots to stay cheap
  if that ever changed.
- The status line's `(+X −Y)` figure reuses `diffText`'s word-level tokenization, which
  reports a whole word as fully deleted+reinserted the instant an edit lands *inside* it
  rather than the true character delta — measurably inaccurate for this use, deferred (full
  repro and the fix trade-offs are in PERFORMANCE.md). Word-level output itself is correct
  and stays as-is for the revision-history diff view, which genuinely wants whole-word
  semantics for a human reading a diff.
- A real before/after benchmark (checked out the commit predating this branch, same
  content, same test, not a guess) confirmed per-keystroke editing latency is unaffected by
  everything in item 9, at both normal and 5x content length. The debounced revision-diff
  computation above is the one measurable new cost, and scales worse than linearly with
  content length (~16x slower at 5x length) — see PERFORMANCE.md's 2026-07-19 benchmark
  entry for methodology and numbers.
- The home and author pages' `revalidate = 60` ISR caching is now a no-op — item 10's edit
  badge made both pages call `auth()`, which Next.js treats as inherently dynamic. Not fixed;
  see CACHING.md's 2026-07-20 entry for why and a possible client-side-split fix.