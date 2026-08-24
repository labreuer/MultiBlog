# The ydoc stack

One Hocuspocus process, three Postgres tables, and the rules that keep a document's identity
intact across restarts and across a browser's local cache. The design is PLAN.md §11 and
§12; this file is what you need to know before restarting something, debugging something, or
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

- **`ydoc:annotation:<id>`** — one ydoc per annotation body (PLAN.md §13a).
- **`ydoc:test-*`** — the containment guard for `scripts/test-ydoc.ts`.

A `ydoc:` name nobody has explicitly created — via `scripts/test-ydoc.ts`,
`scripts/test-doc.ts`, or `/ydoc-debug`'s "New document" button — just starts empty.

That there is exactly one `new Server(...)` in the codebase is also why a slot needs one
collab port and not a block: see [DEV_SLOTS.md](DEV_SLOTS.md).

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
