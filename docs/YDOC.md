# The ydoc stack

One Hocuspocus process, three Postgres tables, and the rules that keep a document's identity
intact across restarts and across a browser's local cache. The design is PLAN.md §11, and the
entity that rides on it is [DOCS.md](DOCS.md); this file is what you need to know before restarting something, debugging something, or
attaching a second persistence layer.

How a *remark* stays attached to a passage inside one of these documents is a different
question entirely — [COLLAB.md](COLLAB.md).

## One stack, one process and port, two sub-namespaces within it

Every `documentName` is `ydoc:`-prefixed, handled by `server/ydoc-hooks.ts` against the
`ydoc` / `ydoc_update` / `ydoc_snapshot` tables (PLAN.md §11, §15).

There used to be a second, older stack for post documents — bare cuid names,
`post_collab` / `post_collab_update`, a parallel set of hooks in `server/collab.ts`. That is
gone: posts are immutable snapshots now, with nothing of their own to edit (§15).
`server/collab.ts` keeps only dispatch. `onAuthenticate` rejects any non-`ydoc:` name
outright — the real chokepoint, since registering that hook is what makes Hocuspocus require
auth on every connection at all — and the other hooks call straight into `ydoc-hooks.ts`.

`isYdocDocument` / `YDOC_PREFIX` (`src/lib/ydoc-names.ts`) still exist, but their job
changed. Not routing away from a legacy path any more, just carving out two things:

- **`ydoc:annotation:<id>`** — one ydoc per annotation body (PLAN.md §13a). Its
  `ydoc_snapshot` rows are the body's **versions** (§22e, docs/ANNOTATIONS.md "Editing after
  posting"), written only by the settle paths; `/ydoc-debug`'s Snapshot button and
  `/admin/ydoc-snapshot` refuse this namespace, because a snapshot here would list as an edit
  nobody made.
- **`ydoc:test-*`** — the containment guard for `scripts/test-ydoc.ts`.

A `ydoc:` name nobody has explicitly created — via `scripts/test-ydoc.ts`,
`scripts/test-doc.ts`, or `/ydoc-debug`'s "New document" button — just starts empty.

That there is exactly one `new Server(...)` in the codebase is also why a slot needs one
collab port and not a block: see [DEV_SLOTS.md](DEV_SLOTS.md).

## One socket per page

A page opens **one websocket** to the collab process and multiplexes every document it
needs over it (built 2026-09-19). Hocuspocus's `HocuspocusProviderWebsocket` holds the
socket and routes each incoming message to the `HocuspocusProvider` whose document it names;
each provider still sends its own token, gets its own `onAuthenticate` run, its own server-side
`Connection` and its own `readOnly` flag. So on `/doc/[slug]` a reader's read-only live tap
and the writable body of the annotation they are composing ride one socket, and the server
keeps them apart *per document* — verified in `@hocuspocus/server`'s `ClientConnection`,
which creates a fresh `connectionConfig` per document name, and proved by
`e2e/shared-socket.spec.ts`. Opening an annotation costs the token round trip plus auth and
sync, never a fresh TCP/TLS/upgrade handshake; on the production box every open annotation
used to be a socket, a file descriptor and a ping timer of its own.

**Who owns the socket.** `DocPresenceProvider` (`src/components/annotation/
doc-presence-context.tsx`), which every surface with annotations already mounts — `/doc/[slug]`,
`/doc/[slug]/edit` and, hoisted into `PdfSurfaceClient`, `/pdf/[slug]`. It exposes `getSocket()`,
which creates the socket on first call and destroys it when the provider unmounts.
`src/lib/collab-socket.ts` has the two helpers: `createCollabSocket` and `attachProvider`.

- **Lazy, not at mount.** An anonymous reader of a public doc gets a 401 from
  `/api/doc/[id]/token` and opens nothing; a socket with no documents on it would be timed out
  by Hocuspocus after 30s and then retried forever by the client. So the first successful token
  fetch is what opens the socket — on `/doc/[slug]` the live tap's, on `/pdf/[slug]` the
  presence hook's, which only runs signed in.
- **A refused reconnect stops; a 401 stops the whole socket.** A token route answering a
  *refresh* with 401 (the session is gone) or 403 (this viewer may no longer open the document)
  is final, and the provider cannot tell either from a network blip: a `token` function that
  throws only leaves the document unauthenticated on a socket that will reconnect and ask again,
  about once a minute, for as long as the tab stays open. `refreshCollabToken`
  (`src/lib/collab-token-request.ts`) turns those two statuses into `CollabTokenDenied`, and
  every refresher uses it. Every provider on the shared socket gets a refresher rather than a
  token string, the PDF presence channel included: a string is re-sent unchanged on each
  reconnect and refused once its two minutes are up. `/ydoc-debug`, on a socket of its own, is
  the one that still passes a string. A 401 goes to `DocPresenceProvider`'s
  `reportSignedOut()`, which `disconnect()`s the socket — so nothing on it, and nothing
  attached to it later, reconnects
  until the page loads again — and raises `signedOut`: `SignedOutNotice` shows it under the
  byline on `/doc/[slug]` and above the viewer on `/pdf/[slug]`, and the editor's status line
  reads "Signed out — sign in again". A 403 detaches only that document. A surface's *first*
  fetch is untouched, because a 401 there is the anonymous reader above, with nothing to be
  told. `DocColumn`, whose provider owns its own socket, stops that socket and says so in its
  own status line.
- **A provider handed a socket does not attach itself.** `new HocuspocusProvider({ url })`
  attaches in its constructor; `new HocuspocusProvider({ websocketProvider })` does not, and an
  unattached provider sends nothing — no token, no sync, no error. `attachProvider` exists so
  that call is made once, in one place. `destroy()` detaches (a per-document close message)
  and leaves the socket alone.
- **Two providers with the same document name on one socket throw** once the first is
  authenticated. Separate sockets used to make that harmless. No surface mounts one annotation
  twice today (the margin rail *portals* a card rather than duplicating it); side-by-side with
  the same doc in both columns would, which is one reason `DocColumn` still owns its own
  provider and socket, and `/ydoc-debug` the other.
- **Server-side caches must key on socket *and* document.** Hocuspocus's `socketId` is per
  websocket, not per document connection. The clientID → user attribution cache in
  `server/ydoc-hooks.ts` was keyed on `socketId` alone and would have held whichever
  document's awareness arrived last, attributing a write to the annotation under the doc tap's
  clientID — right user, wrong key, and author highlighting silently never finds it. It is keyed
  on the pair now, cleared in `onDisconnect`, and `e2e/shared-socket.spec.ts` provokes exactly
  that ordering in both directions.

## Restarting the collab server

### Restarting never duplicates a document's content

`ydocOnLoadDocument` (`server/ydoc-hooks.ts`) creates its `ydoc` row **eagerly**, in
`createIfAbsent`'s transaction, before any client's content is ever applied. There is no
window where a killed server "never got around to" persisting a row, so a restart always
finds one waiting and re-seeds from the actual same lineage rather than building a
structurally new document.

This used to be a contrast worth drawing against posts, which had their own lazily-created
`PostCollab` row and a real doubling bug. Posts have no editable content of their own any
more (PLAN.md §15), so there is nothing left to contrast against.

### A doc's `ydoc` row *is* the doc, with no fallback to re-seed from

Unlike the old post-editing days there is no revision to fall back to, and an annotation's
anchor may be a mark embedded in that exact row's content (§12i) rather than a position
computed against it.

**Deleting `ydoc`/`ydoc_update` for a doc's id and letting it re-seed recovers nothing.**
There is nothing to re-seed *from*: `createIfAbsent` would just build an *empty* document
under that id, discarding every paragraph and every annotation the doc ever had.

If a doc's `ydoc` row is ever genuinely corrupted, the only way back is the update log itself
— `ydoc_update`, never truncated — replayed via `/ydoc-debug`. A doc's `ydoc:<docId>` row is
just another entry in the same table an ADMIN can select there. Not a delete-and-restart.

## `y-indexeddb`: never construct a second instance for one `Y.Doc`

`src/lib/ydoc-persistence.ts` (PLAN.md §11e; also used by `DocEditor.tsx` and
`DocColumn.tsx`'s write mode, §14l).

[y-indexeddb#25](https://github.com/yjs/y-indexeddb/issues/25): each instance re-persists
updates the *other* instance already wrote, because the library's own guard only excludes
itself as an origin, not sibling instances.

`attachIndexeddb` is ref-counted per local IndexedDB database **name** — a `Map`, not a
`WeakMap<Y.Doc>`, re-keyed in PLAN.md §14l Phase 0. That gives two properties:

- React StrictMode's double-invoked effects (same `Y.Doc`, attached twice) reuse the one
  instance.
- A second attach for a genuinely *different* `Y.Doc` against the same name is refused
  outright rather than silently building a competing instance — the shape
  `/side-by-side/<a>/<a>` would hit if the route didn't already reject it (PLAN.md §14c).

### The database is keyed by lineage, not by name

The local IndexedDB database is keyed by the document's *lineage* — `ydoc.created_at`,
fetched from `/api/ydoc/[id]/token` alongside the collab token — rather than by
`documentName` alone. `created_at` only changes if the row is ever recreated, i.e. exactly
when the server has built a structurally new document, so a stale local copy can never merge
into a re-seeded one.

**Attach the lineage-keyed store *before* connecting, and never cache it to attach earlier.**
Caching would let a stale copy merge in before the mismatch could be detected, which is the
bug this avoids rather than a race around it.

## `/ydoc-debug`'s replay slider is deliberately unoptimized

No debounce, no cache of other positions, no precompute (PLAN.md §11h). Backward scrubbing
across a long log *is* supposed to stutter: Yjs updates are append-only with no un-apply, so
going back rebuilds from the nearest snapshot while going forward just advances the doc
already in hand. **Don't "fix" it.**

Two things to know before reading its numbers:

- The `Y.encodeStateAsUpdate` behind the `(+N)` size delta runs on every scrub step and is
  pure instrumentation. It is outside the timer because it isn't part of the rebuild — but on
  a large document it can cost more than the rebuild the timer reports, so **the ms figure is
  not the per-step cost of the view**.
- Forward is *not* always incremental. Jumping forward across a newer snapshot rebuilds from
  that snapshot, which is both correct and cheaper than replaying the deltas in between, and
  is the only way a snapshot earns its keep on a forward jump.

The `forward`/`rebuild` marker at the head of the status line is what tells the two apart.

## The `/admin` endpoints

Besides the websocket, the collab process serves plain HTTP on the same port for server-side
work on a live document: `/admin/ydoc-snapshot`, `/admin/annotation-mark`, `-unmark`, `-flush`
and `-replace`, `/admin/doc-apply-update` and `/admin/doc-edit`. Going through the collab
process is what lets a write reach every connected client, where a write to the stored rows
behind its back would be overwritten at its next store. Each path is a constant in
`src/lib/ydoc-names.ts`, routed by `server/collab.ts`'s `onRequest`. The Next process calls
them over loopback (next section), and so does `scripts/import-claude-chats.ts`.

Each request carries a ydoc token (`src/lib/ydoc-token.ts`) that Next mints for its actor
after authorizing the write, and every handler checks it with **`verifyAdminToken`**
(`server/ydoc-hooks.ts`):

- **Signature, expiry and audience.** The audience is `multiblog:ydoc`. The MCP server's byte
  grants (`src/lib/api/grants.ts`) are signed with the same `AUTH_SECRET`, and each kind
  requires its own audience, so neither passes for the other.
- **The document**, which must be the one the request names.
- **Writable.** A read-only token is what the token routes give a reader's browser for its
  websocket, so it never authorizes a write here, even one made on a reader's behalf:
  `/admin/annotation-mark` exists so a reader can annotate, and Next mints that request a
  writable token of its own.

A new endpoint calls `verifyAdminToken`. `verifyYdocToken` alone is the websocket's check
(`ydocOnAuthenticate`), which lets a read-only token through and narrows the connection
instead. Behind DEPLOY.md's nginx these paths answer only on the loopback, since the public
`/collab/admin/…` never matches; the token is the gate wherever the port itself is reachable,
as it is in development. `e2e/admin-readonly.spec.ts` sends a reader's token to every one.

## The server→collab HTTP origin, and the production-only bug it caused

Moved here from PLAN.md §13m on 2026-09-17, near-verbatim; the section references inside it
are that document's. `src/lib/collab-http-origin.ts` is the fix, docs/ENV.md the variable.

Found 2026-08-11 on the dev deployment, reported as *"Annotation can't be empty."* on every
attempt to annotate a selection. Worth recording in full, because nothing about the symptom
pointed at the cause and the whole class was invisible to every local check.

**The mechanism.** At the time, four endpoints were served by the collab process over plain
HTTP on its websocket port — `/admin/ydoc-snapshot` (§11d), `/admin/annotation-mark` (§12i),
`/admin/annotation-unmark` (§13d), `/admin/annotation-flush` (§13j Phase 3). The Next process
called them server-to-server. Both callers (`src/lib/annotation-admin.ts`,
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

## A tab whose schema is out of date is refused

The first step of [ENTITY_CHIPS.md](ENTITY_CHIPS.md), and it protects every schema change, not
only that one.

### The problem

A tab keeps running the JavaScript it loaded. After a deploy that changes a ydoc-bound schema
(a new node, mark or attribute), y-tiptap in that tab deletes from the *shared* document whatever
its schema can't build. It does so inside a Yjs transaction, so the deletion syncs to everyone:

- **A node type it lacks is deleted**, together with any text inside it. A table is one case.
- **A mark type it lacks erases its paragraph's whole text.**
- **An attribute it lacks is dropped** from a mark or node as soon as the old tab edits that run
  or block, through `updateYText` and `updateYFragment`.

Measured against y-tiptap 3.0.7, using the sync plugin's own calls:
`yXmlFragmentToProseMirrorRootNode`, and `initProseMirrorDoc` followed by `updateYFragment`.

TipTap's `enableContentCheck` doesn't help, because it checks the document y-tiptap has already
built, after the deletion. TipTap's open PR #8686 says the same: "y-tiptap deletes the content
before the content check sees it, so `contentError` never fires."

### The gate

1. **A version in the bundle.** `src/lib/schema-version.ts` exports `SCHEMA_VERSION`, and it is
   compiled into the bundle. It is 0: the gate by itself forces no reload. The first schema
   change after it makes the version 1, which also refuses tabs opened before the gate existed.
2. **The version goes on the socket URL.** `getCollabUrl()` (`src/lib/collab-url.ts`) appends
   `schema=<SCHEMA_VERSION>` through `withSchemaVersion`. Every browser socket is built from it:
   - `createCollabSocket`, the page's one socket;
   - the side-by-side columns (`sidebyside/DocColumn.tsx`);
   - `/ydoc-debug` (`YdocDebug.tsx`).

   It isn't in the token. `/api/doc/<id>/token` is fetched again on every reconnect, so a new
   server would hand an old tab a token carrying the new version.

   A spec that opens a socket of its own calls `withSchemaVersion` on its URL.
3. **The server refuses a mismatch, with a reason the client can read.** `refuseStaleSchema`
   (`server/schema-gate.ts`) runs first in `onAuthenticate` and compares the URL's `schema` with
   the server's own constant. A missing parameter counts as 0; anything that isn't a whole number
   matches no version.
   - Hocuspocus sends the client `error.reason ?? "permission-denied"`, and every other refusal
     throws a plain `Error`, so the browser reads "permission-denied" for those.
   - The gate throws `SchemaRefused`, whose `reason` is `SCHEMA_REFUSAL`: one sentence shared by
     server and client, "This page is out of date. Reload it to keep editing." The client matches
     on it (`isSchemaRefusal`) to tell this refusal from the others.
   - It logs each refusal, once per socket.
4. **A refused tab receives nothing.** Hocuspocus 4 runs `onAuthenticate` before any sync, and
   holds and then drops a document's messages if it fails.
5. **Every deploy reconnects every tab.** `deploy/deploy.sh` restarts web and collab in one
   command, so every open socket reconnects and is checked against the new server.
6. **The refusal is detected once and shown once.**
   - `attachProvider` (`collab-socket.ts`) wraps every provider's `onAuthenticationFailed` and
     tells the socket's owner, so the surfaces with no handler of their own (annotation bodies,
     the live doc tap, PDF presence) are covered with the rest.
   - `DocPresenceProvider` stops the socket and sets `outOfDate`, beside `signedOut`.
   - The doc editor's status line says "Out of date", with a reload button; both its editors go
     read-only; and its IndexedDB is detached. Anything typed while collab was restarting is
     already in IndexedDB, and the reloaded page takes it in (The local database is named by
     schema version, below).
   - Detaching IndexedDB is what makes that complete: the database is closed and no longer
     written, so the reloaded page reads all of it and its delete isn't held up.
   - An annotation's editor has no IndexedDB, so it goes read-only at once, its submit is
     disabled, and it says to copy out anything unsaved before reloading.
   - The reading views and the PDF viewer show `OutOfDateNotice`.
   - A side-by-side column and `/ydoc-debug` own their sockets, so each handles the refusal
     itself: the socket stops, the editors stop, IndexedDB is detached.
7. **A unit test makes a bump impossible to forget.** `src/lib/schema-version.test.ts`:
   - Each live editor's whole extension list lives in `src/lib/live-editor-extensions.ts`
     (`docEditorExtensions`, `annotationEditorExtensions`, `titleEditorExtensions`), and
     `CollabEditorBody`, `AnnotationBody` and `CollabTitleField` pass that call and nothing
     beside it. So the test reads the lists the editors run, and an extension added in a
     component is one it would never see.
   - It asserts that each list builds the same schema as the one `tiptap-schema.ts` decodes that
     ydoc with.
   - It fingerprints the three schemas: every node and mark in order, their attributes and
     defaults, and what may sit where. It fails until `SCHEMA_FINGERPRINTS` has the new
     fingerprint under a new `SCHEMA_VERSION`, the way `check:schema` fails on an unformatted
     `schema.prisma`. The failure prints the line to add.

`e2e/schema-gate.spec.ts` covers the rest: the server's refusal from a raw socket, an editor
refused on reconnect and live again after its reload, and a reading view refused at load. One
build has no out-of-date tab, so the spec rewrites the version on the socket URL the page opens.

### The local database is named by schema version

The server can refuse a socket, but a tab reads its IndexedDB copy of a doc with no server in
between, and y-indexeddb's compaction reads what other tabs in the same browser wrote. A
database shared across bundles would hand an old tab a new tab's content, to delete what its
schema lacks and leave that deletion for its next load to sync. A tab opened before the gate
existed would do it with no refusal to stop its editor first.

So `ydocDbName` (`src/lib/ydoc-db-name.ts`) puts the bundle's `SCHEMA_VERSION` in the name:
`ydoc-debug:s<version>:<document>:<lineage>`. Version 0's name has no `s<version>:`, which is
the name every bundle before the gate used. Two bundles never share a database, and that covers
the tabs from before the gate too, so a bump waits on nothing.

On its first attach of a doc, `attachIndexeddb` settles that doc's other local databases
(`settleOtherDatabases`, `ydoc-persistence.ts`):

- **An older version's, of the same lineage, is taken in and then deleted.** It holds what a tab
  on that bundle typed and hadn't yet synced, typically while collab restarted for the deploy
  that brought the new bundle. It holds nothing the new schema can't build, because no newer
  bundle ever writes it. The updates are applied to the live `Y.Doc`, so y-indexeddb stores
  them under the new name and the provider syncs them.
- **A newer version's is left alone.** This bundle can't build what it holds, and the build
  that can is the one a roll-forward brings back.
- **Another lineage's is deleted**, as before (The database is keyed by lineage, above).

Two limits:

- **The delete waits on any tab that still has the database open**, and what such a tab writes
  after the read is lost with the database. A refused tab has detached and gone read-only, so
  this is only a tab from before the gate, typing on after its refusal, while a reloaded tab in
  the same browser has the same doc open.
- **It needs `indexedDB.databases()`.** Where a browser lacks it nothing is listed, so nothing
  is taken in or deleted, and an older version's unsynced typing stays where it is.

`e2e/local-database.spec.ts` types with collab cut off, moves the database to the previous
version's name, and expects the next load to show and sync the text, delete that database, and
leave a newer version's unread.

### What it doesn't cover

- **A rollback.** Rolling back past a bump, after people have used the new type, makes the old
  build current again, and its tabs delete that content. Roll forward instead.
- **Server-side writers need nothing.** MCP edits, imports and the `/admin` endpoints run the
  server's own schema.

### Not chosen

- **A version stored in each ydoc**, as Leaflet and Lexical's Yjs binding do.
  - It is more precise, but every writer has to stamp it, and it protects only tabs whose code
    already checks it.
  - Their per-update checks exist because clients on different versions meet on one document.
    Here the server refuses any mismatch, so they never do.
- **Keeping unknown content as opaque placeholder nodes**, as Atlassian's editor and BlockSuite
  do. It needs a fork of y-tiptap, and y-prosemirror has no plans for such a node.
- **A second layer, later.** Once y-tiptap ships PR #8686, `enableContentCheck: true` writes
  nothing to the Y.Doc and makes the editor non-editable instead. That is worth enabling, though
  it protects only tabs already running that version.

### Prior art

- **TipTap's Diagrams guide documents this gate.** The client puts `?schema=` on the Hocuspocus
  URL, and the server checks it in `onConnect`, "before the document is loaded"
  (tiptap.dev/docs/diagrams/guides/collaboration).
- **Leaflet hit the same y-prosemirror bug** and checks in the browser: "a client on an old deploy
  merely opening a doc with newer content would destroy that content for everyone."
- **The library maintainers both recommend a version check.**
  - Kevin Jahns (Yjs) says a client on an older schema "shouldn't open the document".
  - Marijn Haverbeke (ProseMirror) says "build some kind of version-check into your protocols".
- **Sync engines refuse an old client.** tldraw sync closes the session with `CLIENT_TOO_OLD`, and
  Replicache sends a `schemaVersion` with every request.
