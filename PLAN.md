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
  undid it" a no-op save, without inspecting the live Yjs doc. See docs/TIPTAP.md for a ProseMirror
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

**Moved to [docs/COLLAB.md](docs/COLLAB.md) §1.** That file is now the single place every
anchoring strategy in this codebase is described and compared — this section, §12h/§12i's
mark, §13f's pending selection and §14a/§14d's external blob were four answers to one
question, written up in four places, and a reader wanting to add a fifth had to find all of
them first.

What stays here is the decision, since the rest of this document refers back to it: a post
comment stores **absolute offsets into an immutable published snapshot** plus the quoted
text, renders through display-only **decorations** that never touch stored content, and is
carried forward on each publish by diffing the old and new documents with
`prosemirror-recreate` and mapping the endpoints through the resulting `Mapping`. A thread
whose quote no longer survives becomes `DETACHED` — still listed, no longer highlighted —
and is re-tried on every later publish rather than being stuck there (§10 item 20).

This works because the target never moves. Docs have no publish step and no snapshot to
anchor against, which is the whole reason §12i reaches for something else.

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
- Email is collected but not verified (no double opt-in) in v1 — deliberately still
  deferred; see [docs/EMAIL.md](docs/EMAIL.md) §7 for the design and why.
- Bylines are chosen from real user accounts (so author pages work), not free text.

**Nothing blocking left.** All six original questions plus concurrency are settled. Remaining
calls are tuning (trust threshold, email verification — [docs/EMAIL.md](docs/EMAIL.md) §7)
and can change anytime.

---

## 10. Implementation progress (as of 2026-07-25)

Steps 1–8 of §8 are built and verified locally. Nothing is deployed — the deployment work
from §7 (and step 1's "prove ops early") has not happened; everything runs on the dev box.
Git history carries per-step detail.

**Done**

1. **Skeleton** — Next.js 16 (App Router) + Prisma 6 + local Postgres + Auth.js v5
   credentials auth with roles; forgot-password flow. Authentication mechanics — the
   credentials provider, the `jwt` session strategy and what it bakes in, the
   forgot-password token details, and how the sign-in form is wired — live in
   [src/app/sign-in/NOTES.md](src/app/sign-in/NOTES.md).
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
21. **Real email delivery and admin-issued invites** — `sendMail()` now sends through
    Resend (an unconfigured environment still just logs), and a new `user_invite` table
    lets an admin email an already-created `User` a link to set a password and claim the
    account, from two new `/users` columns. Design, the deliverability argument, and
    what's still deferred (email verification, bulk invites): [docs/EMAIL.md](docs/EMAIL.md).

**Deliberate deviations from §2–§6**

- Comment bodies are **plain text** (`{"text": ...}` JSON), not rich TipTap content — no
  XSS surface, so the DOMPurify/strict-schema work is deferred until rich comments happen.
- Email delivery is real (Resend, behind the same `sendMail()` seam — an unconfigured
  environment still logs instead of sending), and admin-issued email invites let an
  already-created `User` row claim its account. [docs/EMAIL.md](docs/EMAIL.md).
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

## 12. Docs alongside posts, on the ydoc stack

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

> **The last three lines above are superseded by §13o.** `anchor_from`, `anchor_to` and
> `quoted_text` now exist, for annotations written from a *reading* view — not because the
> mark stopped being the better anchor, but because applying one is a write, and a reader
> was making it. The doc editor still anchors exactly as sketched here.

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

**Per-doc `visibility` is `PRIVATE` | `SHARED`.** `SHARED` is anyone with `canViewDocs`; `PRIVATE`
is its listed `DocAuthor`s' alone, with no ADMIN/EDITOR bypass — the byline *is* the rule, and a
role can't stand in for it. Kept an enum so a future public tier doesn't need a boolean→enum
migration. The whole picture, as tables over roles × visibility × byline membership, is
[docs/PERMISSIONS.md](docs/PERMISSIONS.md).

**Editing a `SHARED` doc is the one place a role still substitutes for a byline**, and it gets its
own predicate rather than borrowing the post side's:

```ts
export function canEditAnySharedDoc(role: Role): boolean { ... }   // src/lib/doc-authz.ts
```

Same two roles as `canEditAnyPost`, stated independently rather than delegating: a delegation
would keep the coupling the split exists to break, where changing the post rule silently moves the
doc rule with it. It lives in `doc-authz.ts`, not `role-checks.ts`, even though it is just as pure
a role check — what earns a place in that file is a **client** consumer, which is why
`canViewDocs`/`canManageDocs` sit there (`SiteHeader` imports them into the browser, where
`doc-authz.ts` would drag Prisma along). Nothing client-side asks this question.

`canUserEditDoc` reads the doc's own visibility in the same query as the author check rather than
taking visibility as a parameter — which keeps the `PRIVATE`/`SHARED` distinction inside one
function instead of rippling it through every call site (`docs.ts`, `posts.ts`, the token and
replay routes, `/doc/[slug]/slug`).

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

**Known consequence: a role change doesn't reach an existing session.** Promoting someone to
`AUTHORIZED` does nothing until they sign out and back in — the session is a JWT with `role`
baked in at sign-in. Interim fix: say so in the permission-denied message. Why it works that
way, and the deferred fix, are in [src/app/sign-in/NOTES.md](src/app/sign-in/NOTES.md).

### 12f. Routes

| Route | Purpose |
|---|---|
| `/docs` | management table of docs, `canManageDocs` + own-byline scoping, widened by `SHARED` and the ADMIN override below |
| `/doc/[slug]` | the live reading view, `canViewDocs` + per-doc `visibility` — embeds §11h's replay slider (§12n) |
| `/doc/[slug]/edit` | the editor, `canUserEditDoc` |
| `/annotations` | annotation browse/admin (§12j), scoped to the docs the viewer may *read* |

**Both admin listings scope their own rows, in their own `where` clause, rather than through
`readableDocsFor`/`editableDocsFor`** — so each restates §12e's rule itself, and each is a place
the two can silently drift apart. `/annotations`' side of that is in §12j; `/docs` lists a
viewer's own byline-authored docs **plus every `SHARED` doc for an ADMIN/EDITOR**, and omitting
that second arm produces not a smaller listing but an incoherent one, hiding docs
`canUserEditDoc` lets the same viewer open and edit straight from a URL.

**`/docs` carries an ADMIN-only "Show all docs" checkbox** (`?showAllDocs=1`) — a per-visit URL
toggle in the shape of the show-deleted-rows checkbox every admin table has (§16b), stored
nowhere. It lifts the byline scoping for that listing and nothing else: it is not an argument to
`canUserReadDoc`/`canUserEditDoc` and reaches no other surface, so an admin who ticks it and opens
a `PRIVATE` doc they don't author still meets the same author-only check. EDITOR has no override.

That it governs **which rows are listed, not what may be done to them**, extends to the table's own
Edit column: `canEdit` restates `canUserEditDoc`'s rule per row with no override term, so a
`PRIVATE` doc the checkbox reveals arrives with no Edit link rather than one leading to Forbidden.
Reusing the same flag the `where` clause uses is the natural way to write that expression and
produces exactly that dead link, with nothing in the row's appearance to reveal it.

**`/doc/[slug]` and `/doc/[id]/edit` cannot literally be two different dynamic segment names.**
Next.js rejects `app/doc/[slug]/page.tsx` alongside `app/doc/[id]/edit/page.tsx` at build time
("You cannot use different slug names for the same dynamic path"). The resolution is one segment —
`app/doc/[slug]/` with `page.tsx`, `edit/page.tsx`, `slug/page.tsx` — and
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

**The collab-JWT reconnect gap (§10) is fixed here, for every collab surface at once.** The
token used to expire after 2 minutes with no refetch on reconnect, so a long-idle tab would
retry forever. `token` is a `fetchToken` *function* rather than a fixed string, so
`HocuspocusProvider` re-mints per reconnect — `PostEditor`, `LiveDocBody`, `DocEditor` and
`/ydoc-debug` all pass one.

**The client `Y.Doc` needs nothing special.** §12h is `gc: true` on both ends, which is the
default on both, so a bare `new Y.Doc()` is correct as written and there is no silent-failure
mode to guard against.

### 12h. `gc: true`, and what a document-level annotation is

**Decision: `gc: true` everywhere, server and client.** §11d already sets
`yDocOptions: { gc: true, gcFilter: () => true }` explicitly, and every client builds a bare
`new Y.Doc()`, whose default is the same. Nothing has to be configured for a doc; this subsection
exists so the choice reads as a decision rather than an accident, since GC is the one Yjs setting
an annotation design can be wrecked by.

**The reasoning moved to [docs/COLLAB.md](docs/COLLAB.md)** — "Why `gc: true`, and what it rules
out" under §2, plus §5 for the `Y.RelativePosition` design this rules out and §8 for what the
never-truncated update log would let a recovery path do. In brief, and enough to act on: GC
costs nothing here because the anchor is *content* rather than a pointer into it, so it moves
with its text and is collected only when that text is; `gc: false` would buy resolvable
item-id anchors at the price of a tombstone per deletion for the life of a document whose
whole premise is that it never ends.

**Losing the mark degrades the annotation; it does not delete it.** Delete the annotated text and
the mark goes with it, and nothing in the document references that annotation's id any more. The
`annotation` row still has its `doc_id`, so the annotation **becomes a document-level comment on
that doc** — it moves out of the margin and into the doc's general discussion, and what it was
about is whatever its body says. That is the entire defined behavior, and it is derived per render
(§12i), not a stored state.

**It is one-way, and recovery is deferred** — still true, still not built (§12m). COLLAB.md §8 is
where the recovery path is worked out: `ydoc_update` is never truncated (§11b), so the state in
which the mark still existed is reconstructible, and item ids are shared across the whole history,
which makes that worth more than a replay-and-read.

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
  **Superseded by §13o**, which took a third option this bullet didn't consider: don't make
  the edit at all. The mark still works and the doc editor still uses it; what §13o rejected
  is a *reader* causing an unattributed, unbounded write into a document they were denied
  write access to, which is what "without a writable connection" turns out to describe.
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

**A browse surface: everything written on the docs this viewer may read, searchable, sortable,
with deleted rows visible.** It is not a queue — the only action an annotation supports is
deletion, and `CommentNode` already offers that inline. The page exists so annotations across
docs can be found at all.

- **Columns:** Doc · Author (a `User`, always) · Body · Quote · Created · Edited · Deleted. The
  Quote cell reads the annotated text out of the doc's `prose_json` via the mark, and says
  *document-level* when there is no mark to read — which makes it the one admin surface where the
  degraded state (§12h) is visible.
- **Controls:** search `q`, the show-deleted toggle, pagination, multi-column sort via
  `use-sortable-rows`, and the deep-link-only filters (`?doc=`, `?author=`, `?user=`).
- **Actions:** Delete / Restore, ADMIN or own annotation — the same rule `CommentNode` already
  applies inline (§10 item 15).
- **Gate:** `canManageDocs` for the page; rows are scoped to the docs the viewer may *read* —
  their own byline-authored ones plus every `SHARED` doc — restating §12e's rule in this page's
  own `where`, since it doesn't go through `readableDocsFor`. **Readability, not
  manage-ability, is the right bound**, and the Quote column is why: it reads out of the doc's
  `prose_json`, so a scope any wider would show an excerpt of a `PRIVATE` doc's body to someone
  `/doc/[slug]` refuses outright. `canUserAccessAnnotationYdoc` delegates to `canUserReadDoc`
  for the same reason. `?doc=` and the other deep links are applied *after* this scope, not
  instead of it.
- **DRAFT annotations are excluded outright**, not merely scoped: §13a's decision is that
  "keep private" holds even from an ADMIN, so the page filters `status: { not: "DRAFT" }`
  rather than leaning on the page gate.

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
- **Re-reading `role` from the DB in the `jwt` callback** (§12e) — moved to
  [src/app/sign-in/NOTES.md](src/app/sign-in/NOTES.md) with the rest of the session mechanics.
  Still deferred, for the same reason: it waits for the granular-permissions work that
  supersedes this whole role scheme.

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
  was out of scope. What `SiteHeader` does gain, `canManageDocs`-gated: a "Docs" link plus a
  small caret dropdown next to it holding "Annotations" — the same `<details>`/`<summary>` +
  outside-click-to-close shape as `CommentsTable.tsx`'s `MultiSelectDropdown`
  (`SiteHeader.module.css`), not the two flat "Manage Docs" / "Manage Annotations" links this
  started as.
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
- **Doc creation is titleless.** `+ New doc` creates the row and drops straight into
  `/doc/[id]/edit` with no title-collecting form in between — `createDoc`
  (`src/app/actions/docs.ts`) writes `title: ""`, since the title is already a live
  collaborative field (`CollabTitleField.tsx`) the editor is better at collecting than a form
  is (`/docs/new` doesn't exist; §12f's route table never listed it). The initial slug is the
  doc's own cuid (`Doc.id`, written in a follow-up `update` inside the same `$transaction` —
  the id isn't known until the create resolves), so `resolveDocParam`'s id-first lookup and the
  slug lookup return the same doc until a manual rename on `/doc/[slug]/slug`. `"Untitled"`
  (`src/lib/doc-title.ts`'s `UNTITLED_DOC`/`docTitleOrFallback`) is a render-time fallback
  only — applied at every server page/props boundary that shows or derives from a doc's title
  (`/docs`, `/annotations`, the `<h1>`s on `/doc/[slug]` and `/doc/[slug]/slug`, and that
  page's suggested "standard slug") — and is never written to the ydoc's title fragment, so it
  can never be backspaced into `"Untitle"` and never appears when scrubbing history, on
  `/doc/[slug]`'s embedded scrub bar (§12n) or `/ydoc-debug` (confirmed by hand: row #1 shows
  no title at all, not the fallback). `doc.title` is an unconditional cache of the title
  fragment, empty included —
  `server/doc-cache.ts` writes it through on every store debounce, so clearing a doc's title
  back out clears `Doc.title` too rather than freezing it at the last non-empty value. This
  doesn't apply to posts: `updatePostTitle`'s "an empty title is never a real one" skip-empty
  rule is unrelated and unchanged, since a post's title has no fragment to be authoritative
  over.
- **The doc reading view carries a byline, and `AuthorByline` is no longer post-only.**
  `/doc/[slug]` lists its authors above the body the way a published post does — the same
  `src/components/AuthorByline.tsx`, the same `#666`/`1px solid #eee` treatment as
  `app/[slug]/page.module.css`'s `.byline`. Two deliberate differences from the post version.
  It drops the `"By "` prefix (a `showPrefix` prop defaulting to `true`, so every post surface
  is untouched), which makes `AuthorByline` the first thing shared across the post and doc
  sides that is *not* threaded through the `CommentTarget` union — only the prefix differs, so
  a boolean was enough and the union would have bought nothing. And the date is
  `Doc.updatedAt`, not a publish date: a doc has no publish step at all (§12k), so "last
  edited" is the only date that means anything, and `server/doc-cache.ts`'s store-debounce
  write is what keeps it current. `toLocaleDateString()` is what renders, with the full
  `toLocaleString()` timestamp on the `title` attribute for hover. The `<h1>` moved out of
  `page.tsx` into `DocView.tsx` (a client component) alongside it; `docTitleOrFallback` still
  applies server-side, now at the `initialTitle` prop boundary rather than at the element.
  The route's own container/byline styling moved from inline `style` objects into a
  co-located `app/doc/[slug]/page.module.css` at the same time, per STYLE.md's
  CSS-Modules-by-default rule.
- **`/doc/[slug]` grew its own lazy-loaded scrub bar (`DocScrubBar.tsx`), and scrubbing now
  rewrites the live title/body in place rather than opening a separate preview — which made
  `/doc/[slug]/live-history` (§12f, §12k Phase 5) redundant, and it's been removed.** Dragging
  the slider calls `LiveDocBody`'s new `overrideBodyJSON` prop, which pushes the historical
  content into the same editor the reader was already looking at (`setContent`, `emitUpdate:
  false`) — the same mechanism the live-update tap already used, just fed a replayed state
  instead of the current one. The title updates the same way: `DocView.tsx` now owns the
  `<h1>` specifically so it can swap `initialTitle` for a scrubbed one, flattened from
  `YdocRenderResult`'s new `titleJSON` field via `extractText` (the existing `title` field is
  already-rendered JSX, useless for a plain-text `<h1>`) and passed through
  `docTitleOrFallback` — the same "Untitled" rule, never written to the fragment, applies
  here too. There's no "return to live" control: a real edit arriving mid-scrub simply wins
  on the next live update, since that handler always sets the *current* content.

  **Lazy by construction, not by a loading flag.** Nothing fetches or replays until the reader
  interacts — before that, `DocScrubBar` renders one grayed-out, inert `<input>` and nothing
  else. The first `pointerdown`/`focus` fetches `GET /api/doc/[id]/replay` and mounts the real
  slider; only then does `useReplayScrub` (extracted from `ReplayView`, now shared by both)
  allocate a `Y.Doc` and start replaying. Deliberately thinner than `/ydoc-debug`'s
  `ReplayView`: no clients table, no per-step perf status line, and the "update N of M"
  position line itself only appears once scrubbing has actually started — before that it's
  just a slider, already sitting at the latest position. The bar's width matches the reading
  column (not the full viewport) via `DocScrubBar.module.css`.

  **`/doc/[slug]/live-history` is gone — `app/doc/[slug]/live-history/page.tsx` and
  `DocLiveHistory.tsx` are both deleted, and `DocEditor.tsx`'s "Scrub live history" link with
  them.** Nothing else needs it: a doc's `ydoc` row is just `ydoc:<docId>`, no different from
  any other row in the same table, so `/ydoc-debug` (ADMIN-only, §11f) already lists it and
  replays it with `ReplayView` unmodified — the two admin-facing tools this section is about
  not duplicating. `GET /api/doc/[id]/replay` stays; it's what `DocScrubBar` itself calls.
- **The reading view holds a fixed 800px width rather than shrinking to short content**, and
  the doc editor's title field shares its border with the body editor frame below it
  (`DocEditor.module.css`'s `.titleInput`/`.editorFrame`, the latter shared with
  `PostEditor.module.css`) so the two read as the same kind of editable surface. On
  `/doc/[slug]`, the title links to `/doc/[id]/edit` — styled as an ordinary hyperlink, not
  inheriting the heading's color — whenever the viewer can edit the doc (`canUserEditDoc`); a
  reader who can't just sees plain text.
- **The shared `Comment*` components say "annotation," not "comment," on the doc side.**
  `CommentSection`/`CommentForm`/`CommentNode`/`CommentEntryList` render both post comments and
  doc annotations through the same `CommentTarget` union (§12i), and now branch their visible
  copy on `target.kind` too — heading, empty state, placeholder, submit button, delete-failure
  message, sort option. `submitAnnotation`'s validation errors ("Comment can't be empty.",
  copied from `submitComment` and never updated) say "Annotation" now as well.
- **`/docs`'s Title column links to the reading view, not straight to the editor**, with a
  separate Edit column (right after Title) linking to `/doc/[id]/edit` only when the viewer can
  edit that particular doc — computed per row in `page.tsx` by restating `canUserEditDoc`'s
  logic against data the listing query already has (an AUTHOR's query is already scoped to
  their own docs), not a per-row DB call. Clicking or hovering anywhere in the Title `<td>` —
  not just the link text — navigates or underlines (`DocsTable.module.css`).
- **A doc's annotation highlights are colored by their author, not a flat amber.**
  `AnnotationColorStyles.tsx` — the same one-rule-per-id `<style>` tag technique
  `AuthorHighlightStyles.tsx` uses for attributed body text — sets `--thread-color` per
  annotation id from `getDocAnnotationsAsThreads`'s already-fetched `root.user.color`, and
  `prose.module.css`'s `.annotation-highlight` reads it the same way `.quote-highlight` already
  reads a quote thread's color. Rendered from `CommentSection.tsx`, so this only colors the
  reading view — `DocEditor` renders no `CommentSection` (annotation capture is
  reading-view-only, above), so its highlight stays the flat amber fallback.

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
- **A mark is `clearable` by default, and `unsetAllMarks` (the editor's "Clear formatting"
  button) removes every clearable one.** The annotation mark had no opinion on this at first,
  so clicking Clear formatting over annotated text silently stripped the mark along with any
  real formatting in the selection. Fixed with `clearable: false` on the mark
  (`annotation-extension.ts`) — `Mark.create` has this option built in for exactly this case
  ("semantic marks that should survive clear formatting"), so no custom command was needed.
- **`e2e/doc-visibility.spec.ts` pins §12e's rule and §12f's two listings**: an ADMIN/EDITOR
  non-author is refused a `PRIVATE` doc for both read and edit, a listed author is not, `SHARED`
  stays open to ADMIN/EDITOR regardless of byline, the `/docs` override is ADMIN-only and doesn't
  carry into opening a doc, and `/annotations` withholds a `PRIVATE` doc's rows by listing and by
  `?doc=` deep link. The `SHARED` cases are positive controls, not decoration — without them the
  absence assertions would pass for the wrong reason.
- **A doc fixture's second identity needs an explicit byline.** `e2e/db-worker.ts`'s
  `addTestDocAuthor` exists because `secondUser()` — the collaboration specs' stand-in for "a
  different person", defaulting to ADMIN — is not automatically an author of the doc it is handed,
  and a `PRIVATE` doc admits only its byline. Any new spec putting two identities in one doc's
  editor needs it.

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
- **The comment list's "Quoted text position" sort is *partly* inert on a doc.** That mode
  sorts by `anchorFrom`, which was null for every annotation-sourced thread when this was
  written (§12i: a doc annotation had no stored offset), so all entries tied and fell
  through to the date comparison. §13o gave reading-view annotations real stored offsets, so
  they now sort correctly; a *mark*-anchored one still has no stored offset and still ties.
  Ordering those is possible — the mark's position in `prose_json` is exactly the needed
  number — just not built, and it would now be the only remaining half of this gap.
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

### 12p. The frozen reading view

**Problem.** `useLiveDocContent` pushes every remote Yjs update straight into the reading
editor via `setContent`. Right for passive reading, wrong the moment a reader is doing
something with the current text: dragging `DocScrubBar`'s slider (the next remote keystroke
silently overwrote the historical body it was showing — there was no "return to live" control
because none seemed needed), or holding a selection about to become an annotation (which
`useSelectionPopover.reresolve` then has to re-find by text search after the fact).

**The fix stops rendering, not receiving.** `useLiveDocContent` gains a `frozen: boolean`
option. Its `ydoc.on("update", …)` listener keeps firing on every remote change either way —
the Y.Doc always has everything — but while `frozen` is true the handler counts the update
instead of calling `setContent`. Unfreezing runs one catch-up render and zeroes the count.
Two independent reasons OR together into `frozen`, both owned by the reading surfaces rather
than the hook itself:

- **Scrub.** `DocScrubBar`'s `ScrubbedState` carries `live: boolean` (`index === total - 1`).
  `DocView` freezes only when scrubbed *and not live* — the slider's own mount-time seed
  already reports `live: true` before any drag, so merely mounting the bar never freezes
  anything.
- **Selection.** Any non-empty selection in the reading view, i.e. `useSelectionPopover`'s
  `pending !== null` — not merely an open annotation popover, since the two are set together.

**The count is updates, not keystrokes.** Yjs batches, so "(+N)" on the FROZEN flag counts
`update` events received while frozen, not characters typed — the only number available for
free on a read-only tap, which never sees individual row ids. Exposed off the hook as a
listener-set pair (`frozenUpdates: { subscribe, getSnapshot }`), read via
`useSyncExternalStore`, rather than React state — the same reasoning §18a's
`margin-notes-context.tsx` already applies to its own per-keystroke signal: state here would
re-render the whole reading surface on every remote update arriving during a long freeze,
to reposition one badge.

**Clicking FROZEN** clears both reasons at once — `useSelectionPopover.clear()`, plus
`DocView` resetting `scrubbed` to `null` and bumping a `resetSignal` that `DocScrubBar` uses
to seek its own slider back to the live end, so the slider's visible position and the body
it drives never disagree.

**The chrome is CSS, not scroll-tracked JS.** `DocReadingBody`'s container carries a permanent
(usually transparent) `border-left` plus matching padding, so freezing only ever changes a
border color, never reflows the article. The flag itself sits in a full-height absolutely
positioned track (`top: 0; bottom: 0`, not `height: 100%` — a percentage height on an
absolutely positioned box resolves to `auto` when its containing block's own height is auto,
which this one is) at `position: sticky; top: 0`. Sticky inside a full-height track is what
gives "top of the document area, then top of the viewport once scrolled past" for free.
Rotation is `writing-mode: vertical-rl` plus `rotate(180deg)`, not `rotate(-90deg)` — both read
bottom-to-top, but only the `writing-mode` form keeps a real layout box for sticky positioning
and hit-testing to work against.

**Tokens.** `--frozen`/`--frozen-text` (`globals.css`, STYLE.md's table) — darker blue in light
theme, lighter in dark, the reverse of this file's usual "brighter on dark for legibility"
rule, because it's a solid fill rather than text on the page background.

**Known consequence, not fixed here.** A selection held through a freeze produces `from`/`to`
measured against the frozen document, while `handleApplyAnnotationMark` verifies them against
the live one — that path already degrades correctly (verify quoted text → unique-occurrence
search → document-level), freezing just widens the window slightly. A real fix needs Yjs
relative positions and the precondition (a `Collaboration`-bound editor) COLLAB.md §5 names for
them cheaply, which the reading view doesn't have.

## 13. Annotations become ydocs, with a TipTap editor of their own

**Decided:** an annotation's body stops being a plain-text `Json` column and becomes its own
collaborative document — a live Yjs document, same substrate as a doc itself (§11), with a real
TipTap editor both inline (over the anchored text) and in a composer below the document. This
supersedes §12i's "one view-model feeds the shared presentation" decision for the presentational
layer: that was right when an annotation was a `<textarea>` and a post comment was a `<textarea>`,
and stops being right once one of them is a collaborative document and the other isn't — the two
no longer share a rendering problem, so the shared `Comment*` components are un-shared back to
post-only and a doc gets its own `Annotation*` components. Nothing about `CommentThread`/`Comment`,
moderation, or the post reading view changes; this section only touches the doc/annotation side.

### 13a. One ydoc per annotation, not one shared ydoc per doc

The alternative — a single `ydoc:doc-annotations:<docId>` holding one XmlFragment per annotation —
was rejected for one decisive reason: **Yjs has no per-fragment ACL.** §12g hands a doc reader a
`readOnly: true` connection specifically so they can't write the body; annotating must remain
possible for a read-only reader, and "who may edit this annotation's live text" has to be
enforceable per annotation, not per doc. Hocuspocus's per-connection `readOnly` flag already is
that enforcement point (`ydocOnAuthenticate`) — one ydoc per annotation is what lets it apply.

```
ydoc.id = "ydoc:annotation:" + annotation.id
```

via `ydocIdForAnnotation` / `annotationIdFromYdocId` in `src/lib/ydoc-names.ts`, no foreign key
either direction — the same §12b rule for docs, restated for annotations.

**An annotation renders from a cache, not a live decode, for the common case.** `Annotation`
gains `proseJson` (cache of its ydoc's `"default"` fragment) and `bodyText` (flattened plain text
— search, `/annotations`, sort), written by the same store-debounce mechanism `doc-cache.ts`
already uses for `Doc.proseJson`/`Doc.title`. A live `HocuspocusProvider` opens only for an
annotation actually open in an editor right now (composing, replying, or being read live) — a
doc with fifty annotations opens zero annotation sockets until one is clicked into.

**The namespace needs two guards or it silently corrupts a doc's own cache:**
- `docIdFromYdocId("ydoc:annotation:abc")` must return `null` — the remainder carries a further
  namespace segment, not a bare doc id — or every annotation store-debounce runs a pointless
  `doc.updateMany` that (today) matches zero rows by luck of id shape rather than by design.
- `server/doc-cache.ts` and the new `server/annotation-cache.ts` each branch on their own prefix
  at the top, rather than relying on an update matching zero rows to tell them apart.

### 13b. Schema

Additive, one migration (both new columns take defaults, so this is the plain case, not the
nullable-then-required two-step CLAUDE.md documents for a required column against existing rows):

```
Annotation.proseJson   Json?    @map("prose_json")   -- cache of the annotation ydoc, §13a
Annotation.bodyText    String   @default("") @map("body_text")  -- flattened text (extractText)
Annotation.status      AnnotationStatus @default(DRAFT)
Annotation.raisedAt    DateTime? @map("raised_at")   -- when authors were notified, §13d

enum AnnotationStatus { DRAFT LIVE RAISED }
```

`Annotation.body` (the old `{text}` Json column) stays for one backfill pass and is then dropped
— every current reader of it (`/annotations`' search and table, `scripts/test-annotation.ts`)
moves to `bodyText`/`proseJson` in the same phase, so nothing reads the stale column and the new
one simultaneously.

`tiptap-schema.ts` gains a named schema for an annotation body, distinct from `docContentExtensions`
on purpose — CLAUDE.md's "picking the wrong variant silently drops marks" warning applies here
directly: an annotation body can't itself carry the `annotation` anchor mark, so it is
`authorHighlightExtensions` alone, not `docContentExtensions`:

```ts
export const annotationContentExtensions = authorHighlightExtensions;
export const pmAnnotationContentSchema = getSchema(annotationContentExtensions);
```

### 13c. Un-sharing the `Comment*` components

`CommentTarget` (§12i) currently threads through five files. Reverting it is contained:

| File | Change |
|---|---|
| `CommentForm.tsx` | drop `target`, back to a bare `postId` field; drop the `submitAnnotation` branch and every `kind === "doc"` copy string |
| `CommentNode.tsx` | drop `target`; drop `deleteAnnotation`; "Failed to delete comment." unconditional |
| `CommentEntryList.tsx` | drop `target`; "Comment date" unconditional |
| `CommentSection.tsx` | back to `{ postId }`; drop `getDocAnnotationsAsThreads`, `AnnotationColorStyles`, the many-general-threads comment |
| `comment-data.ts` | delete `CommentTarget` and `getDocAnnotationsAsThreads`; the doc-specific commentary on `anchorFrom`/`quotedText` goes with them |

A new sibling tree, `src/components/annotation/`, takes over doc-side rendering:
`AnnotationSection.tsx` (server component, the doc-side `CommentSection`), `AnnotationList.tsx`,
`AnnotationThread.tsx`, `AnnotationNode.tsx`, `AnnotationComposer.tsx`, `AnnotationBody.tsx` (the
live ydoc editor), `AnnotationPopover.tsx` (the inline version), and `src/lib/annotation-data.ts`
for the loader `comment-data.ts` loses. `AnnotationColorStyles.tsx` moves under it unchanged — it
never depended on the shared components, only on thread ids and colors.

### 13d. Lifecycle: DRAFT → LIVE → RAISED

Three states, one direction of travel by default, each meaningfully different from the plain
"is it moderated" axis a post comment has (it isn't — §12c already decided annotations are never
moderated; this axis is about visibility and notification, not approval):

- **DRAFT** — visible only to its own author. Carries **no inline mark**: mark application is
  gated on `status !== DRAFT` in the one place marks are ever applied
  (`applyAnnotationMark`/`handleApplyAnnotationMark`), which is what makes "a private note never
  puts an inline mark" structural rather than a rule someone has to remember to check. Notifies
  nobody. A freshly opened composer *is* a DRAFT — creating the row and its ydoc eagerly is what
  gives the editor something to connect to before a single keystroke lands (§13g's open
  question about that eagerness).
- **LIVE** — visible to every doc reader, gets its inline mark (or degrades document-level per
  §12h, unchanged). The ordinary "posted a comment" state. Notifies nobody by itself.
- **RAISED** — LIVE plus the doc's byline authors are emailed (`sendMail`, one call per author) and
  `raisedAt` is stamped; the UI reflects this by showing "Authors notified <date>" wherever LIVE
  would otherwise show nothing. Nothing observably changes about the annotation's mark or
  visibility between LIVE and RAISED — RAISED is LIVE plus a notification that already happened.

The composer's primary action is **Post** (→ LIVE). A `Keep private` toggle posts to DRAFT
instead; a `Notify authors` checkbox posts straight to RAISED. Any DRAFT can later be posted to
LIVE; any LIVE can later be raised. Deleting an annotation (any state) stamps `deletedAt` as
today, additionally clears its mark (see below), and notifies nobody regardless of state.

**Deleting an annotation today leaves its mark in the ydoc forever** — `deleteAnnotation` only
ever stamps `deletedByUserId`/`deletedAt`; nothing removes the mark, so the highlight persists on
text whose annotation is gone. Pre-existing, not introduced here, but this section's "deletion …
never puts inline marks" requirement is what makes it visible enough to fix alongside: a new
`POST /admin/annotation-unmark` endpoint, the exact twin of `handleApplyAnnotationMark` but calling
`removeMark` instead of `addMark`, called from `deleteAnnotation` and from any LIVE/RAISED → DRAFT
transition (moving an already-marked annotation back to private has to remove the mark too, for
the same "DRAFT never has one" invariant).

`sendMail` (`src/lib/mail.ts`) is real delivery (Resend) behind the seam described in
[docs/EMAIL.md](docs/EMAIL.md) — RAISED is wired to call it per byline author and stamp
`raisedAt` so the UI has something real to show, not an in-app notification inbox nobody
asked for.

### 13e. The formatting bar: hidden by default

`CollabEditorBody.tsx`'s `Toolbar` is extracted into a shared `EditorToolbar.tsx` taking a
tool-id list, so a doc/post body keeps its full bar and an annotation gets a reduced one (Bold,
Italic, Bullets, Quote, Clear — no headings in a comment). An `Aa` toggle button in the annotation
editor's footer row, next to Post/Cancel, shows/hides it; hidden by default, and the choice
persists in `localStorage` (`multiblog.annotationToolbar`) so someone who always wants it doesn't
re-toggle every time. Bold/italic keyboard shortcuts keep working regardless of visibility —
they're StarterKit's, not the toolbar's.

A `BubbleMenu`-over-the-selection alternative was considered and set aside for v1: zero idle
chrome, but a bubble menu inside a popover that is itself absolutely positioned over the document
is a z-index/flip-placement fight for a marginal gain over a toggle button. Worth revisiting once
the popover (§13f) is stable.

### 13f. Decorating the selected range while composing

Selecting text to annotate loses the browser's native selection highlight the moment focus moves
into the annotation editor. Fixed with a decoration, not a mark — decorations aren't content,
don't sync, and never touch the doc's ydoc, unlike the `annotation` mark itself. A new
`src/lib/pending-annotation-extension.ts`, the same shape as `quote-highlight-extension.ts`: a
plugin holding `{ from, to } | null`, updated by a meta-tagged transaction `LiveDocBody` dispatches
whenever the pending range changes. Colored via `--thread-color` from the *current user's own*
color, in `prose.module.css`, consistent with the by-author annotation coloring already committed.

**The trap:** `LiveDocBody`'s live tap calls `setContent` on every incoming update (§12n's own
"two implementation details" entry), which rebuilds the doc and discards any decoration along
with it — and with it ProseMirror's own `tr.mapping`, which is what makes this a non-problem on
the editor surface. Each time `setContent` runs while a pending range exists, the range is
re-resolved against the text instead. `findQuoteOccurrences` therefore lives in a shared
`src/lib/` module rather than in `server/ydoc-hooks.ts`, so the client-side re-resolution and the
server-side mark application call one function.

**How weak that anchor actually is — and the two better options — moved to
[docs/COLLAB.md](docs/COLLAB.md) §4**, with §5 (relative positions, and why binding this editor
is gated on decoupling the scrub preview) and §6 (carrying the anchor in awareness, which suits
a transient selection better than durable anchoring does). The short version worth having here:
an edit *before* the selection invalidates the offsets even though nothing about the selection
moved, and the text-search fallback then keeps it only if the quote is unique in the whole
document.

### 13g. Moving a draft to the bottom composer

Content is never copied between the inline popover and the bottom composer — merging two
independent Y.Doc lineages isn't a sound operation, and copying JSON across would discard
whatever collaborative history and attribution the draft already has. Instead, "move to bottom"
re-targets which composer slot renders a given annotation's id: same row, same ydoc, same
provider. Since a moved draft is still DRAFT, it has no mark and lands document-level by
construction — exactly what the bottom composer is for.

"If there is already text there" means the bottom slot is occupied by a different draft, which is
committed first — posted to LIVE, quiet, document-level, no notify — before the incoming one takes
the slot. Unconditionally quiet because posting-as-a-side-effect-of-moving-something-else should
never silently notify anyone.

The button lives in the popover's footer beside Post/Cancel, labeled "Move to bottom ⤓".

### 13h. Author highlighting: on once a second author joins, backfilled

`AuthorHighlight`'s plugin already no-ops when `getAuthorId()` returns `null`
(`author-highlight-extension.ts`), so gating it is one line —
`AuthorHighlight.configure({ getAuthorId: () => (coAuthoring ? userId : null) })` — where
`coAuthoring` is "this annotation's ydoc has seen ≥2 distinct user ids," read from the same
`clients` map (§11d) a doc already maintains, with the annotation provider's own awareness as the
live trigger that flips it mid-session.

**Decided: backfilled, not left uncolored.** Text typed before the second author arrives would
otherwise carry no mark once highlighting turns on, leaving the original author's earlier prose
uncolored while everything after reads attributed — inconsistent in a way that reads as a bug
rather than a deliberate boundary. The moment `attributeUpdate` (`server/ydoc-hooks.ts`) notices a
*second* distinct user_id for a ydoc — the same code that already writes the `clients` map entry —
it also issues one `addMark(0, size)` over the annotation's existing content, attributed to the
original (first) author, inside the same transaction as the `clients` write. This has to happen
exactly once per annotation and exactly there: `attributeUpdate` already is the single place that
detects "second author," so there's no separate race to guard against, and doing it server-side
(rather than from whichever client happens to notice) means it isn't dependent on that client
still being connected.

### 13i. Presence: showing who's editing an annotation

Two awareness channels, not one, because they answer two different questions:

- **Discovery**, on the doc's own provider — every reader already holds a connection to the doc's
  ydoc via `LiveDocBody`. Each client publishes an awareness field (deliberately not named
  `cursor`, to avoid any confusion with `CollaborationCaret`'s own field — moot here since
  `LiveDocBody` registers no `CollaborationCaret` at all, but worth naming distinctly regardless):
  `annotationEditing: { annotationId, user }`. Every other reader renders "● Alice is writing…"
  beside that annotation, or a pulsing marker on the anchored text for a brand-new inline draft.
- **Carets inside a co-edited annotation**, on that annotation's own provider — one
  `CollaborationCaret` per annotation editor, one provider each, so the "one instance, one
  awareness key" problem `CollaborationCaret` already has (CLAUDE.md) never arises: nothing here
  shares a provider the way body + title editors would.

**Verify before building, don't assume:** whether Hocuspocus propagates awareness over a
`readOnly` connection. `readOnly` gates document *updates*; awareness is a separate message type
and is expected to flow, but this hasn't been confirmed against this app's actual Hocuspocus
version and config, and §13i's discovery channel depends on it working from a read-only doc
connection. If it doesn't propagate, presence falls back to being visible only to people already
connected to that specific annotation's own provider — materially weaker, and worth knowing at
the start of Phase 5 rather than discovering it partway through.

**Privacy:** a DRAFT never publishes presence — doing so would leak that a private note is being
written to every other doc reader, defeating the point of DRAFT existing at all.

### 13j. Build order

Each phase leaves the app working, gated on `npx tsc --noEmit`, `npx eslint .`, and `npm run e2e`.

- **Phase 0** — Un-share the `Comment*` components (§13c); stand up `Annotation*` components
  rendering today's plain-text annotation through the existing server actions. No user-visible
  change; posts return to their pre-§12i shape.
- **Phase 1** — Substrate: the `ydoc:annotation:` namespace and its two guards (§13a),
  `proseJson`/`bodyText`/`status`/`raisedAt` migration (§13b), `server/annotation-cache.ts`,
  `POST /api/annotation/[id]/token`, eager `createIfAbsent` on annotation creation, one backfill
  script (`scripts/backfill-annotation-ydocs.ts`, deleted after use) seeding a ydoc from each
  existing `Annotation.body`, then dropping that column. `/annotations` moves to `bodyText`.
  Still a `<textarea>` in the UI at the end of this phase.
- **Phase 2** — The editor: `AnnotationBody.tsx` (Collaboration + provider + caret),
  `EditorToolbar` extraction, hidden-by-default toolbar toggle (§13e). Read-only annotations
  render from `proseJson`. The bottom composer ships first — it has no positioning problem.
- **Phase 3** — The inline popover: its own component and CSS module, the pending-range
  decoration (§13f), shared `findQuoteOccurrences`, "Move to bottom" (§13g).
- **Phase 4** — Lifecycle: DRAFT/LIVE/RAISED, `Keep private`/`Notify authors`, the unmark
  endpoint, quiet delete (§13d).
- **Phase 5** — Presence: the co-authoring gate and its backfill (§13h), `annotationEditing`
  awareness on the doc provider (§13i) — starting with the readOnly-awareness verification.

**Test surfaces that break and need rewriting, not just updating:** `e2e/doc.spec.ts`'s two
annotation tests (they drive a `<textarea>` and assert on the mark directly);
`scripts/test-annotation.ts` (reads `body.text`); the e2e teardown, which needs the
`ydoc:annotation:` prefix added to its cleanup guard or every test annotation leaks a `ydoc` row
the same way §12b already warns a deleted doc's `ydoc` row can leak.

### 13k. Open questions

1. **Draft garbage.** Opening a composer creates a row and a ydoc row eagerly; the plan pairs
   this with a `discardDraftAnnotation` call on close-while-empty. The alternative — stay purely
   local until the first keystroke, then create the row and attach the provider — produces no
   garbage but adds a promotion step to the editor's lifecycle. Eager-plus-discard is the
   working assumption unless told otherwise.
2. **The inline popover's position** — §13f's decoration handles the highlight; the popover's own
   placement (the +0.5em/+0.5em nudge already applied to today's plain popover, PLAN.md's doc
   commit history) carries forward unchanged unless the ydoc editor's different footprint (a
   toolbar toggle, a taller editor) turns out to need its own placement pass.

