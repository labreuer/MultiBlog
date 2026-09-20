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

### 3d. The post editor (`/post/[id]/edit`)

**Moved from `/posts/[id]/…` to `/post/[id]/…` on 2026-09-15**, so that a post's own pages
(`edit`, `slug`, `comments`, `history`) sit under a singular prefix the way a doc's do under
`/doc/[slug]/…`. The rule the rename makes uniform: a **plural** path is an admin table
(`/posts`, `/docs`, `/files`, `/users`, `/tags`, `/links`, `/comments`, `/annotations`, §16)
and the actions that belong to the table as a whole (`/posts/new`); a **singular** path is one
thing's pages (`/doc/[slug]`, `/pdf/[slug]`, `/tag/[slug]`, `/link/[id]`, and now
`/post/[id]`). Until then posts followed `/users/[id]/slug` — management hanging off the table
by id — while docs followed the reading page, and the two rules disagreed. `/users/[id]/slug`
and `/files/[slug]` (§19, a sign-in landing that inherited the download URL's prefix) still
follow the older shape. A published post's *reading* URL is the dated one (§21), so no
`/post/[id]` page reads a post. No redirect from the old paths: they were never public, and
every internal link and `revalidatePath` moved with the route.

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
- **Live-scrubbable history** (`/post/[id]/live-history`, `LiveHistoryViewer.tsx`):
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
- **Management UI**: `/post/[id]/slug` and `/users/[id]/slug` (`SlugManager.tsx`, shared by
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

Built in the first build (2026-07): Disqus-style identity, the three-level moderation
cascade, the trust model, `/comments`; the safe schema and link hardening on 2026-09-16
(§23b). **As built: [docs/COMMENTS.md](docs/COMMENTS.md)** — "Identity, moderation and
abuse", "`/comments`", and the trust-threshold argument under "Decisions". The plan text is in the parent of the commit that introduced this stub.

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
   cascade + trust threshold per §6, moderation queue at `/post/[id]/comments`. Beyond
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
  `/post/[id]/edit`, leaving the clicked action silently unapplied. Measured at roughly one
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

Built 2026-07-29 in the five phases §12k laid out — a **Doc**, an always-evolving living
document read as its live Yjs state, as a second entity beside `Post`; the frozen reading
view (§12p) followed on 2026-08-12, and §15 then made a post a snapshot of a doc. **As
built: [docs/DOCS.md](docs/DOCS.md).** Each subsection below says where its content lives
now. The plan text is in the parent of the commit that introduced this stub.

### 12a. What a doc inherits from §11 for free — docs/DOCS.md, "The ydoc behind a doc"
### 12b. Wiring a doc to a ydoc — docs/DOCS.md, "The ydoc behind a doc"
### 12c. Data model — docs/DOCS.md, "Data model"
### 12d. The `prose_json` cache — docs/DOCS.md, "The caches: `title` and `prose_json`"
### 12e. The `AUTHORIZED` role — docs/DOCS.md, "Roles and visibility"; the tables are docs/PERMISSIONS.md
### 12f. Routes — docs/DOCS.md, "Routes"
### 12g. Collab: tokens, read-only readers, and the client `Y.Doc` — docs/DOCS.md, "Collab: tokens and read-only readers"
### 12h. `gc: true`, and what a document-level annotation is — docs/DOCS.md, "The ydoc behind a doc" and "Annotations on a doc"; the reasoning is docs/COLLAB.md, "Why `gc: true`, and what it rules out"
### 12i. Annotations: the mark, capture, and the shared view model — docs/ANNOTATIONS.md, "Anchoring" and "Decisions" (the reading views stopped writing marks with §13o; the `Comment*` components were un-shared by §13c)
### 12j. `/annotations` — docs/ANNOTATIONS.md, "Surfaces" and "Decisions"
### 12k. Build order — docs/DOCS.md, "History"
### 12l. The carrying cost, stated plainly — superseded by §15, which made a post a snapshot of a doc; docs/DOCS.md, "What a doc is"
### 12m. Deferred, with reasons — docs/DOCS.md, "Deferred, with reasons"
### 12n. As built — docs/DOCS.md throughout; "The title follows the fragment live" is under "The caches"
### 12o. Known gaps — docs/DOCS.md, "Known gaps"
### 12p. The frozen reading view — docs/DOCS.md, "The frozen reading view"

## 13. Annotations become ydocs, with a TipTap editor of their own

Built 2026-07-29 through the five phases the plan laid out; §13n (2026-08-12), §13o and §13p
(2026-08-13) and §13q (2026-08-13) followed. **As built: [docs/ANNOTATIONS.md](docs/ANNOTATIONS.md).** Each subsection below
says where its content lives now. The plan text is in the parent of the commit that introduced this stub.

### 13a. One ydoc per annotation, not one shared ydoc per doc — docs/ANNOTATIONS.md, "The body is a ydoc"
### 13b. Schema — docs/ANNOTATIONS.md, "What an annotation is"
### 13c. Un-sharing the `Comment*` components — docs/COMMENTS.md, "Decisions" (comments and annotations did not become one component again)
### 13d. Lifecycle: DRAFT → LIVE → RAISED — docs/ANNOTATIONS.md, "Lifecycle"
### 13e. The formatting bar: hidden by default — docs/ANNOTATIONS.md, "The body is a ydoc" and "Decisions" (the bubble menu set aside)
### 13f. Decorating the selected range while composing — docs/COLLAB.md §4; docs/ANNOTATIONS.md, "Composing from the doc editor"
### 13g. Moving a draft to the bottom composer — docs/ANNOTATIONS.md, "Lifecycle" and "Decisions"
### 13h. Author highlighting: on once a second author joins, backfilled — docs/ANNOTATIONS.md, "The body is a ydoc" and "Decisions"
### 13i. Presence: showing who's editing an annotation — docs/ANNOTATIONS.md, "The body is a ydoc" and "Decisions"
### 13j. Build order — deleted; the phases are in the commit messages
### 13k. Open questions — docs/ANNOTATIONS.md, "Decisions" (eager draft rows)
### 13l. As built — docs/ANNOTATIONS.md, "Deviations from the plan"
### 13m. The server→collab HTTP origin, and the production-only bug it caused — docs/YDOC.md, "The server→collab HTTP origin"
### 13n. `ydoc_update_id`: which revision an annotation was written against — docs/ANNOTATIONS.md, "The version stamp"
### 13o. Two anchoring mechanisms, picked by surface — and why the reading views stopped writing marks — docs/ANNOTATIONS.md, "Anchoring"
### 13p. A reply anchors to a passage of the annotation it answers — docs/ANNOTATIONS.md, "Replies anchor into their parent"
### 13q. The stamp becomes the version the annotator saw — docs/ANNOTATIONS.md, "The version stamp" and "Decisions"

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
rendering one column beside a placeholder: the page's only purpose is comparison, and the one
in-app way here (`/link/[id]`, §14k) resolves per viewer, so the sole way to arrive is a URL
shared between people with different access. See §14n.

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

`/doc/[slug]` carries no picker for this surface: its byline is the post line (§21i). The in-app
way to a pair is `/link/[id]` (docs/ANCHORED_LINKS.md), which resolves an anchored link across two
docs to `/side-by-side/<a>/<b>` for a viewer who may read both; otherwise it is a URL.

`readableDocsFor(userId, role)` in `src/lib/doc-authz.ts` sits directly beside `canUserReadDoc`
with a comment tying the two together: it is the same predicate expressed as a `where` clause
instead of per-row, and the only thing keeping them honest is proximity plus that comment.
ADMIN/EDITOR get every non-deleted doc; everyone else gets `SHARED` plus their own
byline-authored `PRIVATE` docs. Tag browsing and file authorization read it.

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
`server/collab.ts` is dropped; one editing stack remains. `/post/[id]/edit` no longer edits — it
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

`/post/[id]/edit` (route unchanged) replaces `PostEditor` with `PostPublisher`: a plain title input
(defaulting to, and offering to reset to, the source doc's title), a line naming the source doc with
a link to `/doc/[slug]/edit` and a "Change doc…" picker, the publish/schedule/unpublish controls, a
line stating whether publishing will create a new snapshot or reuse an existing one, a read-only
render of the doc at the selected point, and a scrub bar pinned at the bottom.

**§15i amends this layout for a viewer who cannot edit the source doc**: no scrub bar, the post's
own stored content in place of the replay, a note saying why, and the source-doc line linking only
as far as that viewer may go. Everything above describes the case where they can.

**The publish button** (built 2026-09-16). Its label follows `derivePostStatus`: "Publish"
on a draft, "Publish Now" on a scheduled post (the same action, but the change it makes is
`publishedAt` moving to now), "Republish" on a live one. On a live post it is **disabled when
publishing would change nothing** — same doc, same update as the live event's snapshot
(`initialThroughUpdateId` against the bar's `throughUpdateId`, one id sequence), and the
resolved title equal to `Post.title` — with the tooltip "Already published at this version
with the present title" on a wrapper span, since a disabled button shows no title of its
own. That is the affordance; `publishPostFromDoc` refuses the same case with that message,
comparing the live event's `docId` and `ydocSnapshotId` (equal update ⇒ equal snapshot,
because `ensureYdocSnapshotAt` reuses) and `Post.title`. `schedulePostFromDoc` has no such
guard: a reschedule at the same content is a real change to the date.

**Two notes on the status line** (built 2026-09-16). "Published <date>, **updated** <date>"
when the live event was created after the publication date — which is exactly a republish,
since `publishPostFromDoc` preserves the original go-live date. It writes the event's
`createdAt` as the same `now` as `publishedAt`, so a first publish compares equal by
construction; the client tolerates a second of skew for rows whose `createdAt` came from the
database default. A scheduled post's event predates its date and never reads as
updated; an unpublish followed by an identical republish does, which is rare and arguably
true. The second line, "**The doc has changed since this version**, last edit <date>", shows
when the doc's head is past the live version's mark — read off the scrub bar's replay
(`ScrubSelection.head`), which already holds every update with its timestamp and opens at
that mark, so no second query and nothing for the bar to disagree with. It is about the head,
not the slider, so scrubbing doesn't move it; a draft, having no version, gets neither note.
Not built: a "scrub to latest" control on that line, and any of this on the public page
(§15's decision that a published post is silent about its doc moving on stands; an "updated"
date there would be a separate call).

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

A post can be created from a doc two ways: a picker at `/posts/new` and a "Publish as blog post"
button on `/doc/[slug]` while the doc has no post (once it has any, the byline lists them
instead — `DocPostsLine`, §21i), both landing on the same `createPostFromDoc(docId)` action,
gated on `canUserEditDoc` and seeding the post's authors from the doc's `doc_author` rows.

The doc's **tags** are deliberately *not* seeded the same way — they are offered on
`/post/[id]/edit` instead, one click each. §20m has why the two metadata lists diverge here.

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
commit, since neither can move alone) → Phase 4 (teardown of the old post-editing UI; `/post/[id]/
history` rebuilt as a publication-event list + word diff between consecutive published versions) →
Phase 5 (comments retargeted onto events) → Phase 6 (collab server teardown) → Phase 7 (this
section, plus CLAUDE.md/CACHING.md/e2e docs).

### 15g. As built

Deleted: `LiveHistoryViewer.tsx`, `/post/[id]/live-history`, `/api/posts/[id]/collab-updates`,
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

### 15i. The post editor without doc-edit rights (2026-09-16)

**Built 2026-09-16.** §15d makes a post's byline and its doc's byline independent lists —
seeded alike at creation, edited separately from then on — and `updatePostAuthor` will add
any ADMIN/EDITOR/AUTHOR to a post with no reference to the doc at all. That is right, and the
reasons are worth writing down because the shape it produces looked like a bug:

- **Credit is not authorship of the text.** The doc byline is who works the prose; the post
  byline is whose name is on the published piece. Someone who supplied the argument, the
  data, the translation, the interview or the illustrations belongs on the second and has no
  business in the first.
- **One doc can source several posts** (§21i's `DocPostsLine`) — a series split out of one
  document, each part credited differently. Coupled bylines would put every contributor on
  every part.
- **The lists drift apart over time without anyone deciding to.** Someone comes off a doc's
  byline and must not thereby lose credit for what was already published; someone joins after
  the text is finished and should get credit without edit rights to a doc other posts are
  also snapshots of.
- **It is least privilege in the right direction.** Publishing, unpublishing, retitling and
  setting moderation policy administer a *publication*. Doing them without being able to
  rewrite the source is a narrower power, not a broken one — and "fixing" it by adding the
  person to the doc's byline would be a privilege escalation, granting read access §12e
  reserves to a PRIVATE doc's listed authors.

**What that costs, and what this section pays.** `GET /api/doc/[id]/replay` is
`canUserEditDoc`-gated, and `publishPostFromDoc` requires the same (§15d). So for a post
author without those rights the editor used to render a scrub bar that 403'd, a content pane
that never arrived, and a Publish button greyed for a reason nothing stated — two independent
blocks producing a page that read as breakage. The page now tells the truth instead:

- **The post's own stored `proseJson` replaces the replay**, rendered on the server exactly
  as the public post page renders it, under a label that follows the post's *state* rather
  than its content — `proseJson` survives an unpublish, so calling it "published" on a post
  that has been taken down would be a lie. A post that has never published says so.
- **The scrub bar is not mounted at all**, rather than mounted and showing its error line.
  Its only possible contribution here is a 403 under a control that could not have worked.
- **One note says why**, beside the controls it explains, and says what *is* still available:
  title, byline, tags, settings, and unpublishing. Styled as a notice rather than an error,
  because this is a configuration and not a failure.
- **The "From doc:" line links as far as the viewer may go and no further** — the doc editor,
  the reading view, or plain text for a PRIVATE doc they are not on. A link that 403s reads
  as breakage; its absence reads as the fact.

**Two pre-existing defects fell out of the same root and are fixed here.** The post's own doc
need not be in `editableDocs` — `editableDocsFor` returns own-byline PRIVATE docs plus, for
ADMIN/EDITOR, SHARED ones, so a PRIVATE doc nobody here authors is simply absent. The old
comment on that call said the opposite. Consequently `PostPublisher`'s `currentDoc` fell back
to using the **doc id as a slug**, rendering "Untitled" behind a link to a route that does
not exist; and the "Change doc…" `<select>` held a `value` matching no `<option>`, so it
displayed some *other* doc as chosen. The page now hands over `sourceDocTitle`/`sourceDocSlug`
directly, and the select lists the current doc as a disabled "(no edit access)" option.

**Switching docs restores everything**, and should. `editableDocsFor` is exactly the set this
viewer may publish from, so a doc chosen from the select is editable by construction — the
post's own doc is the only one that might not be. Hence `selectedEditable` is
`selectedDocId !== docId || canEditSourceDoc` rather than a flat capability: pointing the post
at a doc you own brings the scrub bar and the publish controls back, which the server already
permits.

**The alternative, rejected.** The other coherent position is that a post byline *is* the set
of people who publish it — `updatePostAuthor` would then refuse anyone who cannot edit the
doc, and the eligible list would be filtered. That collapses credit into authority and loses
every case above; it is also the larger change. Recorded so the choice reads as one.

**Unchanged on purpose:** `unpublishPost` needs only `canUserEditPost`, so Unpublish and
Cancel schedule stay live for these viewers; and nothing about the server gates moved. §15i
is a page telling the truth about permissions it did not alter.

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
| `/docs` | Annotations | `doc_metrics.annotation_count` | `count(*)` of live, non-DRAFT annotations — replies included, so it counts remarks and not threads |
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
so every post has a row, while `doc_metrics` never reads `doc` at all: it `FULL OUTER JOIN`s an
aggregate over `doc_author` to one over `annotation`, so a doc with *neither* authors nor
annotations has no row at all, and one with annotations but no authors has a row with a NULL
byline. Both render as the same empty cell and sort the same way, since each relation is
optional and byline is ordered nulls-last either way; §16l has why `doc_metrics` is worth the
difference. `file_metrics` is the same `FULL OUTER JOIN` of owners against annotations, and
`add_doc_annotation_count` is where `doc_metrics` adopted it — a second aggregate keyed on the same
id is exactly what a single `GROUP BY` over the join table cannot carry.

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
  the readable shape and gives every post a row. `doc_metrics` avoids it by aggregating the
  owned tables instead — `doc_author` for the byline, `annotation` for the count — which is
  only possible because Length is a column rather than a view expression; the same trick
  would work for `post_metrics` as a `FULL OUTER JOIN` of its two aggregates, at the cost of
  readability and of making both counts nullable for a post with authors but no comments. Not
  worth it for one avoided scan of a small table. When `doc_metrics` grew its second
  aggregate (`add_doc_annotation_count`) that `FULL OUTER JOIN` stopped being hypothetical
  there: a single `GROUP BY` over `doc_author` has nowhere to put a count keyed on the same
  id, so the choice was that join or a `FROM doc` rewrite that would have reintroduced the
  double scan.
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
  list was first built. `annotations` (`doc_metrics.annotation_count`) joined the list when it
  was added, and is the one entry here that is *not* a plain Doc column: /files shows its
  identically-named column by default and /docs does not, because a PDF is a thing people mark
  up while most docs carry no annotations at all.
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

That bound had no escape hatch when this was built: `/posts` is the admin table, and there
was no public archive route, so the eleventh-newest post was reachable only by search, RSS,
or a direct link. §21h's date archives (2026-09-15) are that route — every byline date links
to its day, and the day to its month and year — though the landing page itself still links
to no "older posts" (TODO.md).

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
- **No "older posts" link.** §17d's `take: 10` still has nothing on the landing page to
  link to, though §21h's date archives (2026-09-15) now exist for it to link to.
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

Built 2026-08-12; the doc editor's rail and its phone-landscape queue in August; composing
from the editor (§18f) on 2026-08-30; the rail's width a range since 2026-09-17. **As built:
[docs/MARGIN_NOTES.md](docs/MARGIN_NOTES.md).** The plan text is in the parent of the commit that introduced this stub.

### 18a. Why this is a JS layout and CSS only does half of it — docs/MARGIN_NOTES.md, "CSS owns the grid, JS owns the vertical alignment"
### 18b. Two ways to answer "where is this anchored", because the two sides differ — docs/MARGIN_NOTES.md, "Resolving \"where is this anchored\""
### 18c. The doc editor's rail is narrower on purpose — docs/MARGIN_NOTES.md, "The doc editor's rail"
### 18d. Prepared, not built: reconciling attached vs. detached against the live document — docs/MARGIN_NOTES.md, "Prepared, not built"
### 18e. Known gaps — docs/MARGIN_NOTES.md, "Known gaps"
### 18f. Annotating from the doc editor — docs/ANNOTATIONS.md, "Composing from the doc editor"

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
  id, slug (unique among live files only — see "a deleted file releases its slug" below),
  title, filename, contentType, byteSize Int, sha256 String,
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

**As built (2026-09-10) — a deleted file releases its slug, and only files do.** The mirror
of doc-slug.ts stops at one place: `file.slug` carries no `UNIQUE`, and
`file_slug_live_key` is unique only `WHERE deleted_by_user_id IS NULL`
(`20260911031651_file_slug_unique_when_live`). Uploading a PDF, noticing it carries embedded
annotations, stripping them and re-uploading the corrected copy is an ordinary sequence, and
one a deleted row squatting on `report` answers with `report-2` forever. That is the whole
motivation; docs and posts keep their global `UNIQUE`, because recreating a doc under a
deleted one's name is not a workflow they have.

Three things follow, all of them in `src/lib/file-slug.ts` and `src/app/actions/files.ts`:

- **"In use" means *live*, on both halves** — a deleted file's current slug and its past
  ones. `fileSlugInUse` writes the `deletedByUserId: null` predicate out rather than
  inheriting it from whichever client it was handed, because the two clients disagree
  (`prisma` filters soft-deleted files, `prismaIncludingDeleted` doesn't). This was already
  a live bug before the index: the upload route claims its slug through the *extended*
  client's transaction, so it couldn't see the deleted squatter and the insert died with a
  raw P2002 — a re-upload answered "Couldn't save that file", not `report-2`.
- **Nothing may `findUnique` a file by slug**, since two deleted files may share one.
  `resolveFileParam` is `findFirst` in a deliberate order: the live row, then a redirect into
  a live file, then the most recently deleted namesake (so an admin's link to a deleted row
  still resolves), then a redirect into a deleted one.
- **A restore whose slug was taken renames rather than refuses** — `report` comes back as
  `report-2`, reported to the caller as `renamedFrom` and shown as a notice under `/files`.
  Refusing would strand an admin who cannot restore a row without first renaming a file they
  may not be allowed to touch. `file_slug_history.slug` stays globally unique — the predicate
  it would need lives on another table — so `changeFileSlug` clears a dead redirect (one
  pointing into a deleted file) out of the way before recording a live file's old url.

Found on the way: `canUserManageFile` asked the *filtered* client, so every soft-deleted file
answered "no such file" and **no file could be restored at all** — /files offered the button
(its listing inlines the same rule over rows it fetched unfiltered) and the action refused it.
It reads the unfiltered client now; liveness is the caller's question, not this one's.

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
- `/files/[slug]/download` — the pasteable download URL, resolving to the bytes route.
  `/files/[slug]` is its **post-sign-in landing**: shows title/filename/size and starts
  the download itself. Both gate on `canUserReadFile`, not `canManageFiles`, so an
  AUTHORIZED reader can use a download link without being able to reach `/files`.
  Nothing links to the landing — `FilesTable` still points straight at `/download`.

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
  Below **768px** the panel becomes a toggled overlay. Not `MARGIN_NOTES_MEDIA_QUERY`,
  which this line named and the build never used: `POSITIONED_MEDIA_QUERY` in
  `PdfAnnotationSurface.tsx`, mirrored by `PdfViewer.module.css`'s `max-width: 767px`,
  shipped at 768px in this phase's own commit so that the narrowest iPad in portrait still
  gets viewer and panel side by side. A fixed-width card list beside a viewer with nothing
  to reflow can go narrower than a rail that needs room for live prose — and the doc rail's
  own threshold is 1180px in any case (§18).
- Toolbar: page number/count, prev/next, zoom (`page-fit`, `page-width`, numeric), rotate.

---

### Phase 3 — Anchoring and annotations

*As built: docs/ANNOTATIONS.md ("Anchoring", the PDF row, and "Surfaces") and docs/PDF.md.*

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
queue, since awareness coalesces. docs/PDF.md §9 carries this shape as the wire format.

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

**Where the implementation settled differently from docs/PDF.md's original design, that
file says so in place** — `PDFViewer` rather than `PDFViewerApplication` (its §10),
`convertToViewportRectangle`'s absence in pdfjs 6 (§5), annotations as rows rather than a
`Y.Map` (§9), the wider wire format (§9), fuzzy matching and lazy re-anchoring deferred
(§3, §4). It keeps no separate departures list: each rule there is stated as what is true
now, and that file is the one a reader of docs/PDF.md actually reaches for.

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
- **The annotation panel speaks the file surface's vocabulary** — PRIVATE / SHARED and a Save
  button, no "Post & notify authors" (so `RAISED` is unreachable from `/pdf/[slug]` though the
  mail path to a file's owners is live), and no sort control, since above the breakpoint the
  panel *is* the rail. The wording is `LiveAnnotationComposer`'s `container` prop, so the two
  surfaces share one composer and one submit path. docs/ANNOTATIONS.md, "Surfaces" and
  "Deviations from the plan".
- **The annotation panel is a tabbed side panel, and its toolbar control is an icon** —
  Phase 3 specified one button reading "Annotations / Hide annotations". There are three
  things worth putting beside the viewer — the annotations, the tag chips (§20d) and a
  pane held for presence — and the column has room for exactly one at a time.

  The two questions are therefore asked in two places. The toolbar carries a **show/hide
  icon** and says nothing about contents; the panel carries a **tab strip** — Annotations ·
  Metadata · Collab — and says nothing about whether it is open. A fourth pane touches the
  panel alone, and closing and reopening comes back to the tab you were on. (That fourth pane
  arrived on 2026-09-10 and is **Contents**, first in the strip — §19b. The claim being made
  here is the one that held: adding it moved no other control and cost the viewer no height.)
  The icon is a drawn pane outline whose right section is **filled while the panel is open**,
  so the button reports state rather than only naming its target: `aria-pressed` alone is
  invisible to everyone not using a screen reader, and the toolbar's other glyphs (‹ › ⟳) are
  directional or rotational with no character available for this one.

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
  height from the PDF on every file, tagged or not. The pane holds only tags and is named
  for the category anyway: the file's own facts — size, page count, uploader, visibility —
  belong in it too, and a pane called "Tags" would have to be renamed to take them.
  Mechanically it is a rendered Server Component handed across the `ssr: false` boundary as a
  prop (`PdfSurfaceClient`'s header), which is the only way anything server-rendered gets
  inside that island.
- **Several names in the phases above are the plan's, not the tree's**, and the phase text is
  left as written. The one to know about is Phase 0's `GlobalWorkerOptions.workerPort`: it is
  exactly the trap docs/PDF.md §10 lists (a supplied port is shared, so the second mount dies
  with "the worker is being destroyed"), and `src/lib/pdfjs-client.ts` sets `workerSrc`
  instead. The rest are renames: Phase 0's `e2e/pdfjs-internals.spec.ts` is the first test in
  `e2e/pdf-viewer.spec.ts`; Phase 3's `PdfAnnotationList` is `PdfAnnotationPanel.tsx` with
  the rail positioning in `use-pdf-margin-notes.ts`; Phase 4's `PdfPresenceProvider` is the
  `usePdfPresence` hook (`use-pdf-presence.ts` — the surface reuses `DocPresenceProvider` for
  the composer rather than adding a second provider), its `src/lib/pdf-rail-layout.ts` is
  `src/lib/pdf-geometry.ts`, and Verification's `e2e/pdf-sync.spec.ts` is
  `e2e/pdf-presence.spec.ts`.

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

### 19b. The Contents pane — the document's own table of contents

**Built 2026-09-10.** A fourth tab in the side panel §19's Phase 3 already built, showing the
outline the PDF itself carries: a tree that expands and collapses, jumps the viewer to an
entry, and says which entry the reader is currently inside.

It is a *reading* aid built entirely out of what the file declares — no extraction, no
heuristics, nothing stored. A PDF without an outline gets a pane that says so.

**Where the pieces live.** The same split as §19's geometry: every rule is a pure function in
`src/lib/pdf-outline.ts` with a unit-test table beside it, the worker round trips are in
`src/components/pdf/use-pdf-outline.ts`, and the rendering is
`src/components/pdf/PdfOutlinePanel.tsx`. The surface owns exactly one new piece of state —
which entry is current — and the pane owns which rows are open.

**Four decisions worth stating, because each has a plausible wrong answer:**

- **The current entry is the last one at or above a reading line 25% down the viewport**
  (`READING_LINE_FRACTION`), ordered by resolved position rather than by tree order. "The
  first heading visible in the viewport" highlights nothing through the middle of a long
  section — which is most of the time in exactly the documents that have an outline. Tree
  order breaks on the outlines real generators emit out of order.
- **A collapsed subtree hands its highlight to the outermost closed ancestor, and nothing
  auto-expands.** A collapsed "Chapter 4" lighting up while you read §4.2 is the feature;
  opening the tree to follow the scroll would delete it, and would move rows under the pointer
  of a reader trying to click one.
- **Jumps go through pdfjs's `PDFLinkService.goToDestination`, not `jumpDestinationY`.** A
  destination is something the document declared — a name, an array leading with a page ref,
  any of the `Fit` variants — and pdfjs resolves all of it, keeping the reader's zoom where the
  destination doesn't set one. This is why `linkService` is now on `PdfViewerHandle`. The
  visible difference from an annotation jump is deliberate: a heading lands at the top of the
  viewport rather than a quarter down, because a quote needs the context above it and a
  heading *is* that context. It also leaves the clicked heading just above the reading line,
  so the entry clicked is the entry that lights up.
- **Two levels start visible, by depth alone** (`defaultExpanded`): top-level parents open
  and nothing below does, so the pane reads as chapters and their sections, with level 3 and
  below behind a twisty rather than dumped out in full. The PDF's own `/Count` sign — the author saying which subtrees ship open
  (PDF 32000-1 §12.3.3) — is read through to `OutlineNode` and **deliberately not acted on**:
  it answers what *one file's* author wanted, where the pane needs the same shape from one
  file to the next, and following it makes a 400-entry outline that ships open bury its top
  level and one that ships closed hide that there is anything underneath. That was the rule
  until 2026-09-11.

**Two things it deliberately does not do**, both recorded in TODO.md rather than left to be
rediscovered: an outline entry pointing at a **URL** renders as a plain row and does not
navigate (opening an arbitrary URL out of an uploaded file is a phishing surface that deserves
its own decision), and there is **no fallback** for a PDF without an outline — no heading
detection over `file_page_text`, which is a different feature with its own failure modes.

**Rendered flat.** Every visible row is a DOM sibling carrying `aria-level` /
`aria-posinset` / `aria-setsize`, rather than nested `role="group"` elements. ARIA allows
either; flat is what keeps the focus ring around one row instead of around a row and its
whole subtree, and stops each level's indent from compounding with every ancestor's padding.
Keyboard movement is the APG tree pattern over `visibleOrder` — one tab stop, arrows within,
the same roving-tabindex arrangement the tab strip above it uses.

The page number beside each entry is the document's own **page label** where it has them —
§19c, built straight after this and for this reason.

**Verification.** `e2e/pdf-outline.spec.ts` (a click lands on the entry's page, scrolling moves
the highlight, collapsing hands it to the ancestor, the arrows move and open, the fourth tab
doesn't overflow the strip) plus `src/lib/pdf-outline.test.ts` for the destination arithmetic
and the highlight rules. `scripts/make-test-pdf.ts` grew outline support to make any of it
testable: no PDF in the repo had one, and the generated fixture covers an inline destination
array, a **named** destination resolved through the catalog's `/Dests`, and a closed-by-default
subtree — the three arms the resolver has to tell apart.

### 19c. Page labels — what the document calls its own pages

**Built 2026-09-10**, immediately after §19b, because the Contents pane made the gap
impossible to miss: an entry pointing at the fourth sheet of a book with three pages of front
matter is page **1**, and a table of contents that says "4" is the one thing a table of
contents exists not to make a reader work out.

A page's *index* is where it sits in the file; its **label** is what is printed on it
(`/PageLabels`, exposed as `pdf.getPageLabels()`). They differ in anything with front matter,
an appendix numbered `A-1`, or a scanned volume whose numbering starts partway in.

**Indices stay 1-based everywhere internally.** Anchors, presence, the offset table, every
jump: unchanged. This is a display concern, and `pageLabelFor` (`src/lib/pdf-page-labels.ts`)
is the one function that answers it — for the Contents pane's badge, the annotation cards'
`p. 4`, the composer's "Annotating page …", the indicator strip's tick titles and the
toolbar's box. Anything *computed* from a page keeps counting sheets.

**Labels are ignored when they say nothing.** `usablePageLabels` rejects a set whose every
entry is its own ordinary number — plenty of files ship a `/PageLabels` tree that reproduces
1…N, so honouring it changes no glyph on screen while switching on the chrome that exists to
explain a label, down to a "Sheet 4 of 6" title on a box already showing 4 — and one that is
entirely empty. A *partly* empty set is kept with the blanks filled in by the ordinary
number, since unlabelled front matter beside a labelled body is common and dropping the whole
set would throw away the informative half. The filled-in array is what goes to
`PDFViewer.setPageLabels`, so what we render, what pdfjs puts on `data-page-label`, and what
`pageLabelToPageNumber` will match are one list.

**The page box takes a label back.** `submitPage` tries `pageLabelToPageNumber` first and
falls through to a sheet number, because a reader typing into a box that is *showing* them a
label means the label — "1" is the body's first page, which is what a citation means. Labels
are not unique (front matter 1–12 and a body restarting at 1 give two pages called "1"); the
first match wins, as it does in pdfjs. The sheet number moves to the box's `title` ("Sheet 4
of 6") rather than disappearing, since it is what the scrollbar and every "page N of M" habit
are still counting in.

**The total beside the box counts in the box's units too** (`pageTotalLabel`, added
2026-09-14). A box showing "1" next to "of 362" is a pair that doesn't go together; what the
reader's copy says the book runs to is 350. **The last label is the wrong answer**, though,
because the end of a document is where labels stop being numbers — an index, a colophon, an
appendix running `A-1` — and "of A-12" names no quantity at all. So the last **five** pages are
searched from the back for a plain integer and the first one found wins, with the sheet count
as the fallback when the whole tail is unnumbered. Five because back matter is short: a window
wide enough to tunnel through an entire unnumbered appendix would start answering with a body
page number, which is worse than the sheet count — it reads authoritative and undercounts. The
sheet count keeps a home in this element's own `title` ("6 sheets"), as it does on the box.

**Verification.** `src/lib/pdf-page-labels.test.ts` for the "worth showing" rule and its
rejections, and for the total's tail window (a clean numbered ending, an index, an appendix
long enough to give up on); `e2e/pdf-page-labels.spec.ts` for the two surfaces agreeing, a
typed label navigating, and a 1…N label set correctly ignored. `scripts/make-test-pdf.ts` grew a
`pageLabels` option — a `/PageLabels` number tree, whose keys are **0-based** page indices,
the one place in the format that counts from zero.

### 19d. Zoom gestures — pinch and ctrl-wheel belong to the document

**Built 2026-09-10.** On a full-viewport app shell whose whole point is that the viewer fills
the height, the browser's own zoom is the wrong response to a pinch: it resizes the chrome, the
toolbar and the side panel around a document that stays exactly as illegible as it was. So
inside `.viewerContainer`, pinch and ctrl-wheel change `PDFViewer`'s scale instead. Everywhere
else on the page, both still zoom the page.

**Three input paths, two gestures**, all ending in one `viewer.updateScale({ scaleFactor,
origin })`: ctrl-wheel (which is also every trackpad pinch, and `metaKey` beside it),
two-finger `touchmove` (phones and Android), and Safari's non-standard `gesture*` events,
preferred where they exist with the touch path standing down. The engine facts behind each —
why a trackpad pinch is a `wheel`, why `deltaMode` needs converting, why the listener must be
non-passive, why `updateScale`'s `origin` rather than `currentScale`, and why the container
takes `touch-action: pan-x pan-y` and never `none` — are docs/PDF.md §10c's, stated once
there. The decision here is only *which* element the gesture belongs to: the document, not the
page.

**A mouse notch is one step of 10%, on every browser and every OS setting** (2026-09-14).
The first version ran notch and pinch through one exponential and clamped it, so every notch
in every browser landed on the clamp — 25% in, 20% out — and the constant meant as a guard
had become the step size. There is no cross-browser *size* for a notch to normalise
(docs/PDF.md §10c: Chrome's pixel count carries the OS lines-per-notch multiplier, Firefox's
line count doesn't), so the decision is not to measure one: a delta big enough to be a physical
notch is one tick, a tick is pdfjs's `DEFAULT_SCALE_DELTA` of 1.1, and only the sub-5-pixel
band that is demonstrably a pinch keeps the curve. This is the parity pdf.js's own viewer has
for line mode and never extended to pixel mode. Ctrl and ⌘ are both zoom modifiers
(`wheelIsZoom`), ⌘ because Cmd-scroll is macOS's own page zoom. `WHEEL_SOFTNESS` was left at
200 that morning — Firefox's pinch encoding says 100 tracks the fingers exactly, so 200 was a
deliberate half-speed. Tested the same day on all three Playwright
engines (chromium, firefox, webkit; dev and prod targets): a held-ctrl notch of 240, 100 or 53
px, ⌘ in place of ctrl, dispatched line and page events, the 2 px pinch frame and the fractional
carry all behave identically and the page zoom stays at 1 — docs/PDF.md §10c has the table. What
no engine there could show — Playwright's Firefox sends pixels — was then measured on a **real
Firefox 155 on a Mac** the same day, with native wheel events (`scripts/macos/native-wheel.c`,
e2e/MACOS.md): a notch arrives as **one line** (not the three Linux and Windows send), ctrl and ⌘
each give exactly one ×1.1 step, the browser's own zoom never fires, and the read-order shim is
real and on a Mac costs a whole notch rather than a mis-sized one — docs/PDF.md §10c has that
table too.

**A trackpad pinch has its own gain, and on Safari the wheel constants never see it**
(2026-09-14, afternoon). Asked to double the trackpad zoom rate, the first move was to halve
`WHEEL_SOFTNESS`; the user then set it to 30 and felt no difference at all, which is the tell
that the constant is not on the path. Measured on the MacBook's trackpad in Safari 26.6.1, with
a capture listener recording every event on the page (docs/PDF.md §10c): a pinch arrives as
`gesturestart` / 69 × `gesturechange` / `gestureend` and **zero** ctrl-wheel events, and the
document scale tracks the gesture's cumulative `scale` one to one. So the rate lives in the
gesture path, and the decision is one knob for the trackpad, `TRACKPAD_PINCH_GAIN` — an
exponent on the per-frame factor, applied by `gestureStepFactor` on Safari's path *and* to the
ctrl-wheel pinch branch Chrome and Firefox use (`WHEEL_SOFTNESS` goes to 100, exact tracking,
so both paths are at the same rate and there is one number to change by feel). Its value is
quoted nowhere but its own declaration: `e2e/pdf-zoom.spec.ts` imports the constant for its
bound and docs/PDF.md's worked examples are written as formulas in it, so retuning is a
one-line change with nothing to chase. It is
gated on `navigator.maxTouchPoints === 0`, because the same `gesture*` events fire for an iPad's
screen, and a *touch* pinch must keep the page under the fingers. The log also caught Safari
firing a second `gesturestart` in the tail of a pinch, carrying the gesture's final scale
(0.84): the handler used to reset its baseline to 1 on every start, which would have replayed
the whole gesture as one more step had a `gesturechange` followed, so the baseline is now the
start event's own `scale`. The wheel branch was then measured the same evening on a real
Firefox 155 and Playwright's Chromium 151 on the same trackpad (docs/PDF.md §10c): a pinch is
ctrl-wheel only in both, a slow spread lands every frame in the pinch band and the document
moves by fingers^gain exactly, so the parity is now measured rather than arithmetic. The same
run found the gap: a **quick** pinch delivers 12–72 px frames, which `readWheel` read as mouse
notches, so a fast pinch zoomed *less* than a slow one and the gain never applied. The fix is a
rule about time, not size, because size is exactly what a large pinch frame shares with a notch:
`createWheelReader` keeps a frame on the pinch curve while it arrives within `PINCH_FOLLOW_MS`
of the last pinch frame, and the sub-5 px band becomes only how a pinch *opens*. A wider band
was rejected because it would hand every accelerated mouse to the exponential; the window's
cost is a notch rolled within a quarter second of lifting the fingers, which reads as one
clamped pinch frame instead of one tick. Measured on Windows the next day, where it found a bug — below.
Still unverified: the iOS half above.

**Safari's gesture path loses frames under load, and the gain was tuned on it** (2026-09-15). With the follow window in, the user felt Firefox zoom far more than Safari. Measured
against the OS's own magnify stream (docs/PDF.md §10c; the tap, the poster and the bare page
are e2e/MACOS.md's), the two wheel encodings are exact and lossless — Gecko and Blink
coalesce dropped frames by summing — while Safari's `gesturechange` carries only its own
frame's magnification and WebKit discards the frames a busy main thread could not take. On
`/pdf/[slug]`, one identical posted pinch moved the document ×3.3 in Firefox and Chromium and
×1.35 in Safari; on an idle page Safari delivers every frame. So `TRACKPAD_PINCH_GAIN` was set
by feel against a path that was delivering a fraction of each pinch, and the fraction depends
on how busy pdfjs is. **Decided: leave it.** The machine it was measured on is a 2019
two-core MacBook Air, and the loss is that machine's main thread not keeping up with pdfjs at
trackpad cadence; on hardware that keeps up, Safari delivers every frame (the bare page shows
it does when the page is cheap) and the three engines agree. The options weighed and not
taken: a CSS transform on the viewer during the gesture with one real `updateScale` at
`gestureend`, which is how native pinch-zoom is usually done and would make every frame cheap
enough for any machine; estimating the lost magnification on Safari from the delivered
frames' spacing, a velocity guess wrong whenever the fingers change speed; and a per-engine
gain, which papers over a loss that varies with load. If the transform path is ever wanted,
the measurement to repeat is the synthetic pinch on the real page, e2e/MACOS.md.

**Windows measured, and its third wheel setting was a real bug** (2026-09-15). The Windows
lines-per-notch case left unverified above was measured on a Dell XPS 15 9510 — trackpad,
touchscreen and mouse, on the app's own page through `scripts/remote-console.ts`, in two
browsers and at three `devicePixelRatio`s; docs/PDF.md §10c has every table. Three of the four
paths were already right: a slow trackpad spread tracked the fingers, a quick one stayed on the
pinch curve through `PINCH_FOLLOW_MS` (×0.3112 against fingers of ×0.3087, a third platform for
that fix), a touchscreen pinch went through `touchmove` alone with no `gesture*` and no `wheel`,
and a mouse notch was one 10% step at both the default three-lines setting and at one line. The
fourth was not. **Set to "one screen at a time", Windows switches Blink to `deltaMode` 2 and
sends 1/`devicePixelRatio` of a page** — 0.364, 0.381 and 0.667 at the three measured, never 1
— and `readWheel`'s guard for a fractional line, written on the reasoning that no device sends
one, turned that into a fraction of a tick: three notches per step, and none at all for a reader
who alternates, since `createTickAccumulator` drops its carry on a reversal. Five ctrl-notches
moved the document zero times. **Decided: a page-mode event is one notch at any magnitude** (a
fraction of a screenful is still one wheel click), while a fractional *line* keeps accumulating
— Gecko alone reports lines and does not divide by the backing scale. Rounding the magnitude up
as a special case was rejected by the same measurement: it is the reciprocal of a number that
moves with the monitor and the page zoom, so there is nothing to match against. The commit that
claimed "one 10% step on every browser and OS setting" was one OS setting short, and it is the
setting no Mac has.

**Two corrections the second browser forced, which is why there was a second browser.** The
first pass ran in Vivaldi, whose UA and `userAgentData` both say Google Chrome and nothing else;
it was taken for Chrome until the user remarked that ctrl-minus steps by 5%. Re-measured in real
Chrome, the fractional page and the ungained trackpad reproduced exactly — but the notch size
did not. Vivaldi had been sitting at 110% page zoom, which had made a notch read 90.909 px and
produced a confident "about 30 px per line, not 100" correction to docs/PDF.md that was simply
the true 33.3 divided by 1.1. Chrome sends **100.000 px at the default setting at a dpr of 2.5
and again at 1.5**, so the file's original ~100 was right all along; what is wrong in it is only
"*multiplied by* the lines setting", since the default is already the multiplied value. The
second finding is worth more than the first: **page zoom, not display scaling, is what moves the
CSS delta**, so at one line per notch and 125% zoom a notch is 26.7 px — under `PIXELS_PER_TICK`
— and the first notch of a gesture would zoom nothing. That is two keystrokes away from a
default install, and it is the argument against ever raising that constant.

**The trackpad gain does not apply on a Windows touchscreen laptop, and is left that way.**
`TRACKPAD_PINCH_GAIN` is gated on `navigator.maxTouchPoints === 0`, which on a Mac means "not a
touchscreen, so this is the trackpad". The XPS reports `maxTouchPoints` 10 and
`(pointer: coarse)` **false** — the two discriminators disagree on hardware that has both — so
the trackpad took the touch branch and the slow spread moved the document ×2.5395 against
fingers of ×2.5666, fingers¹ rather than fingers³. `(pointer: coarse)` would get both platforms
right and is a one-line change. **Not made**: the gain is a feel knob, it was tuned by feel on a
Mac against a *lossy* Safari path (the paragraph above), and the user's verdict on the Windows
machine with no gain at all was that it felt right. Changing the gate would triple the rate on
every Windows trackpad on the strength of a symmetry argument rather than a preference, and the
preference is the whole content of the constant. The disagreement is recorded in docs/PDF.md
§10c so the next person to touch the gain knows the gate is wrong on one platform rather than
discovering it as a feel regression.

**The zoom dropdown had to become a readout as well as a control.** A gesture lands on any
scale it likes, and a `<select>` whose value matches no option renders *blank* — so
`scalechanging` now feeds it, and a non-preset scale gets an option of its own showing the
percentage. Picking "Fit width" and then pinching correctly stops the document being fitted to
anything, which the control now says.

**What is verified, and what is not.** `e2e/pdf-zoom.spec.ts` covers ctrl-wheel (including the
negative half — the page's own zoom must not move — which a `{ passive: true }` slip would
break while everything else still passed), an ordinary wheel still scrolling, the dropdown's
readout, the touch arithmetic reaching pdfjs, and the `touch-action` value. `src/lib/pdf-zoom.ts`
has the factors and their clamps under unit test. **The iOS half is not verified**: whether
`touch-action` alone suppresses Safari's own pinch zoom is a real-device measurement, and
docs/PDF.md §10c carries the recipe (`scripts/remote-console.ts`) rather than an assumption —
this file already records two iOS touch claims that measured false.

### 19e. Re-fitting the zoom when the container changes shape

**Built 2026-09-10**, alongside §19d. `PDFViewer` computes a named scale **once**, when it is
set, and then holds the resulting number — Mozilla's viewer *application* re-applies it on
resize, and we build on the library, so nothing did (docs/PDF.md §10c). The visible cost was
a phone: open a document fitted to a portrait width, turn it sideways, and the page stays the
size it was, in a column of empty space.

Two rules, because a reader can have said two different things:

- **A named scale is a standing instruction.** "Fit the width" means fit *this* width, so it is
  re-applied on any container width change — a rotation, a window drag, the side panel opening.
- **A number is a decision already made.** An explicit zoom survives ordinary resizes untouched,
  and is scaled only by a **rotation**, in proportion to the width.

**Why a rotation touches a chosen zoom at all**, when the reader chose it: turning a tablet from
landscape to portrait takes width away, and a page that fitted before then needs sideways panning
to read a single line — the one thing a reader cannot work around by scrolling. Scaling with the
width keeps *how much of the page they see* fixed, which is the part that decides whether a line
is readable.

**The width ratio is an approximation, deliberately.** It stands in for the ratio of the two
fit-to-width scales, which it equals up to pdfjs's fixed scrollbar allowance — about a tenth of a
phone's width. Computing the real thing means either duplicating pdfjs's internal padding
constants or setting the scale to `page-width` to read it back, which the reader would watch
happen. It only ever applies to a zoom the reader picked by feel, so a few percent is beneath
notice; anyone *exactly* fitted is on the named scale, which is exact.

**A rotation is recorded, not acted on.** The orientation media query flips before the layout it
causes, so the handler only timestamps; the `ResizeObserver` on the container is what knows the
new width, and it expires the arming after 1.2s (iOS animates the rotation). `matchMedia
("(orientation: portrait)")` rather than `screen.orientation` or the deprecated
`orientationchange` — one spelling every engine in the baseline agrees on — gated on
`(pointer: coarse)`, since dragging a desktop window through square is not a reader turning a
device over.

**Verification.** `e2e/pdf-zoom.spec.ts`'s second describe, driven by `setViewportSize`, which is
what a rotation is from the page's side. The fit case asserts the page *fits* the new width
rather than a ratio — the ratio assertion is what caught the scrollbar allowance in the first
place.

## 20. Tags, and the anchor envelope they share with annotations

Tags are new: a vocabulary of terms (`tag`), applied to content by acts of tagging
(`tag_assignment`), where one act may target **the whole of, or parts of** a doc, a post,
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

Ships as **two PRs**: PR 1 is the shared library plus whole-object tags, complete and
tied off on its own; PR 2 is part-targeting plus the annotation migration. §20h has the
split.

### 20a. One row-shape, per-consumer tables — and the shapes rejected

Three shapes were considered and two rejected:

- **One W3C-style annotation supertable** (everything is an "annotation" with a motivation
  column; a tag is an annotation whose body is a tag) — rejected. `Annotation` carries a
  live ydoc body, caches, an `AnnotationStatus` lifecycle, and a raise/notify flow; a tag
  assignment has none of those. Folding them together would be the false unification this
  document keeps warning about, and every consumer would pay branches on `motivation`
  forever.
- **One shared `anchor` table with an owner arc** (`annotation_id?`/`assignment_id?`/…) —
  rejected. Two exclusive arcs in one table, every new consumer widening it, cascades running
  through CHECK-guarded nullable FKs, and Prisma include gymnastics on the owner side. The
  queries that would benefit ("everything anchored here, regardless of kind") are not hot
  paths — every surface fetches annotations and tag chips separately because it renders
  them differently.
- **Per-consumer anchor tables sharing one column shape** — chosen. `annotation_anchor` and
  `tag_anchor` each carry a plain required owner FK with a clean cascade, and the same
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

Shown once, on `TagAnchor`; `AnnotationAnchor` (§20e) repeats it verbatim below its own
owner FK.

```
model TagAnchor {
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
  @@map("tag_anchor")
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

### 20c. Tag schema (PR 1)

```
model Tag {
  id          String  @id @default(cuid())
  slug        String  @unique
  name        String
  description String?
  createdById String  @map("created_by_id")
  createdAt   DateTime @default(now()) @map("created_at")
  deletedByUserId String?   @map("deleted_by_user_id")
  deletedAt       DateTime? @map("deleted_at")
  @@map("tag")
}

model TagAssignment {
  id        String   @id @default(cuid())
  tagId String   @map("tag_id")
  userId    String   @map("user_id")
  createdAt DateTime @default(now()) @map("created_at")
  deletedByUserId String?   @map("deleted_by_user_id")
  deletedAt       DateTime? @map("deleted_at")
  // tag (Cascade), user; anchors TagAnchor[]
  @@index([tagId])
  @@index([userId])
  @@map("tag_assignment")
}
```

- **An assignment is one act of tagging** — the `doc_link_group` analogue. It owns 1..n
  anchors and carries who tagged and when. Tagging a whole doc is one assignment with one
  selector-less anchor; PR 2's part-tagging adds anchors, not concepts.
- **Anchors have no soft delete of their own.** Removing one part of a multi-part act
  deletes that row; removing the act soft-deletes the assignment. An anchor is a part of a
  record, not a record.
- **Soft-delete wiring:** `tag` joins the `$extends` filter in `src/lib/prisma.ts` (it
  has an admin table that needs `prismaIncludingDeleted` to offer restore, same as
  `storedFile`). `tag_assignment` does **not** join it and filters by hand — the filter
  intercepts top-level operations only, and assignments are read almost exclusively through
  `tag_anchor` includes, which it cannot reach. Stating that here so the divergence reads
  as chosen, not missed (the §14b convention).
- **Hand-written DDL** in the migration, with comments citing this section: both CHECKs from
  §20b, and `CREATE UNIQUE INDEX … ON tag (lower(name))` — slug uniqueness alone would
  admit "Epistemology" and "epistemology" as distinct terms.
- **Slugs are their own namespace** (`/tag/*`), like docs' and files': `tagSlugInUse`
  checks `tag` only. No slug history table in v1 — a renamed tag breaks inbound
  `/tag/…` links until it earns one (§20i).
- **Whole-object dedup is app-level find-first** in the action (same tag, same object,
  same user → no second assignment). The DB-enforced version needs `tag_id` denormalized
  onto the anchor for a partial unique index; deferred until concurrent tagging is a thing
  that happens (§20i).

### 20d. Tag surfaces (PR 1)

- **Chips on the object pages** — `/doc/[slug]`, post pages, `/pdf/[slug]`: one indexed
  `tag_anchor` query by container, joined through live assignments to terms.
  Server-rendered; gated by the page's own access check, so a PRIVATE doc's chips are as
  private as the doc.
- **`/tag/[slug]`** — the browse page, as **per-type sections** (docs tagged K, posts
  tagged K, files tagged K), each an indexed, SQL-paginated query wearing that type's
  existing permission predicate (`readablePostWhere` — `publishedPostWhere` as built,
  widened in §20l; doc visibility + `DocAuthor`; `file-authz`). Deliberately not an interleaved single timeline: that is a UNION view that
  would re-implement four permission models in one place — the easiest leak to write and the
  hardest to see. Counts shown here come from the filtered queries, never from the view
  below, for the same reason.
- **`/tags`** — an admin table through the §16 kit: `tags-query.ts` over
  `table-query.ts`, plus a `tag_metrics` view keyed 1:1 on `tag_id` (assignment
  count, per-type object counts, last used) so every column sorts. Built by grouping the
  assignment/anchor tables, **never `FROM tag`** — `doc_metrics`' double-scan lesson
  (§16l). All cheap aggregates (`count(*) FILTER`, `max`); nothing here is
  expensive-to-compute, so no trigger-maintained column unless sorting by usage measures
  badly at real scale (the §16l view-vs-column rule decides, not taste).
- **Permissions** get their own rows in docs/PERMISSIONS.md before the actions land.
  Proposed defaults, confirmed there rather than here: applying or removing your own tag on
  a surface follows the permission to annotate that surface; creating a new term follows the
  same; renaming, merging, and deleting terms is ADMIN/EDITOR. Open question §20j-1.
- **Cache:** tagging revalidates the tagged object's own path; `/tag/[slug]` renders
  dynamic (it is permission-shaped per viewer, so ISR would be wrong anyway). CACHING.md gets
  a line when built.
- **Tie-off:** at the end of PR 1 the part columns exist, constrained, and unwritten; no UI
  mentions parts. The feature is complete as "tag whole things": chips, browse, admin,
  fixtures that create and delete their own throwaway tags (docs/TEST_DATA.md gets the
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
- **Tag part-anchors use the column mechanism on every surface, including the doc
  editor.** This is a deliberate, recorded deviation from §13o's "mechanism follows the
  surface": a tag mark would add a second mark type to the collaborative doc grammar,
  a second `excludes: ""` growth path, and a second decoration-splitting layer, for ranges
  lighter-weight than discussion threads. The zero-rows convention keeps the door open if
  editor-applied tag ranges ever prove to need mark-grade drift immunity. The schema
  comment on `tag_anchor` says this out loud, adjacent to `annotation`'s comment
  describing the opposite — §14a's rule.
- **Part-tags join the rail** by feeding the same plugin state and per-transaction resolve
  pass as annotation ranges — preserving `annotation-marks.ts`' "one pass for every id"
  rule, so twenty tag ranges cost what twenty more annotations would, bounded by §13o's
  tiering.

### 20g. Performance and integrity

- Every hot query is an indexed FK lookup on tables sized like `annotation`. The doc
  reading page adds one batched `include` (anchor rows on the annotations it already
  fetches) and one `tag_anchor` query by container — constant query count, no N+1.
- No new per-keystroke O(document × text) surface: resolution stays client-side and tiered
  (map → windowed search → one global scan, §13o), shared by both families in one pass.
- Writes are one transaction: owner row plus N anchor rows.
- Indexes are the plain per-column set in §20b; partial (`WHERE doc_id IS NOT NULL`)
  variants are a later, hand-written upgrade if these tables ever get large enough to care.
- `scripts/integrity/check-annotation-anchors.ts` generalizes: the replay invariant
  ("materialize the state the stamp names; `textBetween` must equal `quoted_text`") is a
  per-row property, so one checker walks `annotation_anchor` and `tag_anchor` alike —
  PR 1 adds the walk (trivially green with only whole-object rows), PR 2 makes it earn its
  keep, and it is the parity gate for §20e step 4.

### 20h. Build order — two PRs

**PR 1 — the shared layer, and whole-object tags.**

1. Extract `src/lib/anchors/`: the anchor TS type (target arc as a discriminated union,
   selector kinds), `parseSelector` (the `parseDocLinkMark` convention — every jsonb read
   goes through a parse, never a cast), and the capture/resolve functions refactored out of
   `annotation-anchor-capture.ts`/`annotation-anchors.ts`. Pure refactor; annotations
   unchanged; the e2e suite is the proof.
2. Migration: `tag`, `tag_assignment`, `tag_anchor` (§20b/§20c), with the
   hand-written CHECKs, `lower(name)` unique index, and arc indexes.
3. `tag_metrics` view migration + schema `view` block (§16e caveats apply verbatim).
4. PERMISSIONS.md rows; server actions: create term, tag object (find-first dedup), untag,
   admin rename/delete.
5. Surfaces: chips on the three object pages; `/tag/[slug]` per-type sections;
   `/tags` through the kit.
6. Tie-off: e2e specs (tag → chip → browse → untag; `/tags` sort through the view);
   throwaway-tag script in docs/TEST_DATA.md; integrity walk from §20g. Part columns
   present, constrained, unwritten.

§20k records what PR 1 actually shipped — only the places it deviates from, or decides
something left open by, the sections above.

**PR 2 — part-targeting, and the annotation migration.**

7. Tag part-capture on the reading views (columns + stamp, §20f), rail integration.
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
- **Tag slug history; DB-enforced whole-object dedup; partial arc indexes.** Each a
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
3. **Does `/tag/[slug]` paginate per section or cap-with-link?** Per-section
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

**A schema-level integrity script, `check-tag-constraints.ts`.** §20g's replay walk covers
stored data; nothing covered the *DDL*. It attempts each violation in a rolled-back
transaction and asserts Postgres refuses it. It earned itself immediately: it caught that
§20b's stated CHECK — `(selector_kind IS NULL) = (anchor_from IS NULL AND anchor_to IS NULL
AND selector IS NULL)` — is a **group-wide equality, not a per-kind rule**, so a `DOC_RANGE`
row with offsets and no `selector` blob is legal. That is correct and load-bearing: it is
exactly the shape §20e step 1's backfill writes, since today's annotation column anchors carry
offsets, a quote and a stamp but no context blob. A stricter CHECK would have blocked PR 2's
migration. The residual it leaves — `PDF_TEXT` with offsets and no blob — is printed by the
script rather than buried, and belongs with PR 2's writer.

**`tag_metrics`' count columns are declared nullable, and it matters.** A term nobody has
used has no view row (the `doc_metrics` semantic, §16l), so Prisma's LEFT JOIN yields NULL —
and plain `DESC` puts NULLs *first* in Postgres, which made "sort by most used" lead with
never-applied terms. Declared non-null, Prisma rejects the `{ sort, nulls }` form. Nullable
plus `nulls: "last"` is the fix. Caught by the e2e spec, not by review. `file_metrics` is
declared the other way and escapes this only because every file has an owner, so its FULL
OUTER JOIN always emits a row.

**Chips read no session at all**, which is not how §20d's "server-rendered" reads at first.
`/[slug]` carries `generateStaticParams` and `revalidate = 60`, and a dynamic API there throws
`DYNAMIC_SERVER_USAGE` at build (§12f) — so reaching for `auth()` to decide whether to draw a
tagger would have broken the build on the page tags most need to reach. Which terms are on
an object is the same answer for every viewer who can see it; everything viewer-shaped moved
into a client island that calls `loadTaggerState` when opened. The build output confirms
`/[slug]` is still `●`.

**§20j-1 decided: minting a term is the same permission as applying one.** AUTHORIZED users
grow the vocabulary. **§20j-3 decided: per-section cap, not per-section pagination** —
`PAGE_CAP = 50` with an honest "showing the first N" line, since three `?page=` params on one
page is a URL nobody can read for a page that has a handful of rows per type. Both recorded in
docs/PERMISSIONS.md and `tag-browse.ts` respectively, both cheap to revisit.

**One judgment call not in §20d**: tagging requires a signed-in AUTHORIZED account on *every*
surface, posts included. "Follows the permission to annotate that surface" read literally
would open post-tagging to COMMENTER and to signed-out visitors, since commenting is open to
both — and a tag is curatorial where a comment is conversational. docs/PERMISSIONS.md states
it as a judgment call rather than as a reading.

**On `/pdf/[slug]` the chips are a panel tab rather than a strip.** Not a §20d departure —
same component, same gate, same `tagsForTarget` query, only a different container. A strip
above the viewer would take height from the PDF permanently on a page whose layout exists to
give the document the whole viewport, so the chips are the **Metadata** tab of the side panel
instead. §19's deviation list carries the mechanism and the constraints it has to respect.

**On `/doc/[slug]` the chips are a second line of the byline**, not a block below the text — a
tag says what the whole document is about, which is the same kind of fact as who wrote it
and when, so it belongs with the rest of the document's metadata. The strip therefore has two
variants (`TagStrip`'s own type documents the split), and the question they answer is
whether the strip has to name itself: a **section** — a post page, the PDF viewer's Metadata
pane — carries the "Tags" label, because nothing around it says what the row is; a
**bare** one carries none, because it has been dropped into something that already says so.
One prop rather than two, because it is one decision.

**Not in §20d: the doc editor's Settings panel gets a Tags field.** §20d put chips on
reading surfaces only, and `/doc/[slug]/edit` is where the rest of a doc's metadata is
administered — authors, visibility, URL — so tags being absent there was a gap rather
than a boundary. It is `TagStrip` itself, `bare` under a `<legend>Tags</legend>` —
not a lookalike built from the panel's own parts. What a chip looks like, where it links, who
may tag, what the popover offers, how you retract your own tag: all of it stays in one place,
so the two surfaces cannot drift. The panel contributes the fieldset and nothing else, and in
particular **no second permission check** — `canUserTagTarget` reads a doc through
soft-delete-filtered `prisma`, so a binned doc is already untaggable and the tagger says so on
open; a client-side guard beside that could only disagree with it.

The one asymmetry left is where the chips come from, and it is the reason for the two seams
this needed. An object page server-renders them and the actions' `revalidatePath` brings them
back; the panel fetches them when it opens, which is out of reach of both that and
`router.refresh()` — hence `TagTagger`'s optional `onChange`, passed through by
`TagStrip`. And `TaggerState` now carries `applied: TagChip[]` instead of an id list
plus a separate "yours" list, because the panel has to *name* the applied terms; both of the
old fields are `filter`s over the new one.

**Also decided in passing**: `/tags` sets the same bar as every other admin table
(`canManageDocs`), not `canApplyTags` — an AUTHORIZED user reaches the vocabulary through
the tagger and `/tag/[slug]` instead of a seventh visibility tier. The four arc legs are
all live in the action and authz layer, including annotations, though only three have chip UI;
the fourth is one `canUserTagTarget` branch rather than a hole to fill in later.

### 20l. Tagging an unpublished post (2026-09-16)

**Built 2026-09-16.** PR 1 made a post taggable only once it was live:
`canUserTagTarget`'s post branch wore `publishedPostWhere()`, and the comment beside it named
the reason — a tag on a draft would be a title `/tag/[slug]` could show to a stranger. That
reason was sound and the remedy was aimed at the wrong end. Tagging is most useful *while*
something is being written; what must not leak is the browse page, not the act.

So the containment moved to the surface that does the leaking:

- **`readablePostWhere(userId, role)`** (`src/lib/post-status.ts`) — `publishedPostWhere()`
  ORed with the unpublished posts this viewer may edit. It is `canUserEditPost` written as a
  `where` clause, with the same caveat `listDocs` records about Prisma being unable to share a
  predicate between a per-row check and a query filter, and the same
  `role === "AUTHOR"` narrowing that function has (a byline survives a demotion; the
  permission does not).
- **`canUserTagTarget`'s post branch and `tag-browse.ts`'s `listPosts` both call it**, which
  is the whole point of it being a function: the gate that lets a tag land and the page that
  lists what was tagged cannot drift into disagreeing about who may see a draft.
- **An unpublished row links into the editor, not to a public URL.** `postPath` throws on a
  null `publishedAt` by design, and a scheduled post's `/yyyy/mm/dd/slug` does not answer
  until its date arrives — so both get `/post/[id]/edit`, plus a `draft`/`scheduled` chip on
  the row. `TagHit` gained a `note` field for it. Without that the same list quietly means
  different things to different viewers, which is the kind of per-viewer page that is worth
  admitting to being one.
- **Nothing public moved.** The landing page, the archives, RSS, search and
  `/yyyy/mm/dd/slug` stay on `publishedPostWhere()`; `readablePostWhere` is only for surfaces
  that were already viewer-shaped. `/tag/[slug]` is `force-dynamic` already, so there is no
  shared cache entry to leak through.

Two things needed no change, both because they had already decided this question the other
way and said so. `tag_metrics` deliberately does not filter publication state — its migration
comment reads "a draft post is real content an editor is curating" — and `/tags`, where those
counts surface, is AUTHOR-and-up with no per-viewer row scoping because a *term* carries no
visibility. And `pathForTarget` already returned null for a post with no `publishedAt`, so
tagging a draft revalidates nothing public.

**Also in the same change: the post editor grows a tag strip.** `/post/[id]/edit` renders
`TagChips` above the rule that separates the post's own metadata from the read-only render of
the doc — the same gap §20k closed on the doc side, and the surface that made the draft
restriction impossible to miss. `TagChips` is an async Server Component and `PostPublisher` is
`"use client"`, so it crosses as a keyed prop, the way `/pdf/[slug]` hands one to its viewer.

### 20m. Carrying a doc's tags onto its post (2026-09-16)

**Built 2026-09-16.** A post is a snapshot of a doc (§15), and the two are tagged
independently — so the terms you filed the doc under while writing it were, until now, terms
you had to find again by hand on the post. The remedy is an **offer**, not a copy.

**`/post/[id]/edit` grows a source-doc tag offer**, directly under the post's own tag strip
(§20l put that strip there): the source doc's terms that are not yet on the post, as dashed
one-click chips, plus an "Add all *n*" when there is more than one.

- **It copies; the doc keeps its tags.** Applying a term here creates a fresh
  `tag_assignment` by this viewer on the post. The doc is still about that subject after
  publication, and `/tag/[slug]`'s Docs section should keep saying so; retracting the doc
  side would also mean retracting *someone else's* act of tagging, which
  `canUserRemoveAssignment` makes a moderation power rather than a publishing one. Move
  semantics stay available as a later opt-in (§20i's list) if doc tags turn out to be purely
  a staging area, which they are not today.
- **Deliberately not the byline's behaviour**, and this is the asymmetry worth naming.
  `createPostFromDoc` seeds `post_author` from the doc's byline automatically (§15d); tags
  are offered instead. A doc's tags are a working filing system and a post's are public
  taxonomy, and they are not the same list often enough for a silent copy to be right.
- **No creation-time step was needed.** `createPostFromDoc` already redirects to
  `/post/[id]/edit`, so the offer is waiting on arrival — and unlike a one-shot prompt at
  creation, terms added to the doc *later* are still offered whenever the editor is next
  opened.
- **Its label is `Doc "<title>"`, deliberately not "From doc …".** `PostPublisher`'s
  status line already says the latter, about `selectedDocId` — and this row is about
  `post.docId`, so the two disagree the moment "Change doc…" is touched. Wording them alike
  would read as one fact stated twice and be wrong half the time. The row carries
  `data-doc-tag-offer` as its test handle for the same reason the label is not one: the
  e2e case first written against the label matched the status line instead, which is how
  the duplication was noticed at all.
- **The row empties itself.** `tagsNotYetOn` subtracts what is already on the post — by
  anyone, not just this viewer, the same rule the tagger's picker wears when it disables an
  option as "Already applied here". An untagged doc, and a doc whose terms have all come
  across, render nothing at all rather than an empty label.

**The gate is the doc's, not the page's — the one place in §20 where that is true.**
docs/PERMISSIONS.md's rule is that a chip is as private as the thing it is on,
*structurally*: `TagChips` renders only from inside a page that has already gated, and takes
a resolved target so it cannot be mounted anywhere else. This row breaks the premise rather
than the rule — it shows **one object's tags on another object's page** — and a post author
need not be an author of the doc the post was made from, so `/post/[id]/edit`'s own gate
(ownership or `canEditAnyPost`) is precisely the wrong one to inherit. The page therefore
runs `canUserReadDoc` as a second, narrower check and renders an empty offer when it fails.
That resolves §20i's deferred "cross-container visibility needs a decision, and conjunctive
is the safe default" for the display case, in favour of conjunctive.

Applying a term needs no doc-read: `canUserTagTarget(post)` alone, unchanged, because a
*term* carries no visibility (`listTagOptions` is unfiltered site-wide). Doc-read gates the
**disclosure of which terms are on that doc**, and nothing else.

**One new action, and one new writer under it.** `tagObjectMany(tagIds, kind, id)` — one
permission check, one transaction, one `revalidatePath`. The client-side alternative (n
calls to `tagObject`) is n round trips, n gate queries, and a half-filled strip if the fourth
fails. Deliberately **not** `settleBulk`: that shape is for an admin table acting on rows a
user selected independently, where one failure must not stop the rest; this is one act with
several terms in it. `tagObject` and `tagObjectMany` both write through a non-exported
`writeWholeObjectTags`, so the shape PR 1 is allowed to write (§20h: every part column
unset) is stated once — and PR 2's part-tagging adds rows to that transaction rather than a
second concept beside it.

The two differ in one respect, on purpose: **a term that has vanished between the render and
the click throws from `tagObject` and is skipped by `tagObjectMany`.** A single deliberate
click is a question about *that* term, so "it isn't there any more" is the answer to it; "Add
all" is a question about whatever is still available, where one binned term must not fail the
rest.

**"Change doc…" is not the source.** `PostPublisher`'s select moves only what the scrub bar
previews; the post's own `docId` moves when it is published from a different doc. The offer
is server-rendered from `post.docId` and so is right by construction, and the
`router.refresh()` after a publish re-renders it against the new source. Wiring it to
`selectedDocId` would show terms from a doc the post is not from.

**Two small shape notes.** `tagsNotYetOn` returns `TagOption`, not `TagChip`:
`ownAssignmentId` and `taggerCount` describe the *source*, and rendering either beside a
control that writes to the *target* would be a number answering a question nobody asked. And
`DocTagOffer` crosses into `PostPublisher` as **plain data** rather than as a rendered
element — it is a client component, so `PostPublisher` imports it directly and §20l's keyed-
lazy-chunk hazard (which `tags={<TagChips key="tags" …/>}` still carries) does not arise.

`tagsForTarget(post)` consequently runs twice on this page — once inside `TagChips`, once
inside `tagsNotYetOn`. Accepted rather than hoisted: hoisting means feeding `TagStrip`
directly and giving up the property that `TagChips` always does its own read from a resolved
target, which is the thing that makes it un-mountable on an ungated surface. One extra
indexed query on a gated editor page is the cheaper side of that trade.

**Deferred, named.** The reverse push (tagging the doc from the post, or "also tag the post"
from the doc editor) — a doc can source several posts, so that is a picker rather than a row,
and a different design. Move semantics, above. And generalising the offer to any related pair
(file → post, annotation → doc): one prop away from what is built, and not built.

**A pre-existing gap this made visible, not introduced.** A post author who cannot *edit* the
source doc reaches `/post/[id]/edit` and gets a 403 from `/api/doc/[id]/replay`, so the
read-only render below the controls never arrives. That predates this section and is
untouched by it; the e2e case here asserts only that such a viewer sees the post's own
strip and not the doc's terms.

## 21. Dated post URLs (`/yyyy/mm/dd/slug`)

A published post lives at `/[slug]` — a flat, top-level namespace. This section
moves it to `/yyyy/mm/dd/slug`.

**Built 2026-09-15**, as designed, with these deviations from the sections below —
each a place where the tree had moved on since this was drafted (2026-08-05, before §20
landed), not a change of mind:

- **`src/lib/post-path.ts`** is the one module (§21b), browser-safe so `PostsTable` can use
  it; it also owns `postDateLabel` (the byline, `yyyy-mm-dd`, from the same UTC parts as the
  URL) and `parsePostDateSegments` (§21a's shape gate, with a unit test for its rejection
  surface — a real calendar date, zero-padded, or nothing). The server half is
  `src/lib/revalidate-post.ts`: `revalidatePostPage` takes `{ slug, publishedAt }` and is a
  no-op for a draft, so every action can call it without first asking whether the post has a
  page. `postPath` itself throws on a null `publishedAt` rather than inventing a path.
- **§21e undercounted.** URL construction was six sites, not three — `/authors/[slug]` and
  the two §20 sites (`pathForTarget` in `actions/tags.ts`, `listPosts` in `tag-browse.ts`).
  `revalidatePath` was seven — `updatePostSlug` and `revertPostSlug` each invalidate the old
  and new slug's page too. And `toLocaleDateString()` on `publishedAt` was in four Server
  Components (post page, landing, author page, search), so all four now render
  `postDateLabel`; otherwise the landing list would say the 4th beside a link to `/…/05/…`.
  The e2e change touched 18 `goto` sites across six specs, not ~13 across three.
- **`revalidatePublicPaths` is handed the post-publish `publishedAt`**, not the pre-update
  row: a first publish is the moment the path comes into existence, and the pre-update row
  has no date to name it with.
- **§21d: `RESERVED_SLUGS` is gone, not corrected.** `file-slug.ts` and `tag-slug.ts` imported
  it too, and their own comments already said the reservation was about posts; with posts
  four segments deep, no consumer had a reason left. The `-post`/`-doc`/`-file`/`-tag`
  fallbacks and the four `changeXSlug` throws went with it; `slug.ts` keeps a note saying why
  there is no list.
- **§21f.1 resolved as "accept that the URL moves"** — nothing links in, and the canonical
  redirect covers a stale tab. The redirect and the `PostSlugHistory` fallback are one code
  path (§21f.3): match on slug alone, ignore the date the URL arrived with, redirect to
  `postPath(post)`. `generateMetadata` runs the same shape gate and the same canonical check,
  since it queries too.
- **`/post/[id]/slug` gives `SlugManager` the date path as `urlPrefix`** — a scheduled post
  shows the path it will have when it goes live; a draft gets the literal `/yyyy/mm/dd` as a
  placeholder, since `""` would render a URL the site no longer serves.
- **e2e:** `TestPost.path` (null for a draft) replaces hand-built URLs, and the published
  fixtures are typed `PublishedTestPost` so `path` is a string there. `publish.spec.ts`'s
  draft flows read the path back through a new `getPostPath(postId)` worker handler after the
  browser publishes — never "today", which crosses midnight in UTC eventually.

**Nothing needs preserving.** No URL from this app has been published anywhere,
so there is no external link, bookmark, feed entry or search index to keep
working. That removes what would normally be the expensive half of this change
and is worth stating explicitly, because most of the design below would be
different if it weren't true — in particular there is no need for the flat
`/[slug]` route to survive as a redirect shim.

### 21a. What actually moves

```
src/app/[slug]/            →  src/app/[year]/[month]/[day]/[slug]/
  page.tsx                      the same file, reading four params
  page.module.css               unchanged
```

`generateStaticParams` returns `{ year, month, day, slug }` instead of
`{ slug }`. `revalidate = 60` carries over, and so does the constraint that
makes it meaningful: this route must not call `auth()`/`cookies()`/`headers()`,
or — because it *does* have `generateStaticParams` — it throws
`DYNAMIC_SERVER_USAGE` at build rather than degrading to per-request rendering
(CACHING.md's 2026-07-23 entry, which is the production crash that taught this).

**No route collisions, and not by luck.** Next resolves a static segment ahead
of a dynamic one at the same position, so every existing route still wins over
`/[year]/…`: `/post/…`, `/posts/…`, `/api/…`, `/authors/…`, `/doc/…`. The deepest routes
in the app are already four segments (`post/[id]/history/[eventId]`,
`api/avatar/[userId]/[hash]`) and both lead with a static segment, so neither is
shadowed.

The corollary is that `/[year]/[month]/[day]/[slug]` matches **any** four-segment
path that isn't claimed by something static — `/a/b/c/d` included. The handler
therefore has to validate the shape (four digits, two digits, two digits) and
404 before touching the database, or every garbage four-segment URL costs a
query.

### 21b. Which date, and in which timezone

**The date is `Post.publishedAt`, and the hard half of keeping it stable is
already built.** `publishPostFromDoc` (`src/app/actions/posts.ts`) pins it
across an unpublish/republish:

```ts
const publishedAt = post.publishedAt && post.publishedAt <= now ? post.publishedAt : now;
```

and `schedulePostFromDoc` refuses to run while a post is actually live, so a
live post's date cannot be pushed forward. `unpublishPost` leaves `publishedAt`
untouched — the comment there already calls it inert. A post that goes live,
comes down, and goes back up keeps its original URL without anything new being
written for this section.

**Timezone is the trap, and it is not cosmetic.** `publishedAt` is a
`timestamp(3)` stored in UTC, but the byline currently renders it with
`toLocaleDateString()` — *server* local time. If the URL derived from local time
too, then:

- deploying to a box in a different timezone silently moves the canonical URL of
  every post published near midnight, with no migration and no error; and
- `generateStaticParams` (build machine) could disagree with the request handler
  (runtime) about what a post's path is, which presents as a 404 on a page that
  demonstrably exists.

So the URL is derived in **UTC, always**. That leaves one visible seam: a post
published at 21:00 EDT is the 5th in UTC while the byline says the 4th. The fix
is not to special-case the byline but to make both read from one helper, so they
cannot disagree:

```ts
// src/lib/post-path.ts — the single place the post URL shape is written down,
// the same "one module owns the URL" pattern as src/lib/avatar-url.ts (§17n).
export function postDateParts(publishedAt: Date): { year: string; month: string; day: string };
export function postPath(post: { slug: string; publishedAt: Date }): string;
```

The byline switches to `postDateParts` too. Displaying a UTC date under a UTC
URL is a real (small) behavior change for readers in western timezones, and is
the price of a URL that doesn't depend on where the server is.

A **site timezone** setting was considered and rejected for now: it turns a
derived value into configuration, and configuration that silently rewrites
every canonical URL when changed is worse than a fixed rule. If it is ever
wanted, `postDateParts` is the one function it has to reach.

### 21c. Slug uniqueness stays global (for now)

Dated paths make it *possible* to scope slug uniqueness per date, so
`/2025/01/01/new-year` and `/2026/01/01/new-year` could both keep the clean
slug. That is genuinely the appeal of dated permalinks — and it is deliberately
**not** part of this change.

Keeping `Post.slug @unique` global means every piece of existing slug machinery
survives untouched: `postSlugInUse`, `changePostSlug`, `revertPostSlug`,
`PostSlugHistory.slug @unique`, `SlugManager`, and the whole
`REVERT_DISCARD_WINDOW_MS` rule. Going per-date means a composite unique
constraint, a rewritten `postSlugInUse`, dropping the unique on the history
table, and rethinking what a history row means when a slug is only unique within
a day. That is a second change wearing the first one's clothes.

The cost of deferring is that a repeated title still gets a `-2` suffix even
though the dates would have disambiguated it. That is a cosmetic wart on a rare
case, and the migration to per-date uniqueness stays available afterwards.

### 21d. What this deletes

`RESERVED_SLUGS` (`src/lib/slug.ts`) exists for exactly one reason: `/[slug]` is
a top-level catch-all, so a post slugged `posts` or `api` would be shadowed by
the static route and never resolve. Move posts four segments deep and **that
entire class of constraint stops existing for posts** — the guard drops out of
both `uniquePostSlug` and `changePostSlug`, and a post may legitimately be
slugged `docs`.

It does not become dead code, though, and the file's own comment is wrong about
why. `src/lib/doc-slug.ts` also imports `RESERVED_SLUGS`, while `slug.ts`'s
header claims it is "only relevant to post-slug.ts today". Docs live at
`/doc/[slug]` — nested, with no sibling static routes — so that use looks
already unnecessary, on the same reasoning the comment gives for author slugs.
Resolving that (either drop it from `doc-slug.ts` as well, or correct the
comment) belongs in this pass rather than being inherited as a contradiction
nobody wants to be the one to touch.

### 21e. Blast radius

Every call site funnels through `postPath`, so the churn is mechanical rather
than delicate. The list is exhaustive as of 2026-08-05, when this section was first drafted:

- **URL construction — 3 sites.** `src/app/page.tsx` (landing list),
  `src/app/search/page.tsx`, `src/components/PostsTable.tsx` (the published-date
  cell links to the public page).
- **`revalidatePath` — 5 sites.** `src/app/actions/posts.ts` ×3,
  `src/app/actions/comments.ts` ×2. These are the ones that need more than a
  find-and-replace: they currently have only `slug` in hand, so
  `revalidatePublicPaths(postId, slug)` and both comment actions have to fetch
  `publishedAt` as well.
- **RSS.** `src/app/rss.xml/route.ts`'s `<link>` and `<guid>`. Changing a `guid`
  normally re-shows every item in subscribers' readers; here there are no
  subscribers, which is the whole reason this is cheap to do now rather than
  later.
- **`SlugManager` needs no change at all.** It already takes a `urlPrefix` prop
  (`""` for posts, `/doc` for docs, `/authors` for users) — the prefix simply
  becomes the post's date path, supplied by `src/app/post/[id]/slug/page.tsx`.
- **The route handler** gains segment validation and a canonical redirect: right
  slug, wrong date → `permanentRedirect` to the real path, reusing the shape of
  the existing `resolveRedirectSlug` fallback rather than a second mechanism.
- **e2e — ~13 `page.goto()` sites** across `moderation.spec.ts`,
  `publish.spec.ts` and `quote-anchoring.spec.ts`. The clean fix is to expose
  `path` on the `TestPost` fixture (`e2e/db-worker.ts`) so specs stop building
  URLs by hand — after which most of the diff is `post.slug` → `post.path`.

### 21f. Edge cases to settle before building

1. **Unpublish, then schedule for a future date.** The one path that moves a
   previously-live post's URL, since `publishedAt` is overwritten with the new
   `scheduledFor`. Either forbid scheduling a post that has ever been live, or
   accept that the URL moves. Accepting it is fine today (nothing links in) and
   the canonical redirect in §21e covers a reader who kept the old tab open.
2. **Drafts and scheduled posts have no `publishedAt`,** so they have no path at
   all — which matches the current behavior of 404ing at `/[slug]`. It is not a
   regression, but `publish.spec.ts` asserts against a draft's URL and therefore
   needs reshaping rather than a mechanical rename.
3. **`PostSlugHistory` narrows in meaning.** It records slug changes; a stale
   *date* is a different kind of miss. Matching on slug alone and ignoring the
   date segments handles both with one lookup, which is why the canonical
   redirect and the history fallback should be the same code path.

### 21g. Sizing

Roughly half a day: one new lib module, one route directory move, ~10 mechanical
call-site edits, the e2e fixture change, and the `RESERVED_SLUGS` cleanup.

**No database migration.** The date is derived from `publishedAt`, which already
exists and is already stabilized across republish (§21b); slug uniqueness is
unchanged (§21c). A stored path column was considered and rejected — it would
freeze the URL against a later edit of `publishedAt`, but it also introduces a
second source of truth for something the existing publish logic already keeps
still.

### 21h. Date archives: `/yyyy`, `/yyyy/mm`, `/yyyy/mm/dd`

**Built 2026-09-15.** The three prefixes of a post's URL are pages: each lists the posts
published in that UTC range, newest first, in the same preview block as `/search`. "URL
hacking" — trimming segments off a post's address — lands somewhere sensible, and the
byline's date on every surface is a link to its day, so a reader can climb from any post
to its day, month and year. That is also the public archive §17d and §17m recorded as
missing: the landing page still shows ten posts and links to no "older", but every post
now leads to the archives and the archives lead to every post.

**Routing.** `src/app/[year]/page.tsx`, `[year]/[month]/page.tsx` and
`[year]/[month]/[day]/page.tsx` are one-line wrappers over `src/app/[year]/post-archive.tsx`;
each carries its own `revalidate = 60` because Next reads segment config from the page
file, not from what it imports. A static segment still beats a dynamic one at every
position, so nothing existing is shadowed — but `/[year]` now matches **every** one-segment
path nothing static claims (`/tag` and `/doc` have no `page.tsx` of their own; a stray
`/favicon.ico` request that misses `public/`), and its children every two- and
three-segment one. So `parsePostDatePrefix` (`src/lib/post-path.ts`) runs before the first
query, the same rule as §21a one level up, and its rejection surface has a unit test. It
returns a half-open UTC range as well as the label and path, so the date arithmetic — a
February prefix is `[Feb 1, Mar 1)`, December's `end` is next January — lives in one
function rather than three route files. A well-formed date with nothing in it is a page
(200, "No posts published in …"), never a 404; only a malformed one 404s.

**Trailing slashes cost nothing.** `next.config.ts` sets neither `trailingSlash` nor
`skipTrailingSlashRedirect`, so Next's default 308s `/2026/09/` to `/2026/09` before any
route runs. Measured on the dev server before building, and asserted by the spec.

**Caching.** ISR with no `generateStaticParams`: a prefix renders on first request and is
served from the Full Route Cache for 60s after. `revalidatePostArchives`
(`src/lib/revalidate-post.ts`) invalidates a post's three prefixes and is called from the
same places that revalidate `/` — `revalidatePublicPaths` on publish and unpublish, and now
the two slug-change actions, which previously revalidated only the two post pages and left
every listing to `PostSlugHistory`'s 301. It is deliberately *not* folded into
`revalidatePostPage`: a comment changes the post's page and nothing a listing shows.
Same constraint as §21a — no `auth()`/`cookies()`/`headers()` in the render path.

**The listing became a component.** `src/components/PostListing.tsx` is the preview block
STYLE.md used to describe as "repeated verbatim across home, author, and search listings";
the archive would have been the fourth copy. It exports `postListingInclude`, which the
four `findMany`s spread into `include:` so the query and the component's props can't
drift, and the author page — which had no byline before — now shows one, so a co-authored
post names its other authors there too. `src/components/PostDate.tsx` is the byline's date:
label, link to `/yyyy/mm/dd`, and the full timestamp as a native `title` tooltip.

**The tooltip is UTC, and so is everything else on that line.** `postDateTimeLabel` slices
the ISO string (`2026-09-15 21:03:47 UTC`), no `Intl`, rendered once on the server into ISR
output. The reader's own zone was considered and not used: the label and the URL are UTC
by §21b, so a local-time tooltip would say the 14th under a link to `/…/15/…` for a
western reader — the tooltip's job is to explain the date shown, not to contradict it. If
a local time is ever wanted it is a second element (`LocalTime`, client-side), not a
change to this one.

**e2e:** `e2e/date-archive.spec.ts`, over a fixture post dated 2001-02-03 — far enough back
that no other spec's "published now" post shares the year. `createTestPost` grew a
`publishedAt` option (ISO string, must be past) for it.

### 21i. Getting between a post's pages

**Built 2026-09-16.** A post has three pages — its doc (`/doc/[slug]`), its editor
(`/post/[id]/edit`, §3d) and its public URL (§21). Three links tie them together, chosen so the
public page still looks, to a logged-in author, like it does to everyone else:

- **The public page carries one link.** `PostEditLink` renders `· configure post` after the byline's
  date, linking to the editor, for a viewer who may edit the post — ADMIN/EDITOR, or an
  AUTHOR on the byline, mirroring `canUserEditPost` as an affordance while the route keeps
  the gate. It is a client island reading `useSession()` (the `TagStrip` shape), which is
  what lets the page keep `generateStaticParams` and `revalidate` (§12f): SSR emits nothing,
  so a signed-out reader's HTML is unchanged, and the link appears after hydration at the end
  of the line where it reflows nothing. In the ordinary link color, not the byline's — it
  is a control, and the one thing on that line that is. The byline's author ids ride along as a prop for the AUTHOR case; the
  session has no slug to match on instead. Alternatives weighed and not built: the title as
  the edit link (as `DocView` does — a whole `<h1>` island, and link styling on the title for
  authors); a slot in `SiteHeader` (the header sits above the page in the root layout and has
  no way to learn the post id short of a store); a keyboard shortcut alone (undiscoverable).
- **The editor links out to the live post.** `PostPublisher`'s "Published <date>" is a link
  to `postPath`, which is why the page passes it the slug, followed by "(publication
  history)"; "From doc: <title>" links to the doc editor.
- **The doc's byline names its posts.** `DocPostsLine` is the post line in `/doc/[slug]`'s
  byline. With no post it *is* the "Publish as blog post" button (§15d); with posts it lists
  them, `|`-separated: "Published on
  <yyyy-mm-dd>" linking to the public URL plus "(configure)" to the editor; "Scheduled for
  <UTC timestamp> (in N days, N hours, N minutes)" linking to the editor; and — a judgment
  call beyond the ask — "Draft (configure)" for a post row that exists but was never
  published, since a row the button would only duplicate needs somewhere to be found from.
  "as <post title>" is added whenever `Post.title` has diverged from the doc's. Shown under
  the same `canEdit` gate the button had: a schedule is not public information. Dates are
  UTC by §21b's rule, sliced from the ISO string and rendered once on the server; the
  countdown (`src/lib/duration.ts`) is computed at request time on this per-viewer dynamic
  page and simply goes stale if a tab sits, which a reload fixes. The doc page's select
  includes a `posts` relation, filtered on `deletedByUserId` by hand because `resolveDocParam`
  reads through `prismaIncludingDeleted`. `e2e/publish.spec.ts` drives all three entry
  kinds and both link surfaces.

Not built: a bare `/post/[id]` page. §3d's rule stands — no `/post/[id]` page reads a post —
and the slug-history redirect already keeps old public links alive. Every "configure" link
above goes to `/post/[id]/edit`.

---

## 22. Editing comments and annotations after posting

Planned and built 2026-09-16 on `annotations-and-comments`: the grace window (§22b),
comment revisions (§22c) and annotation edit sessions (§22e). §22d, a quotation as four
columns on the reply, was built and superseded by §23 before it merged; the superseded
commits and their reference branch were deleted 2026-09-17. **As built:
[docs/COMMENTS.md](docs/COMMENTS.md) for the comment side, [docs/ANNOTATIONS.md](docs/ANNOTATIONS.md) for the annotation side.** The plan text is in the parent of the commit that introduced this stub.

### 22a. The decisions — docs/COMMENTS.md, "Decisions"
### 22b. The grace window, precisely — docs/COMMENTS.md, "Editing after posting" and "Decisions"
### 22c. Comment revisions — docs/COMMENTS.md, "Editing after posting"
### 22d. Quoting a comment in a reply — superseded by §23; deleted. docs/COMMENTS.md, "History"
### 22e. Annotation edit sessions, with versions as snapshots on the body's own ydoc — docs/ANNOTATIONS.md, "Editing after posting" and "Decisions"
### 22f. Permissions, for docs/PERMISSIONS.md — docs/PERMISSIONS.md, "Editing what is already posted"
### 22g. Build order — deleted; the phases are in the commit messages
### 22h. Judgment calls and what was not decided — docs/COMMENTS.md, "Decisions" and "Not built, deferred"
### 22i. Docs to update when each PR lands — deleted; all done 2026-09-16
### 22j. As built — deviations, and what is not built — docs/COMMENTS.md and docs/ANNOTATIONS.md, "Deviations from the plan"

---

## 23. Rich comment bodies, and quotation as a first-class anchor

Planned, amended and built in full on 2026-09-16 on `annotations-and-comments`, replacing
§22d: comment bodies became validated ProseMirror JSON with a Markdown box beside the rich
editor, drafts moved to IndexedDB, and a quotation became a row on §20a's anchor envelope
with a fifth arc leg for comments. PDF quoting exists behind a gate §19 has not yet opened.
**As built: [docs/COMMENTS.md](docs/COMMENTS.md).** The plan text is in the parent of the commit that introduced this stub.

### 23a. The two decisions this forces — docs/COMMENTS.md, "Decisions"
### 23b. The comment schema — docs/COMMENTS.md, "The body — one schema, two front doors"
### 23c. A quotation is an anchor row — docs/COMMENTS.md, "The anchor row"
### 23d. Five substrates, four version stamps — docs/COMMENTS.md, "The anchor row" and "Decisions" (`POST_RANGE`)
### 23e. The audience rule — the one genuinely new permission — docs/COMMENTS.md, "The audience rule"; docs/PERMISSIONS.md, "Quoting into a comment"
### 23f. Inline, block, and where the quoted text lives — docs/COMMENTS.md, "Inline, block, and the words themselves"
### 23g. Drafts in IndexedDB, not as rows — docs/COMMENTS.md, "Drafts live in the browser"
### 23h. The composer, and the quote gesture — docs/COMMENTS.md, "The gestures" and "The citation"
### 23i. What the §22 work becomes — docs/COMMENTS.md, "History"
### 23j. Build order — deleted; the phases are in the commit messages
### 23k. Judgment calls, and what is deferred — docs/COMMENTS.md, "Decisions" and "Not built, deferred"
### 23l. Where §22's built work went, and why — docs/COMMENTS.md, "History"; the revert record was deleted with the branch
### 23m. The Markdown front door — docs/COMMENTS.md, "The Markdown box"; docs/DOC_IMPORT.md §11
### 23n. The quote matcher — docs/COMMENTS.md, "The matcher"; docs/COLLAB.md §9

---

## 24. Tables in docs

Built 2026-09-18 on `tables` — TipTap's native table nodes, after
[docs/research/tables.md](docs/research/tables.md) rejected every external-block pattern
because an external table holds no text in the ydoc; CSV into an existing doc and tables out
as CSV the same day; "Auto-size columns" on 2026-09-19. **As built:
[docs/TABLES.md](docs/TABLES.md).** The section text is in the parent of the commit that
introduced this stub.

### 24a. What is built — docs/TABLES.md, "What is built"
### 24b. Judgment calls — docs/TABLES.md, "Column widths" and "Testing"
### 24c. CSV in and out of an existing doc — docs/TABLES.md, "CSV in and out of an existing doc"
### 24d. "Auto-size columns" — docs/TABLES.md, "Auto-size columns"
