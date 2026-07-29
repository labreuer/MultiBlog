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
who actually edited.** `post_author` is a manual byline list (chosen from user accounts,
so author pages work); edit attribution lives separately in `revision.editor_id`. You can
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
  `revision` row** (§4); the Yjs update log is the working state between publishes.
- **Awareness:** Yjs "awareness" gives presence (who's in the doc, cursors/selections) for
  free — useful even with the byline being separate from edit attribution.
- **Attribution:** `revision.editor_id` at publish records who pressed publish.
  Finer-grained credit — colored per-author highlighting of contributions *since the last
  revision*, Etherpad-style (§3d) — layers on top via an inline `authorHighlight` mark
  carrying the author's `User.color`, applied to newly-typed text and cleared (a real,
  synced transaction) on every save so it always reflects only what's new. It's
  working-session state, not content — stripped before anything reaches `revision.doc`.
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
columns shared with `post` (§4), since it's otherwise a UI + server-actions layer over the
existing `user` table.

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
  CLAUDE.md gotcha. Stripped (`stripMarkFromDoc`) before anything reaches `revision.doc`;
  `contentExtensions` (the shared editor/seed/render schema) never has to know the mark
  exists.
- **Live-scrubbable history** (`/posts/[id]/live-history`, `LiveHistoryViewer.tsx`):
  read-only, and stays live-connected rather than being a one-time snapshot. Hocuspocus's
  `onChange` hook (`server/collab.ts`) appends every raw Yjs update to a new
  `post_collab_update` row, reset whenever a revision is saved — bounding it to "since the
  last revision" controls how much CRDT history is ever kept around. The viewer fetches that
  log, replays prefixes of it into a scratch `Y.Doc` for the scrub slider, and taps a second,
  otherwise-unused `HocuspocusProvider` connection purely to keep appending new updates as
  they arrive live. Replays **both** fragments of that doc — `"default"` (body) and `"title"`
  (see the title field below) — so scrubbing back shows the title as of that moment, colored by
  whoever changed it, rather than today's title from the DB. The title is absent (rendered as
  nothing) for a log whose first full-state entry predates the title fragment; that self-heals
  on the next save, which resets the log.
- **Collaborator cursors**: shown as a thin colored bar rather than `CollaborationCaret`'s
  default always-visible name label (`renderCaret` in `CollabEditorBody.tsx`) — the name
  shows in a CSS `:hover`-only tooltip instead. The local user's own cursor is unaffected
  (y-prosemirror excludes the local clientID before `render` runs).

**Status line(s):** the editor shows two separate status paragraphs.

- `.statusLine` — 🟢 Live/🟡 Connecting/🔴 Disconnected, plus `(+X −Y)` (live doc vs. the
  last saved revision, via the existing word-level `diffText`) and `(Name: +N, ...)` per
  contributing/connected author (`collectAuthorHighlightStats`, `src/lib/tiptap-schema.ts`).
  Both figures are debounced ~400ms rather than recomputed per keystroke — see
  PERFORMANCE.md, which also has a real before/after benchmark of this branch's cost. Both come
  from the **body** editor only: title edits are deliberately excluded from `(+X −Y)` and from
  the per-author counts, since a title change is already signalled separately (TITLE CHANGED and
  the divergence border below) and mixing it into a word-level content diff would misreport it.
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

**Title field** (`CollabTitleField.tsx`): the title is *not* a plain `<input>` backed by React
state, and not a hidden node inside the body doc either. It's a second Yjs fragment (`"title"`)
of the **same `Y.Doc`** as the body, driven by its own minimal TipTap editor
(`titleExtensions` in `src/lib/tiptap-schema.ts`: `Document.extend({ content: "paragraph" })` +
`Paragraph` + `Text`, no StarterKit, no marks besides `authorHighlight`). Consequences:

- It rides the existing Hocuspocus connection, `PostCollab.ydoc` persistence, and
  `PostCollabUpdate` replay log, so two editors share one title (rather than each holding a
  private string where last-save-wins) and live-history scrubbing gets title attribution for
  free.
- Body positions are untouched, which is why it isn't a node in the body doc: a node at
  position 0 would shift every position, and `CommentThread.anchorFrom`/`anchorTo`
  (`anchor-remap.ts`) are absolute. It also keeps the title out of `contentExtensions`, the
  schema shared with the public renderer.
- `content: "paragraph"` (exactly one, not `block+`) makes a second block structurally
  impossible, so neither Enter (also an explicit keymap no-op) nor a multi-line paste can turn
  a title into two lines.
- **No `CollaborationCaret`**: the extension has no per-field awareness key, so a second
  instance on the same provider would write the same `awareness.cursor` as the body's and render
  remote positions against the wrong fragment. Title text still syncs live; only remote carets
  are absent there.
- Seeded/backfilled server-side in `onLoadDocument` (`server/collab.ts`) from the latest
  revision's title — for a fresh doc *and* for any `PostCollab` row written before the title
  moved into the Yjs doc. Built directly on the live `Y.Doc` rather than merging a second
  `TiptapTransformer.toYdoc` result, which would risk a clientID collision.
- `Revision.title`/`Post.title` are unchanged plain string columns. `Revision.title` is still
  written only by `resolveRevision` on save/publish/schedule — the fragment is the *working*
  title, that column the *saved, attributable* one. `Post.title` has a second writer now (see
  below): it's no longer purely "whatever the last save/publish/schedule stamped." `PostEditor`'s
  `title` state is a mirror of the field, fed by an `onTitleChange` callback, trimmed on the way
  to the server and rejected when empty (easier to reach in a contenteditable than in an
  `<input>`).
- **Debounced background autosave of `Post.title` alone** (`updatePostTitle`,
  `src/app/actions/posts.ts`): ~1s after typing settles, `PostEditor` writes the trimmed title
  straight to `Post.title`, independent of Save/Publish/Schedule. Deliberately touches only that
  column — never `Revision`, never `publishRevisionId` — so it can't create a revision for an
  unreviewed keystroke and can't move what a reader currently sees (that's still exclusively
  `publishRevision.title`, stamped only by an explicit publish). This is *why* it's safe to fire
  off a keystroke rather than a save: the two things a title-write could otherwise damage — the
  revision history and the published page — are both untouched by construction. Every tab with
  the title fragment synced runs this independently; since they're all converging on the same
  eventual text, redundant writes across tabs are harmless. Gated on `providerSynced` like the
  save buttons, and a `lastPersistedTitleRef` skips re-sending a title `Post.title` already has —
  which also means an explicit Save/Publish/Schedule (which stamps the same column itself)
  cancels any pending autosave rather than racing it.