### 13l. As built

Built 2026-07-29 through all five phases §13j lays out, each gated on `npx tsc --noEmit`,
`npx eslint .`, the full `npm run e2e` suite, and hand verification in the browser (plus, for
Phase 5's server-only logic, direct verification against a `Y.Doc` bypassing the network layer).
Several deviations from the text above, all judgment calls made while building rather than
oversights:

- **DRAFT/createDraftAnnotation/postAnnotation/discardDraftAnnotation shipped in Phase 2, not
  Phase 4.** §13j originally scoped DRAFT to Phase 4 alone. Building a live editor for content
  that hasn't been posted yet turned out to structurally require a persisted row to attach the
  editor to before a single keystroke lands — exactly the mechanism §13d already describes for
  DRAFT — so there was no coherent way to build "the bottom composer becomes a live editor"
  (Phase 2) without it. Phase 4 kept its own scope: the DRAFT/LIVE/RAISED *choice* (the
  `Keep private` / `Post` / `Post & notify authors` select), `saveDraftAnnotation`, RAISED's
  email, and the unmark endpoint.
- **The inline popover is two-stage, not one.** A selection alone never creates a row — a
  lightweight "Annotate" / "Move to bottom" / "Cancel" prompt shows first (§13f's pending
  decoration already marks the selection, so there's no loss of feedback), and only clicking
  "Annotate" (or "Move to bottom") calls `createDraftAnnotation`. Without this, every
  micro-adjustment of a selection still being dragged would have spun up a fresh draft row.
- **"Keep private" needed a way back in, so `getOwnDraftAnnotations` and `OwnDraftsList`
  exist** — not separately planned, but a direct consequence of adding "Keep private" at all:
  without them, a saved-private annotation would be unreachable the instant its composer
  closed, since `getDocAnnotationsAsThreads` excludes every DRAFT unconditionally (including
  from its own author) by design. "Edit" on an own draft reuses the exact `AnnotationMoveProvider`
  mechanism "Move to bottom" already established, rather than inventing a second one.
- **`/annotations` (the admin browse surface) now excludes DRAFT outright.** Not originally
  called out in §13d's text, but a direct consequence of "a private note stays private even
  from admins" (§13a) — without this filter, `canManageDocs` could browse everyone's private
  notes through that surface, which the whole point of DRAFT is to prevent.
- **A real correctness gap surfaced during testing, not designed for up front:**
  `postAnnotation` flipping DRAFT to LIVE doesn't itself guarantee `proseJson`/`bodyText` are
  current — those are a store-debounce cache (§12d's mechanism, reused as-is for annotations).
  A reader opening a just-posted annotation could see stale (empty) content. Fixed with a new
  `POST /admin/annotation-flush` (`handleFlushAnnotationCache`) that forces the write
  immediately, called from `postAnnotation` with a short bounded retry — the flush reads the
  *collab server's* Y.Doc, which only has what it's already received over the websocket, and a
  keystroke immediately followed by a click can outrace that delivery on a slow connection (and
  reliably does in an automated test with no human-typing-speed gap between typing and
  clicking).
- **Presence is one ambient indicator per doc, not a per-annotation anchored marker.** §13i's
  own text imagined "a pulsing marker on the anchored text for a brand-new inline draft" — not
  built, because a not-yet-posted annotation has no list entry and (for an inline one) no
  guaranteed stable anchor yet to attach a marker to. `AnnotationPresenceIndicator` instead
  renders a plain "X is writing an annotation…" line wherever `AnnotationSection` sits,
  sourced from `DocPresenceProvider` (LiveDocBody's own read-only awareness, confirmed by
  reading `@hocuspocus/server`'s source rather than assumed — only document *content* sync is
  gated by `readOnly`, awareness flows over it unconditionally). Presence publishes whenever a
  composer is open and not set to `Keep private`, which resolves §13i's "a DRAFT never
  publishes presence" concern more precisely than status alone could: every open composer's
  row *is* DRAFT until submit, so gating on status would have suppressed presence always,
  defeating the feature; gating on the visibility selection's current value instead means
  presence disappears the instant someone chooses privacy, before anyone has seen the content.
- **Known gap, left deliberately open rather than silently scoped out:**
  `canUserAccessAnnotationYdoc` already allows any `canUserReadDoc` reader to open a writable
  connection to a LIVE/RAISED annotation's ydoc — which is what makes §13h's backfilled
  highlighting meaningful at all — but no UI exposes that connection. `AnnotationNode` renders
  every already-posted annotation as a static server-rendered body with no "Edit" affordance;
  `Edit` only ever appears on the viewer's own DRAFT, via `OwnDraftsList`. The mechanism is
  real and reachable (§13h's backfill was verified directly against the mark-application logic
  itself, not through this missing UI), but co-authoring someone else's posted annotation is
  not currently a discoverable feature.
- **The old plain-textarea `AnnotationComposer.tsx` and `submitAnnotation` were deleted, not
  deprecated-in-place**, once Phase 3 moved the inline popover off them — nothing else ever
  called either afterward, so keeping them around would have been dead code with no path back
  to it.

### 13m. The server→collab HTTP origin, and the production-only bug it caused

Found 2026-08-11 on the dev deployment, reported as *"Annotation can't be empty."* on every
attempt to annotate a selection. Worth recording in full, because nothing about the symptom
pointed at the cause and the whole class was invisible to every local check.

**The mechanism.** Four endpoints are served by the collab process over plain HTTP on its
websocket port — `/admin/ydoc-snapshot` (§11d), `/admin/annotation-mark` (§12i),
`/admin/annotation-unmark` (§13d), `/admin/annotation-flush` (§13j Phase 3). The Next process
calls them server-to-server. Both callers (`src/lib/annotation-admin.ts`,
`src/lib/ydoc-admin.ts`) derived the origin from **`NEXT_PUBLIC_COLLAB_URL`** by rewriting the
scheme:

```ts
const wsUrl = process.env.NEXT_PUBLIC_COLLAB_URL ?? `ws://localhost:${process.env.COLLAB_PORT ?? 1234}`;
return wsUrl.replace(/^ws/, "http").replace(/\/$/, "");
```

In dev that var is unset (deliberately — CLAUDE.md's env notes, so `getCollabUrl()` can derive
a per-request host), so the fallback applies and the origin is right. In production DEPLOY.md
§4 sets it to `wss://<app-host>/collab`, because the browser reaches the websocket through
nginx on one host and one cert. The rewrite yields `https://<app-host>/collab`, so the POST
goes to `https://<app-host>/collab/admin/annotation-flush`. DEPLOY.md §7's
`location /collab { proxy_pass http://127.0.0.1:1234; }` has **no URI part**, which in nginx
means the request URI is forwarded *unmodified* — so the collab process receives
`/collab/admin/annotation-flush`, and `server/collab.ts`'s `onRequest` tests
`request.url?.startsWith("/admin/annotation-flush")`, which is false. The request falls
through to Hocuspocus's default handler, verified in `@hocuspocus/server`'s source:

```js
await this.hocuspocus.hooks("onRequest", { request, response, instance: this.hocuspocus });
response.writeHead(200, { "Content-Type": "text/plain" });
response.end("Welcome to Hocuspocus!");
```

**A 200.** Every caller therefore saw a successful response to a request that did nothing.

**Why it presented as an empty annotation.** `postAnnotation` flushes the annotation's ydoc
cache and reads `bodyText` straight back, retrying twice at 150 ms. With the flush a no-op, the
only thing that ever writes `bodyText` is Hocuspocus's own store debounce (~2 s after the last
keystroke), so anyone who typed and clicked Post inside that window was refused with
*"Annotation can't be empty."* — and anyone who happened to pause first succeeded, which is
what made it read as flaky rather than broken.

**Three properties made this expensive to find, each worth generalizing:**

- **The websocket was unaffected**, because Hocuspocus upgrades on any path. Live editing,
  presence, and the annotation editor's own sync all worked perfectly, which ruled out the
  collab server in the obvious first pass.
- **It could not reproduce locally at all** — not a timing or load difference, but a
  *configuration* difference: the broken branch is only taken when `NEXT_PUBLIC_COLLAB_URL` is
  set, and it is never set in dev. `npm run e2e` and `web-prod` both miss it for the same
  reason. This is a different failure class from the ones CLAUDE.md's Checks section covers
  (dev-only faults that production doesn't have); this is production-only by construction.
- **Every failure was swallowed.** `flushAnnotationCache` and `removeAnnotationMark` ignored
  the response entirely; `snapshotYdoc` checked `response.ok`, which was true. Only
  `applyAnnotationMark` would eventually have complained, and in the worst way — it called
  `response.json()` on `"Welcome to Hocuspocus!"`, so once the empty-body error was out of the
  way, posting an anchored annotation would have thrown a `SyntaxError` out of the server
  action and surfaced as a generic 500. Same root cause, a completely different-looking bug.

**The fix, and why it's the loopback address rather than a corrected path.** Both callers now
share `src/lib/collab-http-origin.ts`, which resolves
`COLLAB_INTERNAL_URL ?? http://127.0.0.1:${COLLAB_PORT ?? 1234}` and never reads
`NEXT_PUBLIC_COLLAB_URL`. Adding an nginx rewrite (or a path prefix the handler also accepts)
would have worked too, and is worse on every axis: a server-to-server call between two
processes on the same box has no business making a TLS handshake and a proxy hop to reach a
port it can dial directly, and routing it through the public origin means the `/admin/*`
endpoints are internet-reachable — token-guarded, but unreachable beats guarded.
`COLLAB_INTERNAL_URL` exists for the one case the default can't serve, a collab server on a
different host; bare rather than `NEXT_PUBLIC_`, so it's a restart and not a rebuild.

The structural point, which is what makes this more than a typo: **a `NEXT_PUBLIC_` variable
names how the *browser* reaches something, and is the wrong input to any server-to-server
call by definition.** The two answers coincide in dev and diverge exactly when a reverse proxy
appears. `collab-url.ts` (client) and `collab-http-origin.ts` (server) are now the only two
places that decide a collab address, and neither can be reached from the other's side.

Both remaining swallow-points now `console.error` on a non-`ok` response and on an unreachable
host, and `applyAnnotationMark` treats a non-JSON 200 as `applied: false` rather than throwing
— so the next occurrence of anything in this family lands in
`journalctl -u multiblog-web` instead of nowhere. That is the same argument TODO.md's
"Observability of swallowed bulk-action failures" makes about `settleBulk`; this is the second
instance of the pattern, which suggests the general rule is worth stating: **a best-effort call
may swallow a failure's *effect on control flow*, never its *existence in the log*.**

### 13n. `ydoc_update_id`: which revision an annotation was written against

> **Superseded in part by §13o.** When this was written it was metadata and nothing else,
> and said so emphatically: *"deliberately not the `anchor_from`/`anchor_to`/`quoted_text`
> trio COLLAB.md §7 speculates … that stays unbuilt."* Those three columns now exist, and
> this one is the version stamp they are measured against. Everything below about *how the
> value is chosen* and *what reads it back* is unchanged and still current; only the
> "metadata, not a second anchor" framing is not.

`Annotation.ydocUpdateId BigInt?` records which `ydoc_update` row was current when the
annotation was posted. It answers "what did the reader see when they wrote this," and drove
exactly one thing at the time: a scrubber jump.

> **The stamp's meaning, in one line, since it now has two derivations:** *the earliest revision
> at which this annotation is locatable.* For a column-anchored one that is the version its
> author was looking at, because the offsets are true there (§13q). For a mark-anchored one it is
> the update that **carries the mark** — which is strictly *after* what the author saw, because
> the collab server applies the mark as its own update. Stamping the earlier state was a real
> bug rather than a nuance: "at this revision" scrubbed to the one document where the annotation
> provably isn't attached, and the card dropped out of the margin rail the moment you clicked it.
> Measured on a real doc before the fix — at update 64951 (an annotation's own stamp) the
> document carried four annotation marks and not that annotation's; its own first appears at
> 65049. `postAnnotation` re-stamps after a successful `applyAnnotationMark`;
> `scripts/backfill-mark-annotation-stamps.ts` fixed the rows written before that, and
> `check-annotation-anchors.ts`'s `mark-at-stamp` is the standing guard.
>
> Only on success: a mark that never landed leaves the annotation document-level, and its
> original stamp stays the most honest value available.

> **Also superseded in part by §13q**, which is what the paragraph below stopped being true of:
> the tail is now the *fallback*, not the normal case. A reading-view annotation is stamped with
> the version its author was actually looking at, converted from a Yjs snapshot the client
> captures at selection time. The scrub-frozen path below is unchanged and still wins where it
> applies.

**Written in `postAnnotation`** (`src/app/actions/annotations.ts`), for every posted
annotation, root or reply — not gated to roots the way the mark itself is, since "what was I
looking at" is meaningful for a reply too, even though a reply carries no anchor of its own.
The inline popover on a scrub-frozen reading view supplies its own scrub position precisely
(threaded `ScrubbedState.updateId` → `DocView` → `DocReadingBody` → `AnnotationPopover` →
`LiveAnnotationComposer`); every other caller (the bottom composer, a reply, the doc editor once
§18 gains one) omits it, and the action falls back to `ydocStore.maxUpdateId` — the log's tail
at the moment of posting. BigInt never crosses a server-action boundary — stringified in
`annotation-data.ts`'s `getDocAnnotationsAsThreads` before it ever reaches a client component.

**Reading it back** is `AnnotationNode`'s "at this revision" control, beside the existing
timestamp permalink — visible only when the annotation has an id *and* something is registered
to seek with. That second condition is real, not decorative: `src/components/
DocScrubContext.tsx` (`DocScrubProvider`/`useDocScrub`/`useRegisterDocScrubSeek`) is the same
cross-sibling-subtree shape `AnnotationMoveProvider`/`DocPresenceProvider` already use, because
`AnnotationSection` and `DocView` are siblings in `page.tsx`, not parent/child — and
`DocScrubBar`'s `LoadedScrubBar` only has a `ydoc_update.id → slider index` mapping to register
*after* its own replay has loaded, which (§12) doesn't happen until the reader has actually
touched the scrub bar once. Before that, or on `/doc/[slug]/edit` (no `DocScrubProvider` at
all), the control simply doesn't render — the same null-is-supported convention
`useMarginNotes()` established, not a broken state to guard against.

### 13o. Two anchoring mechanisms, picked by surface — and why the reading views stopped writing marks

**Decided:** an annotation written from a *reading* view (`/doc/[slug]`) anchors with stored
`anchor_from`/`anchor_to`/`quoted_text` and never writes to the document. One written from the
doc *editor* keeps §12i's in-ydoc `annotation` mark and stores no offsets. A row has one or the
other, never both.

This is COLLAB.md §7 ("anchoring to a scrub-reachable state"), which §13n above declined and
this section builds — the resolver half of it, not yet the repair half. It reverses part of
§12i, so the reason has to be worth the reversal.

**What the mark cost a reader.** Applying a mark is an edit. §12i knew that and answered it by
having the *collab process* apply the mark on the reader's behalf, so a reader with a
`readOnly` connection could still annotate. That works, and the consequences of it working are
the problem:

- **A reader mutates a document they cannot edit.** Not a metaphor — a real Yjs update, applied
  by a privileged path, to a doc whose `readOnly` token exists precisely to say this person may
  not do that.
- **The update is unattributed.** `attributeUpdate` reads the identity off the Hocuspocus
  *connection*; a direct connection has none, so the change lands in the never-truncated
  `ydoc_update` log with no author. The one table designed to answer "who changed this" can't.
- **It is unbounded.** `excludes: ""` (§12i, deliberately) allows any number of overlapping
  annotation marks over the same text. Each `addMark` splits text runs, and `removeMark` does
  not merge them back. So annotation volume from people with read access is a permanent
  structural growth path into a document they cannot otherwise write to, with no rate limit
  anywhere in front of it.
- **It keeps `/admin/annotation-mark` on the hot path for every reader.** That endpoint marks
  any range of any document, gated only by a token the Next server mints. After this change it
  is reachable only from the editor surface — where the caller could write to the document
  directly anyway, so it grants nothing new.

**The rule is the surface, not the permission.** An author reading `/doc/[slug]` also gets the
column anchor, even though they could have written a mark. Keying on permission would mean the
same gesture on the same page produced two different anchor kinds depending on who made it,
and two code paths whose difference is invisible in the UI. Keying on surface means each page
has exactly one answer, and `postAnnotation` takes an explicit `anchorMode` rather than
inferring it from which optional props happen to be present.

**What the columns cost, and the two things that keep it small.** Stored offsets into a *living*
document are the weak anchor in COLLAB.md's table: unlike a post's, they have no immutable
snapshot to be stable against and no publish step to be remapped at. Two decisions do most of
the work of paying for that.

*`quoted_text` is derived server-side, against the state `ydoc_update_id` names.* The client
sends its own reading of the selection; `captureAnnotationAnchor`
(`src/lib/annotation-anchor-capture.ts`) materializes the stamped state, uses that string only
to verify — and if the document moved under the selection, to re-find — the range, and stores
*its own* `textBetween` at whatever range that resolves to. So:

- §12i's "the selected text is a request field only, never a column" survives the arrival of a
  column, at the level that matters: nothing a client says is stored verbatim. A client naming
  text that isn't in the stamped state gets **no anchor**, not an anchor of its choosing. (A
  client naming text that *is* there gets an annotation on that passage — indistinguishable
  from having selected it, so that residual isn't worth closing.)
- The triple is self-consistent forever. Replay to `ydoc_update_id` and
  `textBetween(anchor_from, anchor_to)` *is* `quoted_text`, by construction. Resolving against
  "now" instead would have stored a triple describing a state nothing records — which is
  exactly what would make COLLAB.md §7's materialize-and-diff repair unbuildable after the
  fact, since it would have nothing trustworthy to diff *from*.

Note what this does **not** need: a collab round trip. `ydocOnChange` appends a `ydoc_update`
row per Yjs update rather than per store debounce, so the log's tail is within a websocket
round trip of live — a different guarantee from `Doc.proseJson`, which lags by seconds and must
never decide where anything is. The reading view's annotation path now touches the collab
server for exactly one thing, the annotation's *own* body flush.

*Resolution at read time is tiered, because the naive version is unaffordable.*
`AnnotationHighlight` (`src/lib/annotation-highlight-extension.ts`) holds the resolved ranges in
plugin state and updates them per transaction:

1. **Map through the transaction**, biased away from the range (`map(from, 1)`/`map(to, -1)`,
   the convention `anchor-remap.ts` already uses), then verify against `quoted_text` — a
   mapping says where positions went, not whether the words survived. Free, and correct for
   every local edit in the doc editor.
2. **Search a window** sized by the document's own size delta plus a pad. The reading views push
   remote updates in with `setContent`, which replaces the document wholesale and makes the
   mapping meaningless (COLLAB.md §4's trap) — but the text has usually barely moved, so a
   keystroke elsewhere costs a few dozen position probes rather than a scan. A hit in the window
   is *more* trustworthy than a globally unique match, being the occurrence nearest where this
   anchor already was.
3. **A full `findQuoteOccurrences` scan, once.** If that fails the anchor is left detached and
   is **not** retried on later transactions — retrying would mean an O(document × quote) scan
   per keystroke forever, for the annotation least likely to repay it. Detachment is
   re-evaluated on the next anchor push (any `router.refresh()`), which is the doc-side
   equivalent of the post side re-testing a `DETACHED` thread at the next publish rather than
   continuously (COLLAB.md §1).

Without tier 2 this would be the first per-keystroke O(document × quote) cost on a reading
surface — doc links pay it (COLLAB.md §3) but memoize on document identity, which is worthless
here because every remote update *is* a new document.

**No repair writes from a reading view**, following COLLAB.md §3's closing rule: a reading view
is a tap at least one update behind, so any correction it computed was already stale, and N
concurrent readers would be last-writer-wins on the one field whose entire job is precision.
The doc editor *could* legitimately persist a correction — it is `Collaboration`-bound and its
positions come from real transactions — and doesn't yet. That is the honest place to build
COLLAB.md §7's repair half.

**The two mechanisms degrade differently, on purpose.** A lost mark leaves nothing behind, so
the thread falls into general discussion with no blockquote (§12h — degraded, not detached,
since there was never a frozen revision to show one against). A stored quote *survives* its own
detachment: it was derived against a reconstructible state, so the card keeps its blockquote and
can still say what it was about even once that text is gone. That is the `DETACHED` affordance a
post comment has always had and a doc annotation could not.

**One answer, two mechanisms.** `resolveAnnotationRanges` (`src/lib/annotation-marks.ts`) merges
the mark scan and the plugin's tracked ranges into one map, and every consumer — both margin-note
rails, `AnnotationClick`, `QuoteThreadHeader`'s jump — goes through it rather than knowing there
are two. `annotation-marks.ts`'s header had already anticipated being that single definition;
this is what made it necessary. The one visible seam is in the DOM: a mark renders
`data-annotation-id` (singular — a mark never merges ids onto one span), a decoration renders
`data-annotation-ids` (plural — overlapping inline decorations silently drop each other's
attributes, so `decoration-segments.ts` pre-splits them, the same split
`quote-highlight-extension.ts` already has against the mark).

**The doc editor gets the decoration too**, not just the reading view. An author rewriting a
passage a reader annotated would otherwise see no sign it had been annotated, since that anchor
is a row rather than content — which would make the reading views' anchor invisible on exactly
the surface whose edits break it.

**As built.** Migration `add_annotation_anchor_columns`; `postAnnotation`'s `anchorMode` branch;
`captureAnnotationAnchor`; `resolveAnchorInDoc` (`src/lib/annotation-anchors.ts`), shared with
`handleApplyAnnotationMark` so the two mechanisms can't come to disagree about what "this quote
is still here" means; `AnnotationHighlight`; `resolveAnnotationRanges`. `/doc/[slug]` fetches
threads once and passes them to both the body and `AnnotationSection` — the shape
`[slug]/page.tsx` already used for a post's comments, and the reason is stronger here: two
fetches would be two snapshots that could disagree about which annotations exist, leaving a
highlight and the card it belongs to derived from different answers.

**Known gaps.** The materialize-and-diff repair pass (COLLAB.md §7's other half) isn't built —
the stamp that makes it possible is stored, nothing consumes it as one. A column anchor spanning
a paragraph break can't be re-found once its offsets go stale, inheriting
`findQuoteOccurrences`' block-boundary limitation (COLLAB.md §3, and §4's rejected fix for why
that isn't quietly patched). And annotations still aren't correct *on the scrub view*: a reader
scrubbed to a past state sees anchors resolved against the live document. The stamp is what
would fix that, and it's now stored on every row.

### 13p. A reply anchors to a passage of the annotation it answers

**Decided:** selecting text inside a posted annotation opens a reply anchored to that passage.
The anchor targets the **parent annotation's body**, never the doc — so a reply cannot quote
the document, and a root annotation cannot quote another annotation. Same three columns §13o
added; no schema change at all.

**Why the target is a property of the row and not of the request.** A reply exists because of
something its parent said. A quotation of the *doc* belongs to whichever annotation is about
the doc, which is the root. So `postAnnotation` decides the target from
`parent_annotation_id` rather than taking it as an argument: non-null picks
`ydoc:annotation:<parentId>` and the annotation schema, null picks `ydoc:<docId>` and the doc
schema. A client cannot ask for the other one, and there is no combination of arguments that
produces a reply pointing into the doc.

Decoding with the right schema is not cosmetic: decoding a doc body with the annotation schema
silently drops every `annotation` mark in it, and decoding an annotation body with the doc
schema registers a mark that body can never contain.

**Only the column mechanism, and not as a temporary limitation.** A reply's anchor could not be
a mark even if this wanted one: `annotationContentExtensions` (§13a) deliberately has no
`annotation` mark, so an annotation body cannot carry an anchor onto another annotation.
`anchorMode` is forced to `"columns"` for any reply, which is also what makes §13o's mark
branch safe to leave keyed on `docId` with no root check of its own.

**The stamp follows the target**, because §13o made the stamp the coordinate system the offsets
are expressed in — the two cannot be chosen independently without the stored triple ceasing to
mean anything. So an anchored reply stamps its *parent annotation's* update log, and
`ydoc_update_id` becomes "the log of whichever document this annotation's anchor is measured
against." An **anchorless** annotation — including the anchorless reply the plain Reply button
still produces — stamps the doc's log exactly as every row did before, since with no offsets to
be a coordinate system for, the column means only §13n's "what was I looking at," and that is
the doc.

The cost of that overload is §13n's "at this revision" control, which seeks the doc's scrub bar:
for an anchored reply it now names a position in a different log. Weighed and accepted rather
than adding a second column that would hold the same value as the first on every root
annotation ever written. The control is unchanged for roots and for anchorless replies, which is
every row that existed before this section.

**A posted annotation's body had to become a real editing surface first.** That is
`AnnotationBodyReader`, and the reason is not aesthetic: a browser `Selection` over the static
React tree `annotation-entries.ts` produces gives DOM nodes and offsets, and converting those
back into document positions means reimplementing what ProseMirror already does exactly — the
same "don't reconstruct what the library has" rule COLLAB.md §4's rejected rewrite is about. A
static tree also cannot carry decorations, which is how an existing reply's quote gets
highlighted inside the parent. So the body renders through an `editable: false` editor behind
the SSR copy, the shape `AnnotatableArticle` and `DocReadingBody` already use, which keeps the
surface working with no JS and the first paint free of a flash. The static tree stays as the
pre-ready and no-JS copy; both it and the JSON ship together.

The cost is **one editor per rendered annotation**, real on a heavily-annotated doc, taken
deliberately over a lazier scheme whose failure mode (mounting an editor mid selection-gesture,
which cancels the gesture) would be worse than what it saves. If it ever measures badly, mount
on first pointer/focus contact and keep eager mounting for any annotation that has anchored
replies to decorate.

**Two interaction rules, and the second is what makes it usable.**

- **A selection with no reply open opens one; a selection with a reply already open re-points
  it.** Not a second composer — the reader is refining what they are replying *about*, and one
  composer per selection adjustment would leave a trail of abandoned `DRAFT` rows behind a
  single change of mind.
- **An empty selection is ignored, not treated as "deselected".** This is the one place the
  gesture deliberately differs from `useSelectionPopover`, which clears on empty. Here the
  composer consuming the selection is a *sibling editor on the same page*: clicking into it
  collapses the body's selection, and clearing the anchor at the moment someone starts typing
  about it would be exactly backwards. An anchor is replaced by another selection or not at all.

**The anchor is immediate; the row is not.** The range reaches React state on every selection,
so the pending decoration (§13f's, in the composing reader's own color) appears with no wait.
The `DRAFT` row waits ~300ms for the selection to stop changing — a drag emits an update per
pixel, and each would otherwise be a row, a ydoc and a websocket. A timer rather than
`pointerup`, so a keyboard selection (shift+arrows, which never emits one) settles the same way.

**Rendering.** Posted reply anchors are highlights inside the parent's body, each in its
replying author's color, clickable to scroll to and flash that reply's card. It is §13o's
decoration layer pointed at a different document — `AnnotationHighlight` and `AnnotationClick`
neither knew nor needed to know which. Only *direct* replies are drawn in a given body: an
anchor points at the annotation it answers, so a reply-of-a-reply is drawn inside its own
parent, by that node.

**Known gaps.** There is no way to *edit* someone else's posted annotation, so the body a reply
anchors into is immutable in practice — but only in practice: `canUserAccessAnnotationYdoc`
grants a writable connection to any doc reader for a non-`DRAFT` annotation, so nothing
structural stops a body from changing under an anchor. The stamp is what would resolve that when
it happens, and it is stored. `/annotations`' Quote column shows a reply's quote now, but the
table still has no way to say *what* a quote is a quote of.

### 13q. The stamp becomes the version the annotator saw

**Decided:** `Annotation.ydocUpdateId` names the document state the annotator was *looking at*,
not the log's tail at the moment they clicked Post. The client captures a Yjs snapshot when it
reads the selection; the server converts that to a `ydoc_update.id`.

**This is an accuracy and semantics change, not a correctness fix**, and the distinction sets
the budget. `captureAnnotationAnchor` (§13o) resolves the offsets *against whatever it stamps*
and stores its own `textBetween`, so the triple has always been self-consistent with the stamped
state — that never depended on the stamp being right. What a post-time tail broke was two other
things: "at this revision" jumped to a state the reader had never seen, and verification fell to
a whole-document text search whenever anyone had edited in between, which is where an anchor
lands on the wrong occurrence.

**A client cannot name its own update id**, which is worth stating because every workaround
looks plausible until traced. `ydoc_update.id` is a *global* sequence, so one document's ids are
non-contiguous and "N plus the seven updates I have seen since" is not computable. The sync
payload is one merged `encodeStateAsUpdate`, so it carries no row boundaries. And `prose_json`
re-encoded into a `Y.Doc` mints fresh structs under a new client id, CRDT-incomparable with the
live document. docs/COLLAB.md's 2026-08-13 entry has the full load → sync → select → post →
resolve timeline; what remains is that the client can state its version exactly in Yjs's own
terms and in no other.

**A snapshot, not a state vector**, and this cost a wrong implementation to learn. A state vector
summarises insertions only — deletions advance no peer's clock — so two documents differing by a
deletion encode identically. Measured on a real corpus: **9.5% of `ydoc_update` rows carry no
structs at all**, in runs of up to 22 consecutive, so a vector alone leaves the answer ambiguous
across a whole run. `Y.snapshot` pairs the vector with the delete set and closes it — verified
4/4 exact inside a real deletion run, where clocks alone collapse every position in it to one id.

**`Y.encodeStateVectorFromUpdate` is the wrong primitive and fails silently.** It answers "what
vector would a document built from this update *alone* have", and a delta's structs cannot
integrate standalone, so it returns empty for every row after the first — 1350 of 1353 on the
document tested. The walk then accepted any prefix and resolved completely different states to
one id, which reads as corrupt data and is not. Reading `decodeUpdate().structs` directly is what
that function gets mistaken for.

**Capture happens in the same synchronous tick as reading the offsets.** From the moment a
selection exists the surface is frozen, and `useLiveDocContent` withholds the *render* while
continuing to apply updates to the Y.Doc — so a version captured any later names something the
reader was never shown. `reresolve` re-versions as well as re-positions, since it runs only after
a `setContent` moved the text and the offsets then describe the new document.

**The rejected alternative.** The collab server could broadcast the current id after every append
(Hocuspocus has `broadcastStateless` for exactly this) and let clients stamp what they last
heard. That is one extra message per Yjs update, permanently, on the busiest path there is, to
serve an event that happens a few times a day. The snapshot puts all of its cost at post time
and adds nothing to the append path.

**What made the walk affordable** is this section's other half: the store debounce now writes
`Ydoc.lastUpdateId` beside the blob and state vector it already wrote, making that row a rolling
checkpoint never more than one debounce behind head. The resolver starts there. Before it
existed the walk began at the newest `ydoc_snapshot` the client covered — and snapshots are
created deliberately, never implicitly (§11b), so a doc that has never been published has none
and the walk covered its whole lifetime: 1219 rows on a real document. **This is what retired
opportunistic snapshotting**, which had been designed to solve exactly that and would have
reversed §11b's invariant to do it.

Latency was the constraint on writing it, and the two writes sit on different paths.
`appendUpdate` records the id its insert returns as a side effect, and nothing on the per-update
path awaits it — the broadcast to peers has already happened. `onStoreDocument`, already async
and already writing, drains the per-document append queue first. Backwards, that stamps content
with an id older than itself, and a consumer replaying to it sees less than the cache shows.

**Cost, measured:** 2ms on the head fast path (nobody edited between load and post — the
overwhelmingly common case), 15ms to walk 1219 rows with no checkpoint at all. Header decode
only; nothing is applied.

**Replies keep the tail, deliberately.** A reply's anchor targets its parent annotation's ydoc
(§13p), which the client has no live connection to — an annotation body renders from its
`proseJson` cache, not a tap. Nothing edits a posted body today, so the tail *is* what the reader
saw. `Annotation.proseJsonUpdateId` is the seam for when that changes.

**As built.** `src/lib/ydoc-version-client.ts` (capture), `src/lib/ydoc-version.ts`
(resolution), `Ydoc.lastUpdateId` / `Doc.proseJsonUpdateId` / `Annotation.proseJsonUpdateId`
(migration `add_ydoc_version_stamps`), `drainAppends`, and
`scripts/integrity/check-annotation-anchors.ts` — which pins the invariant all of this rests on,
and was written first for that reason.

**Known gaps.** The append-queue drain is not covered by a test: locally an insert resolves in
under a millisecond against a seconds-long debounce, so the window never opens, and removing the
drain leaves the assertion passing. Kept on reasoning, recorded at the function. Existing rows
are left null rather than backfilled — the honest value is "unknown", and a guess is
indistinguishable from a real stamp while sending the walk somewhere wrong. And nothing consumes
the stamp as a *resolution* input yet: COLLAB.md §7's materialize-and-diff repair is still
unbuilt, and this is the half that makes it buildable.

## 14. Side-by-side docs, joined by doc links

**Decided:** a third doc surface — two docs rendered in parallel columns at
`/side-by-side/<left>/<right>` — on which a reader can select text in one column and text in the
other and tie the two selections together into a named **doc link group**. A doc link's anchor
lives in Postgres and is painted with ProseMirror **decorations**, not with a mark inside the
document. That deliberately reverses §12i's central choice, and §14a says why and what it costs.
Nothing about the single-doc read view (§12), the doc editor, or annotations (§13) changes; this
section adds a surface beside them and touches shared code only where noted.

### 14a. Why the anchor lives outside the document

**Moved to [docs/COLLAB.md](docs/COLLAB.md) §3**, alongside the three other anchoring strategies
it is a deliberate departure from. The two structural reasons in one line each: **a mark lives in
exactly one document and a link joins two** (the mark design needs two marks in two ydocs, with no
transaction spanning them to close the half-applied window), and **applying a mark is a write**,
which side-by-side's readers may not be entitled to make.

So the anchor is external, and the price is drift: an external offset is a claim about a document
that keeps changing underneath it. §14d is that price paid in full, and it is the single largest
piece of work in this section. **The new models' schema comments must say this out loud**, adjacent
to `Annotation`'s comment claiming the opposite — the next reader will see the two side by side and
deserves to know the difference is deliberate.

**One consequence to state plainly rather than discover: doc links do not propagate live.** An
annotation appears in every open tab because its anchor is a mark riding the same Yjs update stream
as the text. A doc link is a Postgres row with no live channel, and no useful `revalidatePath`
target either, since every consumer of it is client state on a page nobody re-renders. Two people
on the same pair will not see each other's links until one of them reloads. Accepted for this
section; the eventual fix is either a `doc_link:`-prefixed ydoc carrying the group set (§11's stack
already supports that shape) or plain polling. Not both docs' *content* — that is live already,
through each column's own provider.

### 14b. Schema

Two new tables, one migration, both additive:

```
model DocLinkGroup {
  id            String    @id @default(cuid())
  name          String?
  text          String?
  overrideColor String?   @map("override_color")
  userId        String    @map("user_id")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")
  deletedAt     DateTime? @map("deleted_at")
  user  User      @relation(fields: [userId], references: [id])
  links DocLink[]
  @@index([userId])
  @@map("doc_link_group")
}

model DocLink {
  id             String    @id @default(cuid())
  docId          String    @map("doc_id")
  markId         String?   @map("mark_id")
  mark           Json?
  text           String?
  docLinkGroupId String    @map("doc_link_group_id")
  overrideColor  String?   @map("override_color")
  userId         String    @map("user_id")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")
  deletedAt      DateTime? @map("deleted_at")
  doc   Doc          @relation(fields: [docId], references: [id], onDelete: Cascade)
  group DocLinkGroup @relation(fields: [docLinkGroupId], references: [id], onDelete: Cascade)
  user  User         @relation(fields: [userId], references: [id])
  @@index([docId])
  @@index([docLinkGroupId])
  @@map("doc_link")
}
```

**`mark_id` versus `mark` — inline versus external.** `markId` is the id attribute of an inline
TipTap mark inside the doc's own ydoc, exactly as `annotation`'s anchor works; `mark` is the
external anchor this section actually builds. Exactly one is ever non-null. Prisma has no
CHECK-constraint DSL, so the generated migration gets a hand-added
`CHECK (num_nonnulls(mark_id, mark) = 1)` with a comment citing this subsection — the same
hand-edited-migration convention `drop_annotation_body` established. Without that constraint
`mark_id` is an untested column with no writer, so the constraint is what makes shipping both
columns honest rather than aspirational. `resolveAnchor(link)` is the single place that branches.

**`mark`'s shape** — `Json?`, matching how `Doc.proseJson` and `Annotation.proseJson` already store
structured blobs, and giving `jsonb` querying later:

```
{ v: 1, from, to, text, before, after, blocks }
```

`text` is `doc.textBetween(from, to, " ")` at capture time — the same value `findQuoteOccurrences`
searches for. `before`/`after` are up to 50 characters of surrounding context, used to break ties
when the text occurs more than once. `blocks` is how many block nodes the selection spanned, which
§14d needs. `v` is there because this is the one column in the schema whose *shape* will change when
the inline path lands. Prisma types `Json` as `JsonValue`, so every read goes through
`parseDocLinkMark(value): DocLinkMark | null` rather than a cast.

**Nullability beyond what the column list says.** `override_color` is nullable on both tables — the
three-level cascade in §14e has no "no override" state otherwise. `name` and both `text` columns are
nullable as specified. `docLinkGroupId` is required: a link with no group is meaningless, since the
group *is* the link.

**Soft delete is `deleted_at` alone**, not the `deletedByUserId` + `deletedAt` pair every other
soft-deletable model here uses. Deliberate, and it buys something: with one FK to `User` per model
instead of two, neither model needs a named `@relation`. Neither table joins the `$extends`
soft-delete filter in `src/lib/prisma.ts` either — that covers only `post`/`user`/`doc`, and
`annotation` is already excluded on purpose and filters by hand. Both new models do the same, and
their schema comments should say so rather than leaving it to look like an oversight. Recorded as a
divergence in §14n, since it is the one place this section knowingly departs from house convention.

`Doc` gets `docLinks DocLink[]`; `User` gets `docLinks DocLink[]` and `docLinkGroups
DocLinkGroup[]`. `onDelete: Cascade` on `doc_id` rarely fires — a `Doc` is normally soft-deleted —
but it is what keeps a hard delete from orphaning rows.

### 14c. The route

`src/app/side-by-side/[left]/[right]/page.tsx`. Two things about this differ from the obvious
reading, both worth writing down:

**Two segments, not one `[id]+[id]` segment, because Next percent-encodes param values.**
`getParamValue` in `next/dist/shared/lib/router/utils/get-dynamic-param.js` runs
`encodeURIComponent` over every string param before handing it to user code — the comment on the
returned field reads "The value that is passed to user code" — so a request for
`/sidebyside/abc+def` arrives as `params.pair === "abc%2Bdef"`. (The `+`-means-space rule does *not*
apply; that is a query-string convention, and `getRouteMatcher` correctly `decodeURIComponent`s the
captured group first. The `%2B` comes from the *re*-encode afterward.) A `pair.split("+")` would
therefore return one element and 404 every URL in the feature, for a cause that looks nothing like
itself. Two segments sidestep it entirely, and leave room for a future `/side-by-side/<left>` that
renders a "pick the other doc" picker. Verified against `next@16.2.11`.

**Kebab-case, because every other multi-word route here is** — `ydoc-debug`, `site-settings`,
`forgot-password`, `invite` ([docs/EMAIL.md](docs/EMAIL.md)). A URL is expensive to change later.

`"side-by-side"` goes into `RESERVED_SLUGS` (`src/lib/slug.ts`). `src/app/[slug]/page.tsx` is the
post catch-all, and `changeDocSlug` checks the same set, so without this a post or doc slugged
`side-by-side` would be permanently shadowed by the new static segment. That set exists for exactly
this and is exactly what gets forgotten.

**`left === right` is rejected** (`notFound()`). Two columns on one doc would build two distinct
`Y.Doc`s under one `documentName`, and `attachIndexeddb` ref-counts on a `WeakMap<Y.Doc>` — so the
two would get two `IndexeddbPersistence` instances against the same IndexedDB database, each
re-persisting what the other wrote. That is y-indexeddb#25 precisely, reached by a path the existing
ref-count does not cover (it was built for StrictMode's double-invoked effects, where the `Y.Doc` is
the *same*). It is also a semantic rejection rather than a workaround: a link with both ends in one
doc has no representation in `← N  M → (+Y)`. Independently, §14l Phase 0 re-keys that ref-count on
the IndexedDB database name and refuses a second attach for a different `Y.Doc`, which fixes the
class rather than this instance.

**Authorization is per doc.** Each id resolves through `resolveDocParam` (id or slug, as everywhere
else), then `canUserReadDoc(userId, role, { id, visibility })` per column, and `canUserEditDoc` per
column for the write toggle. If *either* doc is unreadable the whole page is forbidden rather than
rendering one column beside a placeholder: the page's only purpose is comparison, and the "Compare
with…" picker (§14k) only ever offers docs the viewer can read, so the sole way to arrive here is a
URL shared between people with different access. See §14n.

### 14d. Anchor drift and repair

**The resolution order and its costs moved to [docs/COLLAB.md](docs/COLLAB.md) §3**, so that the
repair policy sits next to the alternatives it was chosen over — in particular COLLAB.md §7/§8,
which are what this should become if it is ever revisited. The three steps, for reference:
stored offsets if they still read as `mark.text` (O(1), the common case) → otherwise
`findQuoteOccurrences` with `before`/`after` as the tie-break → memoize on
`(doc identity, links identity)`.

Step 3 is not an optimization, it is load-bearing. The read column calls `setContent` on *every*
incoming ydoc update — every remote keystroke — and `findQuoteOccurrences` is O(doc × text) with no
index. Two docs and fifty links without memoization plus step 1's early-out is a full scan per link
per keystroke. Neither annotations nor quotes ever hit this shape: both re-find at most once, on
submit. Wrap the resolve in `perfMeasure` (`src/lib/perf-monitor.ts`), same as the author-highlight
walk, so the cost is measurable rather than inferred.

**Persistence of corrected offsets happens only from a column in write mode.** *(Not built — see
§14o. Write-column highlighting was never wired up, so there is no write surface to persist from, and
`updateDocLink` takes no `mark` argument. Every column resolves in memory, every time. The reasoning
below is what should govern it whenever the write column does land.)* A write column is
bound through the `Collaboration` extension, so its corrected positions come from ProseMirror steps
mapped through real transactions — authoritative, and strictly better than any text search. A read
column is a read-only tap that is always at least one update behind, so offsets it computes were
already stale when computed; persisting them would mean N concurrent readers last-writer-wins on
the one field whose whole job is precision, each rewriting rows owned by other users. So: read
columns resolve in memory and never write; a write column persists (debounced) what its own
transactions told it. Drift therefore heals whenever anybody edits the doc, which is the only moment
at which anyone actually knows the answer.

**An unanchored link stays visible in the group panel** with no highlight — it is still a named row
in a group, and silently vanishing is worse than showing it as unplaced. *(Not built — see §14o. The
group panel edits the group's own name/text/color and lists no links at all, so an unanchored link is
currently invisible everywhere except the count line.)* This mirrors both
`ThreadStatus.DETACHED` on the post side and §12i's degrade-an-annotation-to-document-level
fallback. `anchored` is computed on the client and is deliberately **not** a column: nothing would
ever write it, and a stored status would drift from the document exactly like the offsets do.

Two failure modes that the annotation path never meets:

- **`findQuoteOccurrences` cannot match a selection spanning block boundaries**, as its own header
  comment says: a paragraph break costs two ProseMirror positions but emits one separator
  character, so the `from + len` window under-counts once per boundary. Readers comparing two
  documents will absolutely select across paragraphs. For this section: `mark.blocks > 1` skips
  step 2 entirely and degrades straight to unanchored on any mismatch. Generalizing
  `findQuoteOccurrences` is a shared change that would improve annotations too, and belongs in its
  own pass (§14m).
- **First paint resolves against `Doc.proseJson`, which is a store-debounce cache.** A link created
  against the live editor and then loaded fresh lands on the *lagging* copy, so step 1 misses more
  often right after an edit than intuition suggests. Step 2 covers it; the point is not to read the
  miss as a bug.

### 14e. The decoration layer

`src/lib/doc-link-extension.ts`, built on `pending-annotation-extension.ts`'s skeleton rather than
`quote-highlight-extension.ts`'s:

```
export const docLinkKey = new PluginKey<DocLinkPluginState>("docLink");
export function setDocLinks(view: EditorView, next: DocLinkPluginState): void;
type DocLinkPluginState = {
  links: ResolvedDocLink[];   // { id, groupId, from, to, color, mine }
  activeGroupId: string | null;
};
```

**Link data enters through a meta-tagged transaction, not `configure()`.** `QuoteHighlight` bakes
its threads in at construction and forces editor recreation through a `useEditor` dep array, which
is fine for a page whose threads are fixed at load and wrong here: links change continuously as the
user works, and recreating the editor would tear down the ProseMirror view, lose selection and
scroll, and in the write column destroy the `Collaboration` binding. The push comes from an effect
keyed on `[editor, links, activeGroupId]`. `Display?` and "Show only my Links" are filtered in
React *before* the push — they are non-persisted view state and the plugin needs no concept of them.

**A correction to the obvious worry about `setContent`.** `setContent` does not destroy plugin
state; it dispatches a whole-document replacement, and the plugin's `apply` runs normally. What it
destroys is any `DecorationSet` you tried to *map* through that transaction, since every interior
position remaps to the boundary. Because `decorations(state)` recomputes from `links` plus the
current doc and never caches a mapped set, this plugin is immune by construction — simpler than
`reresolvePending`'s dance, and the real argument for computing decorations from stored anchors
resolved against the current document.

**Resolve outside `decorations()`.** That prop runs on every view update, including bare cursor
moves; an O(n·m) re-find inside it is a per-keystroke path. `resolveDocLinks(doc, links)` lives in
`src/lib/doc-link-anchor.ts` and is called at the one content-change choke point — synchronously in
the same handler right after `setContent`, so no paint lands between the content change and the
position fix. Per surface: the read column re-resolves after each content push; the write column
**maps positions through each transaction in `apply`** (bias −1 on `from`, +1 on `to`, as
`PendingAnnotation` does) and re-resolves only on a debounce after typing stops, or when links
change. Highlights then stay correct while typing without paying the scan per keystroke — and those
mapped positions are the ones §14d persists.

**`buildSegments` is extracted, not copied.** New `src/lib/decoration-segments.ts`, generic over
`{ id, from, to, color }`, returning segments carrying every covering range's id. The CLAUDE.md
gotcha it exists for — ProseMirror silently drops one decoration's `data-*` attributes where inline
decorations overlap — is a property of ProseMirror, not of quote threads; a second copy guarantees a
third. `quote-highlight-extension.ts` calls the extracted function directly (its one call site reads
`segment.ids` where the local version said `segment.threadIds`; no adapter was needed), and because
`e2e/quote-anchoring.spec.ts` covers that file, the extraction is a **pure refactor in its own
phase**, green before any doc-link code exists.

Per segment: `class: "doc-link-highlight"`, plus `"doc-link-active"` when any covering link belongs
to `activeGroupId`; `data-doc-link-ids` and `data-doc-link-group-ids`, both space-separated and
`~=`-selectable exactly as `data-thread-ids` is; and `style: "--doc-link-color:<hex>"` when the
covering links agree on a color, omitted when they disagree so the neutral gray in
`prose.module.css` takes over — the same rule, and the same one-background-per-span reason, as
`quote-highlight`. `data-doc-link-group-ids` is what lets a pulse target a whole group in one
`querySelectorAll` across *both* columns, the one place this page's shared document scope helps.

**Color cascade**, resolved in React and delivered inline on the decoration spec:
`link.overrideColor ?? group.overrideColor ?? <the link author's own color>`. The author color does
*not* come from `useAuthorColors` (`CollabEditorBody`'s client-side `/api/users/colors` fetch) —
`getDocLinkGroupsForPair` already joins `user.color` per link, so it arrives with the first paint and
needs no second round trip. `cascadeDocLinkColor` (`src/lib/doc-link-colors.ts`) is the one place the
rule lives, called from `SideBySideView` on every recompute.
`AnnotationColorStyles.tsx`'s injected `<style>` tag exists because a *mark*'s `renderHTML` cannot
take a computed color; a decoration spec can, so no `<style>` tag is needed here. `SAFE_COLOR` moves
out of `AnnotationColorStyles.tsx` into a shared `src/lib/safe-css.ts` and validates on write in the
server action as well as on read.

**Expressing "no override" needs a control of its own.** A native `<input type="color">` has no empty
state — it always reports some hex — so both surfaces that edit an override (the group panel, §14h,
and the link popover, §14i) pair the swatch with a checkbox to its left, tooltip `Override color`:
checked exactly when the stored value is non-null, unchecking writes `null` without disturbing the
swatch, and picking a color checks it. Keeping the swatch's value through an uncheck is what makes the
box a real toggle — you can drop to the inherited color and back to your chosen one without
re-picking it. Unchecked, the swatch renders `grayscale(1) opacity(0.5)` with a dashed outline so "not
currently applied" is visible rather than inferred; it stays clickable, since clicking it is how you
re-check.

**Color edits repaint before they persist.** Both surfaces fire an `onColorPreview` callback on every
checkbox/swatch change, updating `SideBySideView`'s group/link state — and therefore the cascade and
both columns' decorations — synchronously, while persistence stays exactly as specified (the panel's
debounce, the popover's Save). A `type="color"` swatch fires continuously as it is dragged: saving per
change would be a write per pixel, and not previewing would make picking a color feel like guessing.

**Darken and pulse are CSS only**, mirroring `prose.module.css`'s existing shape: base at 25% tint
of `--doc-link-color`, `.doc-link-active` at 45%, and `.doc-link-active.pulse` running a
`docLinkPulse` keyframe twice over 0.6s. The trigger is `QuoteThreadHeader.jumpToQuote`'s pattern
verbatim — `querySelectorAll('[data-doc-link-group-ids~="G"]')`, `scrollIntoView` the first match in
each column, add `"pulse"`, remove after 1200ms. One-shot on selection; the darkening persists while
the group is selected.

**The plugin's click callback must not be baked in.** `QuoteHighlight` captures
`onIndicatorClick` at construction, which doc links cannot do because the handler needs the
*current* `activeGroupId`. Configure once with `onHit: (hits, pos) => onHitRef.current(hits, pos)`
where `onHitRef` is a ref refreshed every render: stable at construction, always current. This is
the same stale-closure shape `AnnotationBody`'s co-authoring gate solves with a ref.

### 14f. Two docs, one page

**The flex-height chain.** `body` is `height:100dvh; display:flex; flex-direction:column` and
`SiteHeader` is its first child, so `<main>` gets a definite remaining budget only as body's direct
child — the `min-height`-defeats-grow/shrink gotcha in CLAUDE.md. Therefore `main.container` is
`flex:1 1 auto; min-height:0; display:flex; flex-direction:column`, and does **not** copy
`/doc/[slug]/page.module.css`'s `width:800px; margin:4rem auto`. The header row and group bar are
`flex:0 0 auto`; `.columns` is `flex:1 1 auto; min-height:0; display:grid;
grid-template-columns:1fr 1fr; gap:1rem`; each column is `display:flex; flex-direction:column;
min-height:0; min-width:0`; each column's body scroller is `flex:1 1 auto; overflow-y:auto;
min-height:0; position:relative`.

Two of those are load-bearing and easy to omit. **`min-width:0`** on a grid item, because grid items
default to `min-width:auto`, long unbreakable content blows out the `1fr`, and `body`'s
`overflow-x:hidden` then silently clips the evidence instead of showing the bug.
**`position:relative` on the scroller**, because both popovers compute `top`/`left` as
`coordsAtPos(...)` minus the container rect — if that rect is not the scroller, the popover drifts as
the column scrolls. `LiveDocBody` already wraps itself in `position:relative`, so that wrapper stays
*inside* the scroller. `PostEditor.module.css`'s `.editorContent { min-height:300px }` fights a short
viewport — *not actually overridden as built (§14o); the write column inherits the 300px floor, which
only shows up as an unwanted scroll on a very short viewport.*

**Singletons.** `DocPresenceProvider` gets one instance **per column**, as siblings — it is a React
context, so two nest fine; the bug is one instance with two writers. `LiveDocBody` calls
`useDocPresence()` unconditionally and throws outside a provider, so per-column is both cheaper and
safer than loosening that contract, and it leaves the channel correct by construction if annotations
ever do come here. `AnnotationMoveProvider`, `AnnotationSection`, and `AnnotationPopover` are all
omitted: "move to bottom" needs a bottom composer that does not exist here, and the selection
gesture belongs to doc-link creation. That last one is a real change to `LiveDocBody`, which today
*always* renders `AnnotationPopover` on selection — it gains a prop selecting which selection UI to
use. `DocScrubBar` is omitted; it is a `position:fixed` full-width bar and two of them would overlap
with nothing saying which doc each scrubs. `pseudo-border.ts` and `AnnotationList`'s global
`hashchange` listener are never reached, since no annotation tree mounts.

**Annotation highlights are suppressed visually, never schematically.** The `annotation` mark stays
in the write column's extension list. Dropping it would strip every existing annotation anchor out
of the shared ydoc the instant anyone typed — the wrong-schema-variant trap in
`src/lib/tiptap-schema.ts`, with a destructive edge. Suppression is one rule in
`prose.module.css`: `.prose.noAnnotations :global(.annotation-highlight)` resetting background and
cursor, at specificity (0,3,0) so it beats the existing (0,2,0) rule regardless of source order.

**`aria-label`s must be disambiguated.** `e2e/fixtures.ts`'s `bodyEditor()` is
`getByRole("textbox", { name: "Post body" })`, a strict-mode locator that fails on two matches, and
this page can mount four editors. `LiveDocBody`, `CollabEditorBody`, and `CollabTitleField` gain an
optional `ariaLabel` prop **defaulting to today's values**, set here to "Left doc body" / "Right doc
body" / "Left doc title" / "Right doc title", plus `data-side="left"|"right"` on each column for
scoping new specs. Every existing spec stays green because none visits this page.

**Viewport.** Two comfortable columns want roughly 1700px. `1fr 1fr` with `min-width:320px` per
column, and a `@media (max-width:900px)` that stacks to one column — at which point "side by side"
degrades to "stacked", which still works for links but loses the point. A draggable splitter is out
of scope; saying so beats leaving it implied.

### 14g. Read and write per column

**One `Y.Doc` and one provider per column, reused across both modes.** The read surface needs a
`Y.Doc` plus a provider and listens on `ydoc.on("update")`; the write surface needs the same
`Y.Doc` bound through `Collaboration`/`CollaborationCaret` on the same provider. So ownership moves
out of `LiveDocBody` up into a per-column `DocColumn` that owns `ydoc`, `provider`, and —
conditionally — `attachIndexeddb`. Toggling mode then unmounts and mounts only the TipTap editors,
never the websocket; leaving the provider inside `LiveDocBody` would tear down a socket and re-mint
a token on every toggle.

`/doc/[slug]` stays byte-identical: `LiveDocBody` gains optional `ydoc?`/`provider?` props, and when
they are absent it creates and destroys its own exactly as today.

**That hoisting exposes one real bug that must be fixed with it.** `LiveDocBody` registers
`ydoc.on("update", …)` and relies on its own `ydoc.destroy()` to remove it. In hoisted mode it does
not own the doc's lifetime, so a read → write → read cycle leaks a listener that calls `setContent`
on a destroyed editor. The hoisted path must `ydoc.off("update", handler)` explicitly. Today's code
is correct only because it owns the doc.

**Token flow.** `DocColumn` fetches `/api/doc/[id]/token` once and keeps `token` as a *function*, so
reconnects re-mint against the two-minute expiry. The response's `readOnly` decides whether the
write toggle is offered at all. The route computes `readOnly` from the session and offers no way to
*request* a read-only token for a doc you can edit — that stays as it is; the read surface is
`editable:false` with no `Collaboration` binding, so it cannot write regardless of the token's
rights. `attachIndexeddb` runs only for a column actually in write mode.

**The title row.** In write mode the title sits in a `display:flex; gap:8px; align-items:flex-start`
row with a **"Doc Links"** button to its right; the button switches that column to read mode, which
is where links are created. `.titleInput` becomes `flex:1 1 auto; min-width:0` and keeps
`position:relative` (its `::before` placeholder depends on it); the button is `flex:0 0 auto`. The
width is *not* computed from the button in JS — that is the `PostsTable` `contentRect`-versus-
`getBoundingClientRect()` trap, and flex avoids the question. In read mode the same slot holds an
**"Edit"** button (shown only when the token says writable), so the two modes are symmetric and the
title's width math is identical. Read mode's title is additionally a link out to
`/doc/<id>/edit` when the viewer can edit and `/doc/<id>` otherwise — `DocView`'s existing rule plus
an else branch.

### 14h. The group bar

A single strip above the columns, horizontally centered, `flex:0 0 auto`.

**The dropdown.** First entry is `Doc Link Groups` while nothing is selected and becomes
`Hide all Groups` once something is; selecting it deselects and hides every group's highlights. Then
one entry per group having at least one link to either doc, showing its name, prefixed `← ` for
links only to the left doc, `→ ` for only the right, `↔ ` for both. Last entry is
`New Group`. Selecting a group opens a collapsible panel below the bar, in flow rather than
overlaid, with editable `name`, `text`, and `override_color`, a `Display?` checkbox, and a delete
button. (The count line lives in the bar, not this panel — see below.) The panel is **keyed on the
group's id**, so switching the dropdown remounts it: its field state is seeded from props once, and a
reused instance would keep showing the previous group's name.

**Default visibility is every group shown.** This is forced by the spec's own click-disambiguation
case: "if no group is selected, present a choice of which one" is only reachable if highlights are
visible with nothing selected. `Display?` is a per-group opt-out held in page state keyed by group
id, not persisted, defaulting to on; selecting a group *darkens* rather than isolates. Note that
`Hide all Groups` and "uncheck every `Display?`" reach the same paint by different states, and only
the first also clears `activeGroupId`. **Selecting a group also clears its own `Display?` opt-out.**
Opening a panel and darkening a group in the bar while its segments stay hidden reads as broken rather
than as "you already hid this."

**`Show one Group at a time`**, beside `Show only my Links`, restricts both columns' highlights to
whichever group is active rather than darkening it among the rest; with no group active it has no
effect (there is nothing yet to restrict to). Switching the dropdown — including via a doc link click,
§14j — swaps which single group is shown, same as `Display?`'s per-group state does when this is off.
A plain `docLinksFor` filter, not a second copy of `hiddenGroupIds`: no state to keep in sync, since it
reads `activeGroupId` directly.

**The count line, `← N  M → (+Y)`** — N links in the left doc, M in the right, Y in any other doc.
*As built it sits in the bar itself, beside the dropdown, and sums across every group on the page
rather than describing only the selected one — see §14o.* Two queries: one `findMany` over links whose
`docId` is either of the two (with their groups), which
also produces the dropdown's membership and its arrow prefixes; and one over all links belonging to
those group ids, selecting `{ id, docId, docLinkGroupId }`, bucketed in JS. Counts are non-deleted
rows and include unanchored links — they describe the group, not the paint — and are unaffected by
"Show only my Links", which filters the dropdown and the highlights only. `(+Y)` deliberately
does not name those other docs or link to them: the viewer may not be able to read them, and a bare
integer leaks nothing a link count doesn't.

**Saving.** One `DEBOUNCE_MS` constant, flushed on blur and on unmount — without the flush,
navigating away loses the last edit, which is the same class of race `postAnnotation`'s bounded
retry loop exists for. A saving/saved indicator, and a stated last-write-wins rule when two people
edit one group's name, which follows from §14a's no-live-propagation. `updated_at` is `@updatedAt`.

**Deleting a group soft-deletes its links** in one transaction, since `docLinkGroupId` is required
and an orphaned link has no meaning; restore restores both *(the delete half is built; there is no
restore UI or action for either a group or a link — see §14o)*. Deleting the last link does *not* delete
its group — an empty group is a legitimate work-in-progress. Soft-deleting a `Doc` leaves its links
alone, matching how a deleted doc already leaves its annotations alone.

### 14i. Creating a link

Selecting text in a read-mode column opens `DocLinkPopover`, anchored on `coordsAtPos(selection.to)`
and offset **0.5em right and 0.5em down** from it. It carries optional `text`, an override color
(§14e's checkbox-plus-swatch pair, which subsumes a separate Clear button), a Save button, Cancel when
new, and Delete when editing an existing link.

**Placement is `position: fixed` and computed, not `absolute` and laid out.** A `position: absolute`
popover is clipped by its nearest scrolling ancestor, which here is the column's own `.scroller` —
and because CSS cannot leave one axis visible while clipping the other, its `overflow-y: auto` clips
horizontally too, cutting the popover off at the column boundary instead of letting it spill over the
neighbouring column the way a floating popover should. `fixed` escapes the clip, at the price of
having to keep the popover in bounds by hand, since a fixed element has no containing block to be laid
out against. `placePopover` (`src/lib/popover-placement.ts`) is that arithmetic, in one pure function
rather than at each of `LiveDocBody`'s three measurement sites, and the 0.5em offset above is its
`POPOVER_GAP` — *not* a CSS `transform`, which would both double-count the gap and shift the painted
box out from under the very `left` the clamp just computed.

**Three ways it can run out of room, two different answers.** The bounds are the nearest
`[data-popover-bounds]` ancestor — on this page the two-column grid, so a popover never strays outside
the pair it belongs to — intersected with the viewport, falling back to the viewport alone where
nothing is marked (`/doc/[slug]`).

- **No width** → *slide* left until the right edge is inside bounds. Not a flip to the anchor's other
  side: the popover is a large fraction of a column's width (260px of ~630px), so a flip overshoots
  the left edge about as readily as the preferred position overshoots the right one. Sliding can never
  cover the anchor, because the anchor is a point on a line while the popover sits above or below that
  whole line.
- **No height** → *flip* above the anchor. The opposite answer for the opposite reason: sliding up
  would drag the popover over the very text it is describing, while flipping keeps that text visible.
- **Neither** → both, with no special case of its own. The axes are independent, and because one
  resolves by sliding and the other by flipping, neither can undo the other.

Each axis then gets a two-sided clamp. Flipping only helps when the *anchor* is inside bounds; an
anchor scrolled out of view is arbitrarily far outside them and every candidate position inherits
that, so without the clamp a popover left open while its column scrolls away lands thousands of pixels
off-screen instead of pinned to the edge it left through.

**The position is derived, never frozen.** State holds the anchor's *document* position; one
`useLayoutEffect` recomputes `coordsAtPos` plus the popover's measured size on open, on `activeGroupId`
change, and on scroll (capture phase — a column's inner scroller emits no bubbling scroll event) and
resize. Storing coordinates instead invites the whole family of bugs where the anchor moves out from
under a placement taken before some reflow: opening the group panel is one such reflow, and it is
`fixed`'s equivalent of the free re-layout `absolute` used to get. The ordering this implies is worth
naming: the popover has to be in the DOM before its size can be read, so it renders once at the
unclamped preferred spot and is corrected within the same layout pass — never painted there.
`AnnotationPopover` shares the same `pending` state and is therefore on the same convention; when it
briefly was not, annotations on `/doc/[slug]` silently mispositioned while every test still passed.

**Group association.** If a group is selected in the dropdown, the popover says so and the link
joins it. If none is selected, it says a new group will be created, and on save the group and the
link are created in one transaction, the new group becomes `activeGroupId`, and its panel opens.

**A group row is not written until there is something to put in it.** The dropdown's
`New Group` opens an *unsaved* panel; the row lands on the first debounced save of
name/text/color, or when the first link is saved into it. Creating it eagerly is worse than it
looks: the dropdown's own membership rule is "groups with a link to either doc", so an eagerly
created empty group would be **invisible in the very list that created it**, and abandoning the
panel would orphan it permanently. This is the same reasoning `AnnotationPopover` applies when it
refuses to create a draft from a selection alone (§13's two-stage composer), reached from a
different direction.

The first Save creates the row; subsequent edits debounce-save, as specified. Creating a link
requires only `canUserReadDoc` on that column's doc — a doc link never mutates the document, so the
annotation rule applies. Editing or deleting a group is owner-or-admin, matching
`requireOwnOrAdmin`.

### 14j. Clicking a marked range

Through the plugin's `props.handleClick(view, pos, event)`, not a React `onClick` on the container:
it hands over `pos`, runs before selection handling, and the decoration spans are ProseMirror-managed
DOM that React does not own. Routing is over **resolved plugin-state positions, never DOM `data-`
attributes**, so the logic and the paint cannot disagree and the same code serves both surfaces.
(There is no precedent to copy: `.annotation-highlight` has `cursor:pointer` in `prose.module.css`
and no click handler anywhere in the repo.)

With `hits = links.filter(l => pos >= l.from && pos < l.to)` — no `anchored` check, because an
unanchored link never enters the plugin's `links` in the first place (`syncDocLinks` drops it before
the push, so the plugin only ever holds ranges with real positions):

- none → return `false`; this is also the drag-select-to-create path
- one → open that link's popover
- several, `activeGroupId` set, exactly one hit in it → open that one
- several, `activeGroupId` set, several hits in it → chooser filtered to that group
- several, no `activeGroupId` → chooser over all hits

**Opening a link's popover — directly, or via the chooser — also makes its group the active one**,
the same effect as picking it from the bar's dropdown (including un-hiding it, §14h). A click is
therefore also a navigation: it answers "which group is this" without a separate lookup, and composes
with `Show one Group at a time` to let clicking through a document step from one group's links to the
next.

The chooser shows each candidate's selected text, elided in the middle when long — first 50
characters, `…`, last 50 — which is this section's reading of "max 50 chars either side". (The
competing reading is 50 characters of *surrounding context* on each side, which tells two nearby
links apart better; §14n keeps it open, and the two are a one-line swap in `contextAround`.)

**`handleClick` must not swallow caret placement in write mode.** A click inside a highlight is also
a click into an editor, and returning `true` eats it. Read mode returns `true`; write mode opens the
popover and returns `false`, taking the side effect without stealing the caret. `handleClick` only
fires when mousedown and mouseup land together, so a drag-select ending inside an existing highlight
correctly does not trigger it.

**The edit popover is keyed on the link's id**, for the same reason §14h's panel is keyed on the
group's: clicking a second highlight while the first link's popover is open re-renders the same
component, and its note/override state — seeded from props once — would otherwise stay on the first
link while only the quoted-text preview updated.

### 14k. Getting there

A **"Link to…"** control on `/doc/[slug]`, near the byline, listing other docs the viewer can
read and navigating to `/side-by-side/<thisDoc>/<thatDoc>`. Chosen over a two-checkbox control on
`/docs` because `/docs` is gated on `canManageDocs`, and an `AUTHORIZED` reader — the role §12e
exists for — never sees it.

Backed by a new `readableDocsFor(userId, role)` in `src/lib/doc-authz.ts`, placed directly beside
`canUserReadDoc` with a comment tying the two together: it is the same predicate expressed as a
`where` clause instead of per-row, and the only thing keeping them honest is proximity plus that
comment. ADMIN/EDITOR get every non-deleted doc; everyone else gets `SHARED` plus their own
byline-authored `PRIVATE` docs.

### 14l. Build order

Each phase leaves the app working, gated on `npx tsc --noEmit`, `npx eslint .`, and `npm run e2e`.

- **Phase 0** — pure refactors, nothing user-visible: extract `buildSegments` into
  `decoration-segments.ts` and `SAFE_COLOR` into `safe-css.ts`; re-key `attachIndexeddb`'s ref-count
  on the IndexedDB database name; add the optional `ariaLabel` props with unchanged defaults. Gate is
  `quote-anchoring.spec.ts` and `doc.spec.ts` passing untouched. First, so the risky shared-code edit
  is isolated from the feature that motivated it.
- **Phase 1** — schema, migration (including the hand-added CHECK), `doc-link-anchor.ts`,
  `doc-links-query.ts`. No UI. **Restart `next dev` after migrating** — CLAUDE.md's new-model trap
  presents as `prisma.docLink is undefined` while typecheck passes.
- **Phase 2** — the page shell: route, `RESERVED_SLUGS`, `left === right` rejection, both columns
  read-only, the flex chain, independent scrolling, per-column `DocPresenceProvider`, annotation
  suppression, disambiguated `aria-label`s. Gate: a spec measuring both columns' bounding boxes
  in-process (CLAUDE.md prefers that to driving the pane) and asserting `x/x` 404s.
- **Phase 3** — the per-column read/write toggle: provider hoisting, `LiveDocBody`'s
  optional-provider mode *with* the `ydoc.off` fix, the toggle gated on the token's `readOnly`, the
  title row and its button. Gate: a spec on `collab.spec.ts`'s two-context pattern — toggle to write,
  type, assert the other identity sees it, toggle back, assert no duplication and no stale listener.
- **Phase 4** — decorations on the read path: `doc-link-extension.ts`, the CSS, links seeded straight
  from a fixture. Gate: highlights render; two overlapping links produce one segment with a plural
  `data-doc-link-ids`; a highlight survives a remote edit and re-finds after a shift.
- **Phase 5** — creation: the selection popover, server actions in `src/app/actions/doc-links.ts`,
  debounced save, create-group-on-first-link. Gate: create a link on each side through the UI and
  assert both rows plus `← 1  1 →`.
- **Phase 6** — the group bar in full: dropdown with its prefixes and its first-entry swap, the panel,
  `Display?`, active darkening and pulse, "Show only my Links", delete-with-cascade.
- **Phase 7** — click routing: `handleClick`, the single and multi cases, the chooser, and the
  read-versus-write return value.
- **Phase 8** — the "Link to…" entry point, `e2e/side-by-side.spec.ts` (plus `db-worker.ts`
  helpers *and* their `handlers` entries, a `fixtures.ts` fixture, and a `sweepTestData` branch), and
  the doc updates: this section's "As built", CLAUDE.md's new gotchas (the `%2B` param encoding and
  the `attachIndexeddb`-per-database-name re-key), STYLE.md if the group bar introduces conventions.

Write-path phases 4 and 6 also want `scripts/test-doc-link.ts` (create/list/delete, contained to
groups and links owned by `@example.com` accounts, following `scripts/test-doc.ts`'s header-is-the-
documentation shape).

### 14m. Deferred, with reasons

- **The inline-mark path (`mark_id`).** Shipped as a constrained column with no writer, because the
  CHECK constraint makes the intent enforceable now and the migration to it per-row later.
- **Live propagation of links between users** (§14a). Needs either a `doc_link:` ydoc or polling;
  both are larger than this section and neither is needed to make the feature useful to one person
  at a time.
- **Generalizing `findQuoteOccurrences` across block boundaries** (§14d). A shared change that would
  improve annotations too, so it deserves its own pass rather than riding in here.
- **Doc links on the ordinary `/doc/[slug]` page.** They do not show there in this section, which
  means a link created side-by-side is invisible in the single-doc view. Stated rather than implied.
- **A draggable column splitter, a swap-sides control, and group permalinks.**

### 14n. Open questions

- **Soft delete as `deleted_at` alone** (§14b) is the one knowing divergence from house convention.
  The counter-argument for adding `deleted_by_user_id` is consistency with every other soft-deletable
  model plus knowing who deleted a row in a group several users contributed to; the argument against
  is that it buys a named-`@relation` requirement for information no UI would show.
- **"Max 50 chars either side"** (§14j) — the selection elided in the middle, as built, versus 50
  characters of surrounding context on each side.
- **Forbidding the whole page when either doc is unreadable** (§14c), versus rendering the readable
  column beside a placeholder so a pair URL shared between people with different access degrades
  instead of hard-failing.
- **Whether a group's `name`/`text` should be visible to someone who can read only one of its docs.**
  Moot while §14c forbids the mixed case, and live the moment that changes: those fields are
  user-entered and will quote content, so a group's text can leak what the other doc contains.
- **Whether `override_color` on a shared group should be editable by anyone with a link in it**, or
  only its creator (as built) — one user recoloring another's link is the case at issue.

### 14o. As built

Built 2026-07-29, in the order §14l lays out (Phase 0 → 8), each phase gated on `npx tsc
--noEmit`, `npx eslint .`, and the full `npm run e2e` suite before moving to the next.

**Reconciled against the implementation afterward**, which is why several subsections above now carry
inline *(not built)* / *(as built)* notes. Those notes are the authority on what exists; the prose
around them is kept as the record of what was decided and why, since a design rationale is worth more
than a description of code that can be read directly. The unbuilt pieces are listed together below so
nothing is only discoverable by reading all of §14a–§14k.

Three deliberate deviations from the text above:

- **Write-column highlighting was never built.** §14e's decoration layer, §14j's click routing,
  and the `editable` option on `DocLink.configure(...)` are all written to support a highlighted
  write surface — but `CollabEditorBody` never gained the `DocLink` extension, so a write column
  shows no doc-link highlights at all and §14j's "write mode returns `false`" branch is
  unreachable in this build. Out of Phase 4's stated "read path" scope, and no later phase
  explicitly picked it up; noted here rather than silently expanded into. The plugin itself needs
  no change to support it later — only wiring `DocLink.configure({ onHit, editable: true })` into
  `CollabEditorBody`'s extension list and pushing resolved links into it the way the write
  column's `apply()` position-mapping already anticipates.
- **`DocLinkPopover`'s Cancel button shows in both create and edit mode**, not just "when new" as
  §14i's composer description reads. Edit mode's only other way to dismiss without saving was the
  outside-click handler; keeping Cancel visible there too is a usability call, not an oversight.
- **The entry point is a `<select>`** (`CompareWithPicker.tsx`), not the bare "control... listing
  other docs" §14k leaves unspecified in shape. Chosen over a list of links because
  `readableDocsFor` can return every doc a reader has access to, and a picker degrades better
  than a wall of links at that size; renders nothing when the list is empty rather than an
  always-visible disabled control.

Designed above but **not built**, each marked in place and collected here:

- **Write-mode persistence of corrected offsets** (§14d). Follows directly from the write column
  never being highlighted: there is no write surface to persist from, and `updateDocLink` accepts
  only `text`/`overrideColor` — never `mark`. Every column resolves in memory on every content
  change and throws the result away. Drift therefore never heals; it is merely re-derived, correctly,
  on each load. Cheap to add once the write column lands, and §14d's reasoning about *why only* the
  write column may persist still holds.
- **Unanchored links have no UI** (§14d). `DocLinkGroupPanel` edits the group's own
  name/text/override_color and lists no links, so a link whose anchor stopped resolving is invisible
  everywhere except its contribution to the count line. §14d's "stays visible in the group panel"
  needs the panel to list links first, which nothing in §14l's build order called for.
- **Restore for a soft-deleted group or link** (§14h's "restore restores both"). Both delete paths
  set `deletedAt`, and nothing ever clears it — there is no restore action and no UI to reach one.
  Note this interacts with §14b's `deleted_at`-alone divergence: with no `deleted_by_user_id`, a
  restore UI would also have no way to show who deleted the row it is offering to bring back.
- **`.editorContent`'s 300px floor is not overridden** (§14f). The write column inherits
  `PostEditor.module.css`'s `min-height:300px`, which on a very short viewport produces the
  unnecessary scroll §14f predicted. One CSS rule in `DocColumn.module.css` whenever it bites.

One correction to §14i's own promise, fixed in code rather than documented around: "the row lands on
the first debounced save of name/text/color, **or when the first link is saved into it**". The second
path did not work — with the `NEW_GROUP` sentinel active, `createDocLink` correctly built a *fresh*
group (once the sentinel-leak bug below was fixed), but `appendLinkForDoc`'s
`if (!activeGroupId)` guard saw the truthy sentinel and declined to follow it, leaving the unsaved
draft panel open beside a group it had nothing to do with. `appendLinkForDoc` now treats
`isCreatingNew` as "nothing selected" for that guard, so the panel switches to the group that was
actually created.

Bugs worth recording, all of the kind that pass a first read and fail only under real interaction.
The first three surfaced in hand-testing the group bar *after* the phases were done, and were fixed
together; each was confirmed by reverting its fix and watching a new regression test fail with the
exact reported symptom.

- **The `NEW_GROUP` sentinel leaked into `createDocLink` as a real group id.** `SideBySideView`'s
  `activeGroupId` holds three kinds of value — a real id, `null`, or the `"__new__"` sentinel that
  tells the *bar* to render an unsaved draft panel — and passed the raw state to both `DocColumn`s,
  which forward it into `DocLinkPopover`'s `groupId` on save. Creating a link with "New Doc Link
  Group" selected therefore sent `groupId: "__new__"`, `createDocLink` found no such row and
  returned "Group not found", and since that path has no error display the Save button silently did
  nothing. Fixed with a derived `columnActiveGroupId` (null while `isCreatingNew`) for the columns
  only, which falls through to the popover's ordinary "no group selected" path.
- **`DocLinkGroupPanel` had no `key`,** so React reused one component instance across dropdown
  selections (same JSX position). Its `name`/`text`/`overrideColor` state initializes only once,
  from the `initial*` props, so switching groups left the panel showing the *previous* group's
  fields — the props changed, but `useState` initializers do not re-run. Fixed with
  `key={activeGroup?.id ?? "new"}`, forcing a remount per switch.
- **A blank group could never be saved.** Every field's autosave fires only from its own `onChange`,
  so opening "New Group" and typing nothing meant no debounce was ever scheduled and no row
  was ever written — even though `name`/`text`/`override_color` are all nullable and a group with
  none of them set is a legitimate row (§14b). Fixed with an explicit Save button, rendered only for
  an unsaved draft, calling the same `flush()` the debounce uses.
- **A stale-closure bug in `DocLinkGroupPanel`'s debounced save** — reading `name`/`text`/
  `overrideColor` directly from React state inside the `setTimeout` callback saved whatever they
  were *before* the keystroke that scheduled the save, not the just-typed value, because the
  callback's closure was created (and its `flush` reference captured) synchronously within the
  same `onChange` handler that called `setState`, one render before the state update took effect.
  Silent for an *edit* (a debounced save still writes the old value, which happens to already be
  correct at the very first keystroke of a session) and only surfaced testing "New Doc Link
  Group," where the first save's `name` field was empty regardless of what was typed. Fixed with
  a parallel `useRef`, updated synchronously in each `onChange` alongside the `setState` call, that
  `flush()` reads from instead of the state closure.
- **Soft-deleting a `DocLinkGroup` through the UI still blocks e2e user teardown on the FK.**
  §14b's `deleted_at`-alone soft delete (deliberately, unlike every other soft-deletable model's
  `deleted_by_user_id` pair) means a "deleted" group's row — and its `user_id` FK — never
  actually goes away. `e2e/db-worker.ts`'s `deleteTestUser` now hard-deletes a test user's own
  `doc_link`/`doc_link_group` rows before deleting the user, the same shape its existing
  annotation/ydoc cleanup already has for a different FK.

Smaller implementation notes:

- **`doc-links-query.ts`'s `buildDocLinkInputs` was written in Phase 4 and deleted in Phase 7** —
  Phase 6 moved per-column link derivation (including the color cascade) into `SideBySideView`
  itself, since the group bar and both columns need to agree on one filtered/colored set; the
  server-side helper doing the same computation became dead code once nothing called it.
  `cascadeDocLinkColor` (`src/lib/doc-link-colors.ts`) is what both the removed server helper and
  the client computation shared, so the cascade rule itself never forked.
- **The `(+Y)` other-docs count is computed once, server-side, at page load** — like every other
  cross-session doc-link state (§14a), it does not update if a link to a third doc is added by
  someone else mid-session. Consistent with the rest of this section's no-live-propagation stance,
  not a separate gap.
- **`readableDocsFor` (§14k) lives beside `canUserReadDoc`, expressing the same predicate as a
  `where` clause instead of a per-row check** — ADMIN/EDITOR get every non-deleted doc in one
  branch; everyone else gets an `OR` array built from `canViewDocs`/`canManageDocs`, empty (and
  therefore an empty result, not an error) for a role that satisfies neither.

### 14p. Splitting the reading surface

The read column arrived by reusing `LiveDocBody`, `/doc/[slug]`'s reading view, and teaching it a
`selectionUi` flag. That was the wrong reuse boundary, and the size of the change said so: on the
branch that built §14, `CollabEditorBody` — reused *unchanged* by the write column — grew by 19
lines, while `LiveDocBody` grew by 433, from 297 lines and 5 props to 687 and 17. Both are reuse.
The difference is that the write column wanted the same thing the editor already did, and the read
column wanted a variation of what the reading view already did.

**Reuse is right where the second consumer wants the same behavior, and wrong where it wants a
variation** — which is the rule §12o had already applied in the other direction, forking
`AnnotatableArticle` rather than branching it on `target.kind` "touching a component that renders on
every published post". Branching `LiveDocBody` on `selectionUi` was the same move §12o declined,
made without noticing it was the same move.

The cost was not hypothetical. `pending` fed both `AnnotationPopover` and `DocLinkPopover`, so
switching the doc-link popover to `position: fixed` silently mispositioned annotations on
`/doc/[slug]` by the scroll offset, with every test still green (§14o's own bug log records it).
That is what a shared state field across two surfaces buys: a change to one is a change to both,
including the changes nobody intended.

**What is shared now is the part that is genuinely identical, and nothing else:**

- `useLiveDocContent` (`src/lib/use-live-doc-content.ts`) — the live tap. The Hocuspocus connection,
  `setContent` on every remote update, `ready`/`synced`/`error`, and §14g's owned-versus-hoisted
  lifecycle with the different teardown each needs. This is the subtlest code either surface runs
  and the one part worth never writing twice.
- `useSelectionPopover` (`src/lib/use-selection-popover.ts`) — the selection gesture: the pending
  range, its decoration, the §13f re-resolution after a content push, and §14i's placement. Selection
  and placement are one hook rather than two because they are mutually dependent — placement needs
  the anchor the selection provides, and capturing a selection must seed a provisional placement in
  the same React batch so a popover never renders without a position. Splitting them yields a cycle,
  not a layering.

`DocReadingBody` and `SideBySideDocBody` are then siblings over those, each naming exactly one
surface's behavior. `selectionUi`, `suppressAnnotations`, and the optional `ydoc`/`provider` pair all
disappear: the reading view always annotates and always owns its connection, the side-by-side column
always links and always borrows one, and neither carries a flag saying which it is. §14g's "always
supplied together; never toggled on one instance" stops being a comment and becomes the type.

**One structural detail worth naming, because it is the thing that makes the split work.** Both hooks
need the editor ref, and if either created it the other would need a forward reference to state that
does not exist yet — the shape React's `react-hooks/refs` rule correctly rejects. The caller declares
`editorRef` and passes it to both; `useLiveDocContent` populates it. Neither hook depends on the
other, and the callbacks each surface hands the content hook (`capture`, `reresolve`, `syncDocLinks`)
are ordinary values by the time they are passed.

Not changed, deliberately: `AnnotatableArticle` stays the post-side sibling it has been since §12o.
Three surfaces now copy the same *interaction* shape while sharing only what is literally the same
code, which is the arrangement §12o was reaching for and this section finishes.

## 15. Posts become snapshots of docs

Posts and docs have been two independently-editable document stacks solving the same problem
twice — a post edited through `PostEditor` against `post_collab`/`post_collab_update`, saved into
an immutable `revision`, published by pointing `post.publish_revision_id` at one; a doc (§12)
edited through `DocEditor` against the ydoc stack, read live, never checkpointed. §11 called the
ydoc stack a parallel stack meant to be proved on `/ydoc-debug` and then cut over to. This is that
cutover.

**Decided:** a post stops being an independently-edited document and becomes an immutable snapshot
of a doc at a chosen point in that doc's ydoc history, carrying its own `prose_json` and `title`.
`revision`, `post_collab`, and `post_collab_update` are dropped; the post-side half of
`server/collab.ts` is dropped; one editing stack remains. `/posts/[id]/edit` no longer edits — it
publishes. It shows the publish/schedule/unpublish controls, a read-only view of the doc at a
selected history point, and a scrub bar over that doc's `ydoc_update` log. Publishing pins the
selected point as a `ydoc_snapshot` (reusing one if the point is already snapshotted) and copies its
content onto the post. Re-publishing from an earlier point is what "restore a revision" used to
mean; re-publishing from a different doc entirely is now expressible, since a post's `doc_id` is
just the doc it currently draws from, not a fixed parent.

No existing post data was migrated across this change — see §15h.

### 15a. Schema

`Post` drops `publishRevisionId` and its `revisions`/`collab`/`collabUpdates` relations. It gains
`docId` (required — the doc currently backing it), `proseJson` (its own copy of the published
content, so every public read is a column instead of a join), and `publishEventId` (replacing
`publishRevisionId` as the draft/published discriminator). `title` stays its own column rather than
being derived, since a post's title may differ from its doc's title at snapshot time — it only
*defaults* to it. `doc` is a required relation with the default `onDelete: Restrict`: a doc that
still backs a post can't be hard-deleted out from under it.

`PostPublicationEvent` — previously write-only, with no reader anywhere in the app — becomes the
immutable per-version record `Revision` used to be. It gains `docId`, `ydocSnapshotId`, `title`, and
`proseJson`, all nullable: a PUBLISHED/SCHEDULED row carries the whole published version (which doc,
which snapshot pins that doc's state, and the title/content derived from it); UNPUBLISHED/
SCHEDULE_CANCELED rows carry none of the four, since they retire a version rather than introduce
one. `ydocSnapshot` is `SetNull`, not `Cascade` — the snapshot is provenance, and an event that
outlives its ydoc row still holds the content it published; losing the pointer costs only the
ability to re-derive, not the version itself.

`CommentThread.anchoredRevisionId` becomes `anchoredEventId`, referencing `PostPublicationEvent`.
§5's mechanism is unchanged in shape — `remapThreadsToRevision` becomes `remapThreadsToEvent`,
diffing `PostPublicationEvent.proseJson` pairs instead of `Revision.doc` pairs — filtered to events
with non-null `proseJson`, since UNPUBLISHED/SCHEDULE_CANCELED rows have none.

`PostAuthor` gains `createdUserId`/`createdAt`, recording who added a byline entry and when. A
post's authors start as a copy of its source doc's `doc_author` rows but are edited independently
from then on — a post author need not be a doc author, or vice versa. Deliberately no history is
kept beyond that: the simplification is the point, and a `post_author_history` table is the obvious
first addition if "who was on this byline in March" ever needs answering. Two relations to `User`
now exist on the same model, so both carry explicit relation names.

### 15b. Creating a snapshot at an arbitrary past point

The only existing snapshot path — `/ydoc-debug`'s Snapshot button → `POST /api/ydoc/[id]/snapshot`
→ `snapshotYdoc()` → `POST /admin/ydoc-snapshot` on the collab server → `handleYdocSnapshot` in
`server/ydoc-hooks.ts` — snapshots the *live* doc via `openDirectConnection`, which cannot rewind.
Publishing needs a snapshot at a chosen historical `ydoc_update.id`, so wherever it runs, it is a log
replay — the collab server's one unique asset (the live in-memory doc) is precisely the thing a
historical snapshot must not use.

**Decided:** replay in the Next process; leave the `/ydoc-debug` snapshot path untouched. This keeps
§11c's "only writer" rule intact — it's module-scoped, not process-scoped, and `src/app/actions/
docs.ts` already calls `ydocStore.createIfAbsent` directly from Next — while buying WYSIWYG: a
replay to `throughUpdateId` produces exactly the bytes the scrub bar rendered at that position,
where an `openDirectConnection` snapshot at head cannot make that guarantee (`onChange` →
`appendUpdate` is enqueued and un-awaited, so the live doc generally runs ahead of the log). It also
keeps a reachable collab server off the publish button's critical path.

`server/ydoc-store.ts` gains `maxUpdateId`, `findSnapshotAtMark`, and `loadReplaySlice` (newest
snapshot with `lastYdocUpdateId <= target`, then updates in `(mark, target]`) — the primitive
`resolveReplayBase` was declared for but never actually implemented (it keyed on `MIN(ydoc_update.id)`,
invariant 2's truncation question, not this one) and had no callers anywhere; it and
`ResolvedReplayBase` are deleted. `createSnapshot` now returns the new row's id. `src/lib/
ydoc-snapshot.ts` adds `materializeYdocAt`/`ensureYdocSnapshotAt` on top. Snapshot bytes become post
content through `postContentFromYdoc` (`src/lib/post-content.ts`), which strips both the
`authorHighlight` and `annotation` marks before handing off — a doc's ydoc decodes with
`docContentExtensions`, which has both, while every post-side consumer (`[slug]/page.tsx`,
`anchor-remap.ts`, `comment-data.ts`) uses plain `contentExtensions`/`pmSchema`; an unstripped mark
would 500 the public page.

One existing bug this promotes from latent to live: `handleYdocSnapshot` wrote a snapshot whose
bytes could run *ahead* of its own `last_ydoc_update_id` ("the error is in the safe direction" —
safe for truncation), but the replay-base resolution (`baseFor` in `YdocDebug.tsx`, and now
`loadReplaySlice`) treats a snapshot's bytes as exactly the state at its mark. Landing on such a
dot could render content from *after* the mark. Harmless while only `/ydoc-debug` created snapshots
and nothing asserted content at a dot; not harmless once a doc's own scrub bar (`DocScrubBar`,
already wired to `/api/doc/[id]/replay`) can land on a snapshot a publish created. Fixed as part of
this section: `handleYdocSnapshot` now replays to its own mark rather than encoding the live doc.

### 15c. The publish surface

`/posts/[id]/edit` (route unchanged) replaces `PostEditor` with `PostPublisher`: a plain title input
(defaulting to, and offering to reset to, the source doc's title), a line naming the source doc with
a link to `/doc/[slug]/edit` and a "Change doc…" picker, the publish/schedule/unpublish controls, a
line stating whether publishing will create a new snapshot or reuse an existing one, a read-only
render of the doc at the selected point, and a scrub bar pinned at the bottom.

The read-only view needs no TipTap editor instance — `useReplayScrub`'s `renderResult` already
carries a rendered `body`; this is `ReplayContent` (`YdocDebug.tsx`) minus the perf line and clients
table, rendered inside `.prose` per the `globals.css` reset. It uses `docContentExtensions`, since
it is showing *unpublished* doc content — author highlights and all.

The scrub bar is a new sibling, `PostSnapshotScrubBar`, not a variant grafted onto `DocScrubBar` —
§14p's rule again: the second consumer here wants dots, selection, and a will-create/will-reuse
line that `DocScrubBar` has no use for, and teaching it those would be the `LiveDocBody` mistake
repeated. Both sit on the same `useReplayScrub` hook. No new API was needed: `GET /api/doc/[id]/
replay` already ships every snapshot with its `lastYdocUpdateId`, gated on exactly the required
`canUserEditDoc` check.

### 15d. Publish semantics

`publishPostFromDoc`/`schedulePostFromDoc` take `{docId, title, throughUpdateId, snapshotId?}` and
require both `canUserEditPost` and `canUserEditDoc(docId)` — the second is new, and applies to
creation too. They resolve a snapshot at the chosen point (reusing one if `snapshotId` was given or
one already sits at that mark), derive `{proseJson, title}` from it, and in one transaction write a
`PostPublicationEvent` and update `Post{docId, title, proseJson, publishEventId, publishedAt}`. The
original go-live-date-preservation rule across an unpublish/republish cycle carries over unchanged.
`unpublishPost` is unchanged in shape. `derivePostStatus`/`publishedPostWhere` swap
`publishRevisionId` for `publishEventId`.

A post can be created from a doc two ways: a picker at `/posts/new` (replacing the old title-only
form) and a "Publish as blog post" button on `/doc/[slug]`, both landing on the same
`createPostFromDoc(docId)` action, gated on `canUserEditDoc` and seeding the post's authors from the
doc's `doc_author` rows.

### 15e. The collab server after posts leave it

`server/collab.ts` keeps only the ydoc-hooks dispatch. The `isYdocDocument` guard becomes an
outright rejection, but only in `onAuthenticate` — registering that hook is what makes Hocuspocus
require authentication on every connection, so it is the real chokepoint; a throw there is a clean
connection refusal, where a throw inside `onLoadDocument` would instead read as a document-creation
failure. The other three hooks call their ydoc versions unconditionally now that nothing else can
reach them. `src/lib/collab-token.ts`, `/api/collab-token`, `/admin/replace-doc`, and
`src/lib/collab-admin.ts` are deleted outright — their only callers (the post editor's token
fetch and `restoreRevision`) are gone. `src/lib/ydoc-names.ts` loses no exports; the `ydoc:` prefix's
job changes from "route away from the legacy post path" to just carving out the `ydoc:annotation:`
sub-namespace and the `ydoc:test-` containment guard, and its comments were rewritten to say so.

### 15f. Build order

Phase 0 (snapshot machinery) → Phase 1 (schema + migration) → Phase 2 (post creation from a doc,
transitional — new posts still opened the old editor for one phase) → Phase 3 (the cutover: new
publish actions and every public read surface switched to `Post.proseJson`/`Post.title` in the same
commit, since neither can move alone) → Phase 4 (teardown of the old post-editing UI; `/posts/[id]/
history` rebuilt as a publication-event list + word diff between consecutive published versions) →
Phase 5 (comments retargeted onto events) → Phase 6 (collab server teardown) → Phase 7 (this
section, plus CLAUDE.md/CACHING.md/e2e docs).

### 15g. As built

Deleted: `LiveHistoryViewer.tsx`, `/posts/[id]/live-history`, `/api/posts/[id]/collab-updates`,
`RestoreRevisionButton.tsx`, `PostEditBadge.tsx` and its four call sites, `PostEditor.tsx` (+ its
module CSS), `PostSettingsPanel`'s revisions table, `e2e/restore-revision.spec.ts`,
`e2e/collab.spec.ts` (after porting its two genuinely doc-side tests — body-edit propagation and the
title's independent Yjs fragment — into `e2e/doc.spec.ts`, which had no two-author *editing*
coverage before).

`src/lib/post-edit-status.ts`, referenced by name in CLAUDE.md/CACHING.md/earlier PLAN.md prose,
never existed as a file — the heuristic it named lived inline in `PostEditBadge.tsx`, which is one
of the things this section deletes. Those references were corrected rather than pointing at a
deletion.

### 15h. Known gaps

- `PostPublicationEvent` stores a denormalized `title`/`proseJson` rather than re-deriving from its
  `ydoc_snapshot` on demand. Deliberate: §5's remap diffs two versions on every publish, and decoding
  two Yjs blobs through the full extension stack per diff is a real, recurring cost against a table
  row that is written once and never touched again.
- "Post title defaults to the doc's" is enforced client-side (the title field tracks the scrubbed
  doc's title until the user edits it) rather than with a stored `titleOverridden` flag. Cheap, but
  "was this title deliberate?" isn't answerable from the database alone.
- `GET /api/doc/[id]/replay` base64s every snapshot blob in one response. That was inert while docs
  had zero snapshot rows (§12m); it stops being inert once a publish can create one per republish.
  No mitigation shipped yet — the fix, when the payload size actually bites, is to ship snapshot
  metadata for the scrub bar's dots and fetch a blob only on selection.
- No existing post data was carried across this change. The one pre-existing post (`test`, zero
  comments) was deleted rather than backfilled into a doc — there was nothing worth preserving, and
  a backfill script would have had to get byline order, the title fragment, and a synthetic
  publication event right for a single throwaway row.

## 16. Admin tables become one kit

Six surfaces render a table of rows an admin acts on: `/posts`, `/docs`, `/users`, `/comments`,
`/annotations`, and `/site-settings`. All of them ultimately need pagination, bulk operations,
standardized search/filter parameters visible in the URL, and — eventually — the ability to stage
changes locally when the connection is unreliable. This section builds that as one kit the six
share, rather than a seventh copy per surface.

### 16a. Why our own, and what "our own" means here

There were two generations of table already. `/comments` (§11) and `/annotations` (§12j) are
server-driven: filters, sort and pagination all live in the querystring, a `*-query.ts` module is
the single place that knows the querystring's shape, and the server page turns it into a Prisma
`where`/`orderBy`/`take`+`skip`. `/posts`, `/docs` and `/users` are the older generation: every row
is shipped to the browser and sorted/filtered there, with sort state in `useState` and the
show-deleted toggle in `sessionStorage`.

So the kit is an **extraction, not an invention** — the second generation already is the design,
and `/annotations` was built by copying `/comments`, which is the duplication this section stops
before a third copy. A survey of table libraries (headless and rendering both) found none that
supplies pagination, URL-serialized filters, bulk semantics and offline staging as a unit; each
supplies at most the part we already own, and the row-level customization these tables carry —
`UsersTable`'s six inline-edit cell types, `PostsTable`'s scheduled-countdown tooltip and
width-tracking search box — is exactly what a rendering grid makes awkward.

The kit is therefore **hooks plus small components, never a `<DataTable columns={...} />`**. Each
table keeps its own `<thead>`/`<tbody>` JSX and its own cells; what it stops owning is the
plumbing every table repeats. That boundary is the whole design: it is what keeps a cell an
ordinary React component that calls a server action.

`/site-settings` is deliberately out of scope. It is a form wearing table markup — a fixed pair of
settings plus a read-only config list — with no rows to page, select, or sort. It takes the
row-status border (§16f) and nothing else.

### 16b. Rows per page: a stored default, a temporary override

Page size is `10/25/50/100` everywhere. The chosen value is **per user, stored in the database**:
`User.rowsPerPage`, defaulting to 25. Every table's server page reads it and uses it as that
user's default page size; the rows-per-page dropdown in the pagination bar writes `?pageSize=` to
the URL, which **overrides it temporarily** — for that URL, that navigation, that shared link —
without touching the stored preference.

This is why `pageSize` cannot be compared against a module-level constant when serializing the
querystring: the param is omitted when it equals *this user's* default, not when it equals 25. The
user's default is therefore threaded into both halves — `parse*Filters(searchParams, defaultPageSize)`
on the server, and a `defaultPageSize` prop on the client table for the build half. A URL with no
`pageSize` means "whatever my preference is", so the same bookmarked link gives two admins their
own page sizes, which is the intent.

Read from the database per request rather than baked into the session JWT: `id`/`role`/`color` are
fixed at sign-in and go stale until sign-out (see `src/app/sign-in/NOTES.md`), and a preference the
user just changed should apply on the next page load, not the next session.

The preference is edited in `/users`, as a select cell in the row's own **Rows/page** column,
alongside Role and Moderation policy. That surface is ADMIN-only, which is a real gap for everyone
else — see §16l.

### 16c. Phase 1 — the query-param kit

`src/lib/table-query.ts` holds what `comments-query.ts` and `annotations-query.ts` had two copies
of: the page-size options, and parsers/serializers for the five params every admin table has —
`deleted`, `q`, `page`, `pageSize`, `sort`.

```
BaseFilters<K>                       = { deleted, q, page, pageSize, sort: SortColumn<K>[] }
parseBaseFilters(sp, spec)           -> BaseFilters<K>
buildBaseQueryString(f, extra, spec) -> URLSearchParams   // not a string — see below
parseSetParam(value, options)        -> Set<T> | "ALL"
```

Each table's `*-query.ts` composes these into its own **fully typed** filter shape rather than
receiving a generic bag:
`CommentsFilters = BaseFilters<CommentsSortKey> & { status: Set<CommentStatus> | "ALL"; threadStatus: ... }`.
A generic `Record<string, Set<string>>` for the multi-select params would have erased exactly the
enum types that make the server's `where` builder safe, so the kit stops at the shared five and
lets each table add its own with the primitives.

`buildBaseQueryString` returns a `URLSearchParams`, not a string, so a table can set its own params
on the result before serializing. The deep-link-only params (`?post=`, `?author=`, `?commenter=`,
`?doc=`, `?user=`) keep round-tripping through the `extra` argument untouched.

What stays per-table, because it is schema-specific and not plumbing: the sort-key list, the
default sort, the `SortKey -> Prisma orderBy` mapping, the `filters -> Prisma where` mapping, and
the deep-link `where`.

### 16d. Phase 2 — the client kit

`src/components/table/`, with `AdminTable.module.css` moving into it (it was already named for the
shared concept rather than a component — see STYLE.md).

Hooks:

- `useTableFilters` — the `navigate` / `updateFilters` / debounced-search trio, plus the
  search-draft state that resyncs when `filters.q` changes for an outside reason (back/forward, a
  deep link). `updateFilters` resets to page 1; `navigate` does not, so Prev/Next can move the page
  alone.
- `useRevealedRows` — the visit-local overlay that keeps a just-deleted row visible until a real
  navigation, generalized from `CommentsTable`. A `Map`, not the older tables' `Set` of ids: under
  pagination the server refetch drops the row entirely, so the overlay has to carry the row itself,
  not just a flag saying "show it" — **and its index**, so it goes back where it was rather than
  onto the end. Appending is the obvious implementation and reads as a bug: delete the second of
  four rows and it drops to the bottom, which looks like the table re-sorting itself. The index is
  free to capture, since both reveal calls happen while `rows` still contains the row.

  The alternative was to stop dropping these rows in SQL at all — hand the just-deleted ids back to
  the server and widen the `WHERE`, so Postgres returns them in their sorted place. That is the more
  truthful model (the row would be counted and paginated like any other) and it is the one to reach
  for if a revealed row should ever be a *real* row. It was not taken here because it makes the ids
  a sixth shared querystring param, and with that: bookmarkable URLs that resurrect rows for whoever
  opens them, a `FilterHelp` entry for something no one types, a total that moves, and a revealed
  row displacing a live one onto page 2. Three of the five tables also already use `where.OR` for
  their search, so the new clause has to nest under `AND` or it silently disables the search box.
  None of that is worth paying for a row the admin deleted a second ago, where nothing else on the
  page has moved.
- `useRowStatus` — §16f.
- `useRowSelection` — §16g.

Components: `SortHeader` (the `<th>`, its click/ctrl-click handling and the ▲/▼ + priority
superscript), `SearchBox`, `MultiSelectDropdown` (promoted out of `CommentsTable`), `PaginationBar`,
`DateFormatSelect`, `ShowDeletedToggle`, `RowActionButton` (the delete/restore icon toggle every
table has), and `FilterHelp` — the querystring help panel, **generated from the same filter spec
Phase 1 parses**, so the documented params cannot drift from the parsed ones the way a hand-written
help table can.

Three conventions STYLE.md's TODO left open are settled here, since the kit has to pick one:
`.table` carries `margin: 1em 0`; the date-format and show-deleted controls are **siblings after
`</table>`, not a `<tfoot>`** (a `<tfoot>` is for summary rows of the table's own data, not page
controls — `UsersTable`'s `<tfoot>` goes); and every table renders its header row with a centered
`.emptyRow` when there are no rows, rather than bailing to a bare `<p>`, because with pagination and
filters present the controls must stay usable when a filter matches nothing.

### 16e. Phase 3 — Posts, Docs and Users move server-side

Each gets a `*-query.ts` (Phase 1), a rebuilt page (`where`/`orderBy`/`take`/`skip` plus a `count`),
and a table rebuilt on the kit. Their sort and search move from React state into the URL, the
`sessionStorage`-backed `useShowDeletedRows` retires in favour of the `deleted` param, and
`useSortableRows`'s client-side sorting retires with it — only `nextSortColumns` (the
click/ctrl-click toggle semantics) survives, which is what the URL-driven tables already used.

`/users` gains a search box (name/email/initials), which it never had. Sorting by role stays in
privilege order for free: Postgres orders an enum by declaration order, and `Role` is declared
ADMIN → COMMENTER, which is what `ROLE_ORDER` spelled out client-side.

**Sorting the derived columns.** Moving sort into Postgres means every sort key has to be something
an `ORDER BY` can name, and several of these columns are not: they are derived from a to-many
relation, or computed by a SQL function. Prisma's `orderBy` over a to-many offers exactly one
member — `_count` (`PostPublicationEventOrderByRelationAggregateInput` and friends, generated,
Prisma 7.9). A joined byline is not a count; "approved comments, excluding soft-deleted ones" is a
*filtered* count `_count` cannot express either; and "who made the most recent publication event"
is not an aggregate at all but an **argmax** — the actor of the row *having* the max — which no
`orderBy` extension short of raw SQL could reach.

What that wall is really about is *to-many* relations. Prisma orders a **to-one** relation's own
columns freely, nested arbitrarily deep, which is how `/comments` sorts by post title and commenter
name. So a **view keyed 1:1 on the base table's primary key** is a to-one relation, and turns each
of these into a shape Prisma already handles:

| Table | Column | Sorts through | Which is |
|---|---|---|---|
| `/posts` | Author(s) | `post_metrics.byline` | `string_agg` of `adminInitials` in byline order |
| `/posts` | Comments | `post_metrics.approved_count`/`pending_count` | `count(*) FILTER` per status, excluding soft-deleted |
| `/posts` | Last edit by/at | `post_activity.last_editor_name`/`last_event_at` | the argmax over `PostPublicationEvent` |
| `/docs` | Author(s) | `doc_metrics.byline` | `string_agg`, as above |
| `/docs` | Length | `Doc.proseJsonLength` | a stored column, not a view — §16l has the reasoning |

Each view **also displays** the value it sorts (`include: { activity: true }` and friends, rather
than a `take: 1` sub-select or a JS join over an authors include), so the sorted expression and the
rendered one are the same expression. Sorting by one thing while showing another is the failure this
rules out by construction rather than guards against — and it was the deciding factor against the
cheaper alternative for Last edit: `Post.publishEvent` is already a to-one relation and needs no
view, but it is nulled on unpublish and only ever points at a `PUBLISHED`/`SCHEDULED` row, so
sorting by it while displaying "latest event of any type" would have read as a broken sort.

`/posts`'s History column needs none of this (`_count: { publicationEvents }`), nor does `/users`'
Posts column (`_count: { postAuthors }`) — those are plain relation counts, which Prisma does order
by. Nothing here tries to make *every* column sortable: a comment's body text, an avatar, a colour
swatch and an action button are not sort keys in any useful sense and stay plain `<th>`s, as does
`/comments`' commenter-activity column for the reason §11 gives.

The argmax view, which is the one worth writing out:

```sql
CREATE VIEW post_activity AS
SELECT DISTINCT ON (e.post_id)
       e.post_id, e.created_at AS last_event_at, COALESCE(u.name, u.email) AS last_editor_name
FROM post_publication_event e LEFT JOIN "user" u ON u.id = e.actor_id
ORDER BY e.post_id, e.created_at DESC, e.id DESC;
```

The `e.id DESC` tiebreaker matters more than it looks: `created_at` is not a unique ordering key, so
without it *which* of two same-instant events won would be arbitrary. Not reachable today — each of
the three `postPublicationEvent.create` sites writes one event per transaction, and `now()` is the
transaction timestamp — but the view shouldn't depend on that continuing to hold. `id` is the
primary key, so it breaks every tie by definition.

`DISTINCT ON` is a PostgreSQL extension rather than standard SQL; the portable spelling is
`ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY created_at DESC, id DESC)` filtered to `= 1`. Kept
as `DISTINCT ON` deliberately: portability is not the binding constraint (`doc_length()`, Prisma's
`mode: "insensitive"`, JSON path filtering and native enums would all have to move first), it is
normally the cheaper plan on Postgres for top-1-per-group, and the choice is reversible for free —
the schema block, the relation, `buildOrderBy` and the spec are identical either way, so swapping it
is one `CREATE OR REPLACE VIEW` and no application code. `ROW_NUMBER()` would win on merit only if
this ever needed top-*N* per post rather than top-1.

`orderBy: { activity: { lastEventAt: { sort, nulls: "last" } } }` then just works, with the argmax
happening in SQL where it belongs. A post with no events has no row in the view, which is why
`PostActivity` is a nullable relation and both columns sort nulls-last — matching what the cell
shows for such a post anyway.

`post_metrics` and `doc_metrics` are the aggregate counterparts, and stay separate from
`post_activity` rather than being folded into it: an argmax over `post_publication_event` and a
`GROUP BY` over `post_author`/`comment` want different plans, and merging them would force one
shape onto both while changing the row-presence semantics the nulls-last ordering depends on.
The two differ from each other in the same way, and deliberately — `post_metrics` reads `FROM post`
so every post has a row, while `doc_metrics` groups `doc_author`, so a doc with *no* authors has no
row at all. Both render as the same empty cell and sort the same way, since each relation is
optional and byline is ordered nulls-last either way; §16l has why `doc_metrics` is worth the
difference.

Two things Prisma views make you live with: they take `@unique`, never `@id` ("Views cannot have
primary keys"), and **Prisma Migrate does not manage them** — `migrate diff` emits no DDL for a
`view` block at all, so the `CREATE VIEW` lives in a hand-written migration exactly as
`doc_length()` does, and changing it means a new migration rather than an edit to the schema block.
The generated client will also happily *type* writes to a view that Postgres will reject.

What each of these costs, and the measurements behind Length being a column instead: §16l.

### 16f. Row state as a left border

The `savedPulse` animation (`UsersTable`, `SiteSettingsTable`) is replaced by a persistent **3px
left border on the row's first `<td>`**, driven by `useRowStatus`:

| State | Border | Means |
|---|---|---|
| idle | transparent | nothing has happened to this row |
| edited | gray | a field has been changed locally, not yet submitted |
| saving | yellow | a server action is in flight |
| error | red | the action failed |
| saved | green | the action succeeded |

Every row paints the border at all times, transparent when idle, so no row shifts horizontally when
its state changes.

A pulse is a momentary acknowledgement that is gone a second later; a border is a **standing record
of what this visit touched**, which is what an admin editing several rows in a row actually wants.
So `saved` persists until that row is edited again or the page navigates — there is no timer.
`error` persists likewise, and keeps the existing per-cell error text underneath the control, which
says *what* failed; the border only says *that* something did.

The states are not all reachable from every control. A text cell commits on blur, so it passes
through `edited` on its way; a `<select>` or color picker submits on change and goes straight to
`saving`. Delete/restore is a mutation like any other and paints the same border, which is why this
lives in the kit rather than in `UsersTable`.

**A bulk action paints it too**, on every row it applied to — `runWithStatusMany`, the batch
counterpart of `runWithStatus`, which `BulkToolbar` takes as a required prop rather than an optional
one so a new table cannot quietly leave its bulk actions the only mutations on the surface with no
per-row feedback. Two properties fall out of it, both deliberate:

- **Only the rows the action actually applied to are marked.** §16g's rule is that a mixed selection
  silently skips the rows an action doesn't apply to; marking only the rest means the border answers
  *which of the rows I selected did that change?*, not merely *did something run?*. The skipped rows
  stay idle.
- **The mark outlives the selection.** `onDone()` clears the selection and refreshes immediately
  afterwards, so a moment later nothing is checked any more — the border is then the only remaining
  record of what the action covered, which is precisely the standing-record argument above applied
  to a batch.

- **Each row reports its own outcome, not the batch's.** The batched actions are not transactional
  (§16k), so a selection mixing rows the caller may change with rows it may not — the normal case
  for anyone who isn't ADMIN — half succeeds. That is why they return a `BulkResult`
  (`src/lib/bulk-result.ts`) instead of `Promise<void>`: `Promise.all` rejects on the first bad id
  and *discards which ids the rest were*, leaving the browser one bit for the whole batch and no
  choice but to redden rows that saved. `Promise.allSettled` behind `settleBulk` changes only the
  reporting — `Promise.all` already started every call, so the ones that were going to succeed
  always did — and green now means *this row saved*.

  A thrown action still reddens everything, and should: an unauthenticated caller or a dead network
  is the case where the client genuinely doesn't know which rows are which.

- **A red row carries its reason**, as a `title` on the same cell that paints the border — the only
  place a *per-row* explanation can live when one toolbar serves N rows. The toolbar keeps the
  summary (`3 of 8 failed …`), preserving §16f's split: border says *that*, text says *what*.

  The message is filtered, not passed through. Next redacts the message of an error *thrown* from a
  server action in production and a returned value gets no such treatment, so echoing
  `reason.message` verbatim would route around that and put a Prisma query and absolute source
  paths on an admin's screen. `describeFailure` passes through a plain `Error` — which is what this
  codebase's own authorization guards throw — and collapses everything else to a generic string.

  **The collapsed ones are logged, and that is not bookkeeping — it replaces something
  `Promise.allSettled` took away.** Under `Promise.all` the first rejection propagated out of the
  server action and Next logged it (with a digest in production, to correlate against). `allSettled`
  captures the rejection, so nothing throws, so nothing is logged: without an explicit
  `console.error` the only trace of a failure would be one generic sentence on an admin's screen.
  Only the collapsed ones, though — a plain `Error` is a guard the admin reads in full, ordinary
  feedback rather than a fault, and logging every refused authorization at error level would bury
  the real ones. The row id is the correlation key: it is in the log line, and the UI reddens that
  exact row.

Beneath both, **`BulkToolbar` refreshes on the failure path too** — `onDone(ok)`, with every table
refreshing regardless and clearing the selection only when `ok`. Skipping the refresh on failure
left the rows that *had* saved showing their pre-action values next to a red border until someone
reloaded, which made §16k's "a partial application is visible" untrue as written. Keeping the
selection armed when anything fails is the other half: the action is re-runnable without re-picking
the rows. Deletion's `onDeleted` overlay also runs either way, since the ids that did delete are
gone from a `?deleted=0` refetch and would otherwise vanish mid-action — a row that *didn't* delete
costs nothing there, because `useRevealedRows` drops an overlay entry as soon as `rows` contains
that id again.

### 16g. Phase 4 — selection and bulk actions

`useRowSelection` (checkbox column, header select-all, the selected-id set) and `BulkToolbar` (the
toolbar that appears once anything is selected). A table declares its bulk actions as data —
`{ label, icon, applicableTo(row), run(ids) }` — and the toolbar renders them; the "silently skip
rows the action doesn't apply to rather than erroring on a mixed selection" rule that
`bulkModerateComments` established becomes the convention every bulk action follows. Skipping
silently is only tolerable because §16f's border then marks exactly the rows that *were* affected —
the two rules are a pair, and the second is what stops the first from being an admin wondering
whether anything happened.

Each table gets batched server actions of its own, each enforcing its own authorization — which is
why the toolbar takes server actions rather than a table name. `/comments` keeps Approve/Pend/Spam;
`/posts`, `/docs`, `/users` and `/annotations` get delete/restore, and `/users` also gets bulk role
and moderation-policy changes.

Selection stays **scoped to the current page**, as `/comments` already had it. Cross-page "select
all N matching" remains deliberately unresolved; the shape it should take when it lands is a
*filter-scoped* server action (`bulkModerateWhere(filters)`) rather than an id list, so no
thousand-element array crosses the wire and the action means the same thing it displays.

### 16h. Phase 5 — staging changes in IndexedDB (not built)

The requirement is that a change survives a bad connection: an admin moderating on a train should be
able to act, see what they did, and have it land when the network returns. Hand-rolled over plain
IndexedDB, following `y-indexeddb`'s precedent (§11e) that the subtle parts of local persistence are
worth owning.

- A staged mutation is a serialized server-action call:
  `{ id, table, action, args, rowIds, createdAt, status: pending|inflight|failed }`, in one object
  store **keyed by the signed-in user's id**. The browser's cookie jar is shared across tabs, and
  replaying user A's queue as user B is the same class of identity bleed the browser-pane notes in
  CLAUDE.md warn about.
- Actions route through `stageMutation()`. Online, it calls straight through and the queue is never
  touched — the current code path, unchanged. On a network failure it enqueues and paints an
  optimistic overlay: the generalization of `useRevealedRows` from "a deleted row stays visible" to
  "a row shows its staged values", with a per-row pending marker and a queue banner
  ("3 staged changes — retry / discard"). Staging a moderation decision silently would be worse
  than failing loudly.
- Replay on the `online` event, on visibility change, and on an interval: FIFO, one at a time,
  dropping an entry only once its action resolves. A **server-rejected** mutation (as opposed to a
  network failure) goes to `failed` for explicit discard — it must not retry forever.
- Conflict policy is per-action and deliberately dumb: moderation and delete/restore are idempotent
  last-write-wins; field edits are last-write-wins per field. No merge machinery. This is an admin
  table, not a document — the ydoc stack already owns the hard version of this problem.
- **Mutations only.** Staging *reads* (a cached page for offline viewing) is a different and much
  larger feature, excluded on purpose.

### 16i. Phase 6 — column visibility and order

Each table declares its columns as data — the kit already needs a per-table column list for the
help panel and the bulk-action spec, and this extends it to a `ColumnSpec` (`src/components/
table/column-spec.ts`):

```
{ key, header, sortKey?, nowrap?, headerClassName?, headerTitle?, alwaysVisible?, cell(row),
  cellProps?(row), renderHeader?(), thRef? }
```

`key` is a stable string, never the array index: a saved order that survives a column being added
or removed has to name columns, not positions. It is also what appears in `?cols=`, so it is a
user-visible string kept short and lowercase.

The last three fields are what the build added beyond the shape this section originally sketched,
and each earns its place by being load-bearing somewhere real: `cellProps` lets `/docs`' Title cell
stay a whole-cell click target rather than just the link inside it; `renderHeader` is for a header
that isn't "label plus sort arrows" (the delete/restore column's icon button); `thRef` is what
`/posts` measures to size its search box to the Title column. `headerClassName`/`headerTitle` cover
the two columns (`/users`' Name, `/comments`' Changed at) whose `<th>` needs its own class or
tooltip. None of these were guessable in advance — each surfaced only once an existing table's
actual markup had to be expressed as data instead of hand-written JSX.

`ColumnHeaderRow`/`ColumnCells` (`src/components/table/ColumnizedRows.tsx`) render a resolved
column list as the `<thead>` row and each row's `<td>`s — the kit's half of "who owns which columns
render", the cell content staying the table's own React expression either way (§16a's boundary,
unchanged). Two things only these can do, now that order is user-controlled: the row-status border
(§16f) goes on whichever column renders *first*, not a column a table names, and `colSpan` is
`visibleColumns.length` rather than the literal every table used to hardcode.

**State lives in the URL, like every other table parameter** — `?cols=title,authors,created` — with
absent meaning "the default set, in declaration order". That choice falls out of the rest of the
section: a filtered, sorted, paginated view is already shareable, and a link that arrives with the
wrong columns is a worse bug than a preference that doesn't persist. Two params would be one too
many, so a single ordered list carries both facts at once: membership is visibility, position is
order.

The durable half is `User.columnOrder`, a JSON column keyed by table
(`{ posts: ["title", "authors", ...] }`) — the same stored-default/temporary-override split page
size uses in §16b, for the same reason, and the second customer that justifies the pattern. A
"save as my default" control in the column picker writes it; the URL param overrides it for that
navigation. (Named `columnOrder`, not `tableColumns`, once §16m added a second column of the same
shape — see there for why.)

**Json rather than its own table**, which is the one part of this that looks like a shortcut and
isn't. The value is read whole, written whole, and never queried into — nothing will ever ask
"which users hide the Length column". Its shape is also "whatever columns that table happens to
declare today", so a relational spelling would need a row per user per column, and would *still*
have to tolerate rows naming columns that no longer exist. That tolerance is unavoidable either
way; Json is the spelling where it costs nothing.

**The picker (`ColumnPicker.tsx`) is its own component, not `MultiSelectDropdown` reused** — visibility
and order turned out to be one interaction, not two: checking/unchecking a row changes `?cols=`'s
membership and dragging changes its order, both writing the same list. Splitting them across two
controls would have implied two params where §16i settled on one. The drag handling mirrors
`DocSettingsPanel`'s `.draggableRow`/`.dragOver` pattern rather than inventing a second one — only a
*visible* row is draggable there too, for the same reason: there is no meaningful position for a
column that isn't shown. Fixed columns are still listed, disabled, so the picker describes the whole
table rather than implying they don't exist.

Three things this must not break, all of which constrained it and all of which hold as built:

- **A column that carries a row action cannot be hidden into uselessness.** The delete/restore
  column and the selection checkbox are `alwaysVisible`; hiding the only way to act on a row is not
  a customization. (`/annotations` splits its status text from its action button into two separate
  columns — a pre-existing quirk this conversion preserved rather than tidied — so only the button
  column needed to be fixed there; the "Deleted" Yes/blank text is an ordinary movable column.)
- **`colSpan` stops being a literal.** Handled by `ColumnCells`/`ColumnHeaderRow` above.
- **Sorting by a hidden column.** A `?sort=` naming a column that `?cols=` excludes is reachable by
  hand-editing a URL. `resolveColumns` only touches which columns *render* — the server-side
  `buildOrderBy` never sees `?cols=` at all, so the sort stays honoured regardless of what's shown.
  Covered by `e2e/admin-table.spec.ts`, which asserts the same row order with the sorted column
  hidden as with it visible.

One cost the build settled that was open when this was written: **a movable column absent from
`?cols=` is hidden, including one shipped after a user already saved a preference for that table.**
That falls straight out of the single-ordered-list design — membership *is* visibility — and there
is no second "hidden" flag to distinguish "chose to hide this" from "this didn't exist yet". A user
with a saved preference has to reopen the picker to see a newly added column. The alternative (a
second param) is the two-param design this section rejected above.

### 16j. Build order

Phase 1 (§16c) + Phase 2 (§16d) + Phase 3 (§16e), with §16b's `User.rowsPerPage` and §16f's
row-status border, land as **one commit**: the kit and its first three consumers can't be split
without leaving either an unused abstraction or a half-migrated table. Phase 4 (§16g) is a second
commit on top. Phase 3's derived-column sorting — the three views, `Doc.proseJsonLength` and its
trigger, and the two foreign-key indexes the comment counts need — is a third: it is the only part
that carries migrations, and separating it keeps a schema change out of a commit that is otherwise
all application code. Phase 6 (§16i) — `User.columnOrder`, its own migration, `ColumnSpec` and the
picker, all five tables converted — is a fourth. Phase 5 (§16h) is not built. §16m's
`defaultHidden` columns and `SiteSettings.defaultColumnOrder` land as a fifth, later commit.

### 16k. As built

New: `src/lib/table-query.ts` (the shared five params), `src/lib/user-preferences.ts`
(`getDefaultPageSize`), `posts-query.ts`/`docs-query.ts`/`users-query.ts`, and
`src/components/table/` — `use-table-filters.ts`, `use-revealed-rows.ts`, `use-row-status.ts`,
`TableControls.tsx`, `FilterHelp.tsx`, and `AdminTable.module.css` moved in from
`src/components/`.

Deleted: `src/lib/use-show-deleted.ts` (the `deleted` param replaced it),
`UsersTable.module.css` and `SiteSettingsTable.module.css` (each held nothing but its own
copy of the `savedPulse` keyframes). `use-sortable-rows.ts` became `table-sort.ts`: the
`useSortableRows` hook — which also *did* the sorting, client-side, over every row — had no
callers once sorting became an `ORDER BY`, so only `nextSortColumns` and the two types
survive. The file also lost its `"use client"`, since the server pages import `SortColumn`
to build their `orderBy`.

`e2e/admin-table.spec.ts` covers the border's idle → edited → saved path (asserting computed
colors, not class names), the same path driven by a bulk action of each kind — including that a
row the action skipped on a mixed selection stays idle — the querystring round-trip for
search/sort/page size including the "a page size equal to your preference isn't written to the
URL" rule, and that all five tables keep their header and controls when a filter matches nothing.

`e2e/bulk-partial.spec.ts` covers the half-successful batch, which is the case the per-row border
exists for and the one that is easiest to get wrong. It selects the signed-in admin's own row
alongside a throwaway user and bulk-deletes: `deleteUser` refuses the first and completes the
second, so the spec can assert green-on-one and red-on-the-other, the failed row's `title`
carrying its reason, the deleted row rendering as deleted with no reload, and the selection
surviving. That last one was verified by reverting the fix and watching the spec fail on exactly
that assertion.

Two deviations from the plan as written, both flagged when the work was reported:

- `Doc.title` is stored empty for an untitled doc and rendered as "Untitled" (§12n). While
  `/docs` sorted client-side it sorted the *rendered* string; server-side it sorts the
  stored one, so untitled docs now sort as the empty string. Not worth a stored-title
  change to preserve.
- `/users`' Name column sorted by `name ?? email` client-side. Postgres can't express that
  fallback mid-`ORDER BY`, so a nameless user now sorts as a null (kept last either way).

**Phase 4** added `use-row-selection.ts` and `BulkToolbar.tsx`, and put a selection column on
all five tables. `BulkAction` turned out to need two kinds, not one: `"button"` for a fixed
verb (Approve, Delete) and `"select"` for "set every selected row to *this*" — `/users`' role
and moderation policy and `/docs`' visibility have no single obvious value, so a button per
option would have meant eight buttons in the toolbar. `softDeleteBulkActions()` builds the
delete/restore pair every table ends with, since all five share soft-deletion.

The new batched actions (`bulkDeletePosts`/`bulkRestorePosts`, `bulkDeleteDocs`/
`bulkRestoreDocs`/`bulkSetDocVisibility`, `bulkDeleteUsers`/`bulkRestoreUsers`/
`bulkSetUserRole`/`bulkSetUserModerationPolicy`, `bulkDeleteAnnotations`/
`bulkRestoreAnnotations`) each delegate to the existing single-row action per id rather than
issuing one bulk `updateMany`. That is deliberate and the reason is authorization: the
per-row helpers carry guards a bulk path must not be able to sidestep — `deleteUser`'s "you
can't delete your own account", `updateUserRole`'s "you can't remove your own admin role",
`canUserEditPost`/`canUserEditDoc` per row. A `updateMany` over an id list would have had to
restate all of them, correctly, in a second place. Not transactional, matching
`bulkModerateComments`: a partial application is visible and re-runnable, and wrapping N
independent soft-deletes in one transaction turns "9 of 10 worked" into "none did" without
telling the caller more.

The row-status border now sits on the selection checkbox's cell, since that became the first
`<td>`. Still the row's leftmost edge, which is what the border is for.

**The derived-column sorting** (§16e) is five migrations: `post_activity`, `post_metrics` and
`doc_metrics`; the two foreign-key indexes `post_metrics`' comment counts need
(`comment.thread_id`, `comment_thread.post_id` — Postgres indexes a primary key but never the
referencing side of a foreign key); and `Doc.prose_json_length` with its trigger. On the
application side that is three `view` blocks plus their relations, the `buildOrderBy` cases, and
the pages reading each value from the thing that sorts it — which let `/posts` drop the `authors`
and `threads` includes entirely (the latter pulled every comment of every post on the page into
Node to count two statuses) and `/docs` drop its second `$queryRaw` round trip for `doc_length`.

`e2e/admin-table.spec.ts` asserts the actual row order in both directions for every one of these
columns. That is the only assertion that means anything here: a sort through a view fails by
returning the wrong order, not by throwing.

Two operational notes this surfaced, both in CLAUDE.md but easy to be bitten by anyway. Adding a
view is adding a *model*, so a `next dev` started before `prisma generate` keeps the old client in
module memory and every `/posts` query dies with `Unknown argument 'activity'` — restarting the dev
server is the whole fix, regenerating alone is not. And a doc's `prose_json` is a cache with no
recompute-on-read, so the three places that create a doc without a collab server in the loop
(`scripts/seed-sample-data.ts`, `scripts/test-doc.ts`, `e2e/db-worker.ts`) have to write it
themselves; they all call `docContentFromYdoc`, the same derivation `server/doc-cache.ts` uses, and
`scripts/integrity/check-doc-integrity.ts` is what verifies they agree.

### 16l. Known gaps

- **`User.rowsPerPage` is only editable in `/users`, which is ADMIN-only.** An AUTHOR or
  EDITOR who can reach `/posts`, `/docs` and `/comments` has a preference they cannot
  change; the `?pageSize=` override is their only recourse, and it doesn't persist.
  `User.columnOrder` (§16i) already got the self-service surface this one is missing —
  `saveTableColumns` (`src/app/actions/table-preferences.ts`) is the app's first
  self-service preference action, reachable from each table's own column picker — but it
  is scattered one control per table rather than centralized. The home for both, done once
  rather than per-table and per-preference, is a `/dashboard` settings surface.
- **Each view is recomputed per query, and a sort has no `WHERE` to push down.** This is the
  cost that decides view-versus-column, so it is worth stating as a rule: reach for a view
  when a value is *awkward to reach* (a joined byline, a filtered count) and for a stored
  column when it is *expensive to compute*. A view's per-query cost is not bounded by the
  page size — ordering by one of its columns evaluates the expression for every row in the
  table, however few end up on screen.

  `/docs`' Length is the column where that bites, and the reason it is `Doc.proseJsonLength`
  rather than `doc_metrics.length`. `doc_length` is a recursive walk over the whole document
  body, measured here at **~52µs per 1k characters** (~2.1ms for a 40k-character doc, ~0.04ms
  for a 500-character one). Through a view that lands in the two worst places: `/docs` would
  recompute it for the page's 25 docs on *every* load, and sorting by it would walk every doc
  in the table — around a second per page load at 1,000 docs of 20k characters, growing with
  the corpus. The write side pays one walk per debounced collab flush. The other four columns
  have no such asymmetry: a `string_agg` over a byline and a `count(*) FILTER` are cheap, and
  `post_activity`'s argmax is served straight from `post_publication_event`'s existing
  `(post_id, created_at)` index.

  Three things that decided the column's shape, each checked rather than assumed:

  - **A trigger, not a `GENERATED ... STORED` column.** The generated column is the better
    mechanism on every axis but one — identical cost, and it *cannot* drift. Prisma reads and
    sorts it correctly and `doc.create()` works (Prisma omits unnamed columns from the
    INSERT). But `migrate diff` reads the generation expression as a column default and emits
    `ALTER COLUMN "prose_json_length" DROP DEFAULT` permanently, so every future `migrate dev`
    would offer to strip the generated-ness. A plain column plus a trigger diffs clean,
    because Migrate doesn't introspect triggers. It wins by being invisible. (PG18's *virtual*
    generated columns are out regardless — they reject user-defined functions.)
  - **The trigger is narrowed to `UPDATE OF prose_json`**, so title/slug/visibility/soft-delete
    writes don't pay the walk. Verified: a title-only update leaves a deliberately-corrupted
    length untouched, while a body update recomputes it.
  - **Nothing in the application feeds it.** `server/doc-cache.ts` writes `prose_json` and the
    column follows — confirmed end to end by typing 31 characters into a live editor and
    watching the flush land `31`.

  What it costs: drift is possible where a view cannot drift, since a trigger can be bypassed
  by `DISABLE TRIGGER`, a `COPY`, or a restore. `scripts/integrity/check-doc-integrity.ts`
  has a table-wide `length-cache` check for that, reporting the stored and actual values and
  the no-op write that repairs them. No index on the column: sorting an `int` is cheap enough
  that one would be maintenance cost without a demonstrated need.
- **A view that reads its own base table is scanned twice under a sort, and there is no knob
  for it.** Postgres 18's self-join elimination is precisely the optimisation and cannot
  help: it only fires on `INNER` joins, while Prisma emits a `LEFT JOIN` for a to-one
  relation ordering regardless of how the relation's optionality is declared (it also refuses
  a 1:1 with both sides required). `post_metrics` pays this — it reads `FROM post`, which is
  the readable shape and gives every post a row. `doc_metrics` avoids it by grouping
  `doc_author` instead, which is only possible because Length is a column rather than a view
  expression; the same trick would work for `post_metrics` as a `FULL OUTER JOIN` of its two
  aggregates, at the cost of readability and of making both counts nullable for a post with
  authors but no comments. Not worth it for one avoided scan of a small table.
- **Prisma issues the two halves of a view differently, and only one is a join.** An
  `orderBy` through a view is a `LEFT JOIN`; an `include`/`select` of it is a separate
  `WHERE <pk> IN (…)` query. Worth knowing because it means the display path costs one flat
  round trip rather than anything per row — and because the two paths can therefore have
  quite different plans for what looks like one query.
- **Each view is a `previewFeatures = ["views"]` model Migrate won't manage**, so its DDL is
  hand-written and has to be kept in step with the schema block by hand. There are three.
- **Cross-page selection is still unresolved** (§16g). Selecting rows, paging, and coming
  back keeps the selection in React state, so it survives — but the header checkbox only
  ever means "this page", and there is no way to act on "all N matching".
- **Every page load costs one extra query** for `getDefaultPageSize`. Narrow
  (`select: { rowsPerPage: true }` by primary key) and deliberate — see §16b on why not the
  JWT — but it is a per-request round-trip that did not exist before.
- **`?q=` searches one or two obvious columns per table**, chosen to match what the old
  client-side filters did (title for posts/docs; name/email/initials for users). Postgres
  full-text search over post/doc *bodies* is a different feature and isn't attempted here.

### 16m. Defaulted-hidden columns and a site-wide default

§16i's audit was column-*visibility* mechanics; it didn't ask whether every DB column worth
seeing was even offered as an option. It wasn't: several columns each table's query fetched (or
could cheaply fetch) never reached `ColumnSpec` at all, so no `?cols=` value could ever show them.
Added, all `defaultHidden: true` — present in the picker, absent from the default view:

- `/posts`: `slug`, `moderationPolicy`, `deletedAt`.
- `/docs`: `slug`, `deletedAt`, and (since §16n below) `created` — `updatedAt` swapped into its
  spot instead, shown and sorted by default. `updatedAt` was itself `defaultHidden` when this
  list was first built.
- `/users`: `deletedAt`.
- `/comments`: `ipAddress`, `statusChangedBy` (sorts through the comment's own `statusChangedBy`
  relation, the same to-one-relation `orderBy` pattern §16i's `post_activity`/`post_metrics` use,
  just a direct FK rather than a view), `editedAt`, `deletedAt`.
- `/annotations`: `raisedAt`, `resolvedAt`, `deletedAt`. `status` was added too, but *not*
  `defaultHidden` — unlike the timestamp columns, it names a real workflow state (RAISED means the
  doc's byline authors were emailed, §13d) with no other visibility anywhere in this table.

`/posts`' query changed from an `include` to an explicit `select` naming every scalar except
`proseJson` in the same pass — `include` fetches every scalar column of the model, so the page was
already pulling each post's full body into the Node process on every load to serve a table that
never rendered it; adding more `defaultHidden` scalars was the occasion to stop doing that, not a
reason to add to it.

**Why `defaultHidden` is a `ColumnSpec` field and not a second `?cols=`-adjacent param.** A column
can be declared without deciding, in the same declaration, whether an admin encountering the table
for the first time should see it by default — `defaultColumnKeys` (`column-spec.ts`) filters out
`alwaysVisible` and `defaultHidden` columns and is the last-resort fallback, reached only when
neither a user's saved preference nor a site default (below) has an opinion. It changes what "no
preference" means without touching how a preference, once made, is stored or read.

**The site-wide half.** A `defaultHidden` column is a per-column, code-level opinion — good enough
until an admin wants, say, `deletedAt` visible by default for every user on `/posts`, not just
their own account. `SiteSettings.defaultColumnOrder` (Json, keyed by table, identical shape to
`User.columnOrder`: an ordered list of visible column keys) sits between the two: `getTablePrefs`
(`src/lib/user-preferences.ts`) resolves a user's own `columnOrder` first, falls back to
`getSiteDefaultColumnOrder` (`src/lib/site-settings.ts`) next, and only reaches `defaultColumnKeys`
if neither has ever been set. Precedence, in order: `?cols=` (this navigation) > `User.columnOrder`
(this admin's saved preference) > `SiteSettings.defaultColumnOrder` (site-wide) >
`ColumnSpec.defaultHidden` (code fallback, if nobody has ever configured either of the above).

**Same shape on purpose.** Both Json columns started out different — `columnOrder` an ordered
visible-list, an earlier site-wide draft a hidden-*set* — until unifying them turned out to remove
a parameter rather than add one: `resolveColumns` only ever needs one ordered list of visible keys
regardless of which tier supplied it, so `columnOrderFor(stored, table)` (`src/lib/
column-order.ts`) is the one parser both `getTablePrefs` and `getSiteDefaultColumnOrder` call, and
`User.columnOrder` is named to match `SiteSettings.defaultColumnOrder` rather than keeping its
original `tableColumns` name, once the shapes lined up. `AdminTableName` lives in this new file
too (`user-preferences.ts` re-exports it for callers that predate the split), since it is what both
columns are keyed by, not something that belongs to the user-preferences half alone.

**Editing the site default (`/site-settings`) needs column identity a client component's closures
can't give a server component.** Each table's real `ColumnSpec<Row>[]` lives inside that table's
own React component — JSX headers, hooks-dependent cells, closures over local state — and
`/site-settings` is a server component rendering a page for a table it never opens. Rather than
splitting "column identity" from "cell renderer" across all five tables (out of scope for this
pass), `src/lib/admin-table-columns.ts` hand-duplicates the movable columns' `key`/`label`/
`defaultHidden` as plain data, deliberately and explicitly commented as a duplication that must be
kept in step by hand: **adding, removing or renaming a movable column means updating both places.**
`codeDefaultColumns` there mirrors `defaultColumnKeys`'s one-line rule against that static shape.

`DefaultColumnsEditor` (`src/components/DefaultColumnsEditor.tsx`), the `/site-settings` control
itself, edits visibility and order in one control, for the same reason `ColumnPicker` does:
`SiteSettings.defaultColumnOrder` is a single ordered list where membership is visibility and
position is order, so a second control would have nothing of its own to own. Checking/unchecking a
row changes membership; dragging a checked row changes position — both write the same list,
immediately, on every change (no separate save step, unlike `ColumnPicker`'s "save as my default":
there is no draft/URL-param distinction for a site-wide setting to preview before committing). The
drag handling reuses `ColumnPicker`'s own mechanics and CSS classes (`columnPickerList`/
`columnRow`/`columnDragHandle`, `AdminTable.module.css`) rather than a second implementation of the
same gesture — only a checked row is draggable there too, for the same reason: there is no
meaningful position for a column that isn't shown.

### 16n. /docs defaults to Updated, not Created

`/docs`' default view and default sort (`DEFAULT_SORT`, `docs-query.ts`) both pointed at
`created`/`createdAt`. Swapped for `updatedAt`, in the same declared position `created` used to
hold (`DocsTable.tsx`'s `ColumnSpec` list, and its mirror in `admin-table-columns.ts` — §16m's
"adding, removing or renaming a movable column means updating both places" applies to swapping
one's `defaultHidden`/position too) — `created` moved to where `updatedAt` used to sit, now
`defaultHidden`. Both were already sortable, already selected server-side, and already plain
`Doc` columns (`created`/`updatedAt` both existed as `DocsSortKey`s and `ColumnSpec`s before this;
nothing new was added, only which one is the default). Rationale: an admin landing on `/docs` is
almost always there to see what's changed lately, not what was created first — a stale-sorted-by-
creation-date table buries anything just edited under a pile of untouched old docs, however
recently `Doc.updatedAt` moved.

### 16o. Doc.updatedBy — who last moved updatedAt

`Doc.updatedAt` says *when* a doc last changed; `Doc.updatedByUserId` (migration
`add_doc_updated_by`, nullable FK to `User`, relation `DocUpdatedBy`) says *who*, and `/docs`
shows it as an "Updated by" column beside Updated — the pair `/posts` already has as "Last edit
at"/"Last edit by".

**Deliberately last-writer-wins, not an audit trail.** `updatedAt` is `@updatedAt`, which Prisma
applies client-side to *any* update of the row, so the rule is simply "every write that moves
`updatedAt` also names who moved it" — otherwise Updated advances while Updated by still credits
an older edit, which reads worse than either value alone. That covers the doc server actions
(`createDoc`, `updateDocVisibility`, `setDocDeleted`, and `changeDocSlug`/`revertDocSlug`, which
take a `updatedByUserId` argument since `src/lib/doc-slug.ts` has no session of its own) and, the
one that matters, the collab store-debounce flush.

That last one is where the imprecision is, and it is accepted rather than overlooked.
`updateDocCache` (`server/doc-cache.ts`) is called from `ydocOnStoreDocument`, whose payload
offers only `lastContext` — Hocuspocus's "whichever connection most recently drove this
document," verified at `onAuthenticate`, never client-asserted. The hook is debounced, so two
authors typing at once coalesce into one flush and this records whichever happened to be last.
`Doc.updatedBy` is *defined* to accept that. This column is a cheap "who touched it last" for a
listing, and the schema comment says so.

Anything wanting real per-author attribution already has better mechanisms, and it is worth being
precise about what they are — **`ydoc_update` is not one of them.** That table is `id`/`ydoc_id`/
`update`/`created_at`: raw Yjs bytes and a timestamp, no `user_id` (unlike `ydoc_snapshot`, which
does carry one). What exists instead is: the `authorHighlight` marks in the doc's own Yjs state,
which are exact and per *character*; and, per update, the clientID an update's bytes encode
(`Y.parseUpdateMeta(update).from`) resolved through the top-level `clients` `Y.Map` that §11d
keeps *inside* the document (`String(clientID) → userId`, written once per client by
`attributeUpdate`). That second one is a Yjs read, not a join — it needs the document
materialized, it goes ambiguous on a merged update carrying more than one origin client (which
`attributeUpdate` declines to guess at), and clientIDs are per session rather than per user. All
of which is why `Doc.updatedBy` is a plain FK column and not a view over the update log.

`updatedByUserId` is **omitted, not nulled**, when a caller has no user to name (a store flush
during a shutdown drain, a seeding script, an import) — erasing the last real editor would be
worse than leaving a slightly stale one. Nullable for the same reason plus rows predating the
column; `/docs` renders those as a blank cell and sorts them last in either direction, and the
sort goes through the to-one relation exactly as `/comments`' `statusChangedBy` does — a plain
FK needs no view.

**Backfilling the rows that predate it.** `scripts/doc/backfill-updated-by.ts` fills a NULL
`updated_by_user_id` by running the two-hop derivation above in reverse: materialize the ydoc for
its `clients` map, and — only when that map names more than one user — walk `ydoc_update`
newest-first for the latest update whose origin clientID is in it. A single-editor doc needs no
walk, which is most of them. It refuses to guess where the map is empty (a doc seeded straight
into the ydoc tables by `seed-sample-data.ts`/`seed-front-page.ts` has no `clients` entries at
all) rather than falling back to the byline: a byline says who *may* edit, not who did. The write
is raw SQL naming only that one column, so `@updatedAt` doesn't move and the
`doc_sync_prose_json_length` trigger doesn't fire, and it carries `AND updated_by_user_id IS NULL`
so a concurrent collab flush's fresher value wins — which is why, unlike
`collapse-blank-lines.ts`, it needn't have the collab server stopped.

## 17. The landing page

`/` has been a bare list of published posts since the first week — `src/app/page.tsx`, a
680px column, inline styles, every published post unbounded. This section turns it into an
actual landing page with four blocks: a **banner** image, a **preamble** taken from a doc, the
**latest posts**, and a **contributor list** in a right-hand column that moves below the
posts when the viewport is too narrow to hold both.

Three of those four are static content the whole world sees identically. The fourth —
contributors — is the only one that needed schema, and it brought a self-service editing
surface with it, which is the substance of this section.

### 17a. Three constraints that exist before anything is designed

**`/` is genuinely ISR-cached again, and must stay that way.** CACHING.md's 2026-07-20
entry recorded that `PostEditBadge` forced `auth()` into the home page and silently turned
a shared static page into a per-request render; §15 deleted that badge, so `page.tsx` now
has `revalidate = 60` and no viewer-identity read anywhere in its tree. That is a real
shared cache today, not a vestigial export. **Nothing added here may call `auth()`,
`cookies()` or `headers()`** — not the contributor list, not the preamble, not the banner.

This constraint is not just a performance note; it decides where the editing UI goes. A
contributor cannot be offered an inline "edit my entry" affordance on the front page itself,
because knowing whether to show it means knowing who is looking. The panel therefore lives
on `/dashboard` (§17g), which already calls `auth()` and is already dynamic — the same
split CACHING.md's 2026-07-23 entry prescribed and §15 finally made true of this route.

**A doc's prose carries marks the public renderer doesn't know.** `docContentExtensions`
includes `authorHighlight` and `annotation`; `contentExtensions`, which every public
surface renders with, does not. The preamble is doc content on a public page, so it needs the
same strip `postContentFromYdoc` (`src/lib/post-content.ts`, §15b) applies before a post's
snapshot is written — for exactly the same reason, and it would fail exactly as loudly if
skipped.

**`src/lib/prisma.ts`'s soft-delete extension only rewrites a *top-level* `where`.** It
does not reach a nested relation filter, and it does not exist at all in raw SQL. Neither
of the queries this section adds joins through a relation, so the trap is dodged — but the
one-time backfill in §17e is raw SQL and spells out both `deleted_by_user_id IS NULL`
checks by hand for precisely this reason.

### 17b. The banner: env-configured, gitignored, and deliberately not `NEXT_PUBLIC_`

The image is deployment content, not repository content — the same argument
`NEXT_PUBLIC_SITE_TITLE` already won (`src/lib/site-config.ts`): a real deployment's
identity should live somewhere `git pull` cannot revert. So the *path* comes from the
environment and the *file* is gitignored:

```
SITE_BANNER="/banner.png"
SITE_BANNER_ASPECT="4724 / 1609"     # optional — defaults to 3 / 1
SITE_BANNER_ALT=""                   # optional — empty is correct for a decorative banner
```

with `/public/banner.*` added to `.gitignore`.

**A new module, `src/lib/site-banner.ts`, rather than three more lines in
`site-config.ts`.** `SiteHeader.tsx` imports `site-config.ts` and is a `"use client"`
component, which is the whole reason `SITE_TITLE` is `NEXT_PUBLIC_`-prefixed — only those
are inlined into the browser bundle. A bare `process.env.SITE_BANNER` added to that module
would read `undefined` in the browser and quietly resolve to the fallback, a footgun that
only bites whoever next imports the constant from a client component. Keeping the
server-only values in their own file makes "this is never readable from the client" a
property of the module rather than a comment on a line.

**Bare, not `NEXT_PUBLIC_`, is also the better operational answer.** DEPLOY.md §4 warns
that every `NEXT_PUBLIC_` var is baked in at `npm run build` and changing one needs a
rebuild. These are read server-side only, so changing them needs a service restart and
nothing more — and swapping the *image file* needs neither, since `public/` is served from
the project directory at runtime. Dropping a new `banner.png` on the server is a `scp` and
a cache expiry.

**`next/image`, not `<img>`.** The file this was built against is 4724 × 1609; serving that
unresized to every visitor is indefensible when the optimizer is already there. `sharp@0.35.3`
resolves under `next@16.2.11` without being a direct dependency, so production optimization
works as-is. The image renders `fill` inside a wrapper carrying `aspect-ratio` as an inline
style — a genuinely per-deployment value, which is STYLE.md's stated bar for inline over
CSS Modules — with `object-fit: cover` and `priority` (it is the LCP element).

Unset `SITE_BANNER` renders nothing at all and the page degrades to preamble + posts +
contributors. A *set* variable pointing at a missing file is left to 404 rather than
detected and hidden: that is a deployment error, and failing visibly is the point.

### 17c. The preamble: a doc found by title

The preamble is the body of the doc titled **`FRONT PAGE`**. `src/lib/front-page.ts` owns
the lookup:

```ts
export const FRONT_PAGE_DOC_TITLE = "FRONT PAGE";
// getFrontPagePreamble():
// findFirst({ where: { title: { equals: FRONT_PAGE_DOC_TITLE, mode: "insensitive" } },
//             orderBy: { createdAt: "asc" },
//             select: { proseJson: true } })
```

**"Preamble", not "blurb", and the distinction is load-bearing.** §17f gives a contributor
their own short rich-text field, and calling both of them a blurb would collapse two
genuinely different mechanisms into one word: this one is a *doc* — ydoc-backed, collab-
edited, multi-author, arriving through the debounce-written `prose_json` cache and therefore
eventually consistent (§17j) — while `contributor_blurb` is a plain `User` column written by
a server action in the web process and live immediately. Nearly every design difference
between the two follows from that split, so the vocabulary should make it hard to conflate
them rather than easy. "Preamble" also carries no implication of brevity, which "blurb"
does and which is wrong here: this is a whole doc, and it can be several paragraphs.
Identifiers follow the prose — `getFrontPagePreamble`, `.preamble` — with `FRONT PAGE`
staying the doc's literal title, since that is a user-facing string an editor types.

**Only `proseJson` is selected, which is what makes "don't show the title" structural
rather than a rule someone has to remember.** The title is the *selector*; it never reaches
the render because it is never read.

**First-created wins.** `Doc.title` has no unique constraint and never will — it is a cache
of the ydoc's title fragment (§12d), written by the collab server, and two docs can trivially
end up with the same one. `orderBy: { createdAt: "asc" }` makes a second `FRONT PAGE` doc
inert rather than letting the front page flip between two preambles depending on which row
Postgres happened to return. The trade-off is that it also makes the preamble awkward to
test in isolation — see §17m.

**Visibility is deliberately not consulted.** The obvious instinct is to require
`DocVisibility.SHARED`, and it is wrong: §12e defines `SHARED` as "anyone with
`canViewDocs`", which is a role gate, not the public. Requiring it would attach a meaning to
that enum value it does not have, and would leave a `SHARED` doc looking world-readable in
the admin UI when it isn't. The title *is* the switch — one mechanism, stated once. A doc's
`visibility` continues to govern `/doc/<slug>` exactly as before; what changes is that a
doc named `FRONT PAGE` also has its body published anonymously, which is the section every
future reader of this repo needs to have read.

Rendering is `renderToReactElement({ content, extensions: contentExtensions })` inside
`proseStyles.prose`, over content passed through
`stripMarksFromDoc(json, ["authorHighlight", "annotation"])` — §17a's second constraint.

`proseJson === null` (a doc created but never edited, so the store debounce has never
fired) omits the preamble rather than falling back to decoding the ydoc the way
`/doc/[slug]/page.tsx` does. That fallback costs a row read and a Yjs decode on a
statically-generated page, to cover a state that resolves itself the moment anyone types a
character.

**Seeding.** `scripts/seed-front-page.ts` creates the doc if and only if one doesn't already
exist, and never clears anything — deliberately *not* folded into
`scripts/seed-sample-data.ts` as the primary path, because that script empties the content
tables wholesale and is not something to point at a database with real content in it. It
copies that script's mechanics rather than reinventing them: the ydoc row is created
eagerly (§12b), and the title is seeded into the **title fragment** as well as the column,
or `server/doc-cache.ts` writes an empty title straight over it on first flush. Adding the
same doc to `SAMPLE_DOCS` for freshly rebuilt databases is a one-line follow-up, noting that
its guard compares against `SAMPLE_DOCS.length` and that count shifts by one.

### 17d. The latest posts

Unchanged markup — the `padding: 1.5rem 0; border-bottom: 1px solid #eee` article block
STYLE.md documents as repeated across home, author and search listings — plus `take: 10`,
where the query is currently unbounded.

That bound has no escape hatch yet: `/posts` is the admin table, and there is no public
archive route. The eleventh-newest post becomes reachable only by search, RSS, or a direct
link. Recorded in TODO.md rather than solved here.

### 17e. Contributors: three new `User` columns, and what they replace

```prisma
isListedContributor Boolean @default(false) @map("is_listed_contributor")
contributorBlurb    Json?   @map("contributor_blurb")
contributorOrder    Int?    @map("contributor_order")
orcid               String? @map("orcid")
website             String? @map("website")
```

All five in one migration. `isListedContributor` is non-nullable *with* a default, so it
does not need the two-step nullable-then-backfill dance CLAUDE.md documents for
`adminInitials` — that is only required for a non-nullable column with no default.

**`isListedContributor` is the membership switch, and it replaces a derived one.** The
first draft of this section computed the contributor list as "anyone with at least one live
published post". An explicit column is better on three counts: the query stops joining
through a relation (and therefore stops needing the manual `deletedByUserId: null` that
§17a's third constraint would otherwise demand); appearing on the public front page becomes
a deliberate editorial act rather than a side effect of publishing; and it gives the
opt-out in §17h something to write to. The cost is real and worth stating: a newly
published author does **not** appear automatically, and an admin has to flip the flag.

So that the list is not empty on day one, the migration backfills it — raw SQL, in the same
migration file, after the `ALTER TABLE`:

```sql
UPDATE "user" u SET is_listed_contributor = true
WHERE u.deleted_by_user_id IS NULL
  AND EXISTS (SELECT 1 FROM post_author pa JOIN post p ON p.id = pa.post_id
              WHERE pa.user_id = u.id AND p.deleted_by_user_id IS NULL
                AND p.publish_event_id IS NOT NULL AND p.published_at <= now());
```

Both `deleted_by_user_id IS NULL` checks are written out because raw SQL is outside the
Prisma extension entirely — the one place in this section where forgetting them would
silently put a deleted author on the public front page.

**`contributorOrder` is a nullable `Int`, not `@default(0)`.** "Unset" needs to be
expressible and needs to sort to the tail, which `{ contributorOrder: { sort: "asc",
nulls: "last" } }` gives directly; a zero default would make everyone tie at the front and
the column would carry no information until someone edited every row.

The query, then, is flat:

```ts
where:   { isListedContributor: true, name: { not: null } },
orderBy: [{ contributorOrder: { sort: "asc", nulls: "last" } }, { name: "asc" }],
```

`name: { not: null }` mirrors `AuthorByline`, which already drops unnamed authors rather
than rendering an empty link. Name is the secondary sort so equal `contributorOrder`
values — including the whole unset tail — are stable rather than arbitrary.

**One card component, two callers.** `ContributorCard` (`src/components/ContributorCard.tsx`)
renders a single entry and is used by both the front page and the dashboard panel's live
preview (§17g). This is `AuthorByline`'s argument applied again: a preview that renders
something *resembling* the real thing is a preview that will eventually lie.

**The avatar.** `User.image` when set, rendered as a plain `<img>` with the same
`eslint-disable-next-line @next/next/no-img-element` precedent `UsersTable.tsx` already
carries — these are arbitrary remote URLs, not a fixed asset set, and `next/image` would
need an `images.remotePatterns` entry per provider. When null, the stand-in is a circle
filled with `User.color` showing `adminInitials`, rather than a generic silhouette asset:
both columns already exist, both are already treated as general-purpose (the admin table
labels the latter simply "Initials", and `doc_metrics.byline` `string_agg`s it), and
`color` is validated to `#rrggbb` on write, so it is safe in an inline style. Worth noting
the mild misnomer being leaned on: `adminInitials` is not admin-only in practice and hasn't
been since `doc_metrics`.

**ORCID is stored bare** (`0000-0002-1825-0097`), not as a URL — one canonical form,
validated against `^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$` plus the ISO 7064 mod-11-2 checksum
(cheap, and catches transposed digits, which a regex alone does not). The
`https://orcid.org/…` link is built at render. **Website** is parsed with `new URL()` and
required to be `http:`/`https:` — that check, not an allowlist of hostnames, is what makes
a stored `javascript:` href impossible. Both live in `src/lib/contributor-links.ts`
alongside `orcidUrl()`.

### 17f. `contributor_blurb` is TipTap JSON, and the schema *is* the validation

A short rich-text line ("Historian of science; writes here about X") wants emphasis, so the
column is `Json` holding a TipTap/ProseMirror document, rendered with
`renderToReactElement` — the same call §17c's preamble, the post pages and the doc pages
already make. There is no `dangerouslySetInnerHTML` anywhere in this section.

**No ydoc, deliberately — this is the first editable content surface in the app that isn't
backed by a `Y.Doc`.** Everything §11–§13 built exists for content with at least one of
three properties: more than one simultaneous author, a history worth replaying, or anchors
that must survive an edit. A contributor's blurb has none. It is one line, owned by exactly
one person, edited on their own dashboard, and changed about twice a year.

Wiring one up would not be reuse, it would be four new integration points: a
`ydoc:contributor:<userId>` sub-namespace in `src/lib/ydoc-names.ts`; a third authz branch
in `/api/ydoc/[id]/token` beside `doc-authz.ts` and `annotation-authz.ts`; a **third
cache-flush path in the collab server** writing to `user` (`server/doc-cache.ts` writes
docs, annotations have their own, neither touches that table); and client provider plus
`attachIndexeddb` wiring under §11e's ref-counting rules. It would also *cost* something:
a column written by the collab process joins §17j's can't-be-pushed bucket, because that
process has no `revalidatePath`. A plain server action revalidates `/` inline and the edit
is live immediately.

What the plain path reuses instead is already load-bearing elsewhere: `getSchema` over a
restricted extension set, `renderToReactElement`, and `toPlainJSON` — which exists in
`tiptap-schema.ts` for precisely this hop, since `editor.getJSON()`'s null-prototype `attrs`
objects are silently replaced by React's Server Action encoder unless they are round-tripped
first. The editor is a plain `useEditor` with `content:` seeded from the column: no
`Collaboration`, no provider, no IndexedDB, and one explicit Save for the whole panel rather
than a per-keystroke debounce.

**`blurbExtensions`, in `src/lib/tiptap-schema.ts` and nowhere else** — CLAUDE.md's rule
that the schema has exactly one home, now with a fourth entry beside `contentExtensions`,
`titleExtensions` and their mark-layered variants. It is the only one with no Yjs variant:

```ts
export const blurbExtensions = [Document.extend({ content: "paragraph" }), Paragraph, Text, Bold, Italic];
export const pmBlurbSchema = getSchema(blurbExtensions);
```

`content: "paragraph"` (exactly one, not `block+`) is `titleExtensions`' trick and buys the
same thing: neither Enter nor a multi-line paste can turn a one-line sidebar entry into a
stack of paragraphs, structurally rather than by CSS clamp.

**Built from individual extensions rather than `StarterKit.configure({ document: false })`,
because that option does not exist.** Verified against `StarterKitOptions` in
`@tiptap/starter-kit@3.29.0`: every node and mark can be switched off — `blockquote`,
`heading`, `bulletList`, `codeBlock`, `horizontalRule`, and the rest — *except* `document`
and `text`. So "exactly one paragraph" is unreachable through configuration, and the
StarterKit-free shape `titleExtensions` already uses is the only way to get it.

That means two new declared dependencies, `@tiptap/extension-bold` and
`@tiptap/extension-italic`. Both are already physically present at 3.29.0 as transitive
deps of StarterKit, so declaring them adds nothing to the install — but they must be pinned
to `@tiptap/core`'s exact version per CLAUDE.md's install note, not `^3.28.0`.

**This narrows CLAUDE.md's "never add `@tiptap/extension-link` separately" rather than
breaking it.** That rule is about double-registering an extension StarterKit already bundles
*within the same schema*; `titleExtensions` already imports Document/Paragraph/Text directly
for a StarterKit-free schema, and CLAUDE.md explicitly calls that out as not a violation.
The wording should be amended to "never alongside StarterKit" when this lands. Link and Code
are left out of the blurb on their own merits: the card already has dedicated website and
ORCID fields, so the one link a blurb would plausibly want is a field already. Either is one
dependency and one array entry away if that turns out to be wrong.

**`undoRedo` stays on.** CLAUDE.md's `undoRedo: false` rule applies when combining StarterKit
with the `Collaboration` extension, which owns the history stack. There is no `Collaboration`
extension here, so the rule inverts — worth stating, because it reads absolute and this is
the one place in the codebase where it doesn't apply.

**Validation is the schema, not an allowlist.** The server action runs
`pmBlurbSchema.nodeFromJSON(json)`, which throws on any node or mark the schema doesn't
define, and stores the re-serialized `.toJSON()`. Nothing unknown survives the round trip —
a structural guarantee, and a strictly stronger one than sanitizing HTML, since there is no
list to keep current and no parser to be differential against. A cap on extracted text
length rides along, so nobody pastes an essay into a 280px column. The self-service action
(§17g) and the admin action (§17i) call one shared validator, so the two write paths cannot
diverge on what they accept.

The alternative weighed and dropped was **HTML plus `sanitize-html`**: a new runtime
dependency, an allowlist to keep current, and `dangerouslySetInnerHTML` on the public front
page — all to reach a weaker guarantee than the schema gives for nothing.

### 17g. The dashboard panel

`ContributorPanel.tsx`, a client component mounted on `/dashboard` beside `SessionRefresh`,
**rendered only when the signed-in user's `isListedContributor` is true.** That flag is read
from the database in the dashboard's server component, not from the session: the JWT bakes
in `id`/`role`/`color` at sign-in and never re-reads (`src/app/sign-in/NOTES.md`), so a
freshly-listed contributor would otherwise not see their own panel until the token turned
over.

Fields: **image URL**, **blurb**, **order** — the three the panel was asked for — plus
**ORCID** and **website**. Those last two are an addition to the brief, made because the
preview underneath renders the real `ContributorCard`, which shows them: a panel that
previews fields it cannot edit invites exactly one bug report. They are trivial to drop if
that reads as scope creep.

Below the form, the live preview renders `ContributorCard` from the *form state* rather
than from the saved row, so it answers "what will this look like" and not "what did this
look like before I started typing".

**The actions are new, and separately guarded.** Every existing `updateUser*` in
`src/app/actions/users.ts` is `requireAdmin()`; these are self-service and belong in
`src/app/actions/contributor.ts` behind a `requireListedContributor()` that (a) resolves the
user from the session, never from a client-supplied id, and (b) re-reads
`isListedContributor` from the database rather than trusting that the panel was only
rendered when it was true.

**One asymmetry carries the entire security model of the panel: these actions can set
`isListedContributor` to `false` and can never set it to `true`.** Setting it true stays in
`actions/users.ts` behind `requireAdmin()`. Without that asymmetry the opt-out in §17h is
theatre — anyone who had ever been listed could put themselves back on the public front
page at will.

**`contributorOrder` is a shared resource and self-service editing of it is a known
compromise.** Nothing stops a contributor setting `0` and jumping the queue. Accepted
deliberately at this scale — a handful of trusted authors, and the name-ascending secondary
sort keeps the result stable rather than random. If it ever stops being fine, moving that
one field to admin-only leaves the rest of the panel untouched.

Each action calls `revalidatePath("/")` alongside its write (§17j).

### 17h. Opting out, and why an admin has to undo it

The panel offers "Remove me from the contributor list" as an **inline two-step confirm** —
the button swaps in place for `Are you sure? [Yes] [Cancel]` — following
`AnnotationNode.tsx` and `CommentNode.tsx`, which is the established pattern here. Not
`window.confirm`: there is not one call to it anywhere in this codebase, and there is no
reason for this to be the first.

The confirmation text names the consequence rather than gesturing at it: **you will need an
admin to put you back**. That is a true statement about §17g's asymmetry, not a scare
message, and a contributor who understands it before clicking is the entire point of making
this two steps instead of one.

On success `router.refresh()` re-renders the dashboard, `isListedContributor` is now false,
and the panel is simply gone — the same condition that gated it in the first place, with no
separate "you have opted out" state to maintain.

### 17i. `/users` gets the same five columns

All five (`isListedContributor`, `contributorBlurb`, `contributorOrder`, `orcid`, `website`)
join the users admin table as movable columns, all `defaultHidden: true` per §16m so no
existing admin's table silently widens by five columns on deploy.

That means **both** `UsersTable.tsx`'s `ColumnSpec[]` and `ADMIN_TABLE_COLUMNS.users` in
`src/lib/admin-table-columns.ts` — the hand-duplication §16m documents and explicitly warns
must be kept in step.

**Four of the five sort; `contributorBlurb` does not, and that is the `image` column's
precedent rather than a new exception.** `isListedContributor`, `contributorOrder`, `orcid`
and `website` are plain scalar `User` columns, so Prisma's `orderBy` reaches them directly
and each gets a `sortKey` plus a `case` arm in `src/app/users/page.tsx` — per CLAUDE.md
every column on every admin table sorts, and none of these needs a view to do it. `orcid`
and `website` also join that page's `q` OR-list.

`contributorBlurb` is `Json`, which Prisma's `orderBy` cannot reach at all, and the
documented escape hatch — a view keyed 1:1 on the table's primary key (§16e/§16l) — would
need a SQL text-extraction function over TipTap JSON to sort by. That is the `doc_length`
recursive CTE all over again, built for a default-hidden column on a table of a few dozen
rows, to support an alphabetical ordering of one-line biographies that has no user. So the
cell renders an `extractText` excerpt and carries no `sortKey`, exactly as `image` already
does on this same table: shown, not sorted, not inline-editable. It is also left out of the
`q` OR-list, since `contains` doesn't reach into `Json` either. If sorting or searching it
ever matters, `Doc.proseJsonLength`'s trigger-maintained-column pattern is the answer, not
a view.

Editing the blurb therefore stays where §17g put it. The other four get admin actions in
`actions/users.ts` behind the existing `requireAdmin()`, sharing `contributor-links.ts`'s
validators with the self-service pair so the two paths cannot diverge on what they accept —
and an admin blurb editor, if one is ever wanted, shares §17f's `pmBlurbSchema` validator
for the same reason. `updateUserIsListedContributor` is the **only** code path that sets
that flag true.

### 17j. Cache invalidation, and the one thing that can't be pushed

`revalidatePublicPaths` (CACHING.md, 2026-07-23) already revalidates `/` on publish and
unpublish, so the post list is covered. Every action in §17g and §17i adds
`revalidatePath("/")` to whatever it already revalidates, so contributor edits land
immediately.

**Preamble edits cannot be pushed.** `Doc.prose_json` is written by the collab server's
debounce (`server/doc-cache.ts`) — a *different process*, with no access to Next's
`revalidatePath`. An edit to the `FRONT PAGE` doc therefore reaches the public page after
the store debounce plus up to 60s of ISR. A webhook from collab into the web app would close
that, and is not worth a cross-process dependency for a preamble that changes a few times a
year.

The contrast with `contributor_blurb` is the whole of §17f's argument in one line, and the
reason §17c insists the two have different names: same kind of content, same TipTap JSON,
but written by a server action in *this* process, so it revalidates inline and is live
immediately. Which process owns the write is what decides this, not what the content is.

CACHING.md's 2026-07-24 finding — that `revalidatePath` reaches the server's Full Route
Cache but not a browser's own `s-maxage` copy — applies here unchanged.

### 17k. Build order

1. **Schema.** Five columns, one migration, the backfill SQL in the same file. Stop
   `dev:all`, `npx prisma migrate dev --name add_user_contributor_fields`, restart.
2. **`blurbExtensions` + `contributor-links.ts`.** `npm i @tiptap/extension-bold@<core's
   exact version> @tiptap/extension-italic@<same>`; the fourth schema and `pmBlurbSchema` in
   `tiptap-schema.ts`; the ORCID/website validators and `orcidUrl()`. No UI yet, and no new
   runtime dependency beyond two already-installed transitive ones.
3. **`ContributorCard` + the contributor query.** Renderable in isolation before anything
   links to it — `renderToReactElement` over `blurbExtensions` for the blurb.
4. **The landing page.** `site-banner.ts`, `front-page.ts`, the grid, `take: 10`, and
   `page.tsx`'s inline styles moved into `page.module.css` — it is one of the last inline-style
   holdouts.
5. **`scripts/seed-front-page.ts`**, so step 4 has something to render.
6. **The dashboard panel** and `actions/contributor.ts`.
7. **`/users` columns** and the admin actions, including the only set-to-true path.
8. **`e2e/landing.spec.ts`**, docs (STYLE.md, DEPLOY.md §4, TODO.md, and CLAUDE.md — the
   `.env` vars, the `FRONT PAGE` title convention, and §17f's narrowing of the
   never-add-`extension-link`-separately rule to "never alongside StarterKit").

Steps 1–5 are the landing page and stand alone; 6–7 are the editing surfaces and can land
separately if the branch wants splitting.

### 17l. Layout, and a third column width

```css
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px;
          gap: 2.5rem; max-width: 1040px; margin: 0 auto; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
```

Contributors are second in DOM order, so the narrow case needs no `order` juggling — the
aside simply flows below the posts, which is the requested behaviour and also the correct
reading order.

1040px is a **third** centered-column width alongside the 680px (listings) and 800px
(full-text) STYLE.md documents. It is not a drift: the main column inside it stays at
roughly 680px and the extra width is the sidebar plus its gap. STYLE.md gets a line saying
so, since the next person to add a page will otherwise read three widths as three accidents.

### 17m. Known gaps

- **A contributor blurb has no history and no concurrent editing.** That is §17f's decision
  working as intended, not an oversight, but it does mean a mis-save is unrecoverable — no
  `ydoc_update` log to replay, no revision to fall back to, and last-write-wins if a
  contributor has their dashboard open in two tabs. Acceptable for one line owned by one
  person; the moment a blurb wants either property, §11's stack is what it should move onto,
  and the four integration points §17f lists are the actual cost of that move.
- **The preamble is awkward to assert on in isolation.** §17c's first-created-wins tie-break
  means a spec that creates its own `FRONT PAGE` doc loses to any pre-existing one — the
  same class of problem the column-order spec hit against the site-wide default. The spec
  therefore asserts that *a* preamble renders and that the literal string `FRONT PAGE` does
  **not** appear anywhere on the page, rather than asserting on specific preamble text.
  Production determinism was judged worth more than test convenience; reversing the tie-break
  to newest-wins would swap which of the two is easy.
- **No public post archive.** §17d's `take: 10` has nothing to link "older posts" to.
- **No self-service profile page.** `/dashboard`'s panel edits the contributor-facing
  fields only; name, slug, color and role remain admin-only, and a user who is not a listed
  contributor has no self-service surface at all.
- **Contributor membership does not follow publishing.** §17e's explicit flag means an
  author's first published post does not add them to the front page. Whether that ought to
  be a nudge on `/users` (a "published, not listed" hint) or left alone is unresolved.
- **The banner has no admin surface.** It is env plus a file on disk, which is right for a
  self-hosted single deployment and wrong the moment a non-technical editor wants to change
  it. `SiteSettings` is where that would go if it ever matters.

### 17n. Avatars move off remote URLs and into Postgres

`User.image` was a remote URL — originally the Auth.js adapter's field, and
what §17e first rendered. That works, and for the seeded Wikimedia portraits it
was defensible, but it has three costs that only grow:

- **Every visitor's browser talks to a third party.** `next/font/google`
  self-hosts at build time, so contributor avatars were the *only* third-party
  runtime request on `/` — leaking each visitor's IP, User-Agent and Referer to
  whoever hosts the image, on the one page everybody lands on.
- **Link rot and hotlink blocking.** Wikimedia explicitly discourages
  hotlinking; any host can rename, 403, or disappear.
- **The host controls what renders.** A URL's contents can be swapped after the
  fact, on the front page, with no change on our side. Low risk for Wikimedia;
  a real vector for a contributor-supplied URL pointing somewhere they control.

Avatars are now stored as bytes in Postgres and served from our own route.

#### Why not base64 data URIs — the option that looks equivalent and isn't

"Store it in the database" and "serve it as base64" are orthogonal decisions
that are easy to weld together. Storing bytes is right here; inlining them as a
data URI would have been wrong, and specifically wrong *because of this app*:

`/` is an ISR-cached shared HTML artifact (`revalidate = 60`, §17a). A data URI
becomes part of that payload — re-sent in full on every visit by every visitor,
never separately cacheable, never eligible for an ETag, and re-serialized into
the cache entry on every regeneration. With five contributors at ~5KB each
that is ~25KB welded onto every page load, permanently, in exchange for saving
some first-visit round trips that HTTP/2 multiplexing already made cheap.

The counterargument is real but narrow: below ~1–4KB, inlining does save a
round trip, and a 40px avatar is in that range. It is a cold-first-visit win
only, and a blog front page is dominated by repeat visits.

So: bytes in the database, served from a route, with the browser keeping its
own cache entry. That is strictly better than the data URI on every axis they
differ, and the only thing it costs is one route handler.

#### The table, and the `SELECT *` trap it exists to prevent

`user_avatar` is its own table rather than a `Bytes` column on `User`, for one
concrete reason: `src/app/users/page.tsx` queries with `include:` and no
`select:`, so Prisma returns **every scalar column**. An avatar column on
`user` would drag up to 100 blobs (the max page size) into the RSC payload on
every `/users` load, to render 32px circles — silently, because nothing in that
query names the column. A separate table cannot be reached by a wide select on
`user`, which turns "remember to deselect the blob" into "the blob is
unreachable from here". Every query that *does* want it names `avatar: {
select: { hash: true } }` and never `bytes`.

`userId` is the primary key rather than a separate id: one avatar per user, and
the lookup the route does on every request is then a primary-key hit.

**`User.image` is deliberately untouched.** It belongs to the Auth.js adapter
contract (`PrismaAdapter`, `src/lib/auth.ts`), which specifies a string URL and
would populate it from an OAuth provider's profile. Retyping it would break
that contract. `resolveAvatarSrc` (`src/lib/avatar-url.ts`) encodes the
precedence: self-hosted upload → remote `User.image` → null, at which point the
colored initials circle renders. Only `Credentials` is configured today, so the
remote branch is dormant rather than a live privacy cost — but it is why
"self-hosted avatars" is not the same claim as "no third-party image request is
possible".

#### The hash is what earns `immutable`

The route is `/api/avatar/<userId>/<hash>`, where `hash` is a content hash of
the stored bytes. Replacing an avatar changes the hash and therefore the URL,
so the handler can answer `Cache-Control: public, max-age=31536000, immutable`
without any risk of serving a stale image. The same hash is the `ETag`, so a
conditional request answers 304.

One case needs care rather than a rule. `/`'s HTML is cached for up to 60s, so
a reader can hold HTML referencing a hash that was current when the page was
generated and is not current now. 404ing that would show a broken image for the
remainder of the window. Instead the handler serves the *current* bytes — the
reader sees the right person's face — but downgrades to
`max-age=0, must-revalidate`, because a URL whose content just moved has no
business claiming immutability. Fresh hash and stale hash are the same lookup;
only the header differs.

The route is public and unauthenticated on purpose: the contributor list is
public content, and `/` must not call `auth()` (§17a). Nothing there reads a
session, so the response stays cacheable by any intermediary.

#### Ingestion, and what it obliges

`processAvatar` (`src/lib/avatar.ts`) re-encodes every upload through `sharp`
to a 160px square WebP. Re-encoding is not an optimization here, it is the
security and privacy step:

- **EXIF, including GPS, is stripped** — `sharp` drops metadata on re-encode
  unless `withMetadata()` is called. Uploaded phone photos routinely carry
  coordinates, and this image is published publicly. Verified rather than
  assumed: a test JPEG carrying 224 bytes of EXIF including GPS tags comes out
  with zero.
- **`.rotate()` with no argument bakes the EXIF orientation into the pixels**
  *before* that metadata is discarded — otherwise a portrait phone photo would
  be stored sideways.
- **The format is sniffed, never trusted.** The declared content type of an
  upload is attacker-controlled; `sharp` decodes the actual bytes and anything
  it can't parse is rejected. (The declared type is still checked first, only
  to produce a clearer message than a decode failure.)
- `limitInputPixels` caps the decompression bomb at 50MP against `sharp`'s
  ~268MP default. This is the **only** ingestion limit, deliberately. A 5MB
  byte cap sat beside it originally and was removed once the cropper landed
  (§17o): bytes predict decode cost badly — a 2MB PNG can be 100MP — so the
  pixel ceiling is both the stricter and the more honest guard, and a byte cap
  loose enough not to reject real photographs never bound anything the pixel
  ceiling didn't. The app-level byte check was also unreachable from the
  dashboard, since Next's 1MB Server Action `bodySizeLimit` answers a larger
  body with a 413 before the action is entered.

160px is 4× the 40px card slot, so one stored size covers the dashboard preview
and 2× displays without a second variant — which is what lets the render path
skip `next/image` entirely. Routing an already-correctly-sized, content-hashed,
immutably-cached WebP through the optimizer would add a hop and a second cache
layer to re-derive what ingestion already produced. `ContributorCard` therefore
keeps a plain `<img>` and an eslint-disable, with that as the stated reason —
the *remote* fallback keeps the original reason too, since arbitrary hosts
would each need an `images.remotePatterns` entry.

**There is deliberately no "avatar from URL" path.** Having the server fetch a
user-supplied URL is textbook SSRF — internal addresses, cloud metadata
endpoints. The only URL fetch in this feature is
`scripts/seed-sample-data.ts`'s, against hardcoded constants. A remote
`User.image` still renders, but the *browser* fetches that, not us.

#### The upload surface

The dashboard panel's "Image URL" text field becomes a file input plus a
"Remove photo" control, with its own action rather than a field on the combined
Save (§17g): it carries binary in a `FormData`, it should apply immediately
rather than waiting for a Save the user might not press, and its failure modes
are entirely its own. The action returns the new URL so the preview can
repoint without a round trip through the server component. Both actions sit
behind the same `requireListedContributor` as the rest of the panel, and both
`revalidatePath("/")`.

The panel says, in the UI and not only here, that the image is stored on this
site and that location data is removed — a claim the user should be able to
read before uploading a photo of themselves.

#### Known gaps

- **`pg_dump` now carries the avatars.** DEPLOY.md §9's daily dump grows by
  roughly 5KB per contributor — negligible at this scale, and consistent with
  the ydoc `BYTEA` already riding along in the same dump, but it is a real
  change to what backup means. Object storage would decouple them; at
  single-Linode scale that is more moving parts than it is worth.
- **No CSP is configured**, so the tighter `img-src 'self'` this now makes
  possible isn't actually enforced anywhere yet.
- **An admin cannot upload on someone else's behalf.** `/users` shows the
  avatar but doesn't edit it, same as it always did for `image`.
- **Avatars are never garbage collected beyond the `ON DELETE CASCADE`.**
  Replacing an avatar overwrites the row, so there is no orphan accumulation —
  but there is also no history, and no way to undo a replacement.

### 17o. Choosing the crop, in the browser

`processAvatar` resizes with `fit: "cover", position: "attention"` — sharp's
saliency heuristic picks which square of a non-square photo survives. That is a
reasonable default and the wrong decision-maker: which square represents
someone is a judgement only they can make. Picking a file now opens a cropper
(`src/components/AvatarCropper.tsx`) that drags and zooms the photo behind a
circular mask, and what gets uploaded is the crop.

**The crop happens client-side, and that is the load-bearing choice.** The
alternative — POST the original plus crop parameters and `.extract()`
server-side — needs this same UI anyway, *plus* a wider `FormData` contract and
parameter validation, so it is strictly more code for the same result. It also
changes what crosses the wire: a fixed ~320px square of tens of KB whatever the
source was, rather than the user's multi-megabyte original. That is what lets
Next's 1MB Server Action `bodySizeLimit` and nginx's 1MB `client_max_body_size`
both stay at their defaults, and it is why the byte caps above could go.

320px is 2× the stored `AVATAR_SIZE`: the canvas does the *crop* and `sharp`
does the final reduction with a proper resampling kernel, which is better than
asking `drawImage` to do the whole downscale from a phone photo.

None of this weakens ingestion, which is unchanged and still runs on every
upload. A hand-crafted POST that skips the cropper entirely is exactly as
constrained as it was before — re-encoded, EXIF-stripped, format-sniffed,
pixel-capped. What did change is *coverage*: the canvas strips EXIF before the
server ever sees the bytes, so no browser-driven upload can exercise the
server-side strip any more. That guarantee now needs a direct test of
`processAvatar`, not an e2e one.

**Crop parameters are deliberately not persisted.** Storing them so a user
could re-adjust later requires keeping the original in the database — and the
original is the copy that still has the GPS EXIF in it, which would quietly
undo the claim the panel makes to the user's face. Re-adjusting means
re-uploading.

**Minimum zoom is "covers the circle", not "contains the photo".** Letting the
slider go below cover was built and then reverted: it fits the whole photo in,
letterboxed against transparency (WebP carries alpha and `processAvatar`
preserves it), but a circular avatar that doesn't fill its circle reads as
broken rather than deliberate — and choosing which part of a photo shows is the
job this control exists to do. The rejection is recorded in the component so it
isn't re-derived as an improvement.

Two defects worth keeping, both invisible to `tsc`, `eslint`, and any
value-level test:

- **The object URL must be created *and* revoked inside one effect.** Created
  in a `useState` initializer and revoked in an effect cleanup — the shape that
  most obviously satisfies `react-hooks/set-state-in-effect` — it dies on
  StrictMode's first cleanup with nothing to recreate it (App Router sets
  `__NEXT_STRICT_MODE_APP` by default), and *every* pick fails with "That file
  couldn't be read as an image." Handing the URL to the DOM node inside the
  effect satisfies the same lint rule properly, by synchronising an external
  system rather than copying a derived value into state.
- **`.field input` in `ContributorPanel.module.css` was a descendant
  selector**, so a text input's padding and border landed on the cropper's
  range input nested one level deeper — leaving the zoom slider's track 145.2px
  inside a 160px box. The 7.4px of dead margin at each end still looked
  draggable, because the border was drawn around it. The *values* stayed
  reachable programmatically, which is exactly why a `fill()`/keyboard test saw
  nothing wrong; only measuring the track caught it. Narrowed to
  `.field > input`.

`e2e/avatar-crop.spec.ts` covers both, and draws its own source image rather
than reading a committed one — every geometry assertion is derived from the
source's dimensions, so a checked-in file could be swapped for one of a
different shape and break the spec without a line of code changing. That is not
hypothetical; it is how the spec came to be written this way.

## 18. Margin notes: comments and annotations beside the text they belong to

Built 2026-08-12. A comment thread and an annotation both already know exactly which
passage they belong to, and both spent that knowledge on a quoted-text header at the top
of an entry in a list below the article. The reader had to hold the mapping across a
scroll. Above 1200px there is room not to ask, so each card is positioned level with its
own quote.

**Only the anchored cards move.** `CommentSection` and `AnnotationSection` stay exactly
where they were, below the article, and keep everything that isn't a placeable card: the
`<h2>`, the comment form / annotation composer, the own-drafts list, the sort dropdown,
and every entry that has no live anchor — a general-discussion thread, a `DETACHED`
comment thread, an annotation whose mark is gone (§12h). The rail is not "the comment
section, relocated"; it is a second destination for the subset of cards that can point
at something. That keeps the authoring surface where a reader already knows to look for
it, and means the rail never has chrome of its own competing with the article beside it.

Everything below the breakpoint is unchanged — one stacked list, same order, same
markup minus a couple of wrapper divs. This is a reflow breakpoint in STYLE.md's sense
(alongside 900px and 480px), not an overflow fix.

### 18a. Why this is a JS layout and CSS only does half of it

Where a passage lands on screen depends on its content and the viewport width. It cannot
be declared, only measured — `editor.view.coordsAtPos()` against a live editor, which
every reading surface here already mounts and already calls for its selection popover.

The split that matters: **CSS owns the two-column grid, JS owns the vertical alignment.**
So the rail is in the right column from first paint, server-rendered, and only the
per-card `top` waits for hydration. `useMediaQuery`'s server snapshot is a hard `false`
(there is no `matchMedia` during SSR), which would otherwise mean the whole rail popped
into place after hydration rather than just settling.

Three modules, deliberately separable:

- **`src/lib/margin-notes-layout.ts`** — the packing rule alone, pure and DOM-free. Sort
  by where each card wants to be, then walk down placing each at the lower of its own
  wish and the previous card's bottom. Exact alignment wherever there is room; a stable
  cascade wherever there isn't. The invariant worth more than any single card's
  precision: **no card ever appears above one whose anchor is earlier in the document.**
  The packer still handles anchorless cards (they sort last, keeping their input order),
  which the reading surfaces no longer send it — they keep those below instead. The doc
  editor's rail is the caller that relies on it, via `bounds` rather than by placing
  them; keeping the case in the pure function costs nothing and means the rule doesn't
  have to be re-derived if a surface ever wants "anchored first, then the rest".
- **`src/components/margin-notes/use-margin-notes-layout.ts`** — the measuring, and the
  triggers. Positions are written straight to `element.style`, never held in React
  state. Position depends on post-paint measurements, and the doc surfaces re-measure on
  every remote keystroke; a render per measurement would be the wrong shape.
  `pseudo-border.ts` already sets that precedent for the same reason.
- **`src/components/margin-notes/margin-notes-context.tsx`** — carries two things across
  subtrees that are siblings under the page and so have no prop between them, the same
  problem `DocPresenceProvider` solves for awareness (§13i): the article's **editor**
  (only it knows where a quote landed) and the rail's **DOM node** (see the portal
  below). Its change channel is a plain listener set, not a state counter: bumping state
  on every remote keystroke would re-render the article *and* every card, to move cards
  that are moved imperatively anyway.

**The anchored cards are portaled, not re-rendered elsewhere.** `CommentEntryList` and
`AnnotationList` still own every entry — the sort order, the permalink/`hashchange`
effect, and the comment/annotation tree rendering — and `createPortal` moves the DOM of
the anchored subset into the rail without moving that ownership. Splitting the list into
two sibling components instead would have forked all three, and would have needed the
sort state lifted into a third place to keep the two halves consistent.

`pseudo-border.ts` gained multi-root support for the same reason: a card can now sit in
either the section or the rail, and a bar placed unconditionally in the section would
mark a rail card in the wrong column, at an offset measured against a container it isn't
in. It now resolves `target.closest("[data-comment-section], [data-pseudo-border-root]")`
and appends there; `clearPseudoBorders` went document-wide, which it always effectively
was ("at most one activation on the page").

Recompute triggers are: the editor mounting, `window.resize`, a `ResizeObserver` on the
container, on every card, and on the editor's own DOM node (a card growing when a reply
composer opens; the article reflowing on a late font), the editor's `update` event, and
the context's channel. All funnel through one `requestAnimationFrame` gate.

**The degradation is deliberate.** The `.anchored` class is toggled from JS, not from a
`@media` block, so a page whose script fails renders the plain stacked list rather than
a pile of cards at the container's origin.

### 18b. Two ways to answer "where is this anchored", because the two sides differ

This is the one place the post and doc sides genuinely cannot share code, and the
asymmetry is old (§5 vs. §12i) rather than anything this section introduced.

- **A post comment** has stored integer offsets (`anchorFrom`/`anchorTo`) into an
  immutable published snapshot. Resolving a card is a direct `coordsAtPos(anchorFrom)`.
  `from`, not `to` — the card lines up with where the quote *starts*.
- **A doc annotation** has to be resolved against the live document either way, and since
  §13o there are two ways. A mark-anchored one has no stored offset at all and must be
  *found* — `collectAnnotationMarkRanges` walks the live ProseMirror document once per pass.
  A column-anchored one has stored offsets, but into a document that has kept moving since,
  so they are tracked per transaction rather than trusted. `resolveAnnotationRanges`
  (`src/lib/annotation-marks.ts`) merges both into one id → range map, and that is what
  every consumer here calls; nothing in the layout knows there are two mechanisms.

Scanning the live document rather than trusting the server matters more than it looks.
`getDocAnnotationsAsThreads` decides quoted-vs-general against `Doc.proseJson`, which is
a store-debounce snapshot and therefore stale by seconds whenever anyone is typing. That
is fine for deciding whether to draw a quote header; it is not fine for deciding which
paragraph a card sits beside. Reading the editor means a card follows its text as an
author edits above it.

`DocReadingBody` needs one wire `AnnotatableArticle` does not: remote content arrives via
`setContent(…, { emitUpdate: false })`, so the editor's own `update` event never fires
and cards would stay where the *previous* body put them. `onContentPushed` — the surface's
existing choke point for exactly this class of bug — now reports to the layout alongside
re-resolving the pending selection.

A thread whose anchor can't be resolved (a `DETACHED` comment thread, whose offsets are
frozen against a revision that isn't on screen; an annotation whose mark is gone, §12h)
is simply absent from the map, which is exactly the signal that keeps it in the section
below rather than in the rail.

**Which ids are anchored is the one thing that goes through React state**, because it
decides what renders *where* rather than merely where it sits — unlike the positions,
which are written straight to the DOM. `useMarginNotesLayout`'s `onAnchoredIdsChange`
fires only when the resolved set actually changes, never on the per-keystroke passes that
find the same set, so the common case costs no renders at all.

That state is **seeded from data, not from zero**: a post comment from
`anchorFrom !== null && status === "ACTIVE"`, an annotation from the server's
`quotedText !== ""`. Both are computed from props, so SSR and the first client render
agree, and the first anchored render is already correct in the overwhelmingly common
case instead of flinging half the list across the page a frame later. Seeding is all
those values are trusted for — §18b above is why the live scan then overrides them.

**The sort dropdown stays visible and keeps working.** It orders the section below, which
is now its only real job, and a control that disappears on a viewport change would be
worse than one whose effect is partial.

### 18c. The doc editor's rail is narrower on purpose

An author revising a passage had to leave for the reading view to see what had been said
about it. The editing view now carries a rail too — but three deliberate differences,
only the last of which needed new machinery:

- **Presently-anchored only, and nothing below.** No general-discussion bucket, no card
  for an annotation whose mark is gone, and no stacked list under the editor at any
  width: below the breakpoint `EditorAnnotationRail` renders nothing at all. The editing
  view answers "what is attached to the text in front of me", and an annotation with no
  mark has no answer to give there — where the reading view, which is also where
  annotations are *composed*, does have to account for it.
- ~~Read-only cards.~~ **As built (§18f): interactive.** `AnnotationNode`'s `readOnly`
  prop is gone — this was its only caller — so Reply and Delete work from the editor the
  same as from the reading view. Creating annotations from the editor is now built too;
  see §18f.
- **A window, not a list.** The doc body scrolls inside its own frame here
  (`EditorChrome.module.css`'s `.editorContent`), not with the page. That is the one
  structural difference: on a page-scrolled surface the article and the rail move
  together, so a card's offset within its container is invariant under scroll, whereas
  here it is not. The layout hook's `bounds` option covers it and this is its only
  caller — cards track the internal scroll, and one whose anchor has left the frame is
  hidden rather than pinned to an edge.

`CollabEditorBody` marks that scroll frame with `data-editor-scroll`
(`src/components/editor-scroll.ts`). An attribute rather than a class because CSS-module
names are hashed per build and so aren't addressable from a `querySelector` in another
module; a shared constant rather than a literal because two components have to agree on
it and neither should import the other.

`DocEditor`'s container became a flex **row**, with the column behaviour every child
relies on moved down to `.mainColumn`. The height budget is unaffected: `.mainColumn`'s
height comes from the row's default `align-items: stretch`, which is definite, so
`.editorFrame`'s `flex-grow` still has something to grow into (STYLE.md's Global
baseline). `CollabEditorBody`'s `onEditorReady`, which this page passed an empty function
for since it was written, is what the rail measures against.

### 18d. Prepared, not built: reconciling attached vs. detached against the live document

`collectAnnotationMarkRanges` answers "which annotations are presently anchored, and
where" against the live document — which is exactly the input a doc-side equivalent of
the post side's remap-on-publish (§5) would need. Today nothing consumes it that way:
an annotation whose mark is gone still degrades to document-level via §12h's per-render
derivation from `Doc.proseJson`, and no status is written anywhere.

It is built as a shared module rather than inline in each surface specifically so that
when something does consume it, there is **one** definition of "presently anchored"
rather than three drifting ones. Two things a future phase will have to decide, neither
of which this section prejudges:

- **Who writes, and when.** Every reader's browser has this map, and letting each one
  persist a correction is N clients last-writer-wins on the field whose whole job is
  precision — §14d already documents that trap for doc-link anchors and resolves it by
  only ever persisting from a *write*-mode surface. The doc editor's rail is now such a
  surface, which is the natural place for it.
- **Whether a mark that reappears un-detaches.** Undo exists; an author deleting an
  annotated sentence and immediately undoing it should not have cost the annotation its
  anchor. That argues for the status being derived-and-cached rather than a latched
  one-way transition, unlike §12h's current one-way degrade.

### 18e. Known gaps

- **The split only happens after hydration**, so a wide viewport paints the whole list
  in the section once and then lifts the anchored cards out of it. There is no way
  around this without knowing the viewport server-side: `useMediaQuery`'s server snapshot
  must be `false`. The same reading views already swap a static body for an editor on
  `ready`, which is a larger visible change accepted for the same reason, and the split
  is deliberately gated on the *same* flag rather than on a separate one so the two
  settle together rather than in sequence.
- **An entry moving between the rail and the section remounts its subtree.** React sees
  a different parent, so an open reply composer or an in-progress delete confirmation on
  that card is discarded. Only reachable when an author's edit removes or restores the
  marked text while a reader has that exact card open — rare, and the alternative
  (rendering both destinations and hiding one) would duplicate every permalink `id` in
  the document.
- **The rail doesn't scroll independently on the reading surfaces.** A document with
  many anchored comments makes the rail as tall as the article, which is intended, but
  a document with *one* comment near the end leaves a tall empty column. Sticky
  positioning would fix the latter and break the former.
- **No e2e coverage.** The positioning is measured geometry, which is exactly what a
  spec can assert on (`boundingBox()` per card versus per highlight) and exactly what a
  reviewer cannot check by reading. `packMarginNotes` being pure is half of that debt
  already paid; nothing exercises it yet.
- **340px is fixed.** The rail doesn't grow on a very wide viewport, so a 2560px screen
  gets more whitespace rather than roomier cards.

### 18f. Annotating from the doc editor

§18c's rail could show what had already been said; an author still had to leave for the
reading view to say something new. Building the composing half required an anchor that
survives the thing the reading view's own selection can't: a collaborator editing *inside*
the range while the composer sits open. That is precisely COLLAB.md §5's Yjs relative
positions, and precisely why they went unbuilt until now — the reading view has no
`ySyncPlugin` binding to convert against, and the doc editor does.

**The pieces, each new:**

- `src/lib/yjs-relative-anchor.ts` — this codebase's first app-level `Y.RelativePosition`
  code (`captureRelativeRange`/`resolveRelativeRange`). Everywhere else a relative
  position is used, it's inside y-prosemirror's own internals (`CollaborationCaret`'s
  awareness cursor). Never serialized, on purpose — see COLLAB.md §5 and the file's own
  header for the `gc: true` reasoning that rules a persisted one out.
- `src/lib/use-editor-annotation-widget.ts` — the editor's counterpart to
  `useSelectionPopover`, same shape (capture/reresolve/clear/popoverRef) but no
  text-search fallback: `reresolve` either still resolves the captured range or the
  content is gone, full stop. Adds `resolveAnchor`, called once at submit time rather than
  composing time — the actual payoff, since it means the final anchor reflects whatever
  concurrent typing happened while the composer was open, with no re-verification pass.
  Also owns the two-stage geometry below, which is where it stops resembling
  `useSelectionPopover` at all.

**Two stages, because selecting text while editing is not a request to annotate.** This is
the substantive difference from both reading views, and the reason this surface could not
just reuse their popover. On a reading view a selection is a strong signal — there is
little else to do with text you cannot edit — so `useSelectionPopover` opens its composer
immediately, over the text. In an editor, selecting is how you bold a word, move a
sentence, or read with the mouse; a panel appearing over the text on every one of those is
noise in the middle of someone's work. So:

- **Stage one is a marker beside the document, never over it** — `.annotateMarker`
  (`DocEditor.module.css`), a 28px outline bubble in the gutter, level with the *start* of
  the selection. It costs nothing: no DRAFT row, no live connection, no layout change. It
  says only that annotating is possible. Its resting opacity is the dial for how much
  presence that claim gets — it started at 55% and is currently full, with the hover rule
  and the opacity transition left in place as the other half of that dial rather than
  because they do anything at 1.
- **Stage two is the composer, opened where the marker was**, on click. It passes
  `AnnotationPopover`'s new `autoOpen`, which skips that component's own "Annotate" button
  — the marker already asked that question, and the reason the button exists (not spinning
  up a row and a connection on every micro-adjustment of a selection still being dragged)
  is already paid for by the marker being free. Without `autoOpen` this surface would ask
  twice to reach one composer.

**The width floor is derived from that geometry, not chosen.** `.container` is a centred
`max-width: 800px` column, so the text box's right edge sits at `(W + 800) / 2 - 16` and
the marker needs 44px clear to its right — no gutter exists below **W ≥ 856**. The floor is
`900px` (STYLE.md's nearest documented width). Below it the marker is *not offered at all*
rather than repositioned: clamping it back over the text would defeat the one thing it
exists to do. This supersedes the "iPhone 12 Pro Max portrait" (428px) figure the feature
was specced against — that number was picked as the width above which there would be room
beside the document, and measurement says there isn't any until 856. Nothing is lost
between the two: a doc's annotations are still composed from its reading view, which has
its own popover and no width floor. `e2e/text-selection.spec.ts` asserts the clearance at
1280/960/900 and the absence at 700, so the arithmetic can't go stale if the column's
width or padding changes.

The *expanded* panel is best-effort about staying out of the way — `placePopover` still
slides it left to fit, so above ~1200px it lands clear of the text and below that it
overlaps. Accepted: by then it is a panel the author deliberately opened, not one that
appeared over their work.
- `provisionalPlacement` moved out of `use-selection-popover.ts` into
  `popover-placement.ts` as a shared export — both hooks need the identical two-phase
  bootstrap (a same-batch provisional placement so the popover exists in the DOM before
  its real size can be measured), and it was pure geometry with no reason to live under
  one hook's file.
- `CollabEditorBody` gained `onSelectionUpdate`/`onContentUpdate` passthroughs (it had
  neither — only the reading view's `useLiveDocContent` did) and registers
  `PendingAnnotation`, the same view-only decoration the reading view uses, unconditionally
  — harmless on every other embedder.
- `AnnotationPopover`/`LiveAnnotationComposer` gained three optional props rather than a
  parallel composer: `allowMoveToBottom` (false here — no bottom composer on this page),
  `autoOpen` (see the two-stage note above), and `resolveAnchor`.
  `LiveAnnotationComposer.handleSubmit` treats `resolveAnchor` as authoritative over the
  literal `anchorFrom`/`anchorTo` props when present, including posting document-level (not
  falling back to the stale literals) when it resolves to null.
- `DocEditor` wires the widget to `.mainColumn` as both the click-outside and
  popover-bounds region (no wrapping div, so `DocEditor.module.css`'s flex-height chain
  is untouched), supplies `getFrame` scoped to that column (the hook lives in `src/lib`,
  which doesn't import from `src/components`, so `EDITOR_SCROLL_ATTRIBUTE` isn't reachable
  from inside it — and a caller-scoped lookup can't match some other editor's frame the
  way a global `querySelector` could), and feeds `provider.awareness` into
  `DocPresenceProvider`, which `edit/page.tsx` now wraps the page in (alongside
  `AnnotationMoveProvider`, required because `AnnotationPopover` calls `useAnnotationMove()`
  unconditionally regardless of `allowMoveToBottom`).
- `EditorAnnotationRail`'s cards lost `readOnly` — Reply and Delete work there now, same
  as the reading view. `AnnotationNode`'s `readOnly` prop is gone entirely (that rail was
  its only caller).

**Not built:** presence for an in-progress *widget* (as opposed to an already-open
composer) — §13i's "someone is writing an annotation" line still only appears once a
draft row exists, same gap noted there for the inline popover. A not-yet-posted selection
has no stable identity to hang a presence marker on until then.

**A real reentrancy bug, found by e2e, and a known residual after fixing it.**
`CollabEditorBody.tsx`'s `onUpdate`/`onSelectionUpdate` originally called `onContentUpdate`/
`onSelectionUpdate` synchronously — both fire from inside tiptap's own `dispatchTransaction`,
mid-unwind of the transaction that triggered them, and `useEditorAnnotationWidget`'s
`reresolve`/`clear` can themselves update React state and dispatch a further transaction on
the same view. `e2e/quote-anchoring.spec.ts`'s "an edit outside the quote moves the anchor"
case caught it directly: typing `"Yesterday, "` at the very start of a document under
`page.keyboard.type` (which sends real, rapid keystrokes, not a single batched insert)
landed the string mid-word, ~35% of runs. Two independent fixes, both applied:

1. `use-editor-annotation-widget.ts`'s `clear` is a true no-op — no state update, no
   dispatch — when nothing is pending, since `capture` calls it on every keystroke's empty
   selection on this editor (unlike the reading view, where the equivalent only fires on a
   mouse drag).
2. `CollabEditorBody` defers both callbacks with `setTimeout(fn, 0)`, not `queueMicrotask` —
   a microtask can still run before the browser finishes dispatching the *next* queued input
   event under rapid typing; a macrotask waits for that to settle first.

Together these cut the failure rate to roughly 1 in 10-14 runs. Isolating further (see the
session's own diagnostic trail, not reproduced here) showed the *entire* remaining rate
reproduces identically with `onUpdate`/`onSelectionUpdate` registered as **completely empty**
functions — proving the residual isn't in this codebase's logic at all, but some interaction
between tiptap/prosemirror-view's own event pipeline and a `Collaboration`-bound editor
receiving keystrokes faster than a human ever types. Accepted rather than chased further:
`page.keyboard.type`'s per-character dispatch has no real-user equivalent, and the two fixes
above are correct regardless of whether they touch the residual's actual mechanism. Revisit
if it ever surfaces outside this one stress pattern.

**A second, separate bug: the widget never appeared at all**, caught by manual testing after
the above — the e2e trail above exercises typing, not selecting, so it never would have
caught this. `yjs-relative-anchor.ts` imported `ySyncPluginKey` from `y-prosemirror`, but
Tiptap v3's `@tiptap/extension-collaboration` binds through **`@tiptap/y-tiptap`**
internally (`node_modules/@tiptap/extension-collaboration/dist/index.js`) — Tiptap's own
fork, a separate package with its own `PluginKey` instance. `PluginKey.getState()` matches
by object identity, so the wrong package's key doesn't error, it just always resolves to
`undefined`, exactly as if the editor had no Collaboration binding — `captureRelativeRange`
silently returned `null` on every real selection. Fixed by importing from `@tiptap/y-tiptap`
instead, now an explicit direct dependency (`package.json`, pinned `^3.0.7` — it was already
present transitively via `@tiptap/extension-collaboration`'s own dependency, at the same
resolved version, so this changes nothing about what's installed, only makes the import
supportable). `server/ydoc-hooks.ts`'s own `y-prosemirror` import is unaffected and correct
as-is — a stateless Yjs↔ProseMirror conversion with no plugin-state lookup involved, not the
same category of usage.

---

## 19. PDF files and a collaborative PDF viewer

### Context

MultiBlog can host *docs* (TipTap over Yjs) but not *files*. The need is to upload PDFs,
list and permission them the way docs already are, and read them in-browser with the same
quote-anchored annotation conversation `/doc/[slug]` has — plus something docs never needed:
multiple people reading one long document at different places, able to see and join each
other's position.

[docs/PDF.md](docs/PDF.md) settles the renderer (PDF.js) and the hard constraint
(**annotations live outside the PDF; the file is read-only**), and recommends an anchor
model, coordinate rules, layer structure and sync wire format. This plan adopts that
document, with the deviations listed under *Deviations from docs/PDF.md* below.

Intended outcome: `/files` (an admin table with upload) and `/pdf/[slug]` (a viewer with
annotations, presence, and opt-in follow), reusing the existing annotation stack rather
than growing a second one.

---

### Decisions taken

#### Annotation storage — copy `/doc/[slug]`'s split, not a single ydoc

The comparison, since it drives everything downstream:

A single `ydoc:pdf:<fileId>` holding `Y.Map<id, Annotation>` (docs/PDF.md §9's literal
recommendation) wins on three things: awareness needs a per-file ydoc *anyway*, so
annotations would ride a connection that must exist regardless; the annotation list would
update live where `/doc/[slug]` needs a `router.refresh()`; and offline creation would merge
on reconnect.

It loses on five, all specific to this codebase:

1. **Hocuspocus authorizes the connection, not the keys.** Every connected client receives
   every `Y.Map` entry. Two rules currently enforced in Postgres would break: a `DRAFT` is
   invisible to everyone but its author (`getDocAnnotationsAsThreads`), and delete/restore is
   `requireOwnOrAdmin` with a `deletedByUserId` audit. In a `Y.Map` anyone with a writable
   connection can read another's draft and delete or resurrect any key, unattributed.
2. **`/annotations` would go blind.** CLAUDE.md requires every admin table to filter, sort
   and paginate in Postgres. A `Y.Map` is unqueryable from there, so PDF annotations would be
   absent from that listing or need a second, JS-side one.
3. **`RAISED` (notify authors) has no server trigger** — a `Y.Map` write is a client
   mutation the Next server never sees, where `postAnnotation` is a server action that
   flushes, validates, stamps and emails.
4. **One never-truncated update log per PDF** carrying every keystroke of every annotation
   body, downloaded in full on open. Today a body's history loads only when that body opens.
5. **CRDT merge has nothing to merge.** A PDF annotation's *target* is written once and
   never moves — the bytes are immutable and `docId` is a content hash (docs/PDF.md §4). The
   only concurrently-edited thing is the body, which already has its own ydoc.

So: **records → Postgres, ephemeral viewport → awareness**, which is the split
`/doc/[slug]` already makes and docs/PDF.md invariant 5 states. The per-file ydoc still gets
built — it just carries awareness and nothing else.

#### The other two forks

- **Bytes → content-addressed filesystem**, not a Postgres `bytea`. Prisma cannot stream a
  `Bytes` column, so a 50MB file would land whole in Node's heap on upload *and* on every one
  of PDF.js's range requests.
- **`/pdf/[slug]` → full-viewport app shell**, not the page-scrolled `/doc/[slug]` layout.
  This removes the need for PLAN.md §18's `createPortal`: the rail and the annotation list
  are the same scroller, so cards are positioned within the panel that already owns them.

---

### Phase 0 — Dependency and version pin

- `npm i pdfjs-dist@6.2.108` — **exact, no caret** (docs/PDF.md invariant 6, §10). ESM-only
  (`.mjs`); `serverExternalPackages` in [next.config.ts](next.config.ts) may need it if the
  Node-side text extraction (Phase 1) trips the same double-load issue `yjs` has.
- `e2e/pdfjs-internals.spec.ts` — the smoke test §10 asks for. Asserts the specific internals
  we touch still exist: `EventBus`, `PDFViewer.prototype.scrollPageIntoView`,
  `pageView.div`, `viewport.convertToPdfPoint`, `viewport.convertToViewportRectangle`, and
  the `textlayerrendered` / `updateviewarea` / `pagesinit` event names. An upgrade then fails
  loudly here rather than silently at runtime.
- Worker: set `GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" })`.
  Verify under Turbopack at implementation time; fall back to copying the worker into
  `public/pdfjs/` from a `postinstall` script if the `new URL` form doesn't survive bundling.

---

### Phase 1 — The file table, storage, and upload

#### Schema (`prisma/schema.prisma`)

**Model named `StoredFile`, `@@map("file")`.** The table is `file`; the generated TS type
must not be `File`, which would shadow the DOM/Node global that the upload code uses.

```
model StoredFile {
  id, slug @unique, title, filename, contentType, byteSize Int, sha256 String,
  pageCount Int?, visibility DocVisibility @default(PRIVATE),
  createdAt, updatedAt, updatedByUserId, deletedByUserId, deletedAt
  owners FileOwner[]  slugHistory FileSlugHistory[]
  annotations Annotation[]  metrics FileMetrics?
  @@map("file")
}
model FileOwner       { fileId, userId, ownerOrder, @@id([fileId, userId]) }
model FileSlugHistory { id, fileId, slug @unique, createdAt }
model FilePageText    { fileId, pageIndex, textVersion, text, @@id([fileId, pageIndex, textVersion]) }
view  FileMetrics     { fileId @unique, owners String?, annotationCount Int }
```

- `DocVisibility` is reused as-is rather than cloned — it is already the site's
  PRIVATE/SHARED vocabulary, and the user-facing rule is explicitly "same as docs".
- **`FileOwner`, not `FileAuthor`.** Nobody listed on an uploaded PDF wrote it: the list is
  seeded with whoever uploaded the file, is editable afterwards, and grants the `/files`
  display line, the right to rename/re-slug/re-own/delete, and — for a `PRIVATE` file — the
  right to read it at all. That is ownership, not credit. The word stops here:
  `DocAuthor`/`PostAuthor` are accurate, and so is the shared filter kit
  (`AuthorFilterPanel`, `authorFilterWhere`, `AuthorMode`), which `/files` reaches through
  `ownerFilterWhere`/`listOwnerFilterOptions` and an aliased import rather than renaming.
- `FileMetrics` is built by **grouping `file_owner`**, never selecting `FROM file` — the
  lesson `add_doc_metrics_view` records (Postgres 18's self-join elimination only fires for
  INNER joins, and Prisma emits a LEFT JOIN for a to-one ordering). `annotationCount` is a
  filtered count (excludes soft-deleted), which is exactly the case CLAUDE.md says belongs
  in a view. `byteSize`/`pageCount` are plain stored columns — no view, no trigger.
- `FilePageText` holds the **normalised** page text (docs/PDF.md §3), extracted server-side
  at upload. This resolves §12's first open question in favour of storing it, and it is what
  lets `quotedText` stay server-derived (see Phase 3) without re-parsing the PDF per post.

**`Annotation` gains a second container.** `docId` becomes nullable; `fileId String?` is
added with `onDelete: Cascade`; a hand-written `CHECK ((doc_id IS NOT NULL) <> (file_id IS
NOT NULL))` goes in the migration — same technique `DocLink`'s `mark_id`/`mark` CHECK uses,
since Prisma has no CHECK DSL. Required→nullable is a plain `DROP NOT NULL` with no
interactive backfill prompt, so this is one migration.

**`pdfTarget Json?`** carries docs/PDF.md §2's `Target` verbatim — `{ pageIndex, quads,
quote, position, textVersion }` — as one column rather than seven. That is invariant 3
(renderer-neutral, a renderer swap is a rendering change not a data migration), and it
follows `DocLink.mark`'s precedent of an anchor as a JSON blob. `quotedText` reuses the
existing column for `quote.exact`, so `/annotations`' Quote column needs no PDF branch.

A **reply** to a PDF annotation needs nothing new: §13p already anchors a reply into its
parent annotation's own ydoc via `anchorFrom`/`anchorTo`, and a PDF annotation's body is an
ordinary `ydoc:annotation:<id>`. Only *roots* use `pdfTarget`.

#### Byte storage

`FILE_STORAGE_DIR` (bare env var, gitignored path, default `.file-storage/`), laid out
content-addressed: `<dir>/<sha256[0:2]>/<sha256>`. Dedupe is free, and the hash *is*
docs/PDF.md's `DocId`. New `src/lib/file-storage.ts` (server-only) owns pathing, the
streaming write, and the read stream.

**This is a new backup surface** — `pg_dump` no longer captures everything. DEPLOY.md needs
a line saying so.

#### Upload route — `src/app/api/files/upload/route.ts`

`POST /api/files/upload?filename=<encoded>` with the **raw bytes as the body**, not
`multipart/form-data`. Two reasons: `await request.formData()` buffers the whole file into
memory, and raw-body avoids pulling in a multipart parser. A Route Handler is not subject to
Server Actions' `bodySizeLimit` at all — that is the limit the user asked to bypass, and
this is how (`uploadContributorAvatar` in [src/app/actions/contributor.ts](src/app/actions/contributor.ts)
documents the constraint from the other side).

Flow: `request.body` → `createWriteStream(tmp)` while hashing incrementally and counting
bytes; abort past `MAX_UPLOAD_BYTES` (`FILE_MAX_UPLOAD_BYTES` env, default 50 × 1024 × 1024);
verify the `%PDF-` magic on the first chunk; `rename` into the content-addressed path;
extract `pageCount` and per-page normalised text with `pdfjs-dist/legacy/build/pdf.mjs`;
create the `StoredFile` + `FileOwner` + `FilePageText` rows in one transaction, claiming the
slug through it (the `claimSlug` convention the importers use — `uniqueFileSlug` queries the
global client and can't see rows the same transaction created).

Slug from the upload filename, via the existing `slugify` + `RESERVED_SLUGS` machinery in
[src/lib/slug.ts](src/lib/slug.ts); `src/lib/file-slug.ts` mirrors
[src/lib/doc-slug.ts](src/lib/doc-slug.ts) exactly (`uniqueFileSlug`, `changeFileSlug`,
`revertFileSlug`, its own namespace, no catch-all against post/doc slugs).

#### Download route — `src/app/api/files/[id]/[hash]/route.ts`

Session-gated by `canUserReadFile` (unlike the avatar route, which is deliberately public).
Streams from disk with **`Range` support** — PDF.js range-requests a large PDF instead of
pulling it whole. `ETag: "<sha256>"`, `Cache-Control: private, max-age=31536000, immutable`,
and the same stale-hash graceful path the avatar route uses.

#### nginx

Add to the `location / { … }` block in
[deploy/nginx-app.conf.sample](deploy/nginx-app.conf.sample):

```nginx
    # PDF uploads (PLAN.md §19). nginx's default client_max_body_size is 1m,
    # which rejects every upload before it reaches Next. Keep this >= the app's
    # FILE_MAX_UPLOAD_BYTES; the app reports a mismatch rather than hanging.
    client_max_body_size 64m;
    client_body_timeout  300s;
    # Stream the body straight through instead of spooling 64m to disk first.
    # Also makes an over-limit upload fail fast with a clean 413 up front.
    proxy_request_buffering off;
```

#### Catching a misconfigured proxy

Three layers, because an under-configured nginx fails in two different ways:

1. **`GET /api/files/limits`** → `{ maxUploadBytes }`. The client refuses an over-sized file
   locally, before any bytes leave the browser.
2. **`413` on upload** → "The reverse proxy rejected this upload before it reached the app.
   nginx's `client_max_body_size` is probably below the app's limit (N MB) — see
   `deploy/nginx-app.conf.sample`." Uploads go through `XMLHttpRequest` rather than `fetch`,
   for progress *and* because a proxy that resets the connection mid-body surfaces as an
   opaque `TypeError: Failed to fetch`; a rejected `xhr` with `status === 0` on a body over
   ~1MB gets the same message.
3. **Admin-only "Check upload limit"** button on `/files`, which POSTs a
   `MAX_UPLOAD_BYTES`-sized throwaway body to `/api/files/upload?probe=1` (discarded, no row
   written). An honest end-to-end proxy check to run once after a deploy, rather than
   discovering the limit with someone's real 40MB PDF.

#### Permissions — `src/lib/file-authz.ts`

Mirrors [src/lib/doc-authz.ts](src/lib/doc-authz.ts) function for function:
`canUserReadFile` (SHARED → `canViewFiles`; PRIVATE → listed `FileOwner`s alone, no
ADMIN/EDITOR bypass), `canUserManageFile`, `canEditAnySharedFile`, `readableFilesFor`.

`canViewFiles` / `canManageFiles` go in [src/lib/role-checks.ts](src/lib/role-checks.ts)
with the same role sets as their doc counterparts and **deliberately not delegating to
them** — the precedent and its rationale are already written above `canManageDocs` and
`canEditAnySharedDoc`. `role-checks.ts` is the right home because `SiteHeader` (a client
component) needs `canManageFiles` for the nav link.

#### `/files` page and nav

- `src/lib/files-query.ts` over [src/lib/table-query.ts](src/lib/table-query.ts), + a
  `FilesTable.tsx` built from `src/components/table/` — the kit, not a fresh `<table>`.
  Columns, all sortable: Title, Filename, Owner(s) (`file_metrics.owners`), Visibility, Pages,
  Size, Annotations (`file_metrics.annotationCount`), Created, Updated, Updated by, Slug,
  Deleted at, Deleted. Slug/Created/Deleted default hidden, matching `/docs`.
- Row scoping copies `docs/page.tsx`'s `authorScope` verbatim as `ownerScope`: own row in
  `file_owner` OR
  (`canEditAnySharedFile` && SHARED), with an **ADMIN-only `?showAllFiles=1` checkbox**. That
  is exactly the rule asked for — ADMIN-only PRIVATE visibility, EDITOR sees all SHARED,
  AUTHOR sees only their own.
- Upload control above the table, where `/docs` has `+ New doc`.
- [src/components/SiteHeader.tsx](src/components/SiteHeader.tsx): a `Files` link gated on
  `canManageFiles` (ADMIN/EDITOR/AUTHOR). The user asked for it "to the right of Users";
  `Users` is ADMIN-only and `Files` is AUTHOR-and-up, so it is pushed into `leftNav` after
  the `users`/`site-settings` entries and will simply appear left of nothing for a
  non-ADMIN. Flagging rather than deciding silently.
- `scripts/test-file.ts` following the `test-doc.ts` containment convention.

---

### Phase 2 — `/pdf/[slug]` viewer shell (no annotations yet)

`src/app/pdf/[slug]/page.tsx` — server component: resolve slug (with `FileSlugHistory`
redirect, as `resolveDocParam` does), gate on `canUserReadFile`, render the shell.

`src/components/pdf/PdfViewer.tsx` — `"use client"`, loaded through `next/dynamic` with
`ssr: false` (pdfjs touches `DOMMatrix`/`Path2D` at import time).

- Built on **`PDFViewer` + `EventBus` + `PDFLinkService` from `pdfjs-dist/web/pdf_viewer.mjs`**,
  with `pdfjs-dist/web/pdf_viewer.css` imported.
- A cumulative page-offset table is built once on `pagesinit` from
  `pdfPage.getViewport({ scale: 1 }).height` — the **public** API — rather than reading
  `PDFViewer._pages`. This is what every "document fraction" in Phase 4 is computed against.
- Layout is the full-viewport app shell: `SiteHeader` + a flex row of
  `[presence rail | viewer | indicator strip | annotation panel]`, the viewer scrolling
  inside its own box. `globals.css`'s `height: 100vh/100dvh` on `body` is what gives that
  box a definite main size — the same budget `DocEditor.module.css`'s `.container` relies on.
  Below `MARGIN_NOTES_MEDIA_QUERY` (1200px) the panel becomes a toggled overlay.
- Toolbar: page number/count, prev/next, zoom (`page-fit`, `page-width`, numeric), rotate.

---

### Phase 3 — Anchoring and annotations

#### Text normalisation — `src/lib/pdf-text.ts`

docs/PDF.md §3's pipeline, as a **pure function of `getTextContent()` output**, shared by
the browser and the Node-side upload extraction so the two cannot drift:
gap-based space insertion + `hasEOL` newlines → NFKC → ligature decomposition → strip soft
hyphens/zero-width → normalise dashes and quotes → collapse whitespace. Exports
`TEXT_VERSION = \`${pdfjsVersion}/${NORMALISER_VERSION}\`` and builds the offset map
(normalised index → `{ itemIndex, charOffset }`) client-side. Cached per
`(fileId, pageIndex, textVersion)`.

#### Capture — `src/lib/pdf-anchor-capture.ts`

docs/PDF.md §5 exactly: `getSelection().getRangeAt(0)` → split by page → per page
`getClientRects()` → subtract `pageView.div.getBoundingClientRect()` → `convertToPdfPoint`
each corner → quads; plus `quote`/`position` from the normalised page text (never from the
DOM — §11's Hypothesis trap). Rectangle selection is a drag on the `.annoLayer` producing a
single quad with an empty `quote` and null `position`.

CSS pixels from `getBoundingClientRect()`, never canvas backing-store pixels; the page's
**current** rotation passed into every `getViewport`.

#### Resolution — `src/lib/pdf-anchor-resolve.ts`

docs/PDF.md §4 order: exact quote match searching outward from `position.start` → **[step 2
deferred, see below]** → quads fallback → orphaned if the text under the resolved quads
fails the quote check. Since the bytes are immutable, steps 1–2 exist only to survive *our
own* normaliser changes; the quads path is always available and always correct.

#### Layer — `src/components/pdf/anno-layer.ts`

Carries out docs/PDF.md §6 (the `.annoLayer` sibling, its teardown on page eviction, and
invariant 4's **never touch `.textLayer`/`.annotationLayer`**) and §7 (delegated click
handling with the ~4px travel suppression). Those rules are stated there and not repeated
here — this phase is where they get built, and §6's "re-derive rects from quads on every
render, never cache across a scale change" is the one most easily lost in a refactor.

Imperative rather than React-per-page, which follows from §6's eviction rule rather than
being a separate choice: PDF.js virtualises and rebuilds these nodes underneath any
component that thinks it owns them.

#### Server side

- `postAnnotation` ([src/app/actions/annotations.ts](src/app/actions/annotations.ts)) gains a
  `"pdf"` anchor mode beside `"mark"`/`"columns"`. It derives `quotedText` **server-side**
  by slicing `FilePageText.text` at `position` and comparing it to the client's claim —
  keeping §12i's "the selected text is a request field only, never a column" intact, and
  cheaply, because the text was extracted once at upload. A rect-only annotation stores
  `quotedText: ""`. `ydocUpdateId` is null for a PDF root (there is no update log for an
  immutable file); a reply still stamps its parent body's log, unchanged.
- `createDraftAnnotation` takes a container discriminant instead of a bare `docId`.
- `canUserAccessAnnotationYdoc` ([src/lib/annotation-authz.ts](src/lib/annotation-authz.ts))
  takes `{ doc } | { file }` and routes to `canUserReadDoc` / `canUserReadFile`. Its `DRAFT`
  owner-only rule is unchanged.
- `/annotations` ([src/app/annotations/page.tsx](src/app/annotations/page.tsx)): a Container
  column that links to either `/doc/…` or `/pdf/…`. Its `doc.proseJson` content-boundary
  work is skipped for PDF rows — `quotedText` is already stored, so there is nothing to
  excerpt from a document body.

#### Panel — `src/components/pdf/PdfAnnotationPanel.tsx`

Reuses `AnnotationNode`, `QuoteThreadHeader`, `AnnotationColorStyles`,
`NewAnnotationComposer`, `LiveAnnotationComposer`, `OwnDraftsList`, `pseudo-border.ts` and
`MarginNotes.module.css` unchanged.

**One small refactor** makes the layout machinery shared rather than duplicated:
[use-margin-notes-layout.ts](src/components/margin-notes/use-margin-notes-layout.ts) is
already source-agnostic in design ("Surfaces differ in how they answer this — which is the
whole reason this is a callback rather than a prop shape") but typed against a TipTap
`Editor` in four places: the `anchored` gate, `resolveTops(editor)`, `observer.observe(editor.view.dom)`,
and `editor.on("update")`. Replace those with a `{ element, onChange }` source supplied by
`MarginNotesProvider`, so `resolveTops` becomes `() => Map<string, number>` and callers close
over their own source. Mechanical, touching `margin-notes-context.tsx`,
`use-margin-notes-layout.ts`, `AnnotationList.tsx`, `CommentEntryList.tsx`,
`EditorAnnotationRail.tsx` — three working surfaces, so `npm run e2e`'s coverage of
`/doc/[slug]` matters here.

The hook's existing **`bounds`** option is exactly right for this shell: it is documented for
"a surface whose article scrolls inside its own box", hides cards whose anchor has scrolled
out of the band, and attaches the scroll listener. That is the PDF viewer precisely.

`PdfAnnotationList` is a thin sibling of
[AnnotationList.tsx](src/components/annotation/AnnotationList.tsx) — same shape, three
differences: `resolveTops` converts quads → page element → CSS `y` instead of reading
`coordsAtPos`; the `quoteIndex` sort mode orders by `(pageIndex, y)`; and there is **no
`createPortal`**, because in the app shell the rail and the list are the same scroller.
Un-sharing rather than parameterising follows §13c's own precedent (`AnnotationList` was
deliberately un-shared from `CommentEntryList` once the rendering problems diverged).

**The rail holds what is on screen, and is therefore never taller than the panel.**
`resolveTops` ([PdfAnnotationSurface.tsx](src/components/pdf/PdfAnnotationSurface.tsx))
answers only for annotations whose resolved rects intersect the viewer container's own rect —
not for every annotation on a page pdfjs has built, which is a buffer extending well above and
below the visible region. An id absent from that map is out of the rail; the panel's two modes
are what the reader chooses between:

- **Rail** — cards for passages on screen, each level with its own passage. It scrolls only
  when more annotations are anchored on screen than fit beside them.
- **All** — every annotation as a plain list in document order, positioned by nothing. This
  is where an annotation the reader hasn't scrolled to lives, and the only place a
  document-level one (no target at all) appears. Below the 768px breakpoint the panel is a
  full-width overlay with no document beside it, so this is the only mode and the toggle is
  not rendered.

Out of the rail means `display: none`, **not unmounted**, and that is load-bearing twice
over: a card can be holding an open reply composer — a live Hocuspocus connection and a
`DRAFT` row — or a delete confirmation, and scrolling its passage off screen must not discard
either; and the id list `usePdfMarginNotes` keys its effect on stays stable, so membership
changing on every scroll doesn't tear down and rebuild its `ResizeObserver` and pdfjs
subscription. The hook skips any card with a null `offsetParent` so a hidden one doesn't take
a slot in the cascade at zero height.

[margin-notes-layout.ts](src/lib/margin-notes-layout.ts) is unchanged and stays shared with
the doc rail. Its clamp is one-sided by design — `cursor` starts at 0, so nothing is ever
placed above the container's top — and with membership bounded to the visible band there is
nothing left for a bottom clamp to catch.

---

### Phase 4 — Presence, viewport sync, and follow

#### Transport

A per-file ydoc `ydoc:pdf:<fileId>` that stays **empty** and carries awareness only —
docs/PDF.md invariant 5 taken literally. Additions:

- `src/lib/ydoc-names.ts`: `YDOC_PDF_PREFIX = "ydoc:pdf:"`, `ydocIdForFile`,
  `fileIdFromYdocId`, and `docIdFromYdocId` excludes the new prefix the same way it already
  excludes `ydoc:annotation:`.
- `src/app/api/file/[id]/token/route.ts` mirroring
  [api/doc/[id]/token/route.ts](src/app/api/doc/[id]/token/route.ts). Every token is
  `readOnly: true` — nobody ever writes content to this document, and awareness is unaffected
  by `connectionConfig.readOnly`.
- `server/ydoc-hooks.ts` needs no branch: `ydocOnLoadDocument`'s `createIfAbsent` handles a
  name nobody made, and `updateDocCache`/`updateAnnotationCache` already no-op on a prefix
  that is neither. The row accrues one empty state and never changes.
- `PdfPresenceProvider` mirrors
  [doc-presence-context.tsx](src/components/annotation/doc-presence-context.tsx), exposing
  the awareness object to sibling subtrees.

#### Wire format (`src/lib/pdf-presence.ts`)

Wider than docs/PDF.md §9's `ViewportState`, which carries a viewport and nothing else:

```ts
type PdfPresence = {
  user: { id, name, color },                          // author palette
  viewport: { pageIndex, pdfPoint: [left, top], zoomMode, t } | null,
  selection: { pageIndex, quads: Quad[] } | null,
  leading: boolean,          // "I'm presenting — come join me"
  following: string | null,  // clientId being followed
};
```

`user` makes a remote cursor attributable, `selection` puts an in-progress selection on the
wire before it becomes an annotation, and `leading`/`following` give §9's follow semantics a
place to live. **The §9 rules are unchanged and still stated there** — never `scrollTop`,
`scrollLeft`, a pixel offset or a raw scale; all three echo guards; ~10 Hz outbound with no
queue, since awareness coalesces. Recorded as a divergence in docs/PDF.md §13.

#### The three affordances

1. **Broadcast + follow.** A reader sets `leading: true`; others see "N is presenting —
   Follow". Following applies their viewport via
   `scrollPageIntoView({ pageNumber, destArray: [pageIndex, {name:"XYZ"}, left, top, null] })`
   — `null` zoom, so a follower sees the same *content* at their own zoom. Any genuine local
   scroll gesture (distinguished from a programmatic one by `applyingRemote`) drops the
   follow immediately, plus an explicit "Stop following". One-directional only; §9 is
   explicit that symmetric mutual following is unusable.
2. **Left pseudo-scrollbar.** A 1px line the full height of the viewer, with a circle per
   remote reader at their document fraction, in their author color. Click → jump to that
   position.
3. **Right indicator strip.** Same 1px line, carrying (a) a viewport thumb showing the
   visible fraction, drawn only when it would be ≥20px tall, and (b) one tick per annotation
   at its document fraction in its author's color, clickable to jump.

Both rails are pure functions of document fraction — that math goes in
`src/lib/pdf-rail-layout.ts`, DOM-free, the same split
[margin-notes-layout.ts](src/lib/margin-notes-layout.ts) makes and for the same reason.

**Remote selections** are drawn into the same `.annoLayer` as annotation highlights, in the
author's color, for whichever pages are rendered — "always show selection if it would be
visible on other users' views" falls out of the layer only existing for rendered pages.

---

### Phase 5 — Documentation

- **PLAN.md §19** — the whole design (per the §10 convention: a dedicated section, so no §10
  entry). Must record: why annotations are Postgres rows and not a `Y.Map`; why the per-file
  ydoc exists and is empty; why `Annotation.docId` went nullable; why bytes are on disk.
- **CLAUDE.md** — `FILE_STORAGE_DIR` / `FILE_MAX_UPLOAD_BYTES` in the env list; the
  `StoredFile`-not-`File` naming reason; "never position a PDF annotation off anything but
  the live quads"; the pinned-pdfjs rule.
- **docs/PERMISSIONS.md** — files as a fifth pair of tables, or a note that they follow the
  doc tables exactly with `canViewFiles`/`canManageFiles` substituted.
- **docs/PDF.md** — flip §12's "server-side normalised text?" open question to *settled:
  stored*, and record the §10 deviation below.
- **DEPLOY.md** — the nginx block, and that `FILE_STORAGE_DIR` is a second backup surface
  `pg_dump` does not cover.
- **docs/COLLAB.md** — a PDF quad anchor as a third strategy in its comparison, with the
  point that it cannot drift because the bytes cannot change.
- **scripts/integrity/check-pdf-anchors.ts** — the sibling of
  `check-annotation-anchors.ts`: for every PDF annotation, slice `FilePageText` at
  `position` and confirm it still equals `quotedText`. Like its sibling, this verifies a
  claim written down once rather than a derived value, so nothing else would catch a break.

---

### Deviations from this plan, and deferrals

**Where the *implementation* departs from docs/PDF.md, look there, not here:
[docs/PDF.md](docs/PDF.md) §13 is that list** — `PDFViewerApplication` vs `PDFViewer`,
§9's annotations-as-ydoc not taken, and §4 step 2's fuzzy match and §3's lazy re-anchor both
deferred. It carries two further records that never had an entry here, which is the point:
the two copies had already drifted, and one of them is the file a reader of docs/PDF.md
will actually reach for.

What follows is the other kind — where the shipped feature departs from the phase
descriptions *above*, which is this document's own business.

- **The right strip's viewport thumb ships disabled** (Phase 4 item 3a above), behind
  `SHOW_VIEWPORT_THUMB` in `PdfRails.tsx` rather than deleted. The scrollbar sits about ten
  pixels from the strip and says the same thing; two grey bars that close read as a
  rendering fault rather than as one position shown twice. Keeping the code costs nothing
  and buys the only on-screen check of the fraction arithmetic — the thumb is drawn from
  `visibleFractionRange` over `buildPageOffsets`, the scrollbar beside it from the engine's
  own `scrollTop / scrollHeight`, so the two disagreeing is exactly what a bug in that
  arithmetic looks like. The 20px `MIN_VIEWPORT_THUMB_PX` rule and its e2e coverage stay as
  specified, since the switch is the only thing between them and a visible thumb.
- **Neither rail is "a 1px line the full height of the viewer"** (items 2 and 3 above), and
  the viewer's scrollbar is restyled rather than native. Both follow from the same
  requirement, which the phase description doesn't state: a marker at a document fraction
  has to land where the scrollbar between the two rails says that fraction is. It didn't —
  by up to 18px, from an arrow-button inset no API reports, and by a further 9px at any zoom
  past fit-width, from a rail covering the container's border box while the track stops at
  its client box. The rails are now pinned to `container.clientHeight` and the scrollbar is
  drawn from `::-webkit-scrollbar` pseudos, after which the two agree to within 0.0px in
  Chromium. The engine facts, the measurements, what this costs Firefox and Safari, and why
  no e2e spec can see any of it: **STYLE.md, "Custom scrollbars, and anything positioned
  beside one"**. Why it is done *here*: `PdfViewer.module.css` and `PdfRails.tsx`.
- **The `Files` nav link is placed after `Users`/`Site Settings` in the same left group**,
  which for a non-ADMIN means it is the only entry there. The literal reading ("to the right
  of Users") can't hold for AUTHOR/EDITOR, who never see `Users`.
- **The annotation panel speaks the file surface's vocabulary**, where `/doc/[slug]` speaks
  the doc's. On `/pdf/[slug]`:
  - The composer's visibility select offers exactly **PRIVATE** and **SHARED** — the words a
    file's own visibility uses everywhere else (`DocVisibility`, `/files`' Visibility
    column), so an annotation on a file doesn't introduce a second vocabulary for the same
    distinction.
  - The submit button reads **Save**. The select beside it already names the outcome; the
    doc side spells the outcome out on the button instead, because there the button is the
    only thing that does.
  - There is therefore **no "Post & notify authors" on a file**, so `RAISED` is unreachable
    from `/pdf/[slug]`. The path itself is live — `postAnnotation`'s `raise` branch mails a
    file's owners, and a doc annotation offers it — so this is a gap in the PDF UI, not a
    missing capability. Worth knowing before wondering why file owners get no mail.
  - **The panel has no sort control**: order is (page, then down the page, creation time
    breaking ties). Above the breakpoint this panel *is* the margin-note rail, where each
    card sits level with its own passage, so any other order fights the positioning hook
    rather than re-sorting the list. `AnnotationList` on `/doc/[slug]`, which is a plain
    list below its own rail, keeps its sort dropdown.

  The wording lives in `LiveAnnotationComposer`'s optional `container` prop (defaulting to
  `"doc"`), threaded from the `AnnotationTarget` that `NewAnnotationComposer` and
  `AnnotationNode` already carry — so the two surfaces share one composer and one submit
  path, and only the labels and the option list differ.
- **The annotation panel is a tabbed side panel, and its toolbar control is an icon** —
  Phase 3 specified one button reading "Annotations / Hide annotations". There are three
  things worth putting beside the viewer — the annotations, the keyword chips (§20d) and a
  pane held for presence — and the column has room for exactly one at a time.

  The two questions are therefore asked in two places. The toolbar carries a **show/hide
  icon** and says nothing about contents; the panel carries a **tab strip** — Annotations ·
  Metadata · Collab — and says nothing about whether it is open. A fourth pane touches the
  panel alone, and closing and reopening comes back to the tab you were on. The icon is a
  drawn pane outline whose right section is **filled while the panel is open**, so the button
  reports state rather than only naming its target: `aria-pressed` alone is invisible to
  everyone not using a screen reader, and the toolbar's other glyphs (‹ › ⟳) are directional
  or rotational with no character available for this one.

  **The Collab tab ships empty**, deliberately, so the strip is the shape it will keep.
  TODO.md carries what is likely to go in it.

  Two things are load-bearing, each recorded where it is done as well as here:

  - **Every pane stays mounted, and a hidden one is `display: none`.** The same fact
    `PdfAnnotationPanel`'s header records about individual cards holds for the panel as a
    whole: a card can be holding an open reply composer, which is a live Hocuspocus
    connection and a DRAFT row, so changing tabs has to hide the annotations rather than
    unmount them.
  - **The tab strip is a sibling above the panes, never a child of one.** `.panel` is both
    the scroller and the box `use-pdf-margin-notes.ts` measures a card's `targetTop` against
    — put the strip inside it and every card keeps the `top` it already had while its content
    starts lower, so the entire rail slips down by the strip's height. As a sibling the panel
    box simply begins further down, which the hook re-measures on its next frame and gets
    right by construction.

  **Why the chips live in a pane rather than above the viewer.** On every other object page the
  strip costs one line of a document that scrolls. This page is a full-viewport app shell
  whose whole point is that the viewer fills the height, so a strip above it would take that
  height from the PDF on every file, tagged or not. The pane holds only keywords and is named
  for the category anyway: the file's own facts — size, page count, uploader, visibility —
  belong in it too, and a pane called "Keywords" would have to be renamed to take them.
  Mechanically it is a rendered Server Component handed across the `ssr: false` boundary as a
  prop (`PdfSurfaceClient`'s header), which is the only way anything server-rendered gets
  inside that island.

---

### 19a. The engine baseline under the PDF surface

**Baseline: Safari 26 / iPadOS 18.4+.** Recorded here because it is a decision rather than a
measurement: it is a judgement about *engines*, not hardware. Apple ships current Safari to
macOS versions years past their last major release, so old hardware caps macOS and not
Safari, and a stale WebKit is nearly always an un-updated one rather than an unsupportable
one. That is what makes a recent baseline defensible rather than exclusionary.

Everything that follows *from* the baseline — which built-ins WebKit lacks, which patches
stand and which were deleted when it moved, the measured table, the worker-realm
import-order trap, why a selection must settle on `selectionchange` rather than
`pointerup`, and why `e2e/pdf-webkit-gaps.spec.ts` cannot notice its own expiry — is in
**[docs/PDF.md](docs/PDF.md) §10, *Engine coupling***, and only there. It is the file
someone opens when the viewer misbehaves; this one is the file someone opens to ask why the
feature is shaped this way.

### Verification

Per-phase, and each phase is independently shippable:

- **Types/lint** — `npx tsc --noEmit`, `npx eslint .` after each phase.
- **Phase 1** — `npm run e2e` with a new `e2e/files.spec.ts`: upload a small fixture PDF as
  AUTHOR; assert it appears in `/files`, that an EDITOR sees it only when SHARED, that
  another AUTHOR never does, and that ADMIN's `?showAllFiles=1` reveals a PRIVATE one.
  Assert an over-limit upload is refused client-side, and that the download route honours a
  `Range` request. A round-trip check that the stored `sha256` matches the bytes on disk.
- **Phase 2/3** — `e2e/pdf-viewer.spec.ts`: open `/pdf/[slug]`, wait for `pagesinit`, select
  a known phrase via `page.evaluate` over the text layer, post an annotation, reload, and
  assert the highlight lands on the same quads and the card carries the same `quotedText`.
  Then change zoom and rotation and assert the rects moved but the stored target didn't.
- **Phase 4** — `e2e/pdf-sync.spec.ts` using the `secondUser()` fixture and two
  `browser.newContext()`s (the browser pane's shared cookie jar makes this untestable by
  hand): user A scrolls to page 12 and broadcasts, user B follows and lands on page 12, B
  scrolls manually and the follow drops. Assert B's presence circle exists on A's left rail
  at a plausible fraction before and after.
- **Browser engine gaps** — `e2e/pdf-webkit-gaps.spec.ts` (§19a): deletes the built-in WebKit
  lacks and asserts a selection still anchors. Simulated in chromium rather than run under a
  `webkit` project, because chromium is where the suite actually runs and because Playwright's
  WebKit will not launch on every machine (`playwright.config.ts` records the macOS 14 pin).
  Confirm it *fails* with the polyfill disabled before trusting it — a test of a polyfill that
  only ever passes proves nothing. It also drives the `selectionchange` path with no
  `pointerup`, so both triggers are covered between it and the specs above. Two things it does
  not reach: `scripts/probe-engine.ts` is what says whether the polyfill is still *needed* and
  what covers the worker realm, and only a real iPad has the native selection gestures.
- **Regression** — the full `npm run e2e` suite after the `use-margin-notes-layout` refactor,
  which is the one change touching working surfaces.
- **Integrity** — `npx tsx scripts/integrity/check-pdf-anchors.ts` on seeded content.
- **By hand in the browser pane** — only for what the suite can't assert: that the two 1px
  rails read well, that the viewport thumb's 20px threshold behaves at both extremes, and
  that a rectangle selection over a figure produces a sensible highlight.

## 20. Keywords, and the anchor envelope they share with annotations

Keywords are new: a vocabulary of terms (`keyword`), applied to content by acts of tagging
(`keyword_assignment`), where one act may target **the whole of, or parts of** a doc, a post,
an uploaded file, or an annotation's body — several parts at once, the way one
`doc_link_group` already spans several `doc_link` rows. Annotations then adopt the same
shape: their anchor columns move off the `annotation` row into `annotation_anchor` rows, one
per targeted part, which is what makes a multi-part annotation possible at all.

**What is being unified is the envelope, not the selector.** COLLAB.md's conclusion stands:
the selector mechanism follows the target's mutability and the writer's rights, and there is
no universal anchor. What generalizes is only "this row names one target — an object, and
optionally a part of it." Every mechanism keeps its own physics: the doc editor's mark stays
a mark (§12i/§13o), a reading-view range stays offsets-plus-stamp (§13o), a PDF anchor stays
a measured-once blob (§19), a post part-anchor would still remap at publish (§5).

Ships as **two PRs**: PR 1 is the shared library plus whole-object keywords, complete and
tied off on its own; PR 2 is part-targeting plus the annotation migration. §20h has the
split.

### 20a. One row-shape, per-consumer tables — and the shapes rejected

Three shapes were considered and two rejected:

- **One W3C-style annotation supertable** (everything is an "annotation" with a motivation
  column; a tag is an annotation whose body is a keyword) — rejected. `Annotation` carries a
  live ydoc body, caches, an `AnnotationStatus` lifecycle, and a raise/notify flow; a keyword
  assignment has none of those. Folding them together would be the false unification this
  document keeps warning about, and every consumer would pay branches on `motivation`
  forever.
- **One shared `anchor` table with an owner arc** (`annotation_id?`/`assignment_id?`/…) —
  rejected. Two exclusive arcs in one table, every new consumer widening it, cascades running
  through CHECK-guarded nullable FKs, and Prisma include gymnastics on the owner side. The
  queries that would benefit ("everything anchored here, regardless of kind") are not hot
  paths — every surface fetches annotations and keyword chips separately because it renders
  them differently.
- **Per-consumer anchor tables sharing one column shape** — chosen. `annotation_anchor` and
  `keyword_anchor` each carry a plain required owner FK with a clean cascade, and the same
  target/selector/stamp columns by convention. The precedent is the four slug-history tables:
  same shape, separate tables, because Prisma has no polymorphic relations — except here the
  shape is also held together by one TS type and one capture/resolve library
  (`src/lib/anchors/`, extracted from `annotation-anchors.ts` /
  `annotation-anchor-capture.ts`), so the sharing is enforced by the compiler rather than by
  review.

The **object side** is an exclusive arc of four nullable FKs — `doc_id`, `post_id`,
`file_id`, `target_annotation_id` — exactly one non-null, enforced by a hand-written
`CHECK (num_nonnulls(…) = 1)` (no CHECK DSL in Prisma; the `doc_link` and `add_file_model`
convention). Real FKs rather than a `(type, id)` pair because this schema leans hard on
cascades: deleting a doc must take every anchor pointing at it. The cost, accepted with eyes
open: **a new targetable kind is a migration** — one column, one index, one CHECK edit, per
anchor table. That stays cheap while the arc lives only in these leaf tables; §20i names the
signals that would justify the supertype pivot, and why not now.

### 20b. The anchor row shape

Shown once, on `KeywordAnchor`; `AnnotationAnchor` (§20e) repeats it verbatim below its own
owner FK.

```
model KeywordAnchor {
  id           String  @id @default(cuid())
  assignmentId String  @map("assignment_id")

  // Object arc — exactly one non-null (hand-written CHECK); all Cascade.
  docId              String? @map("doc_id")
  postId             String? @map("post_id")
  fileId             String? @map("file_id")
  targetAnnotationId String? @map("target_annotation_id")

  // Part selector — all null ⇒ the whole object.
  selectorKind SelectorKind? @map("selector_kind")   // DOC_RANGE | PDF_TEXT
  anchorFrom   Int?          @map("anchor_from")
  anchorTo     Int?          @map("anchor_to")
  quotedText   String        @default("") @map("quoted_text")
  selector     Json?

  // Version stamps — the coordinate system the offsets are expressed in.
  ydocUpdateId    BigInt? @map("ydoc_update_id")
  anchoredEventId String? @map("anchored_event_id")

  partOrder Int @default(0) @map("part_order")

  // relations: assignment (Cascade), doc/post/file/targetAnnotation (all
  // Cascade), anchoredEvent (SetNull); named @relations where a model
  // appears twice (annotation is both an owner and a target).
  @@index([assignmentId])
  @@index([docId])
  @@index([postId])
  @@index([fileId])
  @@index([targetAnnotationId])
  @@map("keyword_anchor")
}
```

The rules the columns inherit, each already established elsewhere and now holding per row:

- **`quoted_text` is derived server-side against the state the stamp names**, never stored
  as the client sent it — §13o's trust rule. Replay the target to `ydoc_update_id` and
  `textBetween(anchor_from, anchor_to)` *is* `quoted_text`, by construction, which is what
  lets one integrity checker cover every anchor row in the system (§20g).
- **`ydoc_update_id` names the log of the row's own target.** A row targeting a doc stamps
  the doc's log; a row targeting an annotation body stamps that annotation's log. This is
  §13p's overload dissolved: the stamp and the target live on the same row, so they cannot be
  chosen independently.
- **`anchored_event_id` is the post-side axis** — publication events, not ydoc updates
  (§5). It ships inert: nullable, no writer, on the §13p `proseJsonUpdateId` precedent
  (building the seam costs one column now rather than a migration under live data later).
  `POST_RANGE` is deferred with it (§20i).
- **`selector` is opaque jsonb** — PDF quads/quote/position/textVersion, `before`/`after`
  context, `blocks`, `v` — the same trade `pdf_target` and `doc_link.mark` already make.
  Nothing in Postgres sorts or filters inside it, so no GIN index.
- A second hand-written CHECK makes shipping the part columns before their writer honest,
  the way §14b's `num_nonnulls(mark_id, mark)` made `mark_id` honest:
  `(selector_kind IS NULL) = (anchor_from IS NULL AND anchor_to IS NULL AND selector IS NULL)`.
  PR 1 writes only whole-object rows; the CHECK is permanent either way.

Selector kinds are the enum `SelectorKind { DOC_RANGE, PDF_TEXT }`, both writers arriving in
PR 2. `POST_RANGE` is added when its feature is (`ALTER TYPE … ADD VALUE` is cheap; an enum
value with no writer for several sections is not).

### 20c. Keyword schema (PR 1)

```
model Keyword {
  id          String  @id @default(cuid())
  slug        String  @unique
  name        String
  description String?
  createdById String  @map("created_by_id")
  createdAt   DateTime @default(now()) @map("created_at")
  deletedByUserId String?   @map("deleted_by_user_id")
  deletedAt       DateTime? @map("deleted_at")
  @@map("keyword")
}

model KeywordAssignment {
  id        String   @id @default(cuid())
  keywordId String   @map("keyword_id")
  userId    String   @map("user_id")
  createdAt DateTime @default(now()) @map("created_at")
  deletedByUserId String?   @map("deleted_by_user_id")
  deletedAt       DateTime? @map("deleted_at")
  // keyword (Cascade), user; anchors KeywordAnchor[]
  @@index([keywordId])
  @@index([userId])
  @@map("keyword_assignment")
}
```

- **An assignment is one act of tagging** — the `doc_link_group` analogue. It owns 1..n
  anchors and carries who tagged and when. Tagging a whole doc is one assignment with one
  selector-less anchor; PR 2's part-tagging adds anchors, not concepts.
- **Anchors have no soft delete of their own.** Removing one part of a multi-part act
  deletes that row; removing the act soft-deletes the assignment. An anchor is a part of a
  record, not a record.
- **Soft-delete wiring:** `keyword` joins the `$extends` filter in `src/lib/prisma.ts` (it
  has an admin table that needs `prismaIncludingDeleted` to offer restore, same as
  `storedFile`). `keyword_assignment` does **not** join it and filters by hand — the filter
  intercepts top-level operations only, and assignments are read almost exclusively through
  `keyword_anchor` includes, which it cannot reach. Stating that here so the divergence reads
  as chosen, not missed (the §14b convention).
- **Hand-written DDL** in the migration, with comments citing this section: both CHECKs from
  §20b, and `CREATE UNIQUE INDEX … ON keyword (lower(name))` — slug uniqueness alone would
  admit "Epistemology" and "epistemology" as distinct terms.
- **Slugs are their own namespace** (`/keyword/*`), like docs' and files': `keywordSlugInUse`
  checks `keyword` only. No slug history table in v1 — a renamed keyword breaks inbound
  `/keyword/…` links until it earns one (§20i).
- **Whole-object dedup is app-level find-first** in the action (same keyword, same object,
  same user → no second assignment). The DB-enforced version needs `keyword_id` denormalized
  onto the anchor for a partial unique index; deferred until concurrent tagging is a thing
  that happens (§20i).

### 20d. Keyword surfaces (PR 1)

- **Chips on the object pages** — `/doc/[slug]`, post pages, `/pdf/[slug]`: one indexed
  `keyword_anchor` query by container, joined through live assignments to terms.
  Server-rendered; gated by the page's own access check, so a PRIVATE doc's chips are as
  private as the doc.
- **`/keyword/[slug]`** — the browse page, as **per-type sections** (docs tagged K, posts
  tagged K, files tagged K), each an indexed, SQL-paginated query wearing that type's
  existing permission predicate (`publishedPostWhere`, doc visibility + `DocAuthor`,
  `file-authz`). Deliberately not an interleaved single timeline: that is a UNION view that
  would re-implement four permission models in one place — the easiest leak to write and the
  hardest to see. Counts shown here come from the filtered queries, never from the view
  below, for the same reason.
- **`/keywords`** — an admin table through the §16 kit: `keywords-query.ts` over
  `table-query.ts`, plus a `keyword_metrics` view keyed 1:1 on `keyword_id` (assignment
  count, per-type object counts, last used) so every column sorts. Built by grouping the
  assignment/anchor tables, **never `FROM keyword`** — `doc_metrics`' double-scan lesson
  (§16l). All cheap aggregates (`count(*) FILTER`, `max`); nothing here is
  expensive-to-compute, so no trigger-maintained column unless sorting by usage measures
  badly at real scale (the §16l view-vs-column rule decides, not taste).
- **Permissions** get their own rows in docs/PERMISSIONS.md before the actions land.
  Proposed defaults, confirmed there rather than here: applying or removing your own tag on
  a surface follows the permission to annotate that surface; creating a new term follows the
  same; renaming, merging, and deleting terms is ADMIN/EDITOR. Open question §20j-1.
- **Cache:** tagging revalidates the tagged object's own path; `/keyword/[slug]` renders
  dynamic (it is permission-shaped per viewer, so ISR would be wrong anyway). CACHING.md gets
  a line when built.
- **Tie-off:** at the end of PR 1 the part columns exist, constrained, and unwritten; no UI
  mentions parts. The feature is complete as "tag whole things": chips, browse, admin,
  fixtures that create and delete their own throwaway keywords (docs/TEST_DATA.md gets the
  script), and e2e specs for tag → chip → browse → untag.

### 20e. Anchors become rows on the annotation side (PR 2)

`annotation_anchor` — owner FK `annotation_id` (Cascade) plus the §20b shape — and a
migration of the existing columns onto it, expand-and-contract:

1. **Add + backfill.** Every annotation with a column anchor gets one `DOC_RANGE` row
   (offsets, quote, stamp copied); every `pdf_target` becomes one `PDF_TEXT` row with the
   blob as `selector` (renderer-neutral as before, docs/PDF.md invariant 3 untouched); a
   reply's row targets its parent (`target_annotation_id`), which is where its stamp now
   lives. Mark-anchored and document-level annotations get **zero rows** — see below.
2. **Readers switch** behind `resolveAnnotationRanges`, which stays the one function that
   answers "where is this annotation" for every surface (§13o). `/annotations`' Quote column
   reads the first anchor row (`part_order`), with a count badge when there are more.
3. **`postAnnotation` switches** to writing rows — taking a list of ranges, verifying each
   independently against the stamped state (§13o's rule per part).
4. **Drop the old columns** — a second migration in the same PR, gated on
   `check-annotation-anchors` reporting parity between columns and rows on the real
   database. A true expand-and-contract would put the drop a deploy behind the backfill;
   with one operator and an integrity script standing where the soak would be, same-PR is
   accepted. Recorded as a deviation.

**Zero anchor rows means "look for the editor's mark, else document-level"** — today's
`anchor_from IS NULL` semantics lifted to the row count. Deliberately no `DOC_MARK` row
kind: a DB row saying "there is a mark" duplicates, and can drift from, information the
ydoc holds exactly — a mark deleted with its text would orphan the row. Absence of rows is
the record, and the §12h degradation story is unchanged.

**`annotation.doc_id`/`file_id` stay.** They are the container — permissions, cascades,
`/annotations`, and the rail fetch all key on them. Anchor rows add precision inside the
container; v1 enforces target-equals-container (roots) and target-equals-parent (replies)
in `postAnnotation`, not in the DB, leaving cross-container annotation a future decision
(§20i) rather than a present hazard.

**The stamp un-overload, and its backfill.** With coordinate stamps on anchor rows,
`Annotation.ydocUpdateId` shrinks back to §13n's original meaning — which doc state the
author was looking at, driving the "at this revision" control. New anchored replies stamp
both: the doc's log on the annotation row, the parent's log on the anchor row. Existing
anchored replies hold a parent-log value the annotation-level column can no longer honestly
mean, so backfill sets it **null** there — "unknown," the §13q convention, hiding the
control for exactly the rows where it currently points a doc scrubber at a foreign log
(§13p's accepted cost, now retired).

### 20f. Multi-part semantics (PR 2)

- **Column-mechanism multi-part** is several `DOC_RANGE`/`PDF_TEXT` rows under one owner,
  ordered by `part_order`. Parts verify independently at capture: a part the stamped state
  cannot confirm is not stored (the client is told), and an annotation whose every part
  fails degrades to document-level — zero rows, exactly like a lost mark.
- **Mark-mechanism multi-part** costs no schema at all — the same mark id at several
  discontiguous ranges — but `collectAnnotationMarkRanges` currently collapses a split mark
  to first-through-last, and must instead return segments (coalescing adjacent runs,
  preserving gaps). `resolveAnnotationRanges`' consumers move from "a range" to "ranges";
  the rail packs a card at its first attached part and the jump affordance cycles through
  the rest.
- **Keyword part-anchors use the column mechanism on every surface, including the doc
  editor.** This is a deliberate, recorded deviation from §13o's "mechanism follows the
  surface": a keyword mark would add a second mark type to the collaborative doc grammar,
  a second `excludes: ""` growth path, and a second decoration-splitting layer, for ranges
  lighter-weight than discussion threads. The zero-rows convention keeps the door open if
  editor-applied keyword ranges ever prove to need mark-grade drift immunity. The schema
  comment on `keyword_anchor` says this out loud, adjacent to `annotation`'s comment
  describing the opposite — §14a's rule.
- **Part-tags join the rail** by feeding the same plugin state and per-transaction resolve
  pass as annotation ranges — preserving `annotation-marks.ts`' "one pass for every id"
  rule, so twenty keyword ranges cost what twenty more annotations would, bounded by §13o's
  tiering.

### 20g. Performance and integrity

- Every hot query is an indexed FK lookup on tables sized like `annotation`. The doc
  reading page adds one batched `include` (anchor rows on the annotations it already
  fetches) and one `keyword_anchor` query by container — constant query count, no N+1.
- No new per-keystroke O(document × text) surface: resolution stays client-side and tiered
  (map → windowed search → one global scan, §13o), shared by both families in one pass.
- Writes are one transaction: owner row plus N anchor rows.
- Indexes are the plain per-column set in §20b; partial (`WHERE doc_id IS NOT NULL`)
  variants are a later, hand-written upgrade if these tables ever get large enough to care.
- `scripts/integrity/check-annotation-anchors.ts` generalizes: the replay invariant
  ("materialize the state the stamp names; `textBetween` must equal `quoted_text`") is a
  per-row property, so one checker walks `annotation_anchor` and `keyword_anchor` alike —
  PR 1 adds the walk (trivially green with only whole-object rows), PR 2 makes it earn its
  keep, and it is the parity gate for §20e step 4.

### 20h. Build order — two PRs

**PR 1 — the shared layer, and whole-object keywords.**

1. Extract `src/lib/anchors/`: the anchor TS type (target arc as a discriminated union,
   selector kinds), `parseSelector` (the `parseDocLinkMark` convention — every jsonb read
   goes through a parse, never a cast), and the capture/resolve functions refactored out of
   `annotation-anchor-capture.ts`/`annotation-anchors.ts`. Pure refactor; annotations
   unchanged; the e2e suite is the proof.
2. Migration: `keyword`, `keyword_assignment`, `keyword_anchor` (§20b/§20c), with the
   hand-written CHECKs, `lower(name)` unique index, and arc indexes.
3. `keyword_metrics` view migration + schema `view` block (§16e caveats apply verbatim).
4. PERMISSIONS.md rows; server actions: create term, tag object (find-first dedup), untag,
   admin rename/delete.
5. Surfaces: chips on the three object pages; `/keyword/[slug]` per-type sections;
   `/keywords` through the kit.
6. Tie-off: e2e specs (tag → chip → browse → untag; `/keywords` sort through the view);
   throwaway-keyword script in docs/TEST_DATA.md; integrity walk from §20g. Part columns
   present, constrained, unwritten.

§20k records what PR 1 actually shipped — only the places it deviates from, or decides
something left open by, the sections above.

**PR 2 — part-targeting, and the annotation migration.**

7. Keyword part-capture on the reading views (columns + stamp, §20f), rail integration.
8. `annotation_anchor` + backfill script (§20e steps 1–2); readers behind
   `resolveAnnotationRanges`; `/annotations` Quote column off rows.
9. `postAnnotation` writes rows; multi-part capture UI; per-part verify.
10. `collectAnnotationMarkRanges` returns segments; rail packs first-part, jump cycles.
11. Integrity parity run on the real database, then the column-drop migration (§20e
    step 4) and the §20e stamp backfill.
12. e2e: multi-part annotation (create three parts, cards resolve, jump cycles); anchored
    reply still resolves against its parent; PDF annotation round-trips through its
    `PDF_TEXT` row.

### 20i. Deferred, with reasons

- **`doc_link` onto the shape.** `doc_link_group` ≈ assignment, `doc_link` ≈ anchor plus
  role/color; compatible, and nothing in §14 requires the move. Migrating it buys
  uniformity, not capability — do it if the shared library makes §14d's resolve path
  cheaper to maintain, not before.
- **Cross-container anchors.** Structurally ready (the arc doesn't care), semantically
  not: visibility across mixed-permission targets needs a PERMISSIONS.md decision first —
  conjunctive (visible only if every target is) is the safe default when it comes up.
- **`POST_RANGE`.** Honest only once part-anchors join `comment_thread`'s publish-time
  remap (§5); until then a post is whole-object-only. `anchored_event_id` ships inert so
  this is a feature, not a migration.
- **Targets that are mutable but unlogged** — `Comment.body`, `contributorBlurb`. No log
  means no stamp axis, so the replay invariant is unbuildable and offsets into them would
  be text-search-and-hope (COLLAB.md strategy 4's fragility, stored). If they become
  targets, they get **whole-object anchors only** until they gain a log or a snapshot
  discipline. This is the rule that keeps the envelope honest as kinds multiply.
- **Keyword slug history; DB-enforced whole-object dedup; partial arc indexes.** Each a
  small, known upgrade with a named trigger condition above.
- **The supertype pivot.** If targetable kinds push past the high single digits, or a
  third-plus consumer family lands, or a feature needs "any object" pervasively (a
  cross-type activity feed, global search), the classic answer is an `object(id, kind)`
  supertype every targetable row joins 1:1, collapsing each anchor table's arc to one FK.
  Not now: at four kinds it is backfill, two-step creates, and rerouted delete paths for
  no present gain. The current design quarantines the arc in the anchor tables and the one
  TS union, which is precisely what keeps that future rewrite small if it ever earns
  itself.

### 20j. Open questions

1. **Who may mint terms?** The §20d proposal ties term creation to the annotate
   permission, which means AUTHORIZED users grow the vocabulary. If curation matters more
   than friction, restrict creation to AUTHOR+ and let AUTHORIZED users only apply
   existing terms. PERMISSIONS.md decides.
2. **Merge semantics.** Renaming a term is an UPDATE; merging two terms means re-pointing
   assignments and deduping collisions per object. Admin-only either way; the merge action
   can wait for the first real duplicate pair.
3. **Does `/keyword/[slug]` paginate per section or cap-with-link?** Per-section
   querystring pagination matches the kit's habits; a cap ("first 20, see all") reads
   better on a mixed page. Decide when the page has real content to look at.

### 20k. PR 1 as built (2026-08-24)

Steps 1–6 of §20h, complete and tied off. What follows is only where the build **differs from
or decides something left open by** the sections above; everything unmentioned went in as
written.

**The shared library split in two, browser-safe and server.** `src/lib/anchors/index.ts`
exports the pure half (`resolveAnchorInDoc`, the target arc, `parseSelector`);
`src/lib/anchors/capture.ts` is imported explicitly by server callers. §20h said "extract
`src/lib/anchors/`" and did not say this, but a single barrel would have dragged PrismaClient
into every client bundle wanting `resolveAnchorInDoc` — `annotation-highlight-extension.ts`
imports it and ships to the browser. The `avatar.ts`/`avatar-url.ts` precedent, applied.
`captureAnnotationAnchor` became `captureAnchorInYdoc`: it was never annotation-specific.

**A unit-test runner arrived with it.** `npm run test:unit` — `node --import tsx --test` over
`src/**/*.test.ts`, no new dependency. §20h calls step 1 a pure refactor whose proof is the
e2e suite; that proof is a two-minute production build, and the three resolve tiers and
`parseSelector`'s rejection surface are tables of inputs rather than things to drive a browser
through. 19 cases, sub-second. CLAUDE.md says when to reach for it and when not to.

**A schema-level integrity script, `check-keyword-constraints.ts`.** §20g's replay walk covers
stored data; nothing covered the *DDL*. It attempts each violation in a rolled-back
transaction and asserts Postgres refuses it. It earned itself immediately: it caught that
§20b's stated CHECK — `(selector_kind IS NULL) = (anchor_from IS NULL AND anchor_to IS NULL
AND selector IS NULL)` — is a **group-wide equality, not a per-kind rule**, so a `DOC_RANGE`
row with offsets and no `selector` blob is legal. That is correct and load-bearing: it is
exactly the shape §20e step 1's backfill writes, since today's annotation column anchors carry
offsets, a quote and a stamp but no context blob. A stricter CHECK would have blocked PR 2's
migration. The residual it leaves — `PDF_TEXT` with offsets and no blob — is printed by the
script rather than buried, and belongs with PR 2's writer.

**`keyword_metrics`' count columns are declared nullable, and it matters.** A term nobody has
used has no view row (the `doc_metrics` semantic, §16l), so Prisma's LEFT JOIN yields NULL —
and plain `DESC` puts NULLs *first* in Postgres, which made "sort by most used" lead with
never-applied terms. Declared non-null, Prisma rejects the `{ sort, nulls }` form. Nullable
plus `nulls: "last"` is the fix. Caught by the e2e spec, not by review. `file_metrics` is
declared the other way and escapes this only because every file has an owner, so its FULL
OUTER JOIN always emits a row.

**Chips read no session at all**, which is not how §20d's "server-rendered" reads at first.
`/[slug]` carries `generateStaticParams` and `revalidate = 60`, and a dynamic API there throws
`DYNAMIC_SERVER_USAGE` at build (§12f) — so reaching for `auth()` to decide whether to draw a
tagger would have broken the build on the page keywords most need to reach. Which terms are on
an object is the same answer for every viewer who can see it; everything viewer-shaped moved
into a client island that calls `loadTaggerState` when opened. The build output confirms
`/[slug]` is still `●`.

**§20j-1 decided: minting a term is the same permission as applying one.** AUTHORIZED users
grow the vocabulary. **§20j-3 decided: per-section cap, not per-section pagination** —
`PAGE_CAP = 50` with an honest "showing the first N" line, since three `?page=` params on one
page is a URL nobody can read for a page that has a handful of rows per type. Both recorded in
docs/PERMISSIONS.md and `keyword-browse.ts` respectively, both cheap to revisit.

**One judgment call not in §20d**: tagging requires a signed-in AUTHORIZED account on *every*
surface, posts included. "Follows the permission to annotate that surface" read literally
would open post-tagging to COMMENTER and to signed-out visitors, since commenting is open to
both — and a tag is curatorial where a comment is conversational. docs/PERMISSIONS.md states
it as a judgment call rather than as a reading.

**On `/pdf/[slug]` the chips are a panel tab rather than a strip.** Not a §20d departure —
same component, same gate, same `keywordsForTarget` query, only a different container. A strip
above the viewer would take height from the PDF permanently on a page whose layout exists to
give the document the whole viewport, so the chips are the **Metadata** tab of the side panel
instead. §19's deviation list carries the mechanism and the constraints it has to respect.

**On `/doc/[slug]` the chips are a second line of the byline**, not a block below the text — a
keyword says what the whole document is about, which is the same kind of fact as who wrote it
and when, so it belongs with the rest of the document's metadata. The strip therefore has two
variants (`KeywordStrip`'s own type documents the split), and the question they answer is
whether the strip has to name itself: a **section** — a post page, the PDF viewer's Metadata
pane — carries the "Keywords" label, because nothing around it says what the row is; a
**bare** one carries none, because it has been dropped into something that already says so.
One prop rather than two, because it is one decision.

**Not in §20d: the doc editor's Settings panel gets a Keywords field.** §20d put chips on
reading surfaces only, and `/doc/[slug]/edit` is where the rest of a doc's metadata is
administered — authors, visibility, URL — so keywords being absent there was a gap rather
than a boundary. It is `KeywordStrip` itself, `bare` under a `<legend>Keywords</legend>` —
not a lookalike built from the panel's own parts. What a chip looks like, where it links, who
may tag, what the popover offers, how you retract your own tag: all of it stays in one place,
so the two surfaces cannot drift. The panel contributes the fieldset and nothing else, and in
particular **no second permission check** — `canUserTagTarget` reads a doc through
soft-delete-filtered `prisma`, so a binned doc is already untaggable and the tagger says so on
open; a client-side guard beside that could only disagree with it.

The one asymmetry left is where the chips come from, and it is the reason for the two seams
this needed. An object page server-renders them and the actions' `revalidatePath` brings them
back; the panel fetches them when it opens, which is out of reach of both that and
`router.refresh()` — hence `KeywordTagger`'s optional `onChange`, passed through by
`KeywordStrip`. And `TaggerState` now carries `applied: KeywordChip[]` instead of an id list
plus a separate "yours" list, because the panel has to *name* the applied terms; both of the
old fields are `filter`s over the new one.

**Also decided in passing**: `/keywords` sets the same bar as every other admin table
(`canManageDocs`), not `canApplyKeywords` — an AUTHORIZED user reaches the vocabulary through
the tagger and `/keyword/[slug]` instead of a seventh visibility tier. The four arc legs are
all live in the action and authz layer, including annotations, though only three have chip UI;
the fourth is one `canUserTagTarget` branch rather than a hole to fill in later.
