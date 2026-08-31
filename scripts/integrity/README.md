# Integrity checks

Three scripts. Two verify one link each in the chain that turns an append-only
log into the columns the app reads; the third verifies a claim made *about* a
point in that log:

```
ydoc_update  →  ydoc.ydoc  →  doc.title / doc.prose_json / doc.prose_json_length
└─ check-ydoc-integrity ─┘    └────────── check-doc-integrity ──────────┘
     ↑
     └── annotation.{anchor_from, anchor_to, quoted_text} @ ydoc_update_id
         └────────────── check-annotation-anchors ──────────────┘
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
| `check-annotation-anchors.ts` | replay to an annotation's stamp — is it actually anchored there? (its quote, for a column anchor; its mark, for a mark anchor) | ERROR, except a missing stamp (WARN: rows predating the column are legitimately in that state) |

Run all three:

```bash
npx tsx scripts/integrity/check-ydoc-integrity.ts \
  && npx tsx scripts/integrity/check-doc-integrity.ts \
  && npx tsx scripts/integrity/check-annotation-anchors.ts
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

`check-annotation-anchors` sits at the same point in that ordering and for the
same reason — it replays the log, so a corrupt log makes it report anchor faults
that are really one ydoc fault wearing several hats. Run it third.

It is the odd one out in what it verifies. The other two ask whether a *derived*
value still matches what it was derived from. This one asks whether a claim
written down once — "at update N, characters [a, b) of this document read
exactly this" — is still true of the history. Nothing recomputes that claim, and
PLAN.md §13o's design depends on it: the reading views search for the stored
quote as ground truth, and COLLAB.md §7's eventual repair would diff *from* the
stamped state. If the claim is wrong, both silently anchor to the wrong passage
rather than failing.

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

## `check-pdf-anchors.ts` (PLAN.md §19)

The file-side sibling of `check-annotation-anchors.ts`, and the odd one out in the same way:
it verifies a **claim written down once** — "on page N, characters [a, b) of the normalised
text read exactly this" — rather than a derived value. Nothing recomputes it, so nothing
else would ever notice it breaking.

It is a separate script rather than a branch inside `check-annotation-anchors.ts` because the
two check different things against different substrates. A doc annotation's anchor is
verified by replaying a ydoc to a stamped version; a file has no ydoc and no version to
replay to — its bytes are immutable, which is precisely why its anchor is checked against
the stored page text (`file_page_text`) instead.

What it can and cannot see:

- **Can**: a quote that disagrees with the page text at its own offsets; a target whose
  `textVersion` has no matching extraction; a `pageIndex` past the end of the document; a
  malformed target blob; a quote stored with no target at all.
- **Cannot**: the quads. They are geometry, and checking them would mean rendering the PDF,
  which needs a browser. They are also the part least likely to be wrong — they were
  measured against bytes that cannot change.

```
npx tsx scripts/integrity/check-pdf-anchors.ts [--file <idOrSlug>] [--verbose]
```

Unlike the other three it does **not** need to run after the ydoc check: it touches no ydoc
at all, so its findings are never downstream of a bad blob.

## `check-tag-constraints.ts` — the odd one out, again

Every other script here verifies **stored data**. This one verifies the **schema**: that
`add_tags`' two hand-written CHECK constraints and its `lower(name)` unique index actually
reject what their comments claim, by attempting each violation inside a transaction it always
rolls back.

It exists because nothing else can reach them. `npx tsc --noEmit` sees TypeScript, and every
violation is well-typed. `npm run e2e` drives the UI, and the UI never attempts one — the
server actions build valid rows by construction, so a suite that only walks the happy path
cannot tell a live constraint from a comment describing one. And a migration that silently
failed to add a constraint (docs/DATABASE.md's edit-an-applied-migration recipe, a restore
from a dump taken before it) leaves a database that behaves correctly right up until
something writes a bad row.

Run it after either of docs/DATABASE.md's two migration recipes. It also prints its own
**known residuals** — what the specified CHECK deliberately does not catch — because "which
constraint covers this?" is the question it exists to answer, and an honest answer includes
the gaps.

`check-annotation-anchors.ts` also walks `tag_anchor` since PLAN.md §20g: the replay
invariant is a per-row property, so one checker covers every anchor table rather than one per
consumer family. In PR 1 that walk reports `0 of 0` — every tag anchor is whole-object and
makes no claim about any text — and the zero is itself the assertion that PR 1 kept its
tie-off promise.

Since docs/ANCHORED_LINKS.md, the same one-walk-per-invariant rule covers
`anchored_link_anchor` — the third table on the §20a envelope, and the first with real part
rows on main: its `DOC_RANGE` parts join `check-annotation-anchors.ts`'s replay walk, its
`PDF_TEXT` parts join `check-pdf-anchors.ts`'s page-text pass, and `check-tag-constraints.ts`
probes its two CHECKs plus the `anchored_link_one_draft_per_user` partial unique index (both
directions: a second open draft must be refused, a second link for a user whose first is
*minted* must not be).
