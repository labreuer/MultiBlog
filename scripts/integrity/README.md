# Integrity checks

Two scripts, each verifying one link in the chain that turns an append-only log
into the columns the app reads:

```
ydoc_update  →  ydoc.ydoc  →  doc.title / doc.prose_json / doc.prose_json_length
└─ check-ydoc-integrity ─┘    └────────── check-doc-integrity ──────────┘
```

Neither derives anything on read. `ydoc.ydoc` is what a live editing session
loads; the `doc` columns are what `/docs`, search and every non-editing surface
read. Both are written once, by the collab server's store debounce
(`server/doc-cache.ts`) and by the `doc_sync_prose_json_length` trigger, and
neither is ever recomputed to check itself. So a break anywhere in that chain is
silent by construction — the app keeps serving a stale or wrong value
indefinitely, with nothing failing. That is what these exist to make loud.

| | asks | fails on |
|---|---|---|
| `check-ydoc-integrity.ts` | does the stored blob match a replay of its own update log? | ERROR — a divergence here means the document and its history disagree |
| `check-doc-integrity.ts` | do the Doc columns match the stored blob? | mostly WARN, since a cache legitimately trails the ydoc by one debounce; `length-cache` is an ERROR because nothing explains or fixes it |

Run both:

```bash
npx tsx scripts/integrity/check-ydoc-integrity.ts && npx tsx scripts/integrity/check-doc-integrity.ts
```

Each exits non-zero on an ERROR-level finding and zero on WARNs, so the pair can
gate a deploy or run from cron. Each takes `--verbose` and an id filter; see the
header comment in each file for its own flags and the full list of what it
checks — that is where the reasoning lives, not here.

## Why they're split

The split is by *reference*, not by convenience. `check-ydoc-integrity` replays
the log and trusts nothing else. `check-doc-integrity` takes the blob as given
and compares the columns to it — deliberately, because the blob is what
`doc-cache` actually reads, so it is the honest answer to "should this column
look like this?". If the blob itself is wrong, that is the first script's
finding; duplicating it in the second would double-count one fault and make a
single corruption look like two unrelated ones.

The practical consequence: **when both report problems, fix the ydoc one first.**
A bad blob will produce doc-cache findings that evaporate once the blob is
repaired from its log.

## When to run them

- After either one-shot import (`scripts/import-legacy.ts`,
  `scripts/etherpad/import-etherpad.ts`) — this is their acceptance test, and
  the blob-vs-log class of corruption is exactly what the legacy import
  surfaced.
- After anything that writes doc bodies in bulk, especially with
  `DISABLE TRIGGER` or `COPY` — that is the one way `prose_json_length` can go
  wrong, and the only check here that reports a genuine fault rather than lag.
- Not usefully mid-editing-session: `title-cache` and `body-cache` compare a
  cache against a source that is legitimately ahead of it, so an active editor
  produces differences that are not faults. They are `--verbose`-only for that
  reason.
