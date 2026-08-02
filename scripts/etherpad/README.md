# Importing Etherpad history

`import-etherpad.ts` reads an Etherpad Lite `dirty.db` and imports it into MultiBlog's
doc stack, preserving full per-revision edit history. Done 2026-08-02, against a real
file holding 50 pads, 2,140 revisions and 23 authors.

```bash
npx tsx scripts/etherpad/import-etherpad.ts --source=<dirty.db> --verify
npx tsx scripts/etherpad/import-etherpad.ts --source=<dirty.db> --list-authors
npx tsx scripts/etherpad/import-etherpad.ts --source=<dirty.db> --authors=<json> --dry-run
npx tsx scripts/etherpad/import-etherpad.ts --source=<dirty.db> --authors=<json>
```

`--verify` runs everything that touches no database (read, replay, map, and the
list-nesting self-test) and prints the attribute inventory. `--list-authors` prints
an `--authors` skeleton — you cannot write that file without it, because Etherpad
author ids are opaque. `--dry-run` does the whole import inside a transaction and
rolls it back. Run all three, in that order, before a live run, then
`npx tsx scripts/check-ydoc-integrity.ts` afterwards.

Full flag reference and the design rationale for each stage live in the file headers
of `import-etherpad.ts`, `dirty-db.ts`, `changeset.ts`, and `to-prosemirror.ts` — this
file records the decisions someone reading the *app* (not the script) would need,
and follows PLAN.md's section numbering only by cross-reference, since PLAN.md itself
does not track one-shot imports (see CLAUDE.md's "One-shot data imports").

## Why the history, not just the text

The point was never the current text of each pad — it was the *history*. Etherpad
stores a changeset, an author, and a timestamp per revision, and the doc stack's
`ydoc_update` log (PLAN.md §11b) is an exact home for that: never truncated, replayed
by `/ydoc-debug` and `DocScrubBar`, and publishable from any past point (PLAN.md §15).
So the import emits **one `ydoc_update` row per Etherpad revision**, carrying that
revision's real timestamp and its author's clientID.

## The boilerplate pad text is removed from the whole history

Etherpad seeds every new pad with `settings.defaultPadText` — here "Welcome to
Etherpad!" plus three more paragraphs, one of them a DirtyDB warning. That is
the software talking, not the authors, so the imported history is written as
though it had never been there: not merely deleted at the end, but **absent from
every revision**, including those before whoever it was got around to selecting
it and pressing delete, and including pads where nobody ever did. In the real
file, 48 of 50 pads were seeded; 28 still carried some of it at head, and 20 had
deleted it themselves partway through.

It is identified **by identity, not by content**. Revision 0 is the seeding
revision, so the characters it inserts are flagged (`Cell.seed` in
`changeset.ts`) and the flag rides along through every later changeset: a `-` op
drops those cells, an attributed `=` copies the flag onto the rewritten cell,
and no `+` op ever sets it. A pad that deleted the boilerplate halfway through,
one that deleted only half of it, one where somebody typed inside it, and one
that never touched it all come out right, with no text matching anywhere. The
mapping stage then looks only at unflagged cells.

This does not weaken the correctness gate below: the atext checkpoints still
compare the **full** replayed document, boilerplate included, against Etherpad's
own stored atext — all 116 still match. Only the mapping looks away.
`--keep-default-text` imports the boilerplate instead.

Two consequences worth knowing. Sixteen pads contained nothing else and import
as empty documents (one empty paragraph). And the revision whose only effect was
deleting the boilerplate now changes nothing, so it writes no row — four of them
in the real file, each named in the summary. That is the row/revision shear the
next section is about, and `First_entry` exercises it for real: its revision 286
collapses, and its snapshot at revision 326 still lands on the right content
because marks are resolved from row indices rather than revision numbers.

## Each pad becomes a Doc, never a Post

Same call `scripts/import-legacy.ts` made: the editable, collaboratively-authored,
revision-bearing thing a pad *is* maps onto a Doc, and publishing is a deliberate
later act through `/posts/[id]` (PLAN.md §15c) — including from any point in the
imported history, which is the whole reason the history is imported rather than
just the head.

## Both attribution levers are used, and they are not equally exact

`authorHighlight` marks (PLAN.md §3d) carry Etherpad's per-character `author`
attribute, so what a reader sees is what Etherpad showed; nothing on the doc side
ever strips them (§12d). The `clients` map (§11d) is written the first time each
author changes anything, from a per-author `clientID` reassigned on the master
`Y.Doc` between transactions — safe: yjs reads `clientID` only at struct-creation
time, tracks clocks per client, and only reassigns it itself on a *non-local*
transaction. That second layer is approximate: y-prosemirror's diff can delete and
reinsert a run whose marks changed, attributing untouched characters to the editing
author at the CRDT level. Measured at 2.2 bytes of Yjs update per character ever
typed in the real file, so it is diffing rather than rewriting whole paragraphs.

## Rows do not correspond one-to-one with revisions

A `Y.Doc` transaction that changes nothing emits no update at all, so a revision
that is real at the atext level but a no-op once mapped writes no row. Snapshot
marks are therefore resolved from the row index the update handler actually saw,
never from a revision number. In the real file four revisions collapse — each one
the revision that deleted the boilerplate — giving 2,140 revisions + 50 base rows
− 4 = 2,186 rows.

## `ydoc.created_at` is not backdated

It is the y-indexeddb lineage stamp (§11e), and backdating it would let a stale
local copy merge into a re-imported document. `doc.updated_at` and
`ydoc.updated_at` are backdated via raw SQL, both being `@updatedAt`.

## The correctness gate comes from the source data

Etherpad stores the full atext at every 100th revision and at head. The replay is
compared against those cell-for-cell — characters *and* attributes — giving 66
checkpoints plus 50 heads across the real corpus, all matching. Comparing cell
models rather than re-serialized attribution strings is what keeps the gate
trustworthy: no emitter, so no canonical-ordering false failures. It earned its
keep immediately, catching that an op's attribute list is a list of
*instructions* — `["author", ""]` means "remove this key", Etherpad's "clear
authorship colors" feature — which if filtered at parse time turns every removal
into a silent no-op. One pad in 50 had ever used it.

Structural mapping is covered separately by `runMappingSelfTest()` in
`to-prosemirror.ts`, which `--verify` runs: the text round-trip catches *dropped*
content but cannot catch *wrongly nested* content, and flat `bulletN` depth
integers to nested `bulletList`/`listItem` trees is the only non-mechanical step
in the mapping.

## Lossy, by decision

`list=indentN` has no StarterKit equivalent and becomes a nested `blockquote`
(`--indent-as=paragraph` to drop it instead) — one line in the real corpus.
Saved-revision *labels* have nowhere to go (`ydoc_snapshot` has no label column)
and are printed instead; the saved revisions themselves become snapshots. Pad
chat is not imported — a `Comment` needs a `Post` and an `Annotation` needs an
anchor mark, so inventing either from chat text would be fabrication (the real
file had none). Read-only share links, sessions, tokens and groups have no
counterpart.

## Two things about `dirty.db` that generalize

Pad ids can contain colons, so keys must be classified by anchoring on the
`:revs:<n>` suffix, never by splitting on the first colon. And a deleted key is a
line with **no `val` property at all** — `JSON.stringify` drops `undefined` — not
`"val":null`; reading `o.val` and testing for null silently resurrects every
deleted pad.

## Never-edited pads are imported anyway

Sixteen pads in the real file were at head 0 with nothing but Etherpad's stock
text: seven scratch pads, and nine that are a *retitle* of a real pad, created
seconds before it by typing the title with spaces instead of underscores
(Etherpad has no rename, so retitling means a new pad). They are imported anyway
— a transcription does not get to decide which of somebody's documents were
worth keeping — so nine docs share a title with their content-bearing twin, and
the twin with more revisions takes the unsuffixed slug. `--skip-untouched` drops
them. Since the boilerplate is stripped, these are exactly the sixteen documents
that import empty.
