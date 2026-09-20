# Docs — living documents on the ydoc stack

**Status: built.** The Doc entity, its editor, the live reading view and the `prose_json`
cache landed 2026-07-29 in the five phases PLAN.md §12k laid out; the embedded scrub bar the
same day; posts became snapshots of docs on 2026-07-30 (§15); the frozen reading view on
2026-08-12; the live title on 2026-09-20. This file is the as-built account, per the house
convention: PLAN.md §12 is a stub that points here, subsection by subsection, and the plan
text is in the parent of the commit that made it one. This file says what the code does and
why, so that a reader can work on docs without the plan.

What it does not repeat, because another file owns it:

| | |
|---|---|
| [ANNOTATIONS.md](ANNOTATIONS.md) | Annotations on a doc — the row, the body, the three anchor mechanisms, the surfaces. |
| [COLLAB.md](COLLAB.md) | How a remark stays attached to a passage, including why a doc runs `gc: true` and what that rules out. |
| [YDOC.md](YDOC.md) | The stack a doc rides on: one Hocuspocus process, the `ydoc*` tables, restarts, IndexedDB, one socket per page. |
| [PERMISSIONS.md](PERMISSIONS.md) | Who may read, edit and annotate, as tables over role × visibility × byline. |
| [DOC_IMPORT.md](DOC_IMPORT.md) | Creating a doc from Markdown — the file importer and the paste box. |
| [MARGIN_NOTES.md](MARGIN_NOTES.md) | The rail beside a doc's text, in the reading view and the editor. |
| [TABLES.md](TABLES.md) | Tables inside a doc. |
| PLAN.md §14 | `/side-by-side` and doc links, which join two docs. |
| PLAN.md §15 | Posts as snapshots of docs — a post is published *from* a doc, and `/post/[id]/edit` reads a doc's history. |
| PLAN.md §16 | The admin-table kit `/docs` is one instance of. |

## What a doc is

A **Doc** is an always-evolving living document, read as its current Yjs state rather than
as a revision. It was added on 2026-07-29 as a second entity beside `Post`, with nothing
about posts changing; since §15 a post is a *snapshot* of a doc and has no editable content
of its own, so the doc is now the only thing anyone types into.

Five decisions carry the design, and each still holds:

1. **The collab substrate is the ydoc stack** (PLAN.md §11, YDOC.md). A doc is one
   `ydoc`/`ydoc_update` document like any other, and there are no doc-specific collab
   tables.
2. **`doc.title` and `doc.prose_json` are caches** of the ydoc's `"title"` and `"default"`
   fragments, so the reading view is a row read rather than a Yjs decode per request ("The
   caches").
3. **Comments on a doc are annotations** — one `annotation` table, one `/annotations`
   surface, and no moderation, since every annotator is a signed-in account that
   `canViewDocs` already admitted (ANNOTATIONS.md).
4. **`gc: true` everywhere**, server and client, because the doc editor's annotation anchor
   is a mark — content — rather than a pointer into content, so garbage collection cannot
   strand it and a doc's stored state stays bounded ("The ydoc behind a doc").
5. **Nothing checkpoints a doc**: no `doc_revision`, no `ydoc_snapshot` rows for docs, no
   restore. A doc's history *is* `ydoc_update`, never truncated, and its present state *is*
   `prose_json` ("Deferred").

## The ydoc behind a doc

**A doc's `documentName` is derived from its id, not stored:** `ydoc.id = "ydoc:" + doc.id`,
through `ydocIdForDoc(docId)` / `docIdFromYdocId(name)` in `src/lib/ydoc-names.ts`. There is
**no foreign key in either direction** — the `ydoc` tables reference nothing, routing stays
a zero-query string check, and the two ids cannot drift because one is a function of the
other. A `doc.ydoc_id` column was rejected on the drift argument alone: two sources of truth
for one fact, one of which the collab server never reads.

**Creation is eager, in the same request.** `createDoc` (`src/app/actions/docs.ts`) writes
the `doc` row and calls `ydocStore.createIfAbsent(ydocIdForDoc(id), …)` with an empty state,
which closes the window in which a connection could arrive before a row exists. The three
creation paths — `createDocAction`, `scripts/test-doc.ts`, the e2e helper — all do this;
the Markdown importer does the same with a seeded state (DOC_IMPORT.md).

**Everything below comes free from being a ydoc-stack document:** `createIfAbsent`'s
anti-duplication across a cold open, the rule that nothing throws into a Hocuspocus hook,
`y-indexeddb` keyed by lineage so a doc survives a closed tab or an unreachable server, the
in-document `clients` map for author attribution, and the replay slider over `ydoc_update`.
YDOC.md is the account of each.

**A doc's `ydoc` row *is* the doc, with no fallback to re-seed from.** Deleting it and
letting `createIfAbsent` re-seed builds an *empty* document under that id, discarding every
paragraph and every editor-anchored annotation the doc ever had. If a row is ever genuinely
corrupted, the way back is the never-truncated update log replayed through `/ydoc-debug`.
YDOC.md, "Restarting the collab server", states this as the operational rule.

**`gc: true`, and never flip it.** The server sets `yDocOptions: { gc: true, gcFilter: ()
=> true }` explicitly and every client builds a bare `new Y.Doc()`, whose default is the
same. The reasoning — GC costs nothing here because the anchor is content, and `gc: false`
would buy resolvable item-id anchors at the price of a tombstone per deletion for the life
of a document whose premise is that it never ends — is COLLAB.md, "Why `gc: true`, and what
it rules out". One load with GC on collects tombstones permanently, so a future `gc: false`
experiment would be a new-docs-only decision, never a config change.

**Test containment comes from the doc side.** A test doc's ydoc is `ydoc:<cuid>`, not under
`ydoc:test-`, so `scripts/test-ydoc.ts`'s guard will not touch it. `scripts/test-doc.ts
delete` and the e2e fixtures therefore remove the derived `ydoc` row along with the doc,
gated on the `@example.com`-authors-only rule the other scripts use. Nothing cascades that
automatically.

## Data model

Every table is documented column by column in `prisma/schema.prisma`; this is the shape.

- **`doc`** — `id`, `slug UNIQUE`, `title`, `visibility` (`PRIVATE` | `SHARED`),
  `prose_json`, `prose_json_length` (trigger-maintained; never assign to it),
  `prose_json_update_id` (which `ydoc_update` the cache is the content of),
  `created_at`, `updated_at`, `updated_by_user_id`, `deleted_by_user_id`, `deleted_at`.
  No `moderation_policy`: annotations are never moderated. No `publish_revision_id` or
  `published_at`: a doc is never published at a revision; readers see the live document.
- **`doc_author`** — `doc_id`, `user_id`, `byline_order`. The byline is the whole
  permission rule for a `PRIVATE` doc ("Roles and visibility").
- **`doc_slug_history`** — old slugs, so a renamed doc's links still resolve ("Routes").
- **`doc_metrics`** — a view keyed 1:1 on `doc.id`, so `/docs` can sort on values Prisma's
  `orderBy` cannot reach (PLAN.md §16).
- **`annotation`** — ANNOTATIONS.md. The plan's original sketch, with no anchor columns
  because the anchor was a mark, was superseded by §13o for annotations written from a
  reading view.

**Doc slugs are unique among docs only, not against post slugs.** They live under `/doc/*`
with no shared catch-all, so `slugInUse` (`src/lib/slug.ts`) has a doc-scoped twin rather
than two more tables to check. `RESERVED_SLUGS` carries `doc`, `docs` and `annotations`, so
no *post* can be shadowed by those static segments.

**`src/lib/prisma.ts`'s soft-delete extension has a `doc` entry**, alongside `post` and
`user`. It is the mechanism that exists so nobody has to remember the filter — missing it
would mean `/docs` and `/doc/[slug]` serving soft-deleted docs.

**There is no `doc_revision`.** Deferred, not omitted ("Deferred").

## The caches: `title` and `prose_json`

**`ydoc` is the substrate; `title` and `prose_json` are genuinely caches.** Losing either
column costs a render: both are rebuilt from the ydoc on the next store. Losing the `ydoc`
row costs the doc — its history, its `clients` map and above all its lineage, since a
`Y.Doc` rebuilt from `prose_json` would be a structurally new document with fresh client ids
that every browser's `y-indexeddb` copy would *merge* rather than replace. That asymmetry is
why the collab-restart repair recipe from the old post-editing days has no doc counterpart.

**Both are written from the collab server, on the store debounce.** `server/doc-cache.ts`
runs at the end of `ydocOnStoreDocument` — Hocuspocus's default debounce, two seconds of
quiet or ten seconds at most — and issues one `updateMany` writing `prose_json`, `title`,
`prose_json_update_id` and `updated_by_user_id`. The `WHERE id = docIdFromYdocId(name)`
matches zero rows for a `/ydoc-debug` document, so there is no lookup to decide whether to
write and no doc-awareness in `server/ydoc-store.ts`. The derivation is
`docContentFromYdoc` (`src/lib/doc-content.ts`), shared with the two paths that seed a ydoc
without a collab server (`scripts/seed-sample-data.ts`, `e2e/db-worker.ts`), so that a
seeded cache is exactly what the hook would have written — when they drifted, a doc read 0
characters on `/docs` forever. A document that isn't TipTap-shaped is logged and dropped
rather than thrown into the hook.

**`prose_json` is the document, marks and all.** `authorHighlight` and the editor's
annotation mark come through `fromYdoc` and are rendered, never filtered; nothing on the doc
side ever rewrites the document to remove a mark. The deliberate contrast is
`postContentFromYdoc`, which strips marks because a published post renders through a schema
that has none.

**Staleness is bounded by the debounce, and the rule about it is the one that matters.**
`prose_json` is fine for deciding *whether* to draw something and wrong for deciding
*where* — never position an annotation off it (CLAUDE.md's invariant; COLLAB.md's
cross-cutting hazard). `prose_json_update_id` makes the staleness a value rather than an
unknown, which is what lets `scripts/integrity/check-doc-integrity.ts` distinguish a
legitimately-trailing cache from a broken one. It is `NULL` until the first store — a doc
created and never edited — and `/doc/[slug]` then decodes the `ydoc` row directly, a short
branch onto the same renderer.

**`title` is the fragment's text, empty included.** A doc is created titleless
(`createDoc` writes `""`, and no title fragment is seeded), and a title can be cleared
later; both write through as `""` rather than freezing the column at the last non-empty
value. `"Untitled"` is never stored: `docTitleOrFallback` (`src/lib/doc-title.ts`)
supplies it at render, everywhere a title is shown or derived from, so it can never be
backspaced into `"Untitle"` and never appears when scrubbing history. This is the opposite
of a post's `updatePostTitle`, whose skip-empty rule exists because a post's title has no
fragment behind it.

### The title follows the fragment live

Added 2026-09-20. Every heading and tab used to be a server render of the `title` column, so
a title edit took a store debounce *and* a reload to appear anywhere but the field it was
typed into. What changed is only the last hop, and only where a live document was already
in reach:

- `useLiveDocContent` decodes the title on every update it renders and reports a *changed*
  one through `onLiveTitle` — raw, `""` included, so the caller applies the fallback. It
  fires neither for a scrub push nor while `frozen`, because `applyUpdate` returns before
  rendering, so the title freezes with the body it belongs to.
- `/doc/[slug]`'s `<h1>` (`DocView.tsx`) resolves, in order: a scrub position pinned to
  history, then the live tap, then the scrub bar's live-end replay (read from the update
  log, so fresher than the column), then `initialTitle` from the column.
- A `/side-by-side` column's read-mode `<h2>` follows the same tap; its write mode was
  already fed by `CollabTitleField`.
- The browser tab follows on `/doc/[slug]` and `/doc/[slug]/edit`, through
  `src/lib/use-live-tab-title.ts` — the one place that writes `document.title` by hand. It
  composes through `site-config.ts`'s `tabTitle`, which the root layout now builds its
  metadata template from, so the site-name suffix cannot be dropped; and it restores the
  server's value on unmount, because Next rewrites the tab only when its own metadata value
  changes. The editor tab's pencil prefix lives once, in `docEditorTabTitle`, for
  `generateMetadata` and the live update alike.

Deliberately *not* extended to any listing — `/docs`, the dashboard's Recent docs,
`DocRefMenu`, `/annotations`, `/links`. Those are server renders with no live document in
reach, a connection per row is not worth it, and the collab server cannot `revalidatePath`
from its own process anyway. A listing's ceiling is the debounce plus a navigation.

## Roles and visibility

The tables are PERMISSIONS.md; this is the shape and the reasons.

**`AUTHORIZED` sits between `AUTHOR` and `COMMENTER`**, added 2026-07-29 without touching
`COMMENTER` — which is why the migration is one hand-edited `ALTER TYPE "role" ADD VALUE
'AUTHORIZED' BEFORE 'COMMENTER'` rather than the two-step dance a rename would have forced,
since Postgres cannot use a new enum value in the transaction that adds it. The name says
what it means: someone has authorized this account for docs. The hierarchy stays linear —
`ADMIN > EDITOR > AUTHOR > AUTHORIZED > COMMENTER` — which keeps `UsersTable`'s `ROLE_ORDER`
and every `role ===` check honest. An interim measure pending granular permissions, but the
only thing gating doc access meanwhile.

**Two doc gates, easily conflated.** `canViewDocs` (`src/lib/role-checks.ts`, so
`SiteHeader` can import it without Prisma) governs *reading and annotating*: every `SHARED`
doc, for anyone at that level. `canManageDocs` governs `/docs`, with own-byline scoping for
an `AUTHOR`, so an author manages only their own docs while reading everyone's.

**Per-doc `visibility` is `PRIVATE` | `SHARED`.** `SHARED` is anyone with `canViewDocs`;
`PRIVATE` is its listed `DocAuthor`s' alone, **with no ADMIN/EDITOR bypass** — the byline
*is* the rule, and a role can't stand in for it. An enum rather than a boolean so a public
tier would not need a migration; there is no public tier today.

**Editing a `SHARED` doc is the one place a role still substitutes for a byline**, through
`canEditAnySharedDoc` in `src/lib/doc-authz.ts` — stated independently of `canEditAnyPost`
rather than delegating, so that changing one rule cannot silently move the other. It lives
in `doc-authz.ts` rather than `role-checks.ts` even though it is a pure role check, because
what earns a place in `role-checks.ts` is a *client* consumer, and nothing client-side asks
this question. `canUserEditDoc` reads the doc's visibility in the same query as the author
check, so the `PRIVATE`/`SHARED` distinction stays inside one function instead of rippling
through every call site. `readableDocsFor` / `editableDocsFor` are the same rules as
listings, for the pickers that need one.

**A role change doesn't reach an existing session.** The session is a JWT with `role` baked
in at sign-in, so promoting someone to `AUTHORIZED` does nothing until they sign out and
back in; the permission-denied message says so. `src/app/sign-in/NOTES.md` has the
mechanics and the deferred fix.

## Routes

| Route | Purpose |
|---|---|
| `/docs` | management table, `canManageDocs` + own-byline scoping, widened by `SHARED` docs for ADMIN/EDITOR and by the ADMIN-only override below |
| `/doc/[slug]` | the live reading view, `canUserReadDoc`; embeds the scrub bar |
| `/doc/[slug]/edit` | the editor, `canUserEditDoc`; a soft-deleted doc still loads so Settings can offer Undelete |
| `/doc/[slug]/slug` | rename, with a suggested standard slug derived from the title |
| `/annotations` | annotation browse/admin, scoped to the docs the viewer may *read* (ANNOTATIONS.md) |
| `POST /api/doc/[id]/token` | the collab token, with `readOnly` for a reader ("Collab") |
| `GET /api/doc/[id]/replay` | the update log the scrub bar replays |

**One segment, id-or-slug.** Next rejects `app/doc/[slug]/page.tsx` beside
`app/doc/[id]/edit/page.tsx` ("You cannot use different slug names for the same dynamic
path"), so every doc route is under `app/doc/[slug]/` and shares one `resolveDocParam()`
that accepts an id or a slug, **tried in that order** — a rename must not break a bookmarked
edit URL. The reading route additionally falls back to `doc_slug_history` on a live-slug
miss and redirects. (A doc whose *slug* happens to be shaped like another doc's cuid would
resolve to the id; not worth guarding against.)

**Both listings restate the rule in their own `where` clause** rather than calling
`readableDocsFor`, so each is a place the two can drift. `/docs` lists a viewer's own
byline-authored docs *plus every `SHARED` doc for an ADMIN/EDITOR* — omitting that second
arm produces an incoherent listing that hides docs `canUserEditDoc` lets the same viewer
open from a URL. Its Edit column restates `canUserEditDoc` per row from data the query
already has, not a per-row call, and the Title column links to the reading view rather than
the editor.

**`/docs`' ADMIN-only "Show all docs" checkbox** (`?showAllDocs=1`) is a per-visit URL
toggle in the shape of every admin table's show-deleted checkbox, stored nowhere. It lifts
the byline scoping for *which rows are listed* and nothing else: it is not an argument to
`canUserReadDoc`/`canUserEditDoc`, so an admin who ticks it and opens a `PRIVATE` doc they
don't author still meets the author-only check, and the Edit column keeps its own
override-free rule so a revealed `PRIVATE` doc arrives with no Edit link rather than one
leading to Forbidden. EDITOR has no override.

**`/doc/[slug]` is dynamic by design** — per-user gated, so no `generateStaticParams`, and
cheap anyway because the steady-state cost is one row read of `prose_json`. CACHING.md,
"`/doc/[slug]` is dynamic by design". A route eligible for static generation that also
calls a dynamic API throws `DYNAMIC_SERVER_USAGE` at build; that is why the *post* page's
`TagChips` reads no session (CLAUDE.md).

**No per-doc annotations page** — `/annotations?doc=<id>` covers it — and **no reader-facing
doc index**: `/docs` is management, and a reader with `canViewDocs` has no route that lists
what they may open ("Known gaps").

## Collab: tokens and read-only readers

`server/collab.ts` needs no doc-specific dispatch: a doc is a `ydoc:` name and already
routes. `POST /api/doc/[id]/token` resolves the doc, applies doc authz, and mints
`signYdocToken({ sub, documentName: ydocIdForDoc(id), role, readOnly })` plus the `lineage`
the client's IndexedDB layer needs before connecting. An editor gets a writable token;
someone who merely passes `canUserReadDoc` gets `readOnly: true`, which
`ydocOnAuthenticate` turns into `connectionConfig.readOnly` — the token already names the
document, so this needs no doc knowledge on the server.

**Read-only readers show no caret**, by construction rather than by flag: the reading
surfaces are a plain non-`Collaboration` `useEditor` with content pushed in by hand, so
there is no live binding for a caret extension to attach to. Read-only is still meaningful
even though a reader can annotate, because a reading-view annotation writes columns, not a
mark ("Annotations on a doc").

**`token` is a `fetchToken` function**, so `HocuspocusProvider` re-mints per reconnect —
the fix for the old two-minute-expiry reconnect loop, applied to every collab surface at
once. Every provider on a page attaches to the page's one socket through `attachProvider`
(YDOC.md, "One socket per page"); the client `Y.Doc` is a bare `new Y.Doc()`.

## The reading view

`/doc/[slug]` renders the cached body statically, then swaps in a live editor once the tap
has synced.

- **`DocView.tsx`** (client) owns the `<h1>`, the byline slot and the one piece of state the
  scrub bar, the title and the body share: which historical state, if any, is overriding the
  live one. The `<h1>` links to `/doc/[id]/edit` whenever the viewer can edit — an ordinary
  hyperlink, not the heading's color — and is plain text otherwise. The page keys `DocView`
  on `doc.id` so a client-side navigation between docs remounts rather than reuses it.
- **`DocReadingBody.tsx`** is the surface, and **`useLiveDocContent`** (`src/lib/`) is the
  engine underneath it: a read-only Hocuspocus tap that pushes each remote Yjs update into
  a plain `useEditor` through `setContent`, so an already-open tab reflects an author's
  edits with no reload. The 2026-07-30 split of the old `LiveDocBody` into that engine plus
  two thin surfaces (this one and a side-by-side column) is drawn in
  [live-view-composition.html](live-view-composition.html); PLAN.md §14p is the decision.
- **The byline** is `AuthorByline` without its `"By "` prefix, dated by `Doc.updatedAt` —
  a doc has no publish date, so "last edited" is the only date that means anything, and the
  cache write is what keeps it current.
- **The scrub bar** (`DocScrubBar.tsx`) is lazy by construction, not by a flag: before the
  reader interacts it is one grayed-out, inert `<input>`; the first `pointerdown`/`focus`
  fetches `/api/doc/[id]/replay` and mounts the real slider, and only then does
  `useReplayScrub` (shared with `/ydoc-debug`) allocate a `Y.Doc` and start replaying.
  Scrubbing rewrites the live title and body *in place*, through the same `setContent`
  path a live update uses, which is why the separate `/doc/[slug]/live-history` route was
  removed the day the bar landed. With no doc snapshots every rebuild replays from row #1;
  a performance characteristic, not a defect.
- **The column holds a fixed 800px** rather than shrinking to short content, and the
  route's styling is `app/doc/[slug]/page.module.css` (STYLE.md).
- **Annotation highlights are colored by their author**, one `--thread-color` rule per id
  (`AnnotationColorStyles.tsx`), the same technique `AuthorHighlightStyles` uses for
  attributed text. The rail beside the text is MARGIN_NOTES.md.

**The live tap applies a Yjs update on its own handshake**, not only on a real remote edit,
and every such update becomes a `setContent` that silently collapses whatever the reader had
selected. A selection made between "editor mounted" and "provider synced once" therefore
vanishes before it can be annotated. The hook exposes `synced` for exactly this — there is
no visible connection UI on the reading view otherwise — rendered as a hidden marker that
`e2e/doc.spec.ts`'s annotation tests wait on. Anything else that reacts to a reader's
selection needs the same gate.

### The frozen reading view

Added 2026-08-12. Pushing every remote update straight into the reading editor is right for
passive reading and wrong the moment a reader is doing something with the current text:
dragging the scrub bar (the next remote keystroke overwrote the historical body it was
showing), or holding a selection about to become an annotation.

**The fix stops rendering, not receiving.** `useLiveDocContent` takes `frozen: boolean`.
Its `ydoc.on("update", …)` listener keeps firing either way — the `Y.Doc` always has
everything — but while frozen the handler counts the update instead of calling
`setContent`. Unfreezing runs one catch-up render and zeroes the count. Two independent
reasons OR together into `frozen`, both owned by the surface rather than the hook:

- **Scrub.** `ScrubbedState` carries `live: boolean` (`index === total - 1`). `DocView`
  freezes only when scrubbed *and not live* — the slider's mount-time seed already reports
  `live: true` before any drag, so merely mounting the bar never freezes anything.
- **Selection.** Any non-empty selection, i.e. `useSelectionPopover`'s `pending !== null` —
  not merely an open popover, since the two are set together.

**The count is updates, not keystrokes.** Yjs batches, so "(+N)" on the FROZEN flag counts
`update` events received while frozen — the only number available for free on a read-only
tap. It is exposed as a listener-set pair (`frozenUpdates: { subscribe, getSnapshot }`)
read through `useSyncExternalStore`, not React state, for the reason MARGIN_NOTES.md gives
for its own per-keystroke signal: state would re-render the whole reading surface on every
remote update during a long freeze, to reposition one badge.

**Clicking FROZEN** clears both reasons at once — `useSelectionPopover.clear()`, plus
`DocView` resetting `scrubbed` and bumping a `resetSignal` the scrub bar uses to seek its
slider back to the live end, so the slider's position and the body it drives never disagree.

**The chrome is CSS, not scroll-tracked JS.** The container carries a permanent, usually
transparent `border-left` plus matching padding, so freezing changes a border color and
never reflows the article. The flag sits in a full-height absolutely positioned track
(`top: 0; bottom: 0`, not `height: 100%`, which resolves to `auto` inside a containing block
whose own height is auto) at `position: sticky; top: 0` — sticky inside a full-height track
gives "top of the document area, then top of the viewport once scrolled past" for free.
Rotation is `writing-mode: vertical-rl` plus `rotate(180deg)`, not `rotate(-90deg)`: both
read bottom-to-top, but only the `writing-mode` form keeps a real layout box for sticky
positioning and hit-testing. Tokens are `--frozen`/`--frozen-text` (STYLE.md) — darker in
light theme, lighter in dark, the reverse of the usual rule, because it is a solid fill
rather than text on the page background.

**Known consequence.** A selection held through a freeze produces offsets measured against
the frozen document, while the server verifies them against the live one; that path already
degrades correctly (verify quoted text → unique-occurrence search → document-level), and
freezing only widens the window slightly. A real fix needs Yjs relative positions and the
`Collaboration`-bound editor COLLAB.md §5 names as their precondition, which the reading
view does not have.

## The editor

`/doc/[slug]/edit` is **`DocEditor.tsx`**: provider wiring through the page's shared socket,
`attachIndexeddb` for offline durability, `CollabTitleField` and `CollabEditorBody` reused
unmodified, a status line (`🟢 Live` waits for the initial sync, not merely a socket), and
`DocSettingsPanel` for byline, visibility, delete and undelete. There is no save, publish or
schedule — a doc auto-persists through the collab server — no revision diff, and no title
autosave, since the title is a cache written server-side from the fragment. The composing
surface for annotations, and the rail beside the text, are ANNOTATIONS.md and
MARGIN_NOTES.md.

**Creation is titleless.** `+ New doc` creates the row and drops straight into the editor
with no title-collecting form in between: the title is already a live collaborative field,
which the editor is better at collecting than a form is. The initial slug is the doc's own
cuid, written in a follow-up `update` inside the same `$transaction` because the id isn't
known until the create resolves, so `resolveDocParam`'s id-first lookup and the slug lookup
return the same doc until a rename on `/doc/[slug]/slug`. The Markdown importer is the
exception that arrives with a name (DOC_IMPORT.md, "The slug follows the title").

**Author colors have no reset.** Per-author highlighting lives in the doc's working Yjs
state and nothing ever removes it from the doc itself — there is no save step to hang a
reset on, unlike the old post editor's `clearAuthorHighlights`, which no longer exists
(TIPTAP.md).

**The title field shares its border with the body frame** (`DocEditor.module.css`'s
`.titleInput`/`.editorFrame`), so the two read as one editable surface. The browser tab
follows the title as it is typed ("The title follows the fragment live").

## `/docs`

One instance of the admin-table kit (PLAN.md §16): a `docs-query.ts` over
`src/lib/table-query.ts`, with filters, sort, pagination and show-deleted in the querystring
and applied in Postgres. The Title column links to the reading view; a separate Edit column
links to the editor only when this viewer may edit that row ("Routes"). The Length column is
the stored, trigger-maintained `prose_json_length`, because a view has no `WHERE` to push
down when sorted through (CLAUDE.md). The importer and the paste box are DOC_IMPORT.md.

## Annotations on a doc

ANNOTATIONS.md is the account; three doc-side facts belong here because they are about the
document rather than the remark.

- **The mechanism follows the surface.** The doc *editor* writes an `annotation` mark into
  the ydoc — content, so it moves with its text, merges with concurrent edits, and
  disappears exactly when its text does. Either *reading* view writes `anchorFrom` /
  `anchorTo` / `quotedText` columns and never touches the document, because applying a mark
  is a write and a reader was making it (§13o). Don't unify them.
- **Losing the mark degrades the annotation; it does not delete it.** Delete the annotated
  text and the mark goes with it; the row keeps its `doc_id`, so the annotation becomes a
  document-level remark on that doc, derived per render rather than stored. It is one-way:
  retyping the text does not re-anchor it. Recovery from the update log is worked out in
  COLLAB.md §8 and deferred.
- **The mark is `clearable: false`** (`src/lib/annotation-extension.ts`), so the editor's
  "Clear formatting" cannot strip it along with real formatting — found the hard way.

## Deviations from the plan

- **`AnnotatableArticle` is not reused for docs**, though §12i said it would be. The doc
  reading view copies its *interaction* shape — a plain `useEditor`, `editable: false`,
  selection capture, the `staticBody`/live swap — but a single static `doc` prop for a
  post and a live tap that pushes updates by hand differ enough that literal reuse would
  have branched a component rendered on every published post.
- **Annotation capture was reading-view-only** until 2026-08-30, when §18f gave the editor
  its own composing surface (ANNOTATIONS.md, "Surfaces").
- **The shared `Comment*` components did not stay shared.** §13c un-shared them the day
  after §12 landed; the doc side renders through `src/components/annotation/`.
- **No `canViewDocs`-gated nav entry**, since there is no route for it to point to — `/docs`
  is management. What `SiteHeader` has is a `canManageDocs`-gated "Docs" link with a
  dropdown for Annotations and Tags.
- **`/doc/[slug]/live-history` never survived Phase 5**: the embedded scrub bar made it
  redundant the same day ("The reading view").
- **The annotation-mark endpoint's fallback search** (`findQuoteOccurrences`,
  `server/ydoc-hooks.ts`) is a plain `O(document × quote)` scan rather than a
  position-mapped walk — correctness by construction over a fallback that only runs when
  the primary offsets already missed, at the cost of not matching a quote across a block
  boundary.
- **`annotation.user_id` is `ON DELETE RESTRICT`.** Users are only ever soft-deleted, so it
  is inert in production; the test cleanup removes a user's annotations first.

## Testing

- **`e2e/doc.spec.ts`** — creation writes the `ydoc` row eagerly; the cache reaches
  `Doc.title`/`proseJson` after the debounce; a doc never touches a post table and a post
  never touches a ydoc table; a reader's already-open tab updates with no reload; an
  editor's annotation mark lands at the exact selected range, and degrades — never
  appearing on `/comments` — once its text is deleted.
- **`e2e/doc-visibility.spec.ts`** pins the visibility rule and both listings: an
  ADMIN/EDITOR non-author is refused a `PRIVATE` doc for read and edit, a listed author is
  not, `SHARED` stays open to ADMIN/EDITOR regardless of byline, the `/docs` override is
  ADMIN-only and doesn't carry into opening a doc, and `/annotations` withholds a `PRIVATE`
  doc's rows by listing and by `?doc=` deep link. The `SHARED` cases are positive controls,
  not decoration.
- **A doc fixture's second identity needs an explicit byline.** `e2e/db-worker.ts`'s
  `addTestDocAuthor` exists because `secondUser()` is not automatically an author of the
  doc it is handed, and a `PRIVATE` doc admits only its byline.
- **`scripts/test-doc.ts` and `scripts/test-annotation.ts`** cover manual testing, with the
  derived `ydoc` row removed on delete (TEST_DATA.md).
- **`scripts/integrity/check-doc-integrity.ts`** checks that `title`, `prose_json` and
  `prose_json_length` still agree with the ydoc, tolerating debounce lag.
- **TipTap v3's `setContent` takes an options object**: `setContent(json, { emitUpdate:
  false })`, not the v2 boolean, which is now a type error and reads as obviously correct
  against any older example (TIPTAP.md).

## Known gaps

Real and deliberate-to-defer, not broken — places where what is built is narrower than the
account above might read.

- **There is no reader-facing doc index.** A reader with `canViewDocs` can open any `SHARED`
  doc they have a link to but has no route that lists them and no nav entry; docs are
  share-a-link-only in practice.
- **Nothing enforces that a doc's `ydoc` row exists.** Creation is eager on every path, and
  the collab server's forgiving auto-create covers a connection to a name nobody made — but
  a `doc` row whose `ydoc` row was deleted out from under it reads as an empty document
  rather than an error, and the token route 404s on the missing lineage. Acceptable because
  deleting a `ydoc` row by hand is exactly what YDOC.md warns against.
- **`Annotation.resolvedAt` is declared and never touched**, and the comment list's
  "Quoted text position" sort still ties for mark-anchored annotations — both
  ANNOTATIONS.md, "Not built, deferred".

## Deferred, with reasons

- **Checkpointing a doc** — a `doc_revision` table, changelogs, restore-to-a-point,
  `ydoc_snapshot` rows for docs, any doc counterpart to the old replace-doc admin path. Under
  this design a doc's history is `ydoc_update` and its present is `prose_json`; adding
  checkpoints later is additive, since the snapshot table and endpoint already exist and are
  generic. §15's post snapshots pin a doc's state at a point without any of this.
- **Recovering where an annotation used to point once its mark is gone** — replay
  `ydoc_update` back to a state that still had the mark, read its range, offer to re-anchor.
  Later if at all, and an ad-hoc tool if ever. The defined behaviour is the degraded one.
- **Converging posts onto docs.** Largely answered by §15 on 2026-07-30: a post is a
  snapshot of a doc, and there is no second editor or second collab stack to carry any more.
  The carrying cost the plan priced in — two editors, two comment stacks, two admin tables —
  has been paid down to the comment/annotation split, which §13c chose deliberately.
- **Deduplicating `src/lib/ydoc-render.ts` with `LiveHistoryViewer`** — still two.
- **Re-reading `role` from the DB in the `jwt` callback** — `src/app/sign-in/NOTES.md`;
  waits for the granular-permissions work that supersedes the role scheme.

## History

- **2026-07-28** — the annotation mark (ANNOTATIONS.md).
- **2026-07-29** — the entity, `AUTHORIZED`, the editor, the reading view and the cache,
  `/annotations`, in the plan's five phases, each gated on typecheck, lint, hand verification
  and the full suite; the embedded scrub bar, and the removal of `/doc/[slug]/live-history`.
- **2026-07-30** — posts become immutable snapshots of docs (§15); `LiveDocBody` split into
  `useLiveDocContent` plus two surfaces (§14p).
- **2026-08-12** — the frozen reading view.
- **2026-08-13** — reading views stop writing marks (§13o).
- **2026-09-20** — the title follows the fragment live.
