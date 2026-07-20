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
  revision*, Etherpad-style — is now built too (§10 item 9): an inline `authorHighlight`
  mark carries the author's `User.color`, applied to newly-typed text and cleared (a real,
  synced transaction) on every save so it always reflects only what's new. It's
  working-session state, not content — stripped before anything reaches `revisions.doc`.
- **Auth:** the Hocuspocus `onConnect`/`onAuthenticate` hook validates the user's session
  (via Auth.js token) and checks they may edit that post before joining the room.

This raises the ops footprint (a second long-running service + websocket proxying — see §7),
which is the main cost of doing it now rather than later.

---

## 4. Data model

```
users            id, email, name, password_hash | oauth, role, created_at,
                 color                                           -- author-highlight/caret color
                 admin_initials(non-null string)                 -- byline shorthand, §10 item 11
                 moderation_policy('inherit'|'always'|'auto')   -- per-author override
posts            id, slug, title, publish_revision_id,
                 created_at, published_at (may be future),       -- no status column, no schedule
                                                                   -- column (§10 item 12): visible iff
                                                                   -- publish_revision_id is set AND
                                                                   -- published_at <= now()
                 moderation_policy('inherit'|'always'|'auto')   -- per-post override
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
                 created_at, edited_at
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

Resolution order for a new comment: if the commenter is `force_moderate` → queue. Else if
trusted (`approved_count >= threshold`) → publish. Else apply the cascade policy.

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

## 10. Implementation progress (as of 2026-07-20)

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
   - **Author pages** (`/authors/[id]`): a user's name + their published posts, linked from
     every byline (home, search, and article pages now share one `AuthorByline` component
     instead of three copies of comma-joining logic). `authors`, `search`, and `rss.xml`
     added to the reserved-slug list (`src/lib/slug.ts`) so a post title can't shadow them.
9. **Author attribution & live history** — beyond §8's original 8 steps; fulfills the
   "finer per-author edit credit" idea noted in §3a.
   - **Per-author highlighting**: an `authorHighlight` TipTap mark
     (`src/lib/author-highlight-extension.ts`), not a suggest/accept "tracked changes"
     workflow — an `appendTransaction` plugin tags newly-typed text with the current user's
     id, skipping Yjs-sync-origin transactions (`isChangeOrigin`) so remote edits never get
     mislabeled. Rendered via `User.color` (assigned at sign-up, `src/lib/author-colors.ts`),
     painted through a small dynamically-generated `<style>` tag rather than baked into the
     mark, so a color lookup is one small API call away
     (`/api/users/colors`) rather than schema data. Cleared on every save (`removeMark`
     transaction in `PostEditor.tsx`) so highlighting always reflects only "since the last
     revision," not the post's whole life — see the CLAUDE.md gotcha. Stripped
     (`stripMarkFromDoc`) before anything reaches `revisions.doc`; `contentExtensions` (the
     shared editor/seed/render schema) never has to know the mark exists.
   - **Live-scrubbable history** (`/posts/[id]/live-history`, `LiveHistoryViewer.tsx`):
     read-only, and stays live-connected rather than being a one-time snapshot. Hocuspocus's
     `onChange` hook (`server/collab.ts`) appends every raw Yjs update to a new
     `post_collab_updates` row, reset whenever a revision is saved — bounding it to "since
     the last revision" controls how much CRDT history is ever kept around. The viewer fetches
     that log, replays prefixes of it into a scratch `Y.Doc` for the scrub slider, and taps a
     second, otherwise-unused `HocuspocusProvider` connection purely to keep appending new
     updates as they arrive live.
   - **Collaborator cursors**: `CollaborationCaret`'s default always-visible name label
     replaced with a thin colored bar (`renderCaret` in `CollabEditorBody.tsx`) — the name
     shows in a CSS `:hover`-only tooltip instead. The local user's own cursor was already
     unaffected (y-prosemirror excludes the local clientID before `render` runs).
   - **Editor status line**: shows `(+X −Y)` (live doc vs. the last saved revision, via the
     existing word-level `diffText`) and `(Name: +N, ...)` per contributing/connected author
     (`collectAuthorHighlightStats`, `src/lib/tiptap-schema.ts`) next to the live/connecting
     indicator. Both figures are debounced ~400ms rather than recomputed per keystroke — see
     PERFORMANCE.md, which also has a real before/after benchmark of this branch's cost.

10. **Site navigation, admin posts table, and per-post edit affordances** — beyond §8's
    original 8 steps; mostly UI/navigation polish plus one genuinely new piece of logic (the
    edit-status heuristic).
    - **Global site navigation**: `SiteHeader` (title, search, sign-in/out) previously had to
      be rendered by hand on each page and had drifted onto only 4 of them; it now lives once
      in `RootLayout`, so every route gets consistent nav for free. Shows "`{name or email}` /
      Sign out" when signed in, "Log in / Sign up" otherwise, plus a "Manage Posts" link (any
      `canManagePosts` role — ADMIN/EDITOR/AUTHOR) to `/posts`.
    - **Admin posts table** (`/posts`, `PostsTable.tsx`): rebuilt from a bulleted list into a
      table — Title (→ editor), Published (→ public post, blank if unpublished), Comments
      (approved count, with a "(in moderation N)" link to that post's moderation queue when
      there's anything pending), Revisions ("+N" ahead of the published revision, or
      "current" when they match, → history), Last edit by/at, Created at. Column headers sort
      the table client-side; a plain click sorts by just that column, Ctrl-click adds it as a
      secondary/tertiary key without disturbing already-sorted columns' positions (shown via
      a superscript priority number next to the ▲/▼). A date-format dropdown (`yyyy-MM-dd`
      default, three alternates) re-renders every date in the table immediately, client-side.
    - **Editor status line** (`PostEditor.tsx`): replaced the old fixed "Currently viewing
      revision #N" with "`{Published revision #N (linked to the live post) | Unpublished}`.
      `{EDITED | Currently viewing revision #M}`." — the second clause disappears entirely
      once the last-saved revision matches what's published *and* there's no live diff from
      it. Updates live on publish (the existing `router.refresh()` re-derives the published
      revision number from the DB) and live on undo back to a clean state (the existing
      debounced revision-diff, already recomputed on every editor `update` event).
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
    - **Author(s) column** (`/posts`): each post's authors, `adminInitials` joined with
      `", "` in `bylineOrder` — verified against real data that the join order tracks
      `bylineOrder`, not insertion order.
    - **Posts-table search**: a label-less textbox above the table, live-filtering by title
      (case-insensitive substring, same "hobby-scale, no index" approach as `/search`) ahead
      of the existing sort, so an active sort stays applied to the filtered set. Width-matched
      to the Title column and top/left-margined to line up with it — see the
      `ResizeObserver`/`getBoundingClientRect` gotcha in CLAUDE.md. No "no results" message
      for an empty match set; the table just renders no rows.
    - **Also fixed**: the "Published" column's null-sort — blank (unpublished) rows now stay
      pinned to the bottom in *both* sort directions. Previously they only sorted last on
      ascending; descending flipped them to the top, since the shared null-handling was
      subject to the same direction-negation as the actual date comparison.

12. **Publish mechanics rework** — no-op revision skip, unpublish, scheduled
    publishing, and dropping the `status` column entirely.
    - **No-op revision skip**: `saveDraft`/`publishPost`/`schedulePost` all
      route through a shared `resolveRevision` (`src/app/actions/posts.ts`)
      that compares the incoming title+doc against the latest `Revision` row
      via `docsEqual` (`src/lib/diff.ts`) — an order-independent deep-equal,
      not the display-oriented word-level `diffText` — before creating a new
      one. Needed because Postgres `jsonb` doesn't preserve object key order
      on read-back, so a plain `JSON.stringify` compare against the doc as
      just typed would false-positive as "changed" on key order alone. Covers
      "typed something, then undid it" without inspecting the live Yjs doc.
    - **No `status` column.** Originally `draft|published|archived`. Once
      unpublish/republish/schedule cycles could happen without a new
      revision, the only thing `status` was still doing was duplicating
      information already sitting elsewhere — so it was dropped rather than
      kept in sync. `ARCHIVED` was never used by any code path and was
      dropped with it. `src/lib/post-status.ts`'s `derivePostStatus` computes
      draft/scheduled/published for display only.
    - **No separate schedule column, no sweep.** The first cut of this had a
      `scheduled_for` column plus a lazy sweep (`publishDuePosts`, called from
      every public page) that flipped `publish_revision_id` from `null` once
      the scheduled time arrived. That sweep turned out to be pure
      accidental complexity: `schedulePost` now sets `publish_revision_id`
      **immediately** — exactly like an immediate publish — and just sets
      `published_at` to the future date instead of `now()`. Visibility is
      then purely `publish_revision_id IS NOT NULL AND published_at <= now()`
      (`publishedPostWhere()` in `src/lib/post-status.ts`), a query-time
      condition every public-facing query and the comment-eligibility check
      must use instead of checking `publish_revision_id` alone — centralized
      in that one helper rather than repeated at each of the ~7 call sites,
      since forgetting it at even one would leak a not-yet-due post early.
      No write ever needs to happen *at* the scheduled instant, so
      `scheduled_for` merges into `published_at` (which may now be in the
      future) and the whole sweep module is gone. Thread remapping
      (`remapThreadsToRevision`) now happens synchronously inside
      `schedulePost` itself (at the moment `publish_revision_id` changes)
      rather than deferred to a sweep pass.
    - **Unpublish** (`unpublishPost`): sets `publish_revision_id` to `null`
      with no new revision; `published_at` is left untouched (inert whenever
      `publish_revision_id` is null — nothing reads it in that state, so
      there's nothing to clean up). Doubles as "cancel schedule" — a post is
      never both published and scheduled at once (`derivePostStatus`), so one
      action unambiguously covers both starting states.
    - **Scheduling guard**: `schedulePost` is disallowed only when
      `derivePostStatus(post) === "published"` (actually live right now) —
      not merely when `publish_revision_id` is set, since a *scheduled* post
      has that set too. This is what still guarantees a live post's served
      content can never go dark while a future edit is pending, while also
      allowing a reschedule of an already-scheduled post. Renamed from
      `currentRevisionId` to `publishRevisionId` per an explicit request
      during design — read as "the revision this post is currently
      publishing," which doesn't collide with "current" meaning "most
      recently edited."
    - **Rescheduling freezes the target until you reschedule again.**
      Because `publish_revision_id` is set once, at the moment
      Schedule/Reschedule is clicked (via the same `resolveRevision` no-op-
      skip used everywhere else), a plain `saveDraft` afterward creates a
      newer revision but does *not* change what a pending schedule will
      publish — you have to click Reschedule again to move the target
      forward. This reverses the first cut's behavior (where the sweep
      always grabbed whichever revision was *latest* at the scheduled
      instant, so quietly continuing to edit silently changed the outcome);
      the new behavior is more predictable and was a natural consequence of
      removing the sweep, not a separate design choice.
    - **Data migration note**: one already-real in-flight schedule existed in
      the dev DB when the `scheduled_for` column was dropped (a post someone
      had actually scheduled while testing the first cut). The migration
      backfilled it correctly — `publish_revision_id` set to that post's
      latest revision, `published_at` set to its `scheduled_for` value —
      rather than just dropping the column and losing the pending schedule.
    - **`PostPublicationEvent`**: an append-only audit log
      (`PUBLISHED|UNPUBLISHED|SCHEDULED|SCHEDULE_CANCELED`, `postId`,
      `revisionId?`, `scheduledFor?`, `actorId?`), written by every action
      above. Added because, once state transitions stopped always producing
      a new `Revision` row, `Revision.createdAt` alone could no longer answer
      "when did this go live/offline" — no UI reads it yet, but the data
      survives for when a publish-history view is wanted. Deliberately kept
      as a write-only audit trail, not a source of truth read on any hot
      path — visibility/status derivation never queries it.

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