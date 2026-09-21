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

## The server→collab HTTP origin, and the production-only bug it caused

Moved here from PLAN.md §13m on 2026-09-17, near-verbatim; the section references inside it
are that document's. `src/lib/collab-http-origin.ts` is the fix, docs/ENV.md the variable.

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