- **Gated on the collab handshake.** Both title comparisons below are gated on
  `providerSynced && title !== ""` (`titleComparable`): before the provider syncs, the fragment
  is locally empty, which would light up TITLE CHANGED and the divergence border on every load.
  `Collaboration`'s own `onFirstRender` is *not* a sufficient signal — with the collab server
  unreachable it fires immediately against the still-empty fragment. Save/publish/schedule are
  gated on `providerSynced` alone (Unpublish isn't — it sends no content), which also closes a
  pre-existing hole where saving mid-handshake would persist the empty *body*.

**Title-divergence indicator:** the title field gets a persistent 2px `#ffd800` border
whenever its live value differs from the currently *published* title (`publishedTitle`,
`null` unless `postStatus === "published"`) — a separate check from TITLE CHANGED above,
which compares against the last-*saved* title rather than the published one. The field has a
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

**Naming:** the database is snake_case — table and column names below are literal, not
pseudocode — while the Prisma client stays camelCase (`schema.prisma`'s `@map`/`@@map` on
every model and field bridge the two). Table names are singular (`user`, not `users`)
throughout, including any future `doc*` tables — except `site_settings`, which stays plural
despite being a singleton, since "the site setting" reads oddly and "settings" is the natural
English plural regardless of row count. Enum *type* names (`Role`, `ModerationPolicy`, ...)
are also snake_case here (`role`, `moderation_policy`), unlike the Auth.js adapter's own
already-snake_case fields (`refresh_token`, `access_token`, ...), which keep their names on
both sides since `@auth/prisma-adapter` writes them by name.

```
user             id, email, name, password_hash | oauth, role, created_at,
                 color                                           -- author-highlight/caret color
                 admin_initials(non-null string)                 -- byline shorthand, §10 item 11
                 moderation_policy('inherit'|'always'|'auto')   -- per-author override
                 deleted_by_user_id NULL, deleted_at NULL         -- soft delete, §3b
post             id, slug, title, publish_revision_id,
                 created_at, published_at (may be future),       -- no status column, no schedule
                                                                   -- column (§10 item 12): visible iff
                                                                   -- publish_revision_id is set AND
                                                                   -- published_at <= now()
                 moderation_policy('inherit'|'always'|'auto')   -- per-post override
                 deleted_by_user_id NULL, deleted_at NULL         -- soft delete, §3c
post_author      post_id, user_id, byline_order                 -- manual byline, decoupled
revision         id, post_id, revision_number, doc JSONB (ProseMirror),
                 title, editor_id, changelog, created_at         -- IMMUTABLE. title is the
                                                                   -- *saved* title; the working
                                                                   -- one is a Yjs fragment (§3d).
                                                                   -- post.title also gets a
                                                                   -- debounced write straight off
                                                                   -- that fragment (§3d), so it's
                                                                   -- no longer purely "whatever
                                                                   -- the last save/publish wrote"
post_publication_event id, post_id, type(published|unpublished|   -- audit log of publish/unpublish/
                 scheduled|schedule_canceled), revision_id NULL,   -- schedule transitions (§10 item 12) —
                 scheduled_for NULL, actor_id NULL, created_at      -- needed once those transitions can
                                                                     -- happen without a new revision
post_collab      post_id, ydoc BYTEA, updated_at                 -- live Yjs state (working draft):
                                                                  -- two fragments, "default"
                                                                  -- (body) + "title" (§3d)
post_collab_update id, post_id, created_at, update BYTEA         -- raw Yjs update log, since
                                                                  -- last revision only (§10 item 9)
site_settings    id(singleton), default_moderation_policy, trust_threshold(int, e.g. 3), ...
commenter        id, user_id NULL, email, display_name,          -- identity for a commenter
                 approved_count(int), force_moderate(bool)        -- per-commenter override
comment_thread   id, post_id, anchored_revision_id,
                 anchor_from int, anchor_to int, quoted_text,
                 status(active|detached|resolved), created_at
comment          id, thread_id, parent_comment_id NULL,
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
  `post_author` byline.
- **Drafts / working state** live in `post_collab.ydoc` (the live Yjs document), persisted
  by Hocuspocus. Edits never pollute revision history; only an explicit **publish** snapshots
  the current doc into a `revision` row.
- **`post_collab_update`** is an append-only log of raw Yjs updates for the *current*
  session only — reset (rows deleted) every time a revision is saved, so it never grows past
  "since the last revision" regardless of how long a post has existed (§10 item 9).
- **Comment tree**: `parent_comment_id` self-reference; render the tree with one recursive
  CTE. Plenty fast at hobby scale.
- A **thread** is the unit anchored to a quote; **comments** form the reply tree inside it.
- **Commenter identity** (§6): a `commenter` is keyed by account (`user_id`) when logged in,
  otherwise by email. `approved_count` and `force_moderate` drive the trust model.
- **Soft delete** (`deleted_by_user_id`/`deleted_at`, both nullable): the same two-column
  pattern now covers `comment` (§10 item 15, first), `user` (§3b), and `post` (§3c). Rather
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

**Decided:** both `post.slug` and `user.slug` (author-page slugs, `/authors/[slug]`) can be
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

**Cross-post moderation (`/comments`, `CommentsTable.tsx`, built).** The per-post moderation
queue (`/posts/[id]/comments`) only ever shows one post's `PENDING` comments. `/comments`
is the site-wide counterpart: every comment across every post the signed-in user can manage
(all of them for ADMIN/EDITOR, own-authored posts only for AUTHOR — mirrors `/posts`'s own
`canEditAnyPost` gate), filterable and actionable in bulk.

- **Filtering, sorting & pagination all happen server-side** (`comments-query.ts` is the one
  place that knows the querystring shape — `status`, `threadStatus`, `deleted`, `q`, `page`,
  `pageSize`, `sort` — shared by the server page, which turns it into a Prisma `where` /
  `orderBy` / `take`+`skip`, and the client table, which parses it for display and
  re-serializes it on change). Changing any control calls `router.replace()` with a new
  querystring — a real navigation, not a client-side re-filter of an already-downloaded
  array — so a comment volume beyond dev-DB size doesn't ship every row to the browser on
  every load. `status` and `threadStatus` are multi-select dropdowns (with an "All" option,
  closing on an outside click since `<details>` alone doesn't do that);
  `deleted`, `q` (free-text over comment body + commenter name/email, debounced 400ms so
  typing doesn't fire a query per keystroke), `page`, and `pageSize` (10/25/50/100) round out
  the filters with UI. `post`, `author`, and `commenter` remain deep-link-only querystring
  filters (applied server-side, no dropdown yet) — e.g. for a future "moderate this author's
  comments" link. Column headers sort server-side too, including ctrl-click multi-column sort
  (`nextSortColumns`, factored out of `useSortableRows` so this URL-driven sort state could
  reuse the same click/ctrl-click toggle semantics as `PostsTable`/`UsersTable`'s local-state
  version) — except the commenter-activity column (see below), which stays display-only since
  sorting by it would need a correlated subquery per row rather than a plain `orderBy`.
- **Row actions**, one "Action" column: Approve / Pend / Spam (`moderateComment`, extended
  to accept `"pend"` alongside the existing `"approve"`/`"spam"`, mapping to
  `CommentStatus.PENDING`) plus a delete/restore toggle identical in spirit to `/posts`'s
  soft-delete column (`deleteComment`/`restoreComment`). A deleted row stays visible (with a
  visit-local overlay, `CommentsTable`'s `revealedRows`) until the next real navigation even
  though the following server refetch would otherwise drop it — the same UX `PostsTable`/
  `UsersTable` give a just-deleted row, just achieved without their sessionStorage-backed
  `useShowDeletedRows`, since here `deleted` already lives in the querystring. That column's
  header is the same sortable black `IconTrash` control as `PostsTable`/`UsersTable` (§3c) —
  server-side here (`deleted` as a `CommentsSortKey`, ordering by `deletedByUserId` with
  explicit `nulls: "first"`/`"last"` to keep not-deleted rows first when ascending, matching
  the other two tables' client-side sort convention for the same column).
- **Bulk actions**: a row-checkbox column (scoped to the current page only — cross-page
  "select all N matching rows" is deliberately unresolved for now) feeds a toolbar that
  appears once anything is selected, mirroring the per-row Action column: Approve/Pend/
  Spam styled identically (same `AdminTable.module.css` classes), then a delete icon
  (`IconTrash`, `margin-left: 4em` to set it apart from the three moderation actions) and
  a restore icon (`IconTrashOff`) styled like the table's own delete/restore toggle.
  Backed by batched server actions (`bulkModerateComments` — now also taking `"pend"` —
  `bulkDeleteComments`, `bulkRestoreComments`) — each silently skips rows the action
  doesn't apply to (e.g. bulk-approve skips already-deleted rows) rather than erroring on
  a mixed selection.
- **Commenter activity column** reads `{submitted} / {in moderation} / {spam}` — a separate,
  lightweight (`commenterId`/`status` only) query scoped to role + deep-link filters but
  *not* the status/threadStatus/deleted/q filters, so the counts summarize a commenter's
  overall activity within what this user can see rather than just what the current filtered
  page happens to show (an AUTHOR still never sees a commenter's activity on posts they can't
  manage, since the role scope still applies).

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
- Multi-author: posts carry a manual byline (`post_author`) decoupled from edit
  attribution (`revision.editor_id`) (§3).
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

## 10. Implementation progress (as of 2026-07-25)

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
   plan: `comment` also records submitter IP and who/when last changed its status.
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
17. **Fixed: `auth()` in an ISR'd page was crashing production, not just losing cache** — the
    first real deploy (a fresh Ubuntu 26.04 Linode, §7) 500'd on every published post. The
    known gap this item replaces (below) had undersold the severity as "home/author pages
    lose their shared cache": `src/app/[slug]/page.tsx` also calls `generateStaticParams()`
    (item 4), and a route that's both eligible for static generation *and* calls a dynamic
    API (`auth()` reads cookies) during that attempt doesn't fall back to per-request
    rendering — it throws `DYNAMIC_SERVER_USAGE`, a hard error. `next dev` never enforces
    this the same way `next build`/`next start` does, so nothing caught it before a real
    production build. Fixed by moving every viewer-identity-dependent read off the server:
    `SiteHeader`, `PostEditBadge`, `CommentForm`, `CommentNode`, and `CommentSection` no
    longer call `auth()` anywhere in their render path; a new `SessionProvider` (root layout)
    backs a `useSession()` call at each of those components instead, restoring real
    static/ISR/SSG rendering on `/`, `/[slug]`, and `/authors/[slug]`. `src/lib/role-checks.ts`
    was split out of `authz.ts` (which imports Prisma) so client components can import the
    pure `canEditAnyPost`/`isAdmin`/`canManagePosts` checks without risking Prisma landing in
    the browser bundle. See CACHING.md's 2026-07-23 entry.

18. **Playwright end-to-end suite** (`npm run e2e`) — the project's first automated tests,
    beyond §8 and unplanned. Motivated by cost, not coverage: verifying a change by hand
    through the browser pane costs a dozen `read_page`/click round trips per flow and repeats
    the sign-in every session, and the three flows below were being re-driven manually over
    and over. The whole suite runs in ~20s. Written-up detail — fixtures, helpers, and the
    traps that bite when adding specs — lives in `e2e/README.md`; only the decisions are here.
    - **Scope**: `publish.spec.ts` (publish → public slug, edits invisible until republish,
      unpublish → 404), `moderation.spec.ts` (pending comment hidden until approved, approved
      → spam re-hides, plus one real form submission), `collab.spec.ts` (two authors on one
      post: body sync both ways, the title fragment syncing without leaking into the body,
      and a save by one clearing the other's EDITED badge), and `quote-anchoring.spec.ts`
      (item 7 / §5, below). The collab spec is the one that most justifies the suite — the
      browser pane's tabs share a cookie jar, so "two users at once" is a manual balancing
      act there, while Playwright gives each identity its own `browser.newContext()`.
    - **Quote anchoring across revisions now has coverage** (`quote-anchoring.spec.ts`), the
      §1 "genuinely hard part" and previously the most expensive thing to re-verify by hand.
      Four cases against a fixed one-paragraph body, with anchors asserted as literal
      ProseMirror positions: an edit entirely *before* the quote shifts both anchors by the
      inserted length and keeps the thread ACTIVE against the new revision; deleting a word
      inside the quote detaches it; deleting the quoted words detaches it; deleting past the
      quote's trailing boundary detaches it. Each detach case also asserts the anchor stays
      frozen at the revision it was last valid against, and that the public page drops the
      inline highlight while still listing the thread with its notice.
      - **Worth recording, because it's counterintuitive**: deleting exactly the quoted text
        does **not** collapse the anchor range. `recreateTransform` diffs at character level,
        so removing `"brown fox jumps "` still maps the range to 11..12 — the quote's end
        pairs with the `"o"` of the following `"over"`. That case therefore detaches on the
        `quotedText` comparison, the same branch as an edit inside the quote; only deleting
        past the boundary (`"brown fox jumps over "`) actually reaches `mappedTo == mappedFrom`.
        The first draft of the spec asserted the wrong mechanism in a comment while still
        passing, which is what prompted checking the mapping directly.
    - **Auth is paid once.** A `setup` project signs `e2e-admin@example.com` in through the
      real form and writes the cookie jar to `e2e/.auth/admin.json`; every test starts from
      that `storageState`. A matching `cleanup` teardown project sweeps `e2e-*@example.com`
      users, "E2E …" posts and orphaned commenters that a crashed run left behind.
    - **`webServer` reuses a running `dev:all` unconditionally** (not just outside CI) — the
      CLAUDE.md rule that a dev server we didn't start isn't ours to kill applies to the test
      runner too. It starts (and stops) its own web+collab pair only when nothing is listening.
    - **The DB helpers run in a `tsx` child process**, not in-process: Playwright's TypeScript
      loader compiles to CommonJS and `require`s the result, but `src/generated/prisma/client.ts`
      uses `import.meta.url`, which has no CJS equivalent — the transform leaves ESM syntax in
      its own CJS output and Node dies with `exports is not defined`. `e2e/db-worker.ts` holds
      the Prisma calls under `tsx` (the same reason `scripts/*.ts` already run that way);
      `e2e/db.ts` is a JSON-over-stdio client, one child per Playwright worker so the ~1.5s
      startup is amortized. Converting the project to `"type": "module"` would also fix it and
      was rejected as far too large a change for one test runner's import of one generated file.
      Both halves keep the `@example.com`-only guard `scripts/test-user.ts` uses.
    - **Two source changes it forced.** (a) `CollabEditorBody`'s contenteditable gained
      `aria-label="Post body"`, mirroring the title field's existing one — without distinct
      accessible names the only thing separating the two editors is DOM order, the `.tiptap`
      fragility CLAUDE.md already warns about. (b) `server/collab.ts`'s two persistence hooks
      now swallow Prisma's `P2003` specifically: deleting a post while its Yjs doc is still
      loaded made `onStoreDocument`/`onChange` throw a foreign-key violation, and since
      Hocuspocus doesn't catch what its hooks throw, the rejection was unhandled and **killed
      the collab process**. Found by the fixture teardown, but not a test artifact — a
      hard-delete in production would do the same. Every other error still propagates.

19. **Fixed: restoring an old revision never reached the live document** — found by writing
    item 18's `restore-revision.spec.ts`. `restoreRevision` wrote a new Revision row carrying
    the old content and updated `Post.title`, and stopped there. But the editor renders the
    collab Y.Doc, and `onLoadDocument` re-seeds that from a revision *only* when no
    `PostCollab` row exists — which stops being true the moment a post is edited once. So the
    author was dropped back into the editor still looking at the content they meant to
    discard, and the next Publish snapshotted `editor.getJSON()`, silently undoing the
    restore. The revision row made history *look* right, which is what made it hard to see.
    - **Fixed by writing through the running collab server.** A new `onRequest` handler in
      `server/collab.ts` (`POST /admin/replace-doc`, path shared via `src/lib/collab-admin.ts`
      so the two ends can't drift) opens a `DirectConnection` and replaces the `default` and
      `title` fragments; `restoreRevision` calls it after its transaction. Authorization
      reuses the existing short-lived collab JWT — the action mints one only after
      `requireEditableSession`, so a valid token naming the document is the credential, the
      same contract `onAuthenticate` already uses.
    - **Why not just delete the `PostCollab` row and let `onLoadDocument` re-seed:** a
      document with a connected editor stays loaded in the collab server's memory, so
      `onLoadDocument` never runs again and that client simply re-flushes its old state over
      the restore. Going through the running server is also what makes the restore reach a
      co-author who already has the editor open — covered by a test that asserts exactly
      that, with no reload on the second client.
    - Both fragments are written with y-prosemirror's `prosemirrorToYXmlFragment`, which
      diffs against what's there and emits only the differing ops, using the live document's
      own clientID. Merging in an update built from a separately-created `Y.Doc` would risk
      the clientID collision `onLoadDocument`'s title-seeding comment already warns about.
      `y-prosemirror` was promoted to a direct dependency (pinned to the version already in
      the tree via TipTap, so there's still exactly one copy of it and of `yjs`).

20. **Fixed: a DETACHED quote thread could never reattach, even to text identical to what it
    was anchored against** — found via a test written specifically for this scenario: quote
    something, publish an edit that invalidates it (thread goes DETACHED, item 7), restore
    the earlier revision (item 19) and publish that restore, reload the public page. The
    article was now byte-for-byte what it was when the thread was last ACTIVE, and the
    thread stayed DETACHED anyway. `remapThreadsToRevision`'s query
    (`src/lib/anchor-remap.ts`) was `where: { status: "ACTIVE" }` — DETACHED was a terminal
    state, excluded from every future publish's remap, permanently, regardless of what a
    later revision said.
    - **Fix**: the query now includes `DETACHED` alongside `ACTIVE`. A DETACHED thread stays
      frozen at the revision it was last valid against (nothing else ever touches those
      fields while it's detached — see below), so it's still grouped and re-diffed by that
      same frozen revision on every later publish, same mechanism as an ACTIVE thread's
      remap. If the diff finds the quoted text again, it goes back to ACTIVE with a fresh
      anchor into the new revision, same as it would have on first publish.
    - **A DETACHED thread that's still not found writes nothing** — the loop now skips the
      update entirely for that case, rather than writing `{ status: "DETACHED" }` over
      already-DETACHED fields. Purely to avoid a repeated no-op write on every future publish
      for as long as a post keeps a stale detached thread; behavior is identical either way,
      since `CommentThread` has no `updatedAt` for the no-op to have disturbed.

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
  particular to step 7; that's just what "restore" has always meant here (§8 step 2). Since
  item 19 that Publish does at least publish the *restored* content; before it, the second
  step silently republished whatever the live document still held.
- **`next dev` gets unreliable under concurrent load**, which the e2e suite ran into before
  its worker count was tuned down. Two distinct symptoms, neither reproducible in isolation
  and neither an app defect: a public page 500ing with `useSession must be wrapped in a
  <SessionProvider />` thrown from `CommentForm` during SSR (the root layout does wrap
  `{children}`, and next-auth guards that throw so it cannot fire in production), and server
  actions arriving with truncated bodies — `Unexpected end of JSON input` on
  `/posts/[id]/edit`, leaving the clicked action silently unapplied. Measured at roughly one
  failed run in 3.5 with three Playwright workers versus none in eight with two, at identical
  wall-clock time. Worth knowing beyond the tests: it's a ceiling on how much concurrent
  traffic a dev server can be trusted to serve correctly, and says nothing about production.
- The "quoted-text position" sort in the comment list compares `anchorFrom` across threads
  that may be anchored to *different* revisions (an active thread's position is in the
  current doc's coordinates; a detached thread's is frozen in an old revision's) — so sort
  order between an active and a detached entry is not meaningful. Pre-existing limitation,
  more visible now that detached threads are a real state instead of a hypothetical one.
- ~~The collab JWT (`signCollabToken`) expires after 2 minutes and a `HocuspocusProvider`
  doesn't fetch a fresh one on reconnect...~~ **Fixed by §12 Phase 2** — `token` is now a
  *function* rather than a fixed string at all four call sites (`PostEditor`,
  `LiveHistoryViewer`, `DocEditor`, `LiveDocBody`), which Hocuspocus calls on every
  connection attempt rather than only the first. Each one hands the already-fetched token to
  the first call and re-mints from there, so the initial-connection error path is unchanged.
  The doc side is what forced it (§12g: a reading view that promises to stream can't retry
  forever on an expired token), but the fix is the same one line for posts.
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
- ~~The home and author pages' `revalidate = 60` ISR caching is now a no-op...~~ **Fixed by
  item 17** — see CACHING.md's 2026-07-23 entry.
- The e2e suite (item 18) covers seven flows, not the app — the original five plus the ydoc
  stack (§11g) and docs/annotations (§12n). Roles/authz, the admin tables, scheduled
  publishing, soft deletion, and *post* live history still have no specs; the ydoc replay
  slider does (`ydoc-debug.spec.ts`), which is a different component over a different table.
  Nothing runs any of it automatically either: there's no CI (nothing is deployed, per the
  first gap above), so it only runs when someone types `npm run e2e`.
- Comment-submission coverage is capped by the app's own rate limit (5 per IP per 10 minutes,
  `src/lib/rate-limit.ts`) — every Playwright worker shares 127.0.0.1, so specs insert
  comments directly via Prisma and exactly one exercises the real form. A future spec that
  needs several genuine submissions would have to make the limit configurable, or reset the
  window between tests.

## 11. Ydoc persistence — a parallel stack (built 2026-07-28)

The working Yjs document currently lives in two post-shaped tables: `post_collab` (a
whole-document blob, upserted on a debounce) and `post_collab_update` (an append-only delta
log, **truncated on every save**). Both carry a `post_id` foreign key to `post`, and
`server/collab.ts` writes them directly. Four problems, three of them already documented:

- **Re-seeding duplicates content.** `onLoadDocument` seeds a fresh doc from the latest
  revision whenever no `post_collab` row exists — and that row is only written by the
  *debounced* `onStoreDocument`, so a collab server killed before the debounce fires re-seeds
  a second, structurally distinct copy into a doc reconnecting clients already hold. Yjs
  merges rather than dedupes, so every paragraph appears twice (see the "Restarting the collab
  server" gotcha in CLAUDE.md).
- **The foreign key is a crash surface.** Deleting a post while its doc is loaded makes both
  persistence hooks throw `P2003`, and Hocuspocus doesn't catch what its hooks throw, so the
  rejection takes the whole collab process down. `ignoreMissingPost` (item 20 above) is a
  narrow band-aid around one error code.
- **The typing path runs an `O(n)` query per keystroke** — `postCollabUpdate.count()` before
  every insert, to decide full-state vs. delta; `O(n²)` over a session (PERFORMANCE.md).
- **No client-side durability.** Nothing survives a closed tab or an unreachable server beyond
  what the collab process happens to be holding in memory.

The replacement is built as a **fully parallel stack**, proved on a dedicated `/ydoc-debug`
page, and cut over to posts later as a separate change. Three new tables keyed purely by the
Hocuspocus `documentName`, a new store module, new hooks, `y-indexeddb` on the client, and
server-written clientID→user attribution. The log is never truncated on save — only,
optionally, up to a snapshot — and snapshots are ours to construct rather than Hocuspocus's.

**The hard constraint: nothing that presently exists may touch the new tables.** Post editing
stays on `post_collab`/`post_collab_update`, byte-for-byte. `PostEditor.tsx`,
`LiveHistoryViewer.tsx`, `PostEditBadge.tsx`, `src/app/actions/posts.ts` and
`src/lib/collab-token.ts` are not modified at all; `server/collab.ts` gains only dispatch.
Everything new lives in new files. That isolation is the point: it lets the design be proved
against real editing without putting a single existing flow at risk, and it makes the cutover
a reviewable change of its own rather than a big-bang rewrite.

**`gc: true` stays.** It is already Hocuspocus's default (`yDocOptions`, `defaultConfiguration`
in `@hocuspocus/server`), but §11d states it explicitly so it reads as a decision. The
consequence — both already true today — is that comment anchors remain absolute ProseMirror
positions (§5) rather than Yjs relative positions, and the stored blob remains a *derived*
value that nothing anchors into. Moving to `gc: false` later would invert that: anchors would
name item IDs *inside* the stored document, so re-seeding from a revision would build a
structurally new doc and dangle every anchor.

### 11a. Naming, and what routes a document to the new stack

`ydoc.id` **is** the Hocuspocus `documentName`, and new-stack documents are named
`ydoc:<cuid>`. Post documents are bare cuids, so the prefix is an unambiguous, zero-query
routing key — no "does a Post row exist" lookup on every cold open. `src/lib/ydoc-names.ts`
holds the prefix constant, `isYdocDocument(name)`, and the snapshot endpoint's path, shared
between web and collab server exactly the way `src/lib/collab-admin.ts` already shares
`REPLACE_DOC_PATH`.

Throwaway test documents use `ydoc:test-<cuid>`, and both `scripts/test-ydoc.ts` and the e2e
teardown refuse to delete anything that doesn't match — the same containment convention as the
`@example.com` guard in `scripts/test-user.ts` and `e2e/db-worker.ts`.

### 11b. Schema, and the two invariants it rests on

Three models in `prisma/schema.prisma`, snake_case-mapped like the rest. No relation to `Post`;
the only outward foreign key in the whole set is `ydoc_snapshot.user_id → user`:

```
ydoc          id                    -- the Hocuspocus documentName
              ydoc BYTEA            -- encodeStateAsUpdate; the O(1) cold-open path
              state_vector BYTEA
              created_at            -- doubles as the lineage stamp (§11e)
              updated_at

ydoc_update   id BIGSERIAL, ydoc_id, update BYTEA, created_at
              -- NEVER truncated on save. First row per ydoc is a full state; the rest deltas.

ydoc_snapshot id, ydoc_id, ydoc BYTEA, state_vector BYTEA,
              last_ydoc_update_id   -- high-water mark in ydoc_update
              user_id NULL          -- null = system-triggered
              created_at
```

The one line this adds to an existing model is a `ydocSnapshots` back-relation on `User` — no
column, no behavior. Migration `add_ydoc_tables`.

Everything downstream depends on two invariants:

1. **Row #1 of `ydoc_update` for a document is a full state; every later row is a plain
   delta.** Written once, at document creation, in the same transaction as the `ydoc` row.
   The old table decides this per-keystroke with a `count()`, because its log gets truncated
   on every save and so has no stable row #1; this one never does, so the decision is made
   once and the append path is `O(1)`.
2. **The replay base is derivable, so truncation is safe.** `minId = MIN(ydoc_update.id)` for
   the document; the base is the newest `ydoc_snapshot` with `last_ydoc_update_id < minId`, or
   — when there is none — row #1 itself. Nothing truncates yet, but every reader resolves the
   base this way from day one, so switching truncation on later is a no-op for callers rather
   than a migration of every read site.

### 11c. `server/ydoc-store.ts` — the only code that touches the three tables

Generic by construction: it takes a `documentName` and bytes, and knows nothing about posts,
revisions, or authz. That is what "the ydocs don't know about anything else in the DB" buys —
the store is reusable for any Yjs document the app grows later, not just post bodies.

```
load(id)                       -> { ydoc, stateVector, createdAt } | null | Unavailable
createIfAbsent(id, ydoc, sv)   -> { won: true } | { won: false, existing }
appendUpdate(id, update)       -> queued, serialized per document
storeState(id, ydoc, sv)       -> blob + state_vector + updated_at
createSnapshot(id, ydoc, sv, lastUpdateId, userId)
resolveReplayBase(id)          -> { snapshot } | { firstUpdateId }        (invariant 2)
```

Three things it has to get right:

- **`createIfAbsent` is the anti-duplication primitive.** It creates the `ydoc` row and the
  full-state `ydoc_update` row #1 in one transaction; on `P2002` it re-reads and returns the
  *winner's* blob. The caller then applies the winner's bytes to the live document and discards
  its own losing seed. Two processes racing a cold open therefore converge on one lineage
  instead of merging two — which is the root cause of the doubling gotcha, addressed
  structurally rather than by warning people not to restart the server.
- **Appends are serialized per document** by a promise chain, so `BIGSERIAL` order always
  matches emission order. Concurrent `create` calls would otherwise interleave ids against
  causal order and quietly break replay.
- **Nothing throws into a Hocuspocus hook.** Every method runs through an error classifier:
  `P2003` (now reachable only via `ydoc_update.ydoc_id`, if the `ydoc` row is deleted underneath
  a loaded document, or `ydoc_snapshot.user_id`) → log, drop the write, mark the document
  non-persisting; connection-class errors (`P1001`/`P1002`/`P1008`/`P1017`,
  `PrismaClientInitializationError`, `ECONNREFUSED`) → trip a circuit breaker for a few seconds
  so a down Postgres isn't hammered once per keystroke; anything else → log and drop. This
  generalizes `ignoreMissingPost` from "one error code, two call sites" to "the store cannot
  take the process down."

**Degraded mode.** Per-document `{ persisted: boolean }` state, plus a `YDOC_PERSISTENCE=off`
env switch that swaps in a `NullYdocStore` whose every method is a logged no-op. If `load()`
comes back unavailable the document is marked non-persisting **for its whole in-memory
lifetime**: it is not seeded (seeding against unknown stored state is precisely how you get two
lineages), and the write methods become no-ops logged once per document rather than once per
update. Clients still connect and edit, and because of `y-indexeddb` the first client to
reconnect repopulates the server document from its own local copy — the same lineage, so the
merge is correct rather than duplicating. The stickiness is deliberate: a document that came up
unseeded must never later overwrite a real `ydoc` row. It retries on the next cold open, once
the last client disconnects and Hocuspocus unloads it.

### 11d. Hocuspocus wiring, and clientID → user_id

All new behavior lives in `server/ydoc-hooks.ts`. `server/collab.ts` gains only dispatch: a
one-line `isYdocDocument(documentName)` guard at the top of `onLoadDocument`, `onChange` and
`onStoreDocument`, one branch in `onAuthenticate`, one more `onRequest` branch for the snapshot
endpoint, a new `onAwarenessUpdate` that returns immediately for non-ydoc documents, and the
explicit `yDocOptions: { gc: true, gcFilter: () => true }`.

**Auth.** `src/lib/collab-token.ts` is untouched; a parallel `src/lib/ydoc-token.ts` defines
`YdocTokenPayload { sub, documentName, role }`, signed with the same `AUTH_SECRET` and the same
2-minute expiry. `onAuthenticate` picks the verifier by prefix.

**Loading** reads the row and applies it; on `Unavailable` it marks the document degraded and
returns an empty doc; on a miss it calls `createIfAbsent` with an empty state and applies
whichever blob won. There is deliberately **no revision fallback** — that coupling is exactly
what these tables exist to shed. In practice the row always already exists, because the script
and the `/ydoc-debug` "New document" button both create it (row #1 included) before anyone
connects; the auto-create is just the forgiving path for a connection to a name nobody made,
and an empty seed has no content to duplicate.

**`onChange`** is one call to `appendUpdate` — no `count()`, because invariant 1 was settled at
creation. **`onStoreDocument`** writes the blob and state vector.

**Snapshots go through the running collab server** (`POST /admin/ydoc-snapshot`, beside the
existing replace-doc handler), never from the stored blob in Next: the blob is debounce-stale
relative to the log, so a `last_ydoc_update_id` computed against it could sit *ahead* of what
the blob actually contains, and truncating to it would lose updates. Order is what makes it
safe — read `MAX(ydoc_update.id)` **first**, then encode the live document. That guarantees
`blob ⊇ everything ≤ lastId`; anything landing in between shows up after `lastId` and survives
a truncation. The error is in the safe direction by construction.

**clientID → user_id lives in the document**, as a top-level `Y.Map`
(`document.getMap("clients")`, `String(clientID) → userId`). Top-level, so the `"default"` and
`"title"` fragments are untouched; it replays with history, survives cold opens, needs no fourth
table, and holds only an opaque id string — so the `ydoc` tables still reference nothing.

It is written **server-side**, on edit only, from payload fields Hocuspocus already provides:
`onAwarenessUpdate` gives `{ added, connection }`, which is a connection's self-reported Yjs
`clientID` — cached in memory as `socketId → clientID`. That binding, not the update bytes, is
the reliable one: a reconnecting client's SyncStep2 can carry structs authored by *other*
clients, so attributing everything in an update to its sender would mislabel them. Then the
first time a connection produces a doc-changing `onChange`, the map gets
`clients.set(String(clientID), context.userId)` **if absent** — `context.userId` coming from
`onAuthenticate`, so it is the authenticated identity rather than a client-supplied claim.
Presence alone never writes anything: you are added when you *edit*. (The server's own write
produces an `onChange` with no `connection`, so it is skipped and the loop converges.)

This is complementary to, not a replacement for, the `authorHighlight` mark (§3d): that
attributes individual characters and is stripped before a revision is written; this attributes a
whole client session and stays in the document.

### 11e. The client: `y-indexeddb`, and two different duplication bugs

`y-indexeddb` is added for `/ydoc-debug`'s editor only; `PostEditor.tsx` is untouched. There
are two distinct duplication bugs in play, and they need different fixes.

**Multiple `IndexeddbPersistence` instances on one `Y.Doc`**
([y-indexeddb#25](https://github.com/yjs/y-indexeddb/issues/25)) — each instance re-persists the
others' updates, because the library's guard only excludes *itself* as an origin. React
StrictMode's double-invoked effects are exactly how you end up with two. Fixed in
`src/lib/ydoc-persistence.ts` by a module-level `WeakMap<Y.Doc, { persistence, refs }>`, so
attaching twice returns the same instance and bumps a refcount, and detaching only destroys at
zero.

**A stale local copy merging into a re-seeded server document** — the one that actually
corrupts content. It is the client-side twin of the restart-doubling gotcha, and worse, because
IndexedDB makes it survive a fresh tab. Fixed by keying the local store on document *lineage*
rather than name: `ydoc:<documentName>:<ydoc.created_at epoch ms>`. `created_at` changes only if
the `ydoc` row is recreated — precisely when the server has built a structurally new document —
so a re-seed lands in a *different* local store and there is nothing to merge. Stale stores for
the same name are swept on attach via `indexedDB.databases()`, guarded because Firefox doesn't
implement it (in which case they are merely orphaned, which is harmless).

The lineage has to be known *before* connecting, which is why `POST /api/ydoc/[id]/token`
returns `{ token, lineage }` — it is already doing a Postgres round-trip to authorize, and the
`ydoc` row is guaranteed to exist by then (§11d), so the lineage is never null. Caching it in
`localStorage` to skip that round-trip was considered and rejected: it would let a
stale-lineage store merge into the live document *before* the mismatch could be detected, which
is the bug, not a race around it.

Unchanged and load-bearing: **the client never seeds content.** Seeding is server-side only.

### 11f. `/ydoc-debug`

An ADMIN-gated page in the same shape as `/site-settings`, existing to make every claim above
observable rather than to ship a user-facing feature.

- A dropdown of the ten most recently updated `ydoc` rows, first auto-selected.
- **Read-only by default**: a replay slider over the update log (§11h), rendered through
  `TiptapTransformer` + `@tiptap/static-renderer` exactly as `LiveHistoryViewer` does, wrapped
  in a `try/catch` so a document that isn't TipTap-compatible renders an error message instead
  of blowing up the page. The `"title"` fragment renders alongside when present, and so does the
  `clients` map — the point being that you can watch it stay empty while you only *look* at a
  document, and fill the moment you type. The render helper is copied into
  `src/lib/ydoc-render.ts` rather than refactored out of `LiveHistoryViewer`, which is off-limits
  under the isolation constraint; deduplicating the two is part of the cutover.
- A **"Switch to editing"** toggle that mounts a `HocuspocusProvider` plus the existing
  `CollabEditorBody`, used unmodified (its toolbar and `QuoteControls` are purely editor-local,
  with no post coupling).
- A **Refresh** section showing the single `ydoc` row, the `ydoc_update` count and its last ten
  rows, and every `ydoc_snapshot` row — plus a **Snapshot** button that takes one and refreshes
  in place.

Fixtures come from both directions: `scripts/test-ydoc.ts` (create/list/delete, with
`--from-post` to build a document from a real revision so there is genuine TipTap content, and
`--garbage` to exercise the error path) and an on-page "New document" button for a quick empty
one.

### 11h. The replay slider — measuring what a snapshot buys

The read-only view is a scrubber over `ydoc_update`, and the first thing that actually consumes
either of §11b's invariants. It exists to *measure*, not to scrub pleasantly: it rebuilds from
the newest `ydoc_snapshot` at or before the target position rather than from row #1, and reports
what that cost.

`GET /api/ydoc/[id]/replay` ships every update and snapshot payload once, so a scrub step
touches no network and the reported milliseconds are Yjs replay and nothing else. (base64 is
decoded to bytes up front for the same reason — it's a transport artifact of shipping this over
JSON, not part of replay.) That deliberately ships the whole log in order to measure the cost of
*not* replaying all of it; it's a debug page, and the alternative — fetching per step — would put
network latency inside the number being compared.

**Forward is fast, backward is slow, and that asymmetry is the point.** Moving forward advances
the `Y.Doc` already in hand. Moving backward can't: Yjs updates are append-only and there is no
un-apply, so going back means rebuilding from the base. Nothing debounces the slider, caches
other positions, or precomputes — measured over an 882-update log with two snapshots, a full
forward sweep applied 879 updates in 56ms total, while the same sweep backward applied 137,406
in 852ms. The status line reports `forward`/`rebuild`, the base and its size, the resultant size
as a signed delta, updates-since-base, updates-applied-this-step, and elapsed ms.

Snapshots show up as circles on the track, and the cliff either side of one is the clearest
single demonstration in the whole §11 stack: landing exactly on a snapshot applies **0** updates
(0.1ms — the blob alone is the answer), while one index earlier applies 354 (2.7ms), because that
snapshot no longer qualifies and the rebuild falls back to the previous base.

Two caveats worth keeping:

- The `Y.encodeStateAsUpdate` behind the size delta runs every step and is **pure
  instrumentation**. It sits outside the timer because it isn't part of the rebuild, but it is
  real per-step cost, and on a large document it can exceed the rebuild it reports on. The
  millisecond figure is not this view's total step cost.
- A snapshot's blob is guaranteed to contain everything at or below its `last_ydoc_update_id`,
  but may contain slightly *more* — §11d reads that mark *before* encoding, deliberately, so
  truncation stays safe. So landing exactly on a circle can show content a hair ahead of that
  point if the snapshot was taken mid-keystroke. Near-zero in practice (snapshots are a manual
  button press), but it's why the scrubber isn't frame-accurate at snapshot boundaries.

### 11g. Verification

The suite (`e2e/ydoc-debug.spec.ts`, with `db-worker.ts` helpers and a `ydoc:test-*` teardown
sweep) asserts the invariants rather than the UI: creating a document writes the `ydoc` row and
**exactly one** `ydoc_update` row before anyone connects; opening the page read-only adds no
rows and leaves `clients` empty, while typing one character adds rows and exactly one `clients`
entry; replaying row #1 plus deltas into a scratch `Y.Doc` reproduces the editor's text with
each paragraph appearing once; a snapshot's `last_ydoc_update_id` never exceeds
`MAX(ydoc_update.id)`. The isolation constraint gets its own assertion — editing a post must
leave all three new tables empty — and the existing specs must pass unchanged.

What the suite can't reach is checked by hand: restarting `collab` with the tab open and
confirming content appears once (the case that doubles on the post path today); running with
`YDOC_PERSISTENCE=off` and with Postgres stopped mid-session, confirming the process survives
and logs once per document rather than once per keystroke; deleting a `ydoc` row underneath a
live editor to exercise the `P2003` path; and killing `collab` mid-typing to confirm the local
IndexedDB edits sync back up once, not twice.

## 12. Docs alongside posts, on the ydoc stack (built 2026-07-29 — see §12n for the as-built record)

**Decided:** add a **Doc** — an always-evolving living document, read as the live Yjs state
rather than as a revision — as a *second, parallel entity* beside today's `Post`. Nothing about
posts changes: `/[slug]`, `/posts`, publish/unpublish/schedule, `CommentThread`/`Comment`, the
§6 moderation cascade, and §5's remap-on-publish all keep working exactly as §10 describes them.

Six decisions carry the whole design:

1. **The collab substrate is §11's `ydoc`/`ydoc_update`.** §11 built a store keyed purely by
   `documentName` that references nothing and is never truncated on save. A doc is its first
   real consumer; `/ydoc-debug` remains its debug consumer. There are no doc-specific collab
   tables.
2. **`doc.prose_json` caches the rendered body**, so the reading view is a row read rather than
   a Yjs decode per request.
3. **Annotations are located by a mark embedded in the ydoc itself**, not by positions stored
   beside it. An anchor is therefore content: it moves with its text, merges with concurrent
   edits, and disappears exactly when its text does. When it disappears the annotation
   **degrades to a document-level comment** (§12h) — not lost, just no longer located.
4. **`gc: true` everywhere.** GC cannot strand a mark, because a mark is not a pointer, so
   anchoring costs nothing here and a doc's stored state stays bounded (§12h).
5. **Comments on docs are annotations** — one `annotation` table, one `/annotations` browse
   surface, and no moderation.
6. **Nothing about checkpointing a doc is here yet**: no doc revisions, no `ydoc_snapshot` rows
   for docs, no restore. Held back deliberately, pending review (§12m).

**Posts do not move.** §12 is not the cutover. Post editing stays on `post_collab`/
`post_collab_update` and `server/collab.ts`'s own hooks, byte for byte. §11's isolation
constraint is relaxed in exactly one place: `src/lib/ydoc-render.ts` stops being
`/ydoc-debug`-only and becomes the doc reading view's renderer too. Deduplicating it with
`LiveHistoryViewer` still belongs to the cutover.

Docs and posts then run side by side indefinitely. Converging them — moving post content into
docs and retiring the post stack — is a separate decision for later and explicitly **not in
scope**. This plan only has to keep that move cheap, which it does by giving the new tables and
routes the names the surviving entity should end up with, so converging is a backfill rather
than a rename.

### 12a. What a doc inherits from §11 for free

Everything below is already built and already verified by `e2e/ydoc-debug.spec.ts`; a doc gets it
by being a ydoc-stack document, not by reimplementing it:

- **`createIfAbsent` anti-duplication** (§11c), so two processes racing a cold open converge on
  one lineage. CLAUDE.md's collab-restart doubling gotcha does not apply to a doc, for the reason
  that gotcha's own text gives: the `ydoc` row is created eagerly, never lazily off a debounced
  first edit.
- **Nothing throws into a Hocuspocus hook** — the error classifier, the connection-class circuit
  breaker, per-document degraded mode, `YDOC_PERSISTENCE=off`.
- **No revision fallback in `onLoadDocument`.** For `/ydoc-debug` that was convenient; for a doc
  it is *correct*, since there is no revision to fall back to and any seed-from-elsewhere path
  would build a structurally new document with fresh client ids under clients that already hold
  the old one (§12d).
- **`y-indexeddb`, lineage-keyed** (§11e), so a doc survives a closed tab or an unreachable
  server. `PostEditor` still has none of this.
- **The `clients` map** (§11d): server-written clientID → `user_id`, in-document, replayed with
  history. A doc gets session-level author attribution without a table.
- **The replay slider** (§11h) over `ydoc_update`, which is what a doc-side live history is.

**No collab renaming is needed on the post side.** `isYdocDocument` already routes by prefix and
post documents keep their bare-cuid names, so `PostEditor`'s `name:`, `/api/collab-token`,
`collab-token.ts`'s claim, `collab-admin.ts` and the `/admin/replace-doc` handler are all left
alone.

### 12b. Wiring a doc to a ydoc

**A doc's `documentName` is derived from its id, not stored:** `ydoc.id = "ydoc:" + doc.id`, via
`ydocIdForDoc(docId)` / `docIdFromYdocId(name)` in `src/lib/ydoc-names.ts`, beside the prefix
constant they build on. There is **no foreign key in either direction**. The `ydoc` tables keep
referencing nothing (§11b), routing stays a zero-query string check (§11a), and the two ids
cannot drift because one is a function of the other.

The alternative — a `doc.ydoc_id` column — was rejected on the drift argument alone: two sources
of truth for the same fact, one of which the collab server never reads. As a *foreign* key it is
worse still, reintroducing a cross-table constraint on the write path that §11 exists to have
removed.

**Creation is eager, in the same request.** `createDoc` writes the `doc` row and calls
`ydocStore.createIfAbsent(ydocIdForDoc(id), …)` with an empty state — `src/app/api/ydoc/route.ts`
already does exactly this from Next for `/ydoc-debug`'s "New document" button, so the store is
known to be callable from the app process. That closes the window in which a connection could
arrive before a row exists, and it is what makes §11a's eager-row property true for docs too.

**Test containment comes from the doc side.** A test doc's ydoc is named `ydoc:<cuid>`, which is
*not* under `ydoc:test-`, so `scripts/test-ydoc.ts`'s guard deliberately will not touch it. That
is a real trap for a teardown sweep: the doc row disappears and its `ydoc` row does not.
`scripts/test-doc.ts` (and the e2e doc fixtures) therefore delete the derived `ydoc` row along
with the doc, and stay gated on the `@example.com`-authors-only rule the other scripts use.

### 12c. Data model

Additive only. Every table below is new; not one existing table is renamed, dropped, or gains a
column. The names are chosen for the entity that should *survive* a later convergence, not for
the one being added.

```
doc                id, slug UNIQUE, title, visibility('PRIVATE'|'SHARED'),
                   prose_json JSONB NULL,      -- cache of the live body (§12d)
                   created_at, updated_at,
                   deleted_by_user_id NULL, deleted_at NULL
                   -- no moderation_policy: annotations are never moderated
                   -- no publish_revision_id / published_at: a doc is never "published
                   --   at a revision"; readers see the live Yjs doc
                   -- no doc_collab / doc_collab_update: that is ydoc/ydoc_update (§12b)
doc_author         doc_id, user_id, byline_order
doc_slug_history   id, doc_id, slug UNIQUE, created_at

annotation         id, doc_id, parent_annotation_id NULL, user_id, body JSONB,
                   resolved_at NULL, created_at, edited_at NULL,
                   deleted_by_user_id NULL, deleted_at NULL
                   -- two FKs and no third table: doc_id says which doc, and
                   --   parent_annotation_id says which conversation. A row with
                   --   parent null IS the thread; replies hang off it.
                   -- no anchor columns: the anchor is a mark in the ydoc (§12i)
                   -- no quoted_text: the annotated text is read from the document
                   --   through the mark, so there is nothing to keep in sync
                   -- no status: document-level-ness is derived per render (§12h)
```

**A root annotation *is* the thread.** `resolved_at` is meaningful only where
`parent_annotation_id` is null, the ydoc mark carries a root annotation's id, and replies hang
off it through the same self-FK shape `Comment.parent_comment_id` already uses. There is no
separate thread row because there is nothing left for one to own: the anchor lives in the
document, there are no doc revisions to anchor against, and there is no status. One fewer join on
every read, and no way to produce a thread with no comments in it.

**Nothing about an annotation is denormalized out of the document.** The anchor is the mark, the
annotated text is whatever the mark currently covers, and both are read from `prose_json` in the
one pass the reading view already makes (§12i). Nothing can fall out of sync with the document
because nothing is a copy of it.

**`doc.title` and `doc.prose_json` are both caches of Yjs fragments** — `"title"` and
`"default"` respectively — written by the same hook at the same moment (§12d). A post keeps its
title on the `Revision` because that is where a post's content lives; a doc has no revision, so
the row is the only place a title can be read without decoding a blob, and slug generation,
`/docs`, and `<title>` all need it.

**Doc slugs are unique among docs only, not against post slugs.** They live in a separate
`/doc/*` namespace with no shared catch-all, so `slugInUse` (`src/lib/slug.ts`) gains a
*doc-scoped* twin rather than growing two more tables to check. A doc and a post may share a
slug; they resolve to different URLs.

**`RESERVED_SLUGS` grows by three:** `doc`, `docs`, `annotations`. `/docs` and `/annotations` are
static top-level segments, so a *post* slugged either would be shadowed and unreachable — the
same failure the set already prevents for `posts`, `users` and `ydoc-debug`.

**`src/lib/prisma.ts`'s soft-delete extension needs a `doc` entry**, alongside `post` and `user`.
Easy to miss precisely because it's the mechanism that exists so nobody has to remember the
filter — and missing it means `/docs` and `/doc/[slug]` both start serving soft-deleted docs.

**`annotation.user_id` is a plain non-null FK to `User`.** Reading a doc requires `AUTHORIZED`
(§12e), so every annotator is a known account: there is no anonymous identity needing a stable
handle, and nothing in `Commenter`, `spam-check.ts`, `rate-limit.ts`, `moderation.ts` or
`SiteSettings` is involved. `resolved_at` — nullable, with one reachable transition and its
reverse — is the only state an annotation carries.

**There is no `doc_revision`.** See §12m — that is the deferred half, not an omission.

### 12d. The `prose_json` cache

**`ydoc` is the substrate; `prose_json` is genuinely a cache.** Worth stating in both directions,
because the asymmetry governs what may safely be deleted:

- Losing `prose_json` costs a render. It is rebuildable from `ydoc.ydoc` at any time, and the
  reading route already contains that code as its cold-start path.
- Losing a doc's `ydoc` row costs the doc's *history and identity*, and there is no revision to
  re-seed from. Rebuilding a `Y.Doc` from `prose_json` would recover the prose and — because the
  anchor is a mark, i.e. content — every annotation anchor with it, which is a real robustness
  win over the relative-position design. What it would not recover is the update log, the
  `clients` attribution map, and above all the *lineage*: a structurally new document with fresh
  client ids that any client's `y-indexeddb` copy would merge rather than replace, which is the
  doubling failure §11 exists to prevent. So CLAUDE.md's "delete the collab rows and let it
  re-seed" repair recipe still has no doc counterpart and must not acquire one by analogy — but
  the reason is lineage, not lost anchors.

**It is written from the collab server, on the store debounce.** A new `server/doc-cache.ts` is
called at the end of `ydocOnStoreDocument`, after `storeState`, and issues one statement:
`UPDATE doc SET prose_json = …, title = …, updated_at = now() WHERE id = docIdFromYdocId(name)`.
For a `/ydoc-debug` document that id matches no row and the statement affects zero — so there is
no lookup to decide whether to write, and no doc-awareness anywhere in `server/ydoc-store.ts`,
whose genericity is exactly what §11c bought and is worth not spending.

The JSON comes from `TiptapTransformer.extensions(authorHighlightExtensions).fromYdoc(document,
"default")` — the same call `src/lib/ydoc-render.ts` makes — so a cached render and a live decode
cannot disagree. It is wrapped so a document that isn't TipTap-shaped logs and drops rather than
throwing into the hook (§11c's rule).

**Staleness is bounded by the store debounce**, and does not matter much: `/doc/[slug]` shows the
last settled state, and a reader with the page open is on the WS anyway and watches it update
(§12g). `prose_json` is NULL until the first store — a doc created and never edited — and the
route falls back to decoding `ydoc.ydoc`, which is a two-line branch onto an existing path rather
than a second rendering implementation.

**The cache is the document, marks and all** — `authorHighlight` and the annotation mark of §12i
both come through `fromYdoc` and are rendered rather than filtered. Nothing on the doc side ever
rewrites the document to remove a mark: the post side's `clearAuthorHighlights` (§3d) is a
`removeMark` transaction dispatched after a *save*, and a doc has no save to hang it on. That the
cache and the live document agree exactly, with no transform in between, is what lets the
degradation check in §12i read `prose_json` instead of decoding a blob.

### 12e. The `AUTHORIZED` role

One new enum value, added above `COMMENTER` rather than splitting it — nobody's stored role
changes and nothing is removed. The name says what it means: someone in the system has authorized
this user for docs, as opposed to `COMMENTER`, which means only "can comment on the public blog."
An interim measure — granular permissions are intended later — but one that carries real weight
in the meantime, since it is the only thing gating doc access.

```
ADMIN > EDITOR > AUTHOR > AUTHORIZED > COMMENTER
```

The hierarchy stays linear, which keeps `UsersTable`'s `ROLE_ORDER` sort and every `role ===`
check honest; `AUTHORIZED` is strictly `COMMENTER` plus doc access. New accounts keep defaulting
to `COMMENTER` — `signUp` sets no role, so this is purely the schema `@default`, unchanged.

One new pure check joins `src/lib/role-checks.ts`, not `authz.ts`, so `SiteHeader`'s nav can
import it without dragging Prisma into the browser bundle (§10 item 17):

```ts
export const DOC_VIEWER_ROLES: Role[] = ["ADMIN", "EDITOR", "AUTHOR", "AUTHORIZED"];
export function canViewDocs(role: Role): boolean { ... }
```

**Two doc gates, easily conflated.** `canViewDocs` governs *reading and annotating* docs — every
`SHARED` doc, for anyone at that level. It does **not** govern `/docs`, which keeps today's
`canManagePosts`-shaped rule (`canManageDocs` + own-byline scoping for AUTHOR), so an AUTHOR
manages only their own docs while reading everyone's. Rejection reuses the §3b/§3c pattern:
unauthenticated redirects to sign-in, a signed-in `COMMENTER` gets the inline "doesn't have
permission" message.

**Per-doc `visibility` is `PRIVATE` | `SHARED`.** `PRIVATE` is byline authors plus ADMIN/EDITOR;
`SHARED` is anyone with `canViewDocs`. With role gating underneath, an "unlisted" tier has no
threat model left to address. Kept an enum so a future public tier doesn't need a boolean→enum
migration.

**The migration is one step, which is the point of not touching `COMMENTER`.** Postgres can't
drop a value from an enum type, and `ALTER TYPE ... ADD VALUE` adds a value that **cannot be used
in the same transaction** — which is what Prisma wraps each migration in. That's what forced
`adminInitials` (CLAUDE.md) into two migrations, and would have forced a
`DOC_COMMENTER`/`BLOG_COMMENTER` split into two as well. Adding `AUTHORIZED` needs none of it,
because nothing is backfilled and nothing is dropped:

```sql
-- one hand-edited --create-only migration, nothing else in the file
ALTER TYPE "role" ADD VALUE 'AUTHORIZED' BEFORE 'COMMENTER';
```

`BEFORE 'COMMENTER'` is cosmetic, not load-bearing — `ROLE_ORDER` is a plain TypeScript array and
never reads the enum's ordinal position — but it keeps the database's own ordering honest for
anyone reading it directly.

Blast radius is small and already surveyed: the enum and `src/lib/role-checks.ts`. `User.role`'s
`@default` doesn't move, `UsersTable`'s `ROLE_ORDER` gains one entry, and `scripts/test-user.ts`'s
usage string gains one option. `updateUserRole` validates against `Object.values(Role)`
generically and needs no edit.

**Known consequence: a role change doesn't reach an existing session.** `src/lib/auth.ts` uses
the `jwt` strategy and reads `user` only when it's present — i.e. once, at sign-in. Promoting
someone to `AUTHORIZED` does nothing until they sign out and back in. A curiosity today; once
promotion *is* the mechanism for granting doc access it becomes the first support question, with
nothing broken to find. Interim fix: say so in the permission-denied message.

### 12f. Routes

| Route | Purpose |
|---|---|
| `/docs` | management table of docs, `canManageDocs` + own-byline scoping |
| `/doc/[slug]` | the live reading view, `canViewDocs` + per-doc `visibility` |
| `/doc/[slug]/edit` | the editor, `canUserEditDoc` |
| `/doc/[slug]/live-history` | §11h's replay slider, over this doc's `ydoc_update` |
| `/annotations` | annotation browse/admin (§12j) |

**`/doc/[slug]` and `/doc/[id]/edit` cannot literally be two different dynamic segment names.**
Next.js rejects `app/doc/[slug]/page.tsx` alongside `app/doc/[id]/edit/page.tsx` at build time
("You cannot use different slug names for the same dynamic path"). The resolution is one segment —
`app/doc/[slug]/` with `page.tsx`, `edit/page.tsx`, `live-history/page.tsx`, `slug/page.tsx` — and
**one shared `resolveDocParam()` that accepts an id or a slug**, tried in that order. Id-first
matters: a rename must not break a bookmarked edit URL. (A doc whose *slug* is shaped like another
doc's cuid would resolve to the id; slugify can produce such a string in principle, and it is not
worth guarding against.)

The reading route additionally falls back to `doc_slug_history` on a live-slug miss and 301s,
exactly as `[slug]/page.tsx` does today (§4a).

**`/doc/[slug]` is inherently dynamic** — it is per-user gated — so it gets no
`generateStaticParams`. A route eligible for static generation that also calls a dynamic API
throws `DYNAMIC_SERVER_USAGE` at build, which is what §10 item 17 was. Needs a CACHING.md entry;
note there that `prose_json` is what keeps a dynamic route cheap, not a Next cache.

**No per-doc annotations page.** §3c's `/posts/[id]/comments` has no doc counterpart; the
`/annotations?doc=<id>` deep link covers it.

### 12g. Collab: tokens, read-only readers, and the client `Y.Doc`

`server/collab.ts` and `server/ydoc-hooks.ts` need **no new dispatch** — a doc is a `ydoc:` name
and already routes. Two additions, both small:

**A doc-scoped token route.** `POST /api/ydoc/[id]/token` stays ADMIN-gated and
`/ydoc-debug`-only. `POST /api/doc/[id]/token` is its sibling: it resolves the doc, applies doc
authz, and mints `signYdocToken({ sub, documentName: ydocIdForDoc(id), role, readOnly })` plus the
`lineage` the client needs before connecting (§11e). `YdocTokenPayload` gains `readOnly?: boolean`
and `ydocOnAuthenticate` sets `connectionConfig.readOnly` from it — the only change to an existing
ydoc file, and it needs no doc knowledge, since the token already names the document.

**Read-only readers.** An editor gets a writable token; someone who merely satisfies `canViewDocs`
on a `SHARED` doc gets `readOnly: true`. The read-only client registers **no
`CollaborationCaret`** — awareness is a separate channel from the document, so being read-only is
not on its own enough to keep readers out of the authors' caret list. Read-only stays meaningful
even though such a reader can annotate, because §12i's mark is applied by the server rather than
by their connection.

**Fix the collab-JWT reconnect gap here.** §10 lists it as a known gap: the token expires after
2 minutes and `HocuspocusProvider` doesn't refetch on reconnect, so a long-idle tab retries
forever. Passing a `fetchToken` *function* as `token` instead of a fixed string makes the provider
re-mint per reconnect. It's a dev annoyance on the editor today and a reader-facing bug the moment
`/doc/[slug]` promises to stream — and the same change fixes `PostEditor`, `LiveHistoryViewer` and
`/ydoc-debug` for free.

**The client `Y.Doc` needs nothing special.** §12h is `gc: true` on both ends, which is the
default on both, so a bare `new Y.Doc()` is correct as written and there is no silent-failure
mode to guard against.

### 12h. `gc: true`, and what a document-level annotation is

**Decision: `gc: true` everywhere, server and client.** §11d already sets
`yDocOptions: { gc: true, gcFilter: () => true }` explicitly, and every client builds a bare
`new Y.Doc()`, whose default is the same. Nothing has to be configured for a doc; this subsection
exists so the choice reads as a decision rather than an accident, since GC is the one Yjs setting
an annotation design can be wrecked by.

**It costs nothing, because the anchor is content.** The design GC *would* break is anchoring by
`Y.RelativePosition`, which names an item id:
`createAbsolutePositionFromRelativePosition` returns `null` once that item has been collected
into a `GC` struct rather than surviving as a tombstone, so keeping such an anchor resolvable
means `gc: false`. §12i's mark has no such failure mode — it is not a pointer into the document,
it *is* part of the document, so it moves with its text, merges under concurrent editing, and is
collected only when the text it decorates is. GC never strands it.

**It buys a doc that doesn't grow forever.** `gc: false` means `ydoc.ydoc` accumulates a tombstone
per deletion for the life of the document. A post could afford that, since its life is punctuated
by revisions; a living document's whole premise is that it never is, so the entity that most
needs bounded growth is exactly the one that would pay most for turning GC off.

**Losing the mark degrades the annotation; it does not delete it.** Delete the annotated text and
the mark goes with it, and nothing in the document references that annotation's id any more. The
`annotation` row still has its `doc_id`, so the annotation **becomes a document-level comment on
that doc** — it moves out of the margin and into the doc's general discussion, and what it was
about is whatever its body says. That is the entire defined behavior, and it is derived per render
(§12i), not a stored state.

**It is one-way, and recovery is deferred.** Retyping the same words does not restore the mark;
re-marking is an edit somebody has to make. `ydoc_update` is never truncated (§11b), so the state
in which the mark still existed is reconstructible — replay to before the deletion, read the
mark's range, and you have both where the annotation lived and what it covered. That is a real
path and the reason the log matters here, but it is **not being built now, and may never be**
(§12m).

**Never flip `gc` for a doc that has already loaded with it on.** One load with GC on collects
tombstones permanently, so a future `gc: false` experiment is one-way per document and would have
to be a new-docs-only decision, not a config change.

### 12i. Annotations: the mark, capture, and the shared view model

**An annotation is anchored by a mark in the ydoc, carrying the root annotation's id.** A new
mark joins `src/lib/tiptap-schema.ts` — the one place the editor, Hocuspocus seeding and public
rendering share a schema, so the three can't drift (CLAUDE.md) — as a doc-side extension set
beside `authorHighlightExtensions`. Posts never apply it; an unused mark type in the schema costs
nothing, exactly as `authorHighlight` already demonstrates.

Two details it has to get right:

- **`excludes: ""`,** so the mark does not exclude itself. ProseMirror's default is that a mark
  type excludes its own type, which would make a second annotation over overlapping text *replace*
  the first rather than coexist with it. Setting `excludes` empty lets several instances with
  different `id` attrs sit on the same text, and ProseMirror splits the run into segments
  carrying the right subsets on its own — no equivalent of the `data-thread-ids`-plural handling
  in `quote-highlight-extension.ts` (§10 item 6) is needed, since that exists for overlapping
  *decorations*, which marks are not.
- **`renderHTML` emits `data-annotation-id`,** which is what carries the highlight into
  `prose_json` and through `@tiptap/static-renderer`. The reading view therefore gets its
  highlights from the cache with no client-side resolution step at all — the decoration builder
  is not involved on the doc side, and neither is any per-sync re-resolution.

**The mark is applied server-side, through the collab server.** `submitAnnotation` inserts the
`annotation` row first, then asks the collab process to apply a mark carrying that id over the
requested range — a new endpoint beside `/admin/ydoc-snapshot` and `/admin/replace-doc`, in the
idiom §11d already established for server-authored writes into a live doc (the `clients` map).
Three things fall out of that ordering and that placement:

- **A reader can annotate without a writable connection.** Annotating is otherwise a document
  edit, which a `readOnly` connection (§12g) cannot make — so the alternative is handing every
  `AUTHORIZED` reader a writable socket and relying on the UI not to let them type.
- **The failure mode is the degraded state, not a corrupt one.** Row first, mark second: if the
  mark never lands, the annotation is document-level, which is a state the system already
  renders. Mark-first would leave a mark naming a row that doesn't exist.
- **The client never mints the id it marks with**, so a client cannot mark text with somebody
  else's annotation id.

**Capture, and the one place it can miss.** In the editor, the range comes from the live
ProseMirror state and is exact. From the reading view, `AnnotatableArticle` captures the selection
against the *cached* render, which the live document may have moved past since the last store
(§12d) — so the request carries the selected text alongside the offsets and the server verifies
`textBetween(from, to)` against it before marking. On a mismatch it falls back to a unique
occurrence of that text in the live document; failing that, the annotation is created
document-level. The selected text is a **request field only, never a column**: it exists to
validate offsets against a document that may have moved, and once the mark is placed the document
itself is the record of what was annotated.

**Document-level-ness is derived, not stored.** `collectMarkAttrValues(prose_json, "annotation",
"id")` (already in `tiptap-schema.ts`, already doing this for `authorHighlight`'s `authorId`) is
one pass over JSON the reading view is holding anyway; any root annotation whose id isn't in that
set renders in the doc's general discussion instead of the margin. §10 item 20's whole bug class —
`DETACHED` as a terminal state nothing revisited — is structurally impossible here, since there is
no stored state to get stuck. §5's remap-on-publish machinery is not involved at all:
`anchor-remap.ts` and `@fellow/prosemirror-recreate-transform` stay, untouched, serving posts.

**One view-model feeds the shared presentation, and this is the part to build first.**
`src/lib/comment-data.ts` grows an annotation loader producing the same `ThreadComment`/
`ThreadWithComments` shape the post side already renders — synthesizing a thread from a root
annotation plus its replies, resolving each participant's color from their `User.color` (§10 item
13), and setting capability flags (`canModerate`, `showStatus`) that an annotation leaves off. A
`CommentTarget = { kind: "post" | "doc"; id: string }` discriminated union threads through the
components, so `CommentNode`, `CommentEntryList`, `CommentSection`, `CommentForm`,
`QuoteThreadHeader`, `pseudo-border.ts` and `AnnotatableArticle` each stay a single copy. Build
the loader before the UI: retrofitting a shared shape after two renderers exist is the expensive
order, and this one is permanent rather than a bridge to somewhere.

**The shared components keep their `Comment*` names.** Tables, routes and server actions say
*annotation*, because that is the distinction worth making in the data model and the URL space;
the presentational components render both kinds, and the seam is `CommentTarget`, not the
filename.

`submitAnnotation` is its own server action. Eligibility is `doc.visibility === SHARED` plus
`canViewDocs`, and the annotation is inserted immediately visible.

### 12j. `/annotations`

**A browse surface: everything written on docs, searchable, sortable, with deleted rows visible.**
It is not a queue — the only action an annotation supports is deletion, and `CommentNode` already
offers that inline. The page exists so annotations across all docs can be found at all.

- **Columns:** Doc · Author (a `User`, always) · Body · Quote · Created · Edited · Deleted. The
  Quote cell reads the annotated text out of the doc's `prose_json` via the mark, and says
  *document-level* when there is no mark to read — which makes it the one admin surface where the
  degraded state (§12h) is visible.
- **Controls:** search `q`, the show-deleted toggle, pagination, multi-column sort via
  `use-sortable-rows`, and the deep-link-only filters (`?doc=`, `?author=`, `?user=`).
- **Actions:** Delete / Restore, ADMIN or own annotation — the same rule `CommentNode` already
  applies inline (§10 item 15).
- **Gate:** `canManageDocs`, with own-byline scoping for AUTHOR.

Query-string parsing gets its own `annotations-query.ts`, since the option set it parses is the
list above and nothing more. `use-sortable-rows`, `AdminTable.module.css` and the pagination
controls are shared.

### 12k. Build order

Each phase leaves the app working and verifiable on its own.

**Phase 0 — add the `AUTHORIZED` role (§12e).** The one-step enum addition and its small blast
radius. `canViewDocs` has nothing to guard yet — this phase lands the role and the helper, and
de-risks the enum change separately from everything else. Gate: `npx tsc --noEmit`,
`npx eslint .`, `npm run e2e` green with only role-name churn in the fixtures.

**Phase 1 — the Doc entity and its editor.** Schema from §12c minus the `annotation` table, the
`prisma.ts` soft-delete entry, `RESERVED_SLUGS`, `ydocIdForDoc`/`docIdFromYdocId`, eager creation
(§12b), `resolveDocParam`, `/docs`, `/doc/[slug]/edit`, and `POST /api/doc/[id]/token`. Docs are
not yet readable by anyone but their managers.

> `DocEditor` starts as a copy of `PostEditor`, but a small one. `PostEditor`'s 535 lines are
> dominated by save, publish, schedule and revision machinery, none of which a doc has. What
> carries over is provider wiring plus `CollabEditorBody` and `CollabTitleField` — close to what
> `/ydoc-debug`'s editing mode already does — plus `attachIndexeddb` and a `DocSettingsPanel` for
> byline and visibility. Resist factoring the two together anyway until the divergence is visible
> rather than guessed at; the duplication is cheap enough to carry until then.

**Phase 2 — the live reading view and the `prose_json` cache (§12d).** `server/doc-cache.ts`,
`visibility` wired to `canUserReadDoc`, `/doc/[slug]` reading `prose_json` with the
decode-from-`ydoc` fallback, the read-only Hocuspocus path, `canViewDocs` on the route and in
`SiteHeader`'s nav, the collab-JWT reconnect fix, and the CACHING.md entry. Spec: two contexts,
author types, reader's DOM updates with no reload; plus one asserting `prose_json` is populated
after a store and that a fresh doc renders from the fallback.

**Phase 3 — annotations (§12i).** **Do the `comment-data.ts` view-model loader first** — it
decides whether `CommentNode`/`CommentEntryList`/`QuoteThreadHeader`/`pseudo-border.ts` stay one
copy or quietly become two. Then the annotation mark in `tiptap-schema.ts`, the `annotation`
table, `submitAnnotation`, the server-side mark endpoint, capture from both the editor and the
reading view, and the derived document-level check. Spec: annotate a doc; author edits *before*
the annotated range → the highlight tracks it with no work on our side; author deletes the
annotated text → the annotation renders in the doc's general discussion; author retypes it →
**stays document-level** (§12h, one-way); two overlapping annotations both survive on the shared
run (the `excludes: ""` case); and one asserting an annotation is visible immediately and never
appears in `/comments`.

**Phase 4 — `/annotations` (§12j).**

**Phase 5 — live history, support scripts, and documentation.**
`/doc/[slug]/live-history` rehousing §11h's replay slider over the doc's `ydoc_update` — note that
with snapshots deferred (§12m) a doc has no `ydoc_snapshot` rows, so every rebuild goes back to
row #1, which is a performance characteristic of this phase and not a defect. Then
`scripts/test-doc.ts` and `scripts/test-annotation.ts` (with §12b's ydoc-row cleanup), e2e doc
fixtures and teardown, and updates to CLAUDE.md — including the §12d note that the collab-restart
repair recipe has no doc counterpart — plus CACHING.md, STYLE.md and §10 of this document.

### 12l. The carrying cost, stated plainly

Running two stacks side by side is not free, and the cost is *ongoing* rather than one-off: two
editors, two comment stacks, two admin tables. Two things it is deliberately *not*: a second
collab-persistence pair, since docs share §11's, and a second revision table, since §12m defers
the question. What remains buys the ability to use a living document next to a post, against real
content, before committing to either — which is the only way the question "is a living document
the model I want?" actually gets answered. It is the wrong trade the moment that answer is known.

Three things keep a later convergence cheap, and all are worth protecting while building:

- **The new tables and routes already carry the names the surviving entity should end up with**,
  so converging is a backfill plus deleting the post stack, not a second rename.
- **The shared comment view-model (§12i) is the seam that keeps the UI from forking**, which is
  the one duplication that would be genuinely expensive to undo.
- **Posts moving onto the ydoc stack stays a separate, already-scoped change**, not something
  entangled with docs — §11 built and proved the target; §12 gives it a second consumer and
  therefore a second confirmation that the store is general.

### 12m. Deferred, with reasons

- **Everything about checkpointing a doc — held back pending review of this plan.** Absent by
  intent: a `doc_revision` table, changelogs, restore-to-a-point, `ydoc_snapshot` rows for docs
  (and therefore any doc-side use of §11h's snapshot base), and any doc counterpart to
  `/admin/replace-doc`. Under §12 a doc's history *is* `ydoc_update` and its present state *is*
  `prose_json`; nothing else is claimed. Adding checkpoints later is additive — §11's snapshot
  table and endpoint already exist and are already generic — so nothing in Phases 0–5 has to be
  designed around the eventual answer.
- **Recovering where an annotation used to point, once its mark is gone** (§12h) — replaying
  `ydoc_update` back to a state that still had the mark, reading its range there, and offering to
  re-anchor. **Later if at all**, and an ad-hoc tool if ever, not a background job. The plan's
  defined behavior is the degraded one: the annotation becomes document-level and stays that way.
  Worth being clear that this is the *only* thing the never-truncated log is being held for on the
  doc side — if it never gets built, the log has still earned its place as history (§11h) and as
  the doc's durable substrate.
- **Converging posts onto docs**, and **carrying annotations onto post content** at that time.
  Explicitly out of scope; §12l sketches why it stays cheap.
- **Factoring `DocEditor` and `PostEditor` back together.** Revisit after Phase 3, once the real
  divergence is visible rather than guessed at (§12k).
- **Deduplicating `src/lib/ydoc-render.ts` with `LiveHistoryViewer`.** Belongs to the post cutover,
  when there is one renderer's worth of behavior to keep rather than two.
- **Re-reading `role` from the DB in the `jwt` callback** (§12e), rather than documenting the
  sign-out-and-back-in workaround. Waits for the granular-permissions work that supersedes this
  whole role scheme.

### 12n. As built

Built 2026-07-29, in the order §12k lays out (Phase 0 → 5), each phase gated on `npx tsc
--noEmit`, `npx eslint .`, hand verification in the browser, and the full `npm run e2e` suite
before moving to the next. Two deliberate deviations from the text above, both judgment calls
made under real time constraints rather than oversights:

- **`AnnotatableArticle` itself is not reused for docs.** §12i's own text says it is; in
  practice the doc reading view (`LiveDocBody.tsx`) is a sibling component with the same
  *interaction* shape (a plain, non-`Collaboration` `useEditor`, `editable: false`, selection
  capture via `onSelectionUpdate`, a `staticBody`/live-editor swap identical to
  `AnnotatableArticle`'s `ready` toggle) rather than the same file. The two content sources
  differ enough — a single static `doc` prop for a post versus a live Hocuspocus tap that has
  to push updates into the editor by hand (`editor.commands.setContent`) for a doc — that
  literal reuse would have meant branching `AnnotatableArticle` on `target.kind` throughout,
  touching a component that renders on every published post. `LiveDocBody` copies the pattern
  instead of the file. What *is* shared exactly as §12i describes: `CommentSection`,
  `CommentForm`, `CommentNode`, `CommentEntryList`, `QuoteThreadHeader`, and
  `pseudo-border.ts` — all threaded through the `CommentTarget` union, none forked.
- **Annotation capture is reading-view-only.** §12i's "in the editor, the range comes from the
  live ProseMirror state and is exact" describes a capture path from `DocEditor` that was not
  built — `DocEditor` has no selection-to-annotate UI. An author who wants to annotate their
  own doc does it from `/doc/[slug]`, the same as any other `AUTHORIZED` reader; nothing stops
  this today, and it keeps `CollabEditorBody` (shared with `PostEditor`) untouched.

Smaller implementation notes worth recording against the design text above:

- **`DocEditor`/`DocsTable`/`DocSettingsPanel` are simpler than their `Post*` counterparts**,
  not just smaller — `DocsTable` is a plain sortable table without `PostsTable`'s column-
  resize-tracking search box or per-row drag affordances, and `DocSettingsPanel` has no
  revisions table (a doc has none). Functionally complete; less visually polished.
- **No `canViewDocs`-gated entry in `SiteHeader`'s nav.** §12g mentions wiring it in, but
  there is no "browse every doc I can read" route in §12f's table to link to — inventing one
  was out of scope. `SiteHeader` does gain a `canManageDocs`-gated "Manage Docs" /
  "Manage Annotations" pair, mirroring "Manage Posts" / "Manage Comments".
- **The annotation-mark endpoint's fallback search** (`findQuoteOccurrences`,
  `server/ydoc-hooks.ts`) is a plain `O(document size × quotedText length)` scan, not the
  smarter position-mapped walk first sketched — chosen for correctness-by-construction (it
  reuses `Node.textBetween`'s own separator handling rather than reimplementing it) at the
  cost of not matching a quote that spans a block boundary. Acceptable for a fallback that
  only runs when the primary offsets already missed.
- **`annotation.user_id` is `ON DELETE RESTRICT`.** Real users are never hard-deleted in this
  app (soft-delete only), so this is inert in production; it did surface against
  `scripts/test-user.ts delete` and the e2e suite's `deleteTestUser`, both fixed to remove a
  user's own annotations first — the same shape the pre-existing `Commenter`-row cleanup
  already had.

**Verification.** Every phase was hand-tested end to end in the browser (doc creation → live
two-author editing → the reading view's live update with no reload → annotate → delete the
annotated text and watch it degrade to the doc's general discussion → reply → delete-with-a-
live-reply showing `[deleted]` → `/annotations`' search/sort/delete/restore → the live-history
replay slider, confirmed rebuilding from row #1 every time since a doc has no snapshots yet).
`e2e/doc.spec.ts` covers the parts of that worth pinning down as regression tests: the
invariant-1 creation check, the doc-cache debounce reaching `Doc.title`/`proseJson` live, the
isolation check in both directions (a doc never touches `post_collab`, a post never touches any
ydoc-stack table — the latter already covered by `e2e/ydoc-debug.spec.ts`), the reader's
already-open tab updating with no reload, an annotation's mark landing at the exact selected
range, and that same annotation degrading — and never appearing on `/comments` — once its text
is deleted. `scripts/test-doc.ts` and `scripts/test-annotation.ts` cover manual testing, same
`@example.com`-author containment as `test-post.ts`/`test-user.ts`, `test-doc.ts delete`
additionally removing the doc's derived `ydoc:<id>` row (§12b — nothing cascades that
automatically). Full suite: 30/30 passing.

**Two implementation details worth knowing before touching this again**, both found the hard
way rather than designed:

- **The reading view's live tap applies a Yjs update on its own connection handshake**, not
  only on a real remote edit — and `LiveDocBody` turns every such update into an
  `editor.commands.setContent`, which silently collapses whatever the reader had selected.
  A selection made in the window between "editor mounted" and "provider synced once"
  therefore vanishes before it can be annotated. `LiveDocBody` exposes a `synced` marker for
  exactly this (there is no visible connection UI on the reading view otherwise), and
  `e2e/doc.spec.ts`'s annotation tests wait on it. Anything else that reacts to a reader's
  selection needs the same gate.
- **TipTap v3's `setContent` takes an options object, not a boolean.** `setContent(json,
  false)` — the v2 "don't emit an update" signature — is a type error now; it's
  `setContent(json, { emitUpdate: false })`. Worth knowing because the wrong form reads as
  obviously-correct against any pre-v3 example.

### 12o. Known gaps

Everything below is real and deliberate-to-defer, not broken. Distinct from §12m (deferred
*design* decisions) — these are places where the built thing is narrower than the section
above might read.

- **`Annotation.resolvedAt` is declared and never touched.** §12c gives a root annotation a
  nullable `resolved_at` as "the only state an annotation carries," but nothing writes it and
  nothing reads it: there is no resolve/unresolve control anywhere, and
  `getDocAnnotationsAsThreads` hard-codes `status: "ACTIVE"`. The column is schema-only until
  a resolve UI exists.
- **`Annotation.editedAt` is displayed but never written.** `/annotations` has an Edited
  column and sorts on it, and it is always empty — there is no edit-an-annotation action.
  (`CommentNode` offers Reply and Delete, not Edit, on both the post and doc sides.)
- **There is no reader-facing doc index.** `/docs` is `canManageDocs`-gated management; a
  reader with `canViewDocs` can open any `SHARED` doc they have a link to but has no route
  that lists them, and no nav entry. §12f's route table never specified one, so this isn't a
  regression against the plan — but it does mean docs are share-a-link-only in practice.
- **The comment list's "Quoted text position" sort is inert on a doc.** `CommentEntryList`
  sorts that mode by `anchorFrom`, which is null for every annotation-sourced thread (§12i:
  a doc annotation has no stored offset), so all entries tie and fall through to the date
  comparison. The dropdown still offers the option on `/doc/[slug]`, where it does nothing.
  Deriving a real ordering is possible — the mark's position in `prose_json` is exactly the
  needed number — just not built.
- **`/annotations`' deep-link filters have no UI and no Help section.** `?doc=`, `?author=`
  and `?user=` work and round-trip through the URL, but unlike `/comments` (which documents
  its equivalents in an on-page Help table) nothing on `/annotations` advertises them.
- **Nothing enforces that a doc's `ydoc` row exists.** Creation is eager on all three paths
  (`createDocAction`, `scripts/test-doc.ts`, the e2e helper), and `ydocOnLoadDocument`'s
  forgiving auto-create covers a connection to a name nobody made — but a `doc` row whose
  `ydoc` row was deleted out from under it reads as an empty document rather than an error,
  and `POST /api/doc/[id]/token` 404s on the missing lineage. Acceptable because deleting a
  `ydoc` row by hand is exactly the thing CLAUDE.md now warns against, not a path the app
  can reach on its own.