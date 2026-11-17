# Forks and diffs — a doc's copies, and what changed between two texts

**Status: built, but for one choice and one plan. The engine's size guards, the diffs and the
forks are built (Build order, items 1 to 3).** How the diff page shows a fork against its
parent is built to be tried and not yet chosen ("Which side is later"), and sliders on the diff
page are planned ("Planned: sliders on the diff page"). Everything else is the as-built
account.
PLAN.md §36 points here.

A **fork** is a new doc seeded from another doc's text at one version, which records where it
came from. A **diff** shows two texts side by side, word by word: two docs, or one doc at two
versions. The `wiki` branch built both for wiki pages (its docs/WIKI.md, "Forking", "The
banner", "Diffs"). Here they are for every doc, with nothing of the wiki in them, so
that the wiki, when it is rebuilt, adds its addresses on top of them rather than carrying forks
and diffs of its own ("What the wiki adds later").

What it does not repeat:

| | |
|---|---|
| [DOCS.md](DOCS.md) | The doc, its ydoc, the reading view and its scrub bar. |
| [PERMISSIONS.md](PERMISSIONS.md) | Who may read and edit, as tables; the rows for diffs and forks are named where they arise. |
| [MCP.md](MCP.md) §6 | The engine, `alignBlocks` and `diffRuns`, which MCP's `since` already runs. |
| PLAN.md §14 | `/side-by-side`, the doc-link surface, which links to the diff of its pair and shares nothing else with it ("Its own route"). |

## Mistakes that fail no check

Read these before changing code that shows a doc as it was at an earlier version: code that
calls `loadDocStateAt` or `isDocVersion`, serves a doc's `ydoc_update` rows, or takes an update
id from a request. Today that is the doc page's scrub bar and its replay route, the diff page,
forking, MCP's reads and writes, and `/post/[id]/edit`. Read the last of them before writing
code that seeds a doc from another doc's text. Each mistake compiles, lints and gives a doc's
editors the right answer, and the specs cover the diff page's gate and `forkDoc` alone.
CLAUDE.md points here and holds none of it, so this list is the whole of the warning.

- **Showing history through `canUserEditDoc`.** The two answer alike for a doc's own scrub bar,
  so nothing differs there until the permissions redesign. They already differ in a diff, where
  a fork's editors may see one version of a parent they can't edit. Ask `canUserSeeDocHistory`
  for a doc's history, `docsWithVisibleHistoryWhere` for several docs at once, and
  `canUserSeeDocVersion` for one version in a diff ("Who may see a doc's history").
- **Asking whether a version exists before whether the viewer may see it.** `isDocVersion`
  first answers not-found for an id outside the doc's log and Forbidden for one inside it,
  which tells a reader without the history which ids the log holds. `canUserSeeDocVersion`
  comes first, and a viewer who fails it is refused whatever the id (`loadDiffPair`,
  `src/app/diff/[left]/[right]/page.tsx`).
- **Moving a check that replays in order to write.** `/post/[id]/edit`, MCP's revert and an
  edit that names a passage at a version ask `canUserEditDoc`, because each is an edit. On the
  history predicate, a rule that showed history to more people would let them publish from the
  doc or write to it. Two of MCP's reads are outside the rule on purpose ("Who may see a doc's
  history").
- **Asking `canUserSeeDocVersion` outside a diff.** Its fork-point exception shows one version
  of a parent to a fork's editors, who hold that text already. The parent's scrub bar, its
  `since` and forking it at a version ask `canUserSeeDocHistory`. On the wider predicate, a
  fork's editor could fork the parent again at that version, or be served its replay.
- **Seeding a doc from another doc's body without `forkSeed`.** The doc schema has the
  `annotation` mark, so `createDocWithContent` accepts a body that still carries the marks of
  the other doc's notes, and nothing after it refuses one. An editor-made annotation is a mark
  whose `id` is one of that doc's annotation rows, so a copy lights up its notes in the new
  doc's editor, on rows that resolve against another doc. `forkSeed` (`src/lib/fork-seed.ts`)
  strips the mark, and its unit test is all that holds the strip ("What it takes, and what
  stays").

## What it is for

1. **Changing a doc you can read but not edit**, in a copy of your own, with the text's
   authors still credited where their words survive.
2. **Seeing what a fork changed, what its parent changed since, and how the two differ now.**
3. **Diffing one doc between two points in its history**, chosen on the scrub bar.
4. **Diffing any two docs you can read**, the pair side-by-side shows.

Items 3 and 4 need no fork ("Build order").

## Who may see a doc's history

**An interim rule, until the permissions redesign replaces it**: a doc's history, meaning any
state of it but the current one, is its editors', with one exception for forks.

- **One predicate, `canUserSeeDocHistory(userId, role, docId)`** in `src/lib/doc-authz.ts`, is
  `canUserEditDoc`'s answer for now. That is everyone on the doc's byline whose role may manage
  docs (ADMIN, EDITOR, AUTHOR), and an ADMIN or EDITOR on any `SHARED` doc. A byline member whose
  role can't (AUTHORIZED, COMMENTER) sees no history.
- **Every check that shows a doc's history goes through it**: the scrub bar's replay route
  (`/api/doc/[id]/replay`), the doc page's choice to mount the scrub bar, MCP's `since`
  (`src/lib/mcp/read/doc.ts`), a diff's versions, and forking at a version (`readForkSource`).
  So the redesign replaces the predicate and its filter form rather than five call sites.
- **The predicate has a filter form beside it, `docsWithVisibleHistoryWhere(userId, role)`**, as
  `readableDocsWhere` is beside `canUserReadDoc`: the same rule as a `where` on `Doc`, and null
  for a viewer who sees no doc's history. A check that asks about several docs at once goes
  through it, in one query: the fork-point exception (below), and the family lines' diff links
  ("A doc's family").
- **The doc page asks two questions.** `canEdit` decides the title's link to the editor and
  the posts line. The predicate's answer decides the scrub bar, the room left for it
  (`containerScrubbable`) and `DocScrubProvider`'s `hasScrubBar`, and is a prop of its own on
  `DocView`, `canSeeHistory`.
- **Three checks stay on `canUserEditDoc`, since each is an edit.** `/post/[id]/edit` asks it to
  choose between the scrub bar's replay and the post's stored `proseJson`: the bar there picks
  the version to publish, and publishing from a doc is its editors' (CLAUDE.md, "A post's byline
  is not its doc's"). MCP's revert, and an edit that names a passage by its ends at a version,
  replay the log to write to the doc. The post page's bar fetches the replay route, so the
  redesign must leave a doc's editors able to see its history, or change that page with it.
- **Two of MCP's reads are outside the rule.** Anchoring rebuilds a doc at the version an agent
  sends with a quote, for any reader who may leave a note, and says when that version isn't in
  the doc's log. It shows no old text. Reading a thread whose note's mark has left the doc
  rebuilds the doc at the note's stamp and gives the passage the note was on
  (`passageAtStamp`, `src/lib/mcp/read/threads.ts`), to any reader of the thread: old text, and
  no more of it than the note marked. The redesign weighs both (below).
- **The exception: a fork point is not history to the fork's editors.** A diff may show
  `<parent>@<X>` to a viewer who may see the history of a live fork of that parent whose
  `forked_from_update_id` is X, and who can read the parent now, as any diff demands. The
  parent at X is that fork's first state, which its editors can already reach on its own scrub
  bar, so the exception shows them nothing they don't already hold. It is what lets an AUTHOR
  who forked a doc they can't edit see what its author changed since.
- **`canUserSeeDocVersion(userId, role, docId, version)`** is what a diff asks of each
  version. It holds both: the predicate, or a live fork of the doc, forked at that version,
  among the docs whose history the viewer may see, of a parent the viewer can read now. That
  is one query, through the filter form and `readableDocsWhere`, however many forks were made
  at that version. Its answer depends only on forks the viewer may already see into, so it
  tells them nothing about the parent's log that those forks don't.
- **The exception is for diffs alone.** The parent's scrub bar, its `since` and forking it at a
  version stay its editors'.

Whether readers should see more, and from when, is the redesign's question. TODO.md's "Who
may see a doc's history" says what it should weigh: drafts written while a doc was `PRIVATE`,
which no record dates; the states readers saw live anyway; and MCP's anchoring, which checks a
quote against any version in a doc's log.

## Diffs

### The route

**`/diff/<left>/<right>` shows a word diff from its left side to its right**: what the left
has and the right lacks is shown as removed, and what the right has and the left lacks as
added. **Either side may be the older.** The scrub bar's links put the older one on the
left, the route asks for no order, and "Swap sides" gives the other reading. The server
decides who may see it and reads each side; the reader's browser compares them ("Where the
comparing is done"). The page opens no `Y.Doc` in the browser, so the same doc may be on both
sides. Each side is one of:

- **`<doc id>`**, the doc as it is now: `loadDocStateNow`, the `ydoc` row with the log's later
  rows applied ("A doc as it is now"). A fork of the latest reads the same, so a fork point is
  never ahead of a later diff's "now";
- **`<doc id>@<update id>`**, the doc at that `ydoc_update`: `loadDocStateAt`.

**A version is part of what a diff is, so it is in the path**, not in a query parameter. A
parameter dropped from a pasted URL would turn "what the fork changed" into "how they differ
now", a different comparison, without saying so. It is a bare `@1234`, since braces would be
percent-encoded when the URL is copied. Next hands the segment over with the `@` as `%40`
(CLAUDE.md, "A Next dynamic-route `params` value arrives percent-encoded"), and the parser
decodes it once. **Sides are doc ids, never slugs**: a slug changes, and an id-only lookup
can't be confused by a slug that happens to look like `x@1`.

`src/lib/diff-side.ts` is the parser, pure, with a unit table: `parseUpdateId` (a positive
integer with no leading zero, at most 9223372036854775807, Postgres's largest `bigint`, so a
larger one is a 404 here rather than a 500 from the database; `parseScrubUpdateId` accepts 19
digits, past that bound), `parseDiffSide`, `diffSideSegment` and `diffPath`.

### A doc as it is now

**"Now" is the `ydoc` row with the log's later rows applied to it**, `loadDocStateNow(docId)`
in `src/lib/doc-state.ts`. The collab server appends a `ydoc_update` row on every update and
writes the `ydoc` row only at its store debounce, two seconds of quiet and ten at most while
someone types. The scrub bar hands out log ids. So the stored row alone can be older than a
version a reader has just pinned: "Diff with now" would compare that version with an earlier
text, under a header that calls it the doc as it is.

- **It reads the row's `ydoc` and its `last_update_id`**, which one store pass writes together
  after its appends have landed (`drainAppends`), so the bytes hold every log row up to that
  id.
- **It applies the doc's log rows past that id** (`ydocStore.updatesAfter`) to the decoded
  doc. With nobody typing there are none, and the answer is the stored row.
- **Its version is the last row applied**, or `last_update_id` when there were none.
- **The two reads need no transaction.** Applying a row the state already holds changes
  nothing, so a store that lands between them does no harm.
- **A null `last_update_id` applies the whole log.** It is null on a doc just created, whose
  log is one row, and on a row no store pass has written since the column was added. That is
  correct, and costs the log's length.

**Not a replay of the log alone.** `materializeYdocAt` starts from the newest `ydoc_snapshot`
or from row #1, so every read of "now" would cost the doc's history and not the seconds since
its last store. And a row that fails to append is logged and dropped (`appendUpdate`), while
the stored row still holds its text: a replay would show less than the doc's own page does.
In that case the state holds more than a replay to its version, as `loadDocState`'s does.

**`loadDocState` stays as it is**, the stored row alone, which is what MCP reads (MCP.md §6).

### Its own route

**The diff is a route of its own, not a child of `/side-by-side/[left]/[right]`**, where the
`wiki` branch put it. Side-by-side is the doc-link surface (PLAN.md §14): two live columns,
each a `Y.Doc` on a socket of its own (docs/YDOC.md's exception to one socket per page), with
read and write modes, IndexedDB while writing, and the doc-link groups, highlights, popovers
and counts that are most of `src/components/sidebyside/`. Its only way in is `/link/[id]`, for
an anchored link across two docs. A diff needs none of it, and the parts of the page that look
shareable each answer a question of side-by-side's:

- **Its sides are a doc's id or slug** (`resolveDocParam`), with no old-slug redirect, and take
  no version. A diff's sides are ids with an optional `@<update id>`. As a child route, the two
  grammars would share the same segments, so a URL that works for one would 404 for the other:
  a slug on side-by-side but not on its diff, `x@1` on the diff but not on side-by-side.
- **It refuses the same doc on both sides**, because two live columns on one doc would put two
  providers for one document name on a socket, or two `Y.Doc`s on one IndexedDB database. A
  diff of one doc at two versions is half of what a diff is for.
- **Its bodies come from `prose_json`**, with a decode of the `ydoc` row when that is still
  null, copied from `/doc/[slug]`. That is right for a live column's first paint, which the tap
  then replaces, and wrong for a diff, whose "now" must be the state a fork records
  (`loadDocStateNow`).
- **Its layout is a flex-height chain** of two columns that scroll on their own. A diff's rows
  line up across its two sides and scroll as one page.

What the two do share is the shared kit's, not side-by-side's: `gated` and `titleWhenOk` from
`src/lib/route-access.ts`, and the rule that a pair with an unreadable side is forbidden whole.
No layout, loading, error or not-found file sits in side-by-side's segments today, so nesting
would have inherited no code yet; it would have inherited whatever side-by-side adds there next.
A static `diff` folder at the top of `src/app/` takes precedence over the `[year]` catch-all,
and no reserved-slug list needs it, since nothing slugged lives at the top level.

### No collab connection

**The diff page opens no socket and is never recomputed while it is open.** A diff that followed
live edits would rerun the alignment and every word diff on each incoming update, with a
reader's rows shifting under them while someone types. A side named by a version never changes,
so a diff of two versions is final. A side with no version is the doc as it was when the page
loaded, and its header says so: "when this page loaded" and the time. Reloading the page brings
it up to date.

### Who may see one

**The pair gate, `loadDiffPair`, is the route's own**, built from the same kit as
side-by-side's `loadPairForRead`, which refuses one doc on both sides and resolves a slug as
well as an id. In order:

1. both sides parse, or the page is a 404;
2. each doc is read by id through `prismaIncludingDeleted`, and a deleted one is a 404, by
   hand, since `canUserReadDoc` doesn't consider deletion;
3. **if either side is unreadable, so is the page**: Forbidden, as side-by-side answers, and
   the title answers the same way rather than naming half a pair;
4. **a version needs `canUserSeeDocVersion`, checked before the version itself** ("Who may see
   a doc's history"). A reader it refuses gets Forbidden, whatever the id;
5. **then a version that isn't in its doc's log is a 404** (`isDocVersion`), never quietly
   replaced by "now". In the other order, Forbidden against 404 would tell a reader without the
   history which ids are in the log. MCP's anchoring tells an agent that already ("Who may see
   a doc's history"); the diff is not a second way to ask.

**A side the server can't read is said on the page, and is not a 500.** `loadDocStateAt` throws
while the store is unavailable, and either read throws on a ydoc the doc schema can't decode.
The page catches both, once the gate has passed. It keeps the header of a side it could read.
Under the other doc's current title it says "Couldn't read this doc's text", with a link to
reload, and it shows no rows.

A COMMENTER gets no diffs, since `canUserReadDoc` refuses them every doc, and someone signed
out is sent to sign in. PERMISSIONS.md has two rows per table: "Diff, as it is now" (read both
sides) and "Diff at a version" (see that doc's history, or the history of a fork of it made at
that version).

### What is compared

- **Top-level blocks and their text**, `DocState.blocks`, with entity chips as their labels
  (`docBlocks(node, labels)`). A label is not part of a version, so both sides show each chip
  with its label as it is now: a person renamed in between reads alike on both sides, and a
  chip swapped for another with the same label is no change. The style a label is written in
  is each side's own, since it is in the ydoc (`chipStylesOf`). So a doc whose mentions went
  from names to initials between two versions shows every one of them as changed, which is
  how the two texts read.
- **Only the body, never the title.** Two versions that differ in their title alone read "No
  differences". Each header gives its side's title as of that side, so a changed title shows
  there and nowhere in the rows.
- **Text runs only.** Bold, a link's target, or a paragraph becoming a heading with the same
  text is not shown as a change. A heading is styled as one on each side.
- **A table, a list or a code block is one block**, its text joined, so one cell changed is
  one changed pair, diffed word by word over the whole table's text. `blockText` puts a line
  break between a container's children, and a row keeps those breaks (`white-space: pre-wrap`),
  so a list's items and a table's cells stay on lines of their own.
- **An empty paragraph added or deleted is left out.** StarterKit's `TrailingNode`, on by
  default in TipTap 3, appends one the first time a doc ending in anything but a paragraph
  (a heading, a list, a table, a code block, a blockquote, a rule) is opened in the editor,
  credited to whoever opened it. "What the fork changed" would otherwise show it on a fork
  nobody had touched. Any other block without text, a horizontal rule, is still shown.
- **Unchanged stretches fold.** Unchanged blocks more than one block from a change become one
  "N unchanged blocks" row per stretch, unless the stretch is a single block.
- **Each side's header** gives its title as of that side, then "as it was at" a `LocalTime`
  for a version, or "when this page loaded" and the time for no version ("No collab
  connection"), and links to the doc: at `/doc/<slug>?at=<id>` for a version the viewer may see
  the doc's history at, since only then does its reading view honour `?at=`, and as it is now
  otherwise, which is a fork point shown by the exception. A "Swap sides" link reverses the
  pair, and a pair with no change says "No differences". What a header says of its side's
  order is under "Which side is later".

`src/lib/doc-diff.ts` holds the rows, pure, with a unit test: `diffRows(oldBlocks, newBlocks, opts)`
and `hasChanges`. It imports the engine alone, since it runs in a worker ("Where the comparing
is done").

### Which side is later

**The page says which side is later when the pair has an order.** A reader takes "removed" and
"added" as what happened over time, and with the later side on the left they mean the
opposite.

- **The same doc on both sides has an order**: the lower update id is the earlier, and a side
  with no version is later than any version. Two sides at one version have none, and the page
  says "No differences".
- **A fork and its parent at or before the fork point have one**: the parent's side is the
  earlier, whichever version the fork is at. A parent's side with no version stands at the
  update it was read at as the page loaded, so a parent nobody has changed since the fork is
  at its fork point.
- **No other pair has one**: two unrelated docs, or a fork and its parent past the fork point,
  where each has changed since. A chain through a grandparent isn't followed. It can pass
  through a doc the viewer can't read, and a label would tell them the two sides are related
  through it.

`sideOrder(left, right, lineage)` in `src/lib/diff-side.ts` answers it, pure, with a unit
table: the left is the earlier, the right is, or the pair has no order. The lineage
(`PairLineage`) is which of the pair's two docs was forked from the other, the fork point, and
the update the parent is at now. The page reads it off the two docs' rows once the gate has
passed both, so it names nothing the viewer can't read. `pastForkPoint` beside it answers
whether a parent's side is past the fork point.

**How the page shows it:**

- **Each header carries "Earlier" or "Later"** beside its time when the pair has an order, and
  nothing when it has none, so that "in order" and "no order" look different.
- **With the later side on the left, a line above the rows says so**: "The later version is on
  the left, so text marked removed was added since, and text marked added was removed," with
  "Swap sides" beside it.
- **Rows keep their colours and wording whatever the order.** Removed is always what the left
  has and the right lacks, so a swapped pair shows the same rows mirrored.

**How a fork and its parent are shown is not decided, and is decided by trying it.** What is
built to be tried: the labels above for a fork against its parent at or before the fork point,
and, for a fork and its parent past the fork point, a line above the rows, "Both sides have
changed since the fork was made," so that the diff isn't read as what the fork changed. Two
things the choice should weigh:

- **A fork keeps its parent's title**, so the two headers read alike, and nothing in them says
  which side is the fork.
- **The line shows whenever the parent's side is past the fork point**, also when the fork has
  not been edited, where it is untrue. Telling the two apart needs the fork's first update,
  one more query.

Nothing more is built on the headers for a fork, and no spec covers them, until Luke has
chosen. What he chooses replaces this paragraph.

### Where the comparing is done

**The server decides who may see a diff and reads its two sides; the reader's browser compares
them.** The alignment and the word diffs build tables that grow with the square of what they
compare ("The engine's size guards"). An instance has one vCPU and 2 GB, and its web process
serves every request from one event loop, which the engine holds until it is done. A diff of
two docs as they are now is any reader's to ask for. So the server does the work that grows
with a doc's length, and the work that grows with its square costs the reader who asked.

- **The page is a Server Component** (`src/app/diff/[left]/[right]/page.tsx`). It runs
  `loadDiffPair`, loads each side's state, renders the two headers, and hands each side's
  blocks to a client island, `DocDiff` (`src/components/DocDiff.tsx`), as `DiffBlock[]`: a
  block's text, its node type and whether it is a heading.
- **The browser is sent nothing its reader couldn't already read.** The gate has passed both
  sides whole by then. A block's text arrives with its chips' labels in it, computed on the
  server as `DocState.blocks` has them, so the browser loads no chip context.
- **The island starts a worker** (`src/lib/doc-diff.worker.ts`), which calls `diffRows` once
  and posts the rows back. In a worker and not on the page's own thread, since the engine
  doesn't yield: the page scrolls while it runs, and leaving the page ends it. Until the rows
  arrive, the page shows its headers and "Comparing…". The island marks itself done, which is
  what a spec waits on.
- **Every diff is compared there, a small one too.** Comparing small ones on the server would
  save them the wait, and leave two places for `diffRows` to run and their rows to be kept
  alike.
- **A worker that can't start, or throws, leaves a line in place of the rows**, with a link to
  reload. `diffRows` is not run on the page's thread instead.

**A deadline bounds the time, and the engine's caps bound the memory.** `diffRows` takes a
deadline and a clock, the clock passed in so that the function stays pure and its unit test
sets the time. It checks between changed pairs. Past the deadline (`DIFF_DEADLINE_MS`, a first
guess of three seconds), each remaining changed pair is not diffed: it stays one `changed` row
with its two blocks side by side, the old one marked removed whole and the new one added whole
(`whole`). A note row above the first of them says where: "From here on, changed blocks are
shown whole: this diff was taking too long to show word by word." A deadline means the same on a phone as on a desktop,
which a count of cells doesn't. It can't interrupt the alignment, which is one call, so the
alignment's cap bounds that. The page needs no total over its word diffs: each pair's table is
capped and dropped before the next is built.

**A cap that bites is said on the page too.** Past a cap a read shows less detail ("The
engine's size guards"), and nothing in the rows tells that from a real rewrite. A list is one
block, so an edit near its top and another near its bottom, with about a thousand words
between them, come back as everything between them removed and added. So the engine's three
functions take an optional `onCap` when they read, called with the cap's name when one bites,
and `diffRows` passes it:

- **a row whose word diff was capped** stays one `changed` row (`capped`), under a note row
  that says "Too long to compare word by word: everything between its first change and its
  last is shown whole";
- **a diff whose alignment or pairing was capped** says above its rows that some blocks are
  shown removed and added without being matched to each other.

`since` passes none, and reads as it does now.

**The worker imports the engine and nothing else.** `src/lib/diff.ts` holds `diffText` beside
`extractText`, whose chip helpers reach the chip registry and both kinds with it. So
`diffText` and its tokenizers move to `src/lib/diff-text.ts`, which imports nothing, and
`diff.ts` exports them again for its callers. The worker's bundle is then `doc-diff.ts`,
`block-align.ts` and `diff-text.ts`.

**It is the first worker the repo makes itself**; the PDF viewer's is pdfjs's own. A
production build serves it to Chromium, to Firefox and to Playwright's WebKit build, where it
answers. A real Safari has not been tried (TODO.md, "The diff page's worker has not run in a
real Safari").

### The engine's size guards

**Built.** The engine is `since`'s: `alignBlocks` pairs the blocks, identical ones
anchoring a longest common subsequence and changed ones between them paired by how alike their
words are, and `diffRuns` diffs each pair word by word (MCP.md §6). Each builds a table that
grows with the square of what it compares: unbounded, one cell edited in a 400×5 table would
build a ~2 GB word-diff table through `since`, on a server with 2 GB. The diff page adds no
caller on the server, but its worker runs the same code in a reader's tab, with the
alignment's worst case among its inputs: two docs written apart share few identical blocks to
anchor on, often only empty paragraphs. So the engine bounds every caller, the worker
included, as MCP.md §6's "Size guards" sets out:

- **Three changes answer the same, more cheaply**: `pairGap` counts each block's words once,
  the alignment's table is a `Uint16Array`, and a code block, which takes no marks, is merged
  by taking the new block whole. Its old block's mentions are still checked for coming back
  as plain words (`chip_as_text`), which needs no diff.
- **Three caps change the answer when they bite**: the word diff at 4M cells after trimming a
  pair's shared ends, the alignment at 25M cells, and pairing at 1M pairs summed over every
  gap.
- **A read past a cap shows less detail; an edit past one is refused** and writes nothing
  (`TooLargeToMerge`), since merging with less detail would lose marks. The Yjs write-back
  never refuses, since a throw would leave its transaction half written. A PDF sheet's diff,
  which carries a file's notes to its next version, refuses as an edit does, since a carry
  writes anchors (PDF.md §13, "Placing each anchor").

**The caps are the engine's constants, and the worker runs them as the server does.** They
are first guesses from development machines, and TODO.md's "The diff engine's size guards are
first guesses" lists what tuning them takes: among it a total over a request's word diffs, for
`since`, the deadline's length, and the engine's time and memory on the oldest phone the
baseline claims, which has less memory than a server.

**A version costs one replay on the server**, the one `since` already pays:
`materializeYdocAt` starts from the newest `ydoc_snapshot` at or before it, or from row #1. A
versioned side is rebuilt there even when the reader's scrub bar holds the same replay. A
pasted URL has no bar behind it, and a fork point shown by the exception is in a log its
viewer may not fetch. A side at a fork point is replayed like any other version, since a fork
leaves no snapshot on its parent ("The function").

### Choosing two versions on the scrub bar

**The scrub bar has a pin, two links and a note** once its history has loaded (`LoadedScrubBar`,
`src/components/DocScrubBar.tsx`). So they are for whoever may see the doc's history, the only
viewers it mounts for:

- **"Diff with now"**, while the slider is off the live end: `/diff/<doc>@<here>/<doc>`.
- **"Pin this version"**, whenever the slider is not on the pin, keeps the slider's position
  as the reader scrubs on, shown as a tick on the track and a line naming it ("Pinned: update
  12 of 40, <time> · Unpin"). Pinning again moves the pin.
- **"Diff pinned → here"**, once the slider is off the pin, with the older of the two on the
  left whichever was pinned. Either may be the live end, a side with no `@`, which in the diff
  means the doc as it is when the diff loads, not the head the bar loaded.

Both links are built with `diffPath` (`src/lib/diff-side.ts`).

**The pin is the tab's, not the URL's.** `?at=` stays one position, under
`src/lib/scrub-url.ts`'s rules unchanged, and a URL naming two positions is the diff's own. The
position line and the pinned line are formatted in the browser from fetched data, which the
hydration rule allows (CLAUDE.md, "Never call `toLocaleString()`").

**The links are plain `<a>`s, and Back returns to the bar at its `?at=`, unpinned.** A
`<Link>` would not get there: Next's router keeps the page it rendered for the address the
reader arrived at, and `?at=` is written with `replaceState` afterwards, so Back from a client
navigation restores a page whose bar never loaded, under a URL that names a position. A click
on either link writes `?at=` first, since the URL trails the slider by its debounce and
leaving the page drops a write still waiting.

**The bar says when changes have come in, and does nothing more live.** Its history is the
replay it fetched (`/api/doc/[id]/replay`), while the reading view's tap goes on receiving
updates, so the slider's last position stands for the doc as it was when the history loaded.
Once the tap reports a change after that, the bar says "Changes have come in since this
history loaded; reload to include them." Nothing is replayed or diffed again. The tap reports
through `useLiveDocContent`'s `onLiveUpdate`, which is called for each Yjs update it applies
once it has synced, frozen or not, and never for its own handshake, which applies an update as
a real edit does (DOCS.md, "The reading view"). `DocView` hands the bar those reports as a
subscription, not as state, so a remote keystroke re-renders nothing but the bar, once. The
note is the one live part of this page, and it can be left out without changing anything
else.

### From side-by-side

**`/side-by-side/<a>/<b>` has a "Diff" link** to `/diff/<a's id>/<b's id>`, rendered by its
page above `SideBySideView`, so no side-by-side component knows of it. Its gate already demands
both docs be readable, which is all the diff of two "now" sides asks.

### Planned: sliders on the diff page

**A side whose history the viewer may see gets a slider under its header**, and the rows follow
it. The scrub bar's pin chooses two versions before any diff is shown; a slider changes one
while the diff is on the page, which is how a reader finds the version a paragraph came in at.
Both stay: the pin and its links are how a reader gets here from a doc, and the sliders are
what they do once here.

- **Who gets one is `canUserSeeDocHistory`, per side**, which `loadDiffPair` already asks for a
  side at a version, and here asks for a side with none too. A side that fails it keeps its
  header and has no slider. A parent a fork's editor sees through the fork-point exception has
  none: the exception is one version.
- **One slider a side, for one doc at two versions too.** A single track with two thumbs suits
  that case alone, and two docs have two histories. The sliders may cross: the headers' "Earlier"
  and "Later" and the line above the rows already follow the order ("Which side is later").
- **A side's history is the replay the doc page's bar fetches** (`/api/doc/[id]/replay`), walked
  with `useReplayScrub`, and fetched when its slider is first used, so that opening a diff
  costs what it does without them. The same doc on both sides is fetched once.
- **A moved side's blocks are built in the browser**, on the page's thread, from the replayed
  state: `docBlocks` over its node with its chips' labels, which is what `DocState.blocks` is
  on the server. The labels come through `useChipInputs`, as the reading view's do. The worker
  is still sent `DiffBlock[]` and still imports the engine alone.
- **Each move starts the worker again** and ends the one before it, after a short debounce. The
  deadline and the caps apply to each run as they do to the first.
- **The address follows the sliders** once they settle, written with `replaceState` as `?at=`
  is, so that the diff on the page is the diff its address names. A slider at the live end
  writes a side with no `@`, which is the doc as it was when its history was fetched.
- **Still no collab connection.** A side's last position is the head its replay held, and
  nothing arrives after it.

**The cost is a second way to turn a version into blocks**, and it is the reason this is a
change to the page's loading and not only to its header. The server builds a side's blocks
when the address is loaded; the browser builds them when a slider moves. If the two differ, the
diff a reader slid to is not the one its address shows on reload. So the block-building step is
one function both call, and a test compares the two paths' blocks for a doc with entity chips
at several versions.

**The replay is the whole log**, every update's bytes, for each side with a slider that is
used, which is what the doc page's bar downloads too. A reader who never touches a slider
downloads none of it.

## Forks

### What a fork is

**A fork is a new doc seeded from another doc's text at one version**, recording the doc and
the version it came from. The version is the latest, or the one the reader is looking at on
the parent's scrub bar. A doc has at most one parent, and lineage comes only from forking: it is
never declared afterwards, nor edited. So there are no merges and no cycles, and "what the fork
changed" can rely on the fork having begun as that exact copy.

### Who may fork

- **Anyone who may create a doc (`canManageDocs`) and can read the parent.** So an AUTHOR may
  fork a `SHARED` doc they can read but not edit, which is the point. An AUTHORIZED reader,
  who creates nothing, may not. Nobody forks a `PRIVATE` doc they aren't on, an ADMIN included
  (CLAUDE.md, "A `PRIVATE` doc is its listed `DocAuthor`s' alone").
- **Forking at a version needs the parent's history (`canUserSeeDocHistory`), and then
  `isDocVersion`**, in that order, as for a diff: otherwise the fork would copy out text from a
  history its forker may never have been shown. The id is parsed with `parseUpdateId`.
  `loadDocStateAt` replays up to any id without asking whether it is one of this doc's, so an
  unchecked one would record a fork point that isn't the parent's version, and "what the parent
  changed since" would 404. A reader without the history is refused as Forbidden whatever the
  id; for one with it, an id outside the grammar or the parent's log is refused as invalid.
- **A parent the forker can't read is Forbidden, and one that is missing or deleted is not
  found**, the two answers the doc's own page and the diff's gate give. Whoever gets as far as
  this check may create docs, and to them the difference is useful: Forbidden says the doc is
  there and to ask its authors. `canManageDocs` is checked before the parent is looked up, so
  an actor who may not fork is told that and nothing about the parent. Deletion is checked by
  hand, as side-by-side checks it, since `canUserReadDoc` doesn't consider it. An MCP tool
  would reach `forkDoc` through its own resolver, which answers an unreadable doc as missing.
- **The visibility asked for is checked to be `PRIVATE` or `SHARED`, by name**, in `forkDoc`,
  before anything is read, and anything else is refused as invalid, as `setDocVisibility`
  checks it (`src/lib/doc-manage.ts`). A server action is sent whatever its caller likes,
  whatever its parameter's type says. By name and not by membership of `DocVisibility`: the
  wiki adds `PUBLIC` to that enum, and who may make a doc public is a rule of its own, which a
  membership test would let a fork walk past the day the value exists.
- **`parentId` is checked to be a string, and `revision` a string or null**, for the same
  reason.
- **A parent with no log is refused**, saying so. `loadDocStateNow`'s version is null for one,
  after a failed eager `createIfAbsent` or a legacy import, and the fork point is required.
- **A fork's visibility is its own, with no cap from its parent's**, as decided for the wiki. A
  cap would only send people to copy and paste, which loses the credit a fork keeps. A fork of
  a `SHARED` doc may be `PRIVATE`, and a fork of a `PRIVATE` doc, which only its byline can
  make, may be `SHARED`.

PERMISSIONS.md has two rows per table: "Fork, as it is now" and "Fork at a version".

### What it takes, and what stays

| | The fork |
|---|---|
| Body | The parent's at the version, `authorHighlight` marks kept, so inherited text still shows who wrote it; `annotation` marks removed |
| Title | The parent's, seeded as plain text, as a seeded title always is; the slug comes from it (`my-essay-2`) |
| Entity chips | Carried, and so are the parent's chip styles at the version (`Y.Map("settings")`), written into the seed with `setChipStyle` and into the row's `chip_styles`, so the labels read as the parent's did. A style for a chip kind this build doesn't know is not carried, since `setChipStyle` refuses one |
| Byline, creator | The forker alone |
| Visibility | Chosen in the dialog, `PRIVATE` by default |
| Replay | Starts at the fork: row #1 is the seed, credited to the forker through the `clients` map |
| `record`, `importKey`, `importedUpdateId` | Not carried. A fork is for changing, and an importer must never match its source to the copy |
| Annotations, tags, anchored links in and out, doc links, posts | Stay with the parent |

**The `annotation` strip is the only guard against copying them.** `createDocWithContent`
seeds through `docContentExtensions`, which has the `annotation` mark, so a forgotten strip
would be accepted. An editor-made annotation is a mark whose `id` is one of the parent's
annotation rows, so a copied one would light up the parent's notes in the fork's editor, on
rows that resolve against another doc. `forkSeed`'s unit test is what holds the strip.

**Who wrote the inherited text is not kept back.** A fork's readers see the parent's authors in
its author colours even when the parent is `PRIVATE`, as the wiki decided: the words shown are
theirs.

### The function

**Forking is a function in `src/lib/` taking an `Actor`**, `src/lib/doc-fork.ts`, wrapped by a
server action in `src/app/actions/docs.ts` (CLAUDE.md, "A write the UI and the MCP server share
is a function in `src/lib/` taking an `Actor`"). It is cut in three so the wiki can reuse the
first two:

- **`readForkSource(actor, parentId, revision)`**: the checks above, in their order, then the
  read, `loadDocStateNow` for the latest or `loadDocStateAt` for a version. It returns the
  parent's row, its `DocState`, and the version, which becomes the fork point.
- **`forkSeed(state)`**, pure, in `src/lib/fork-seed.ts` with its unit test: the body with its
  `annotation` marks removed (`stripMarksFromDoc`), the title, and the chip styles.
- **`forkDoc(actor, { parentId, revision, visibility })`**: the visibility's check,
  `readForkSource`, `forkSeed`, then `createDocWithContent`. It returns the fork's id and its
  editor's path, to which the action redirects.

Each refusal is an `ApiError`. The action, `forkDocAction`, hands the form's fields over as
they were sent, shows a refusal in the dialog, and lets anything else be a fault.

**A fork writes nothing to its parent.** It could leave a `ydoc_snapshot` of the parent at the
fork point (`ensureYdocSnapshotAt`, the call publishing a post makes), so that "what the parent
changed since", and a later fork at the same point, would start there and not at row #1. It
doesn't. The row would be the parent's, written for someone who may not be able to edit the
parent, and the parent would pay for it:

- **Both replay routes send every snapshot's bytes whole** on each load of a scrub bar
  (`/api/doc/[id]/replay`), so each distinct fork point would add one copy of the doc to that
  payload for good.
- **`findNewestSnapshotCoveredBy` reads every snapshot's state vector**, and was written for a
  handful per doc.
- **The fork would pay a replay of the parent**, which `loadDocStateNow` spares a fork of the
  latest.
- **A `PRIVATE` fork would leave a dated dot** on the parent's `/post/[id]/edit` scrub bar, for
  the parent's editors to see.
- **Nothing is unique on a snapshot's doc and mark**, so two forks at once would write two.

What it would save is small where it has been measured: replaying the longest doc log in a
copy of a production database, 1,270 updates, takes about 10 ms on a development machine.
TODO.md's "A snapshot at a fork point" says when to look again: when a replay of a parent,
timed on an instance, takes long enough to notice. It also keeps the one rule such a snapshot
must follow. It is built by replaying the log to the fork point, never from
the state the seed came from, which for a fork of the latest can hold more than a replay to
its version ("A doc as it is now"): a snapshot holding that extra text would hand it to every
replay that starts there and to none that starts earlier.

**`createDocWithContent` (`src/lib/doc-create.ts`) takes three options for a fork**, each
written in its one transaction, from named fields (`npm run check:prisma-data`):

- `visibility`, written with the row, `PRIVATE` when absent, as now;
- `forkedFrom: { docId, updateId }`;
- `chipStyles`, written into the seed's settings map before it is encoded, and so into the
  row's `chip_styles` beside `prose_json`: `docCacheFromYdoc` returns the styles it labelled
  the body under, and the create writes both. A fork nobody has edited has had no store to
  fill the column. With it null, the reading view's static body would label the fork's chips
  in the default style, and a label refresh would write `prose_json` in it (CLAUDE.md, "An
  entity chip's label is computed").

**A duplicate slug is recognised from the driver adapter's error.** Prisma 7.9's adapter builds
a P2002 with no `meta.target`, so `isSlugTaken` reads the columns from the adapter's `fields`
(`isUniqueViolationOn`, `src/lib/unique-violation.ts`, with its unit test). Reading
`meta.target` alone, two docs created at once with one title, two forks of one doc or two
imports, would end in a 500 rather than the `-2` retry, a race forks make likelier.

### The doc view: an Actions menu and the Fork dialog

**"Publish as blog post" is an item of an "Actions" menu** on the byline line, beside the
doc's posts (`src/components/DocActionsMenu.tsx`):

- **Publish as blog post**, for an editor of a doc with no post, as the button is now;
- **Fork…**, for any reader with `canManageDocs`, readers who can't edit included.

The menu is a client island beside `DocPostsLine`, a Server Component gated on `canEdit` that
shows once the doc has a post. The menu shows to anyone who may do one of its items, and to
nobody else. It is a `<details>`, as the header's tool menus are, and its dialog
(`src/components/ForkDialog.tsx`) is a native `<dialog>` outside it, since a modal inside a
closed `<details>` isn't rendered. It only keeps from offering what would be refused; the
server decides.

**The Fork dialog says what it will copy**, "as it is now", or "as it was at" a time when the
reader has scrubbed back, and asks for a visibility, `PRIVATE` by default. Fork takes the
reader to the fork's editor.

**It reads the version from the scrub bar, not from the URL.** `LoadedScrubBar` registers a
getter in `DocScrubContext` (`useRegisterDocScrubPosition`), beside the seek function it
registers there. Called, it answers with the slider's position: the update's id and its time,
or null at the live end. The menu calls it (`useDocScrubPosition`) as the dialog opens.
**The position is never the provider's state.** The getter reads a ref the bar keeps, the
provider keeps the registered getter in a ref of its own, and neither identity changes as the
slider moves, since a state update in that provider re-renders the doc view, the notes and
the rail, and a drag would make one per tick (`useRegisterDocScrubSeek`'s note). `?at=` would
not serve:

- it holds an id and no time, and the time is in the bar's replay alone;
- it trails the slider by `SCRUB_URL_DEBOUNCE_MS`;
- it can name an id the bar never went to, another doc's, which leaves the reader on the live
  text while the URL still says otherwise.

A page with no bar, or one whose bar hasn't loaded its history, has no getter registered. The
reader is on the live text in both cases, and the dialog offers the doc as it is now.

### A doc's family

**A fork says it is one, and a forked doc lists its forks**, under the byline in the doc view
(`src/lib/doc-family.ts`, `src/components/DocFamily.tsx`, handed to `DocView` as its `family`
prop):

- **Forked from:** the parent, linked as it is now, and when the fork was made. It isn't
  linked at the fork point (`?at=`), which only a view with the parent's history honours; the
  fork point is in the diffs instead.
- **Forks:** docs whose `forked_from_doc_id` is this one, newest first, at most 20, saying when
  there are more without counting them.

**Only what the viewer can read is named.** A parent the viewer can't read, deleted or another
byline's `PRIVATE` doc, isn't named or linked, but the line stays: "Forked from a doc you can't
read". Left out, a `SHARED` fork of a `PRIVATE` doc would pass its parent's text off as its
forker's. The forks list names readable forks only and gives no count of the rest. Each query
goes through `readableDocsWhere` and spells out `deletedByUserId: null`, since a relation filter
goes around the soft-delete extension. A fork whose parent was hard-deleted, which only
fixtures and scripts do, has no line at all: its `forked_from_doc_id` is null.

**Each entry links to the diffs between it and this doc that the viewer may see**, labelled
"(diff: parent vs. fork, parent, fork)" in both directions. Whose history the viewer may see
is asked once for the docs listed, through `docsWithVisibleHistoryWhere`, not row by row. The
docs are `<Link>`s and the diffs plain `<a>`s, for the scrub bar's reason ("Choosing two
versions on the scrub bar"):

| Diff | URL | For |
|---|---|---|
| what the fork changed | `/diff/<fork>@<its first update>/<fork>` | whoever may see the fork's history |
| how they differ now | `/diff/<parent>/<fork>` | readers of both |
| what the parent changed since | `/diff/<parent>@<forked_from_update_id>/<parent>` | whoever may see the parent's history, or the fork's ("Who may see a doc's history"), and can read the parent |

**What the fork changed is read off the fork alone.** Its first update is its seed, the parent
at the fork point minus annotation marks, which a diff of text never sees. So it needs no
replay of the parent, and survives the parent's deletion. The first update is the least id in
the fork's log, found for every fork listed in one `groupBy`, which `ydoc_update`'s index on
`(ydoc_id, id)` answers. It isn't `prose_json_update_id`, which moves on at every store.

### Data model

**One migration, `doc_forks`**: Prisma's own SQL for the columns and the foreign key, from
`prisma migrate dev --create-only`, with the CHECK and the index appended by hand.

```sql
-- Prisma's columns and foreign key, then
-- Hand-written below this line

ALTER TABLE "doc" ADD CONSTRAINT "doc_fork_at_revision"
  CHECK ("forked_from_doc_id" IS NULL OR "forked_from_update_id" IS NOT NULL);
CREATE INDEX "doc_forked_from_idx" ON "doc" ("forked_from_doc_id")
  WHERE "forked_from_doc_id" IS NOT NULL;
```

- **Prisma:** `Doc.forkedFromDocId` (`forked_from_doc_id`), `Doc.forkedFromUpdateId`
  (`forked_from_update_id`, a `BigInt`), and the self-relation `forkedFrom`/`forks`
  (`"DocFork"`), `onDelete: SetNull`. A hard-deleted parent, which only fixtures and scripts
  make, leaves the update id behind as harmless residue; a soft-deleted parent keeps its link.
- **`forked_from_update_id` has no foreign key**, like every `ydoc_update` id column in the
  schema. The log is never truncated, so the id names a row of the parent's log for as long as
  the parent exists.
- **Prisma writes the foreign key**, since a hand-written `REFERENCES` gets Postgres's
  `ON UPDATE NO ACTION` where every foreign key in the repo is Prisma's `ON UPDATE CASCADE`, and
  the next `migrate dev` would change it. Below the line goes only what Prisma has no syntax
  for here: the CHECK, and a partial index, with the `partialIndexes` preview off. Prisma leaves
  hand-written partial indexes out of what it introspects, so they never drift.
- `npx prisma format`, then `npm run check:schema`, and `npx prisma generate`.

### Rules elsewhere that a fork meets

- **No `SCHEMA_VERSION` bump.** A fork adds no node, mark or attribute to any ydoc's schema.
- **Search finds a fork beside its parent**, with the same text, and doesn't merge them.
- **Mentions and citations:** a fork's chips get rows of their own from the `mention` and
  `citation` triggers, first seen at the fork. Nothing reads that outbox yet. When
  notifications are built, a fork's inherited mentions should not count as new, as
  MENTIONS.md's "The notification stub" says.
- **`/docs`** has no fork column in v1. One later goes through the table kit.
- **MCP:** `forkDoc` takes an `Actor`, so a tool is a wrapper. Deferred, with
  `multiblog_read` naming a doc's parent and reading a diff's URL.

## Before forks reach an instance

**`scripts/integrity/check-ydoc-integrity.ts` runs on it first.** Its blob-vs-log check flags a
doc whose stored blob holds an update its log lacks: one acknowledged and then not appended.
The `ydoc-appends-kept` branch's plan (its docs/YDOC.md, "Planned: appends that are kept until
they land") stops new gaps from opening, and repairs none. A fork of the latest copies the
blob's text with the log's later rows applied, and records the log's last row as its fork
point (`loadDocStateNow`). A replay of the parent to that point lacks the missing update, so
"what the parent changed since" would show it as a change made after the fork, for every fork
of that doc, for good. A diff at a version meets the same gap less lastingly: the missing
update shows as a change made after the left side's version, until the doc is repaired.

**So a flagged doc is repaired first, by appending what its blob holds beyond its log's replay
as one update**, which keeps text its writers saw saved. The script's closing note offers the
other direction, rewriting the blob from the log, which would drop that text. Nothing does
either yet, so the check runs on each instance well before forks deploy there: if it flags
nothing, nothing more is needed, and if it flags a doc, the repair is written as a script of
its own before forks go out.

## Build order

**Four PRs, one at a time**, each branched from main once the last has merged.

1. **The engine's size guards — built.** `b6126e5` ported. MCP.md §6 has "Size guards", and
   TODO.md the entry on tuning them. The branch's unit tests came with it:
   `block-align.test.ts`'s comparison with the alignment from before on a seeded random table,
   `diff.test.ts`, and `doc-edit.test.ts`'s refusals. Two things main has and the branch
   didn't are covered beside them: a code block's merge keeps the `chip_as_text` check
   (`entity-chips/edit.test.ts`), and a PDF sheet's diff refuses past the word diff's cap
   (`pdf-quote-carry.test.ts`, PDF.md §13). No UI and no migration.
2. **Diffs — built.** `canUserSeeDocHistory`, its filter form and `canUserSeeDocVersion`, with
   the replay route, the doc page and `since` on the first; `canUserSeeDocVersion` is the
   predicate alone until forks exist. `diff-text.ts` apart from `diff.ts`; the engine's
   `onCap`; `diff-side.ts` and `doc-diff.ts` with their unit tests, a capped pair's row among
   them; the worker; `loadDocStateNow`; the route, its gate and `DocDiff`; the scrub bar's pin,
   links and note; side-by-side's link.
   PERMISSIONS.md has the diff rows, and its "Replay history" rows name the predicate; DOCS.md's
   "The reading view" has the scrub bar's links; TODO.md has "Who may see a doc's history",
   "`?at=` is ignored for a reader without the scrub bar, and says nothing" and the worker's
   untried Safari, and its size-guards entry the deadline and the phone. "Mistakes that fail
   no check" has the history's three, and CLAUDE.md the line that points there (below).
   `e2e/doc-diff.spec.ts`. No migration.
3. **Forks — built.** The duplicate-slug fix; the `doc_forks` migration; `doc-fork.ts`, and
   `fork-seed.ts` with its unit test; `createDocWithContent`'s options; the scrub bar's
   position getter; the Actions menu and the Fork dialog; the family lines with their diff
   links; `sideOrder`'s fork cases, with how the page shows them still to choose ("Which side
   is later"); and the fork-point exception in `canUserSeeDocVersion`.
   PERMISSIONS.md has the fork rows; TODO.md has "A snapshot at a fork point" ("The function");
   "Mistakes that fail no check" has the strip and the exception's reach (below);
   `e2e/doc-fork.spec.ts`. One migration.
4. **Sliders on the diff page** ("Planned: sliders on the diff page"). It needs item 2 alone.
   The shared block-building function and its parity test
   first; then the sliders, the worker's restart and the address. DOCS.md and this file's
   "Diffs" gain it as built; `e2e/doc-diff.spec.ts` gains a slid side's rows and the address
   it leaves. No migration.

**Each PR deploys once it merges**, so the feature reaches an instance in four steps, and the
diffs work there before forks do.

**CLAUDE.md holds one line for this file**, which names the code it applies to and points at
"Mistakes that fail no check" (TODO.md, "CLAUDE.md: move topic-only traps into their topic
doc"). The `annotation` strip in `forkSeed` is on that list and not in CLAUDE.md, whose line
carries a clause for code that seeds a doc from another doc's text.

**Testing** ports what `e2e/wiki.spec.ts` checks of forks and diffs, without addresses.
Diffs, in `e2e/doc-diff.spec.ts`: every check of rows waits for the island to mark itself done;
a foreign version and one past the bound are 404s, a version is Forbidden to a reader without
the history, whatever the id, a deleted side is a 404, the same doc on both sides is a 200, the
headers say Earlier and Later for a pair in order, the later-on-left line shows when it is
swapped, and neither shows for two unrelated docs; the scrub bar's links carry the right
sides, and Back from one returns to the bar at its position, unpinned; side-by-side's link
names its pair by id; a diff with now asked for while a socket is still typing has the
scrubbed-to version's text on the left and the later text on the right, and the bar says
changes have come in; and a doc ending in a heading, opened in the editor, gains the trailing
paragraph and the diff leaves it out. That last check is also made of a fork. Forks, in
`e2e/doc-fork.spec.ts`: the menu offers each item to whoever may do it, a reader forks the
latest through the dialog, an editor forks at the version the scrub bar is on, a reader's
version is refused, a deleted parent is not found and an unreadable one is Forbidden, a
visibility that is neither value is refused, two forks of one doc at once both succeed, the
parent has no more `ydoc_snapshot` rows after a fork than before it, annotation marks don't
follow, the chip style does and shows on the fork's reading view before any edit, "Forked from
a doc you can't read" stands in for a hidden parent, the forks list leaves out what the viewer
can't read, and each diff link shows to whom it should. The exception: a fork's editor who
can't edit its parent sees what the parent changed since, is still refused any other version
of the parent, its replay and a fork of it at a version, and loses it when the fork is
deleted. No spec covers how the diff page's headers show a fork against its parent, which is
not chosen ("Which side is later"); `diff-side.test.ts` holds which of those pairs have an
order. The diff
with now is typed over a socket: an edit through `/admin/doc-edit` stores as its connection
closes (Hocuspocus's `DirectConnection.disconnect`), and leaves no gap to test. Before each UI
commit, the specs it touches run with `npm run e2e:dev -- <spec>`; the full suite runs before
each PR.

## What the wiki adds later

The wiki's "Planned: wiki-style titles" asks for its history to be rebuilt onto `wiki-titles`,
off main. Built on this, the rebuild takes forks and diffs from main and adds only what an
address needs:

| On `wiki` | Here | What the wiki adds |
|---|---|---|
| `forked_from_*` columns in `wiki_pages`, with `doc_fork_is_wiki_at_revision` | `doc_forks`, with `doc_fork_at_revision` | Nothing to forks: its migration adds the address columns alone. The titles plan had already relaxed the CHECK to this one |
| `wiki-fork.ts`'s checks and read | `readForkSource`, `forkSeed` | The address: namespace, name and variant, claimed under its lock, through a `wiki` option of `createDocWithContent` |
| `createDocWithContent`'s `visibility`, `forkedFrom` and `seed: "keep"` | `visibility`, `forkedFrom`, `chipStyles` | `wiki`. No `seed` option is needed: main already seeds through a schema with the author mark and keeps the marks a body has |
| `diff-side.ts`, `doc-diff.ts`, the diff route at `/side-by-side/<a>/<b>/diff` | The same two files, the route at `/diff/<a>/<b>`, and the rows compared in a worker (`DocDiff`, `doc-diff.worker.ts`) | Sides linked at their wiki addresses (`wikiPathOfDoc`), an unreadable wiki doc answered as a missing one, and diffs for signed-out readers when those come |
| `wiki-family.ts`, `WikiBanner` | `doc-family.ts`, `DocFamily` | "Same name", the public render's wording, and `readableWikiDocsWhere` for `PUBLIC` pages |
| `DocActionsMenu` | Publish as blog post, Fork… | Move into the wiki…, Fork into the wiki… |
| `b6126e5`, `1425a6a` | Ported | Nothing |

**Both `b6126e5` and `1425a6a` are on main**, so the rebuild needs neither from the `wiki`
branch it replaces.

Its replay map shrinks to match: the size guards and the slug fix leave its prerequisites,
forking a doc as a doc is no longer deferred, and its fork, banner and diff steps keep only
their address halves. That edit belongs to the rebuild, not to this branch.

**Slot A's database already holds the wiki's fork columns**, from the `wiki_pages` migration
applied there, so `doc_forks` can't apply in slot A until that migration's objects are dropped,
which is the rebuild's own first step. Slot B's database has neither.

## Decisions

Carried over from the wiki:

- **No visibility cap on forks**, and who wrote the inherited text is not kept back.
- **A fork whose parent the reader can't read still says it is a fork**, without naming it.
- **A version is named in the diff's path**, as `<doc id>@<update id>`.
- **The size guards are a first, sensible set**: a read past a cap shows less detail, and an
  edit past one is refused.

Made here:

- **A doc's history is its editors', plus fork points for a fork's editors**, behind one
  predicate, until the permissions redesign ("Who may see a doc's history"). The wiki had no
  exception.
- **The diff is its own route, `/diff/<left>/<right>`**, sharing nothing with side-by-side but
  the route kit ("Its own route").
- **A diff is compared in the reader's browser, in a worker**; the server gates it and reads
  its sides ("Where the comparing is done"). The wiki rendered its diffs on the server.
- **A doc as it is now is its stored row with the log's later rows applied**, for a diff's
  side and for a fork of the latest, so neither trails a version the scrub bar has handed out
  ("A doc as it is now").
- **The diff page opens no collab connection**; the scrub bar's note that changes have come in
  is the one live part ("No collab connection").
- **Two ways to choose a diff's versions, and both are kept**: the scrub bar's pin on the doc,
  and sliders on the diff page ("Planned: sliders on the diff page").
- **A fork writes nothing to its parent**: no snapshot at the fork point, whose costs fall on
  the parent and whose saving is small where measured ("The function").
- **"Publish as blog post" moves into an Actions menu**, beside "Fork…", which the wiki later
  extends.

## Open

**One choice is open**: how the diff page shows a fork against its parent, built to be tried
("Which side is later"). **How the sliders load a side's history is not settled either.** The
plan under "Planned: sliders on the diff page" fetches the whole replay to the browser; the
alternative is to fetch an index alone, the update ids and their times, and have the server
rebuild a side each time its slider settles, as it does for any `@<id>`. Who should see more
of a doc's history is left to the permissions redesign.

## Deferred

- **Pulling a parent's later changes into a fork**, and any merge.
- **More than one generation** in the family lines; further ones are a click away.
- **Who wrote each change**, as `since` names the writers of each run, and formatting changes.
- **Tables aligned row by row, and lists item by item**, rather than each as one block. Until
  then a long one is where the word diff's cap bites first ("Where the comparing is done").
- **A snapshot of the parent at a fork point**, which a fork doesn't write ("The function").
- **Changes shown in the reading view while scrubbing.** The replay is already in the browser,
  and so is the engine, in its worker, so the frozen body could mark what changed since the pin
  as decorations. A surface of another kind, wanted only if the pin and the page prove too
  coarse.
- **A post's snapshot against its doc now**, from `/post/[id]/edit`, whose scrub bar knows the
  update each snapshot was taken through; and post history on the engine, block by block
  rather than `diffText` over two whole texts.
- **MCP**: a fork tool, a doc's parent in `multiblog_read`, and reading a diff's URL. That
  read would run `diffRows` on the server, as `since` runs the engine, and wants the total
  over a request's word diffs first.
- **A "% changed since forking" figure**, and copying a parent's tags to a fork on request.
