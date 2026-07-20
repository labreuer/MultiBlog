# Performance Notes

Running log of known performance characteristics, trade-offs, and decisions in
the collaborative editor. Add a new dated entry below for each notable
finding, fix, or deliberately-deferred issue — most recent last.

## Console-based performance logging

Some hot paths are instrumented with `perfMeasure` (`src/lib/perf-monitor.ts`).
Logging is off by default (zero overhead — `perfMeasure` just calls the
function directly when disabled). To turn it on, run in the browser console
on any page that mounts the editor:

```js
multiblogPerf.enable()   // turn on, persists across reloads (localStorage)
multiblogPerf.disable()  // turn back off
multiblogPerf.isEnabled()
```

Enabled logs look like `[multiblog perf] <label>: <ms>ms`.

## 2026-07-19 — Status line: revision diff + author mark counts

Added a status-line segment showing `(+X −Y)` (word-level diff of the live
document against the last saved revision, via the existing `diffText`/
`extractText` in `src/lib/diff.ts`) and `(Name: +N, ...)` (character counts
per author, from the `authorHighlight` marks added in the
`author-highlight-and-live-history` work).

Both computations are non-trivial and were built debounced (~400ms after the
last edit, not per keystroke) from the start:

- The revision diff is word-level LCS (`diffText`), `O(n·m)` in token count on
  both sides — expensive to run on every keystroke for anything beyond a
  trivial document. The "last revision" side is cached via `useMemo` (it's
  static until the next save) so only the live side is re-extracted per
  recompute.
- The author-mark walk is `O(document size)`, same order as an *existing*
  unthrottled walk that was already running on every keystroke (see below) —
  rather than add a second full-document pass on top of it, this walk
  replaced that one: `CollabEditorBody`'s author-id collection (used for
  color-fetching/highlight styling) and the new per-author character counts
  now come from a single debounced `collectAuthorHighlightStats` call
  (`src/lib/tiptap-schema.ts`) that walks the live ProseMirror `Node` via
  `.descendants()` instead of `editor.getJSON()` + a separate tree walk.

Both are wrapped in `perfMeasure` (labels `"revision diff"` and
`"author-highlight walk"`).

## 2026-07-19 — Known, unaddressed hot paths (found during the above review, not fixed)

Two pre-existing costs from the `author-highlight-and-live-history` work were
identified but are out of scope for the status-line change above:

- **`server/collab.ts`'s `onChange` hook** (`PostCollabUpdate` logging for
  live history) runs `prisma.postCollabUpdate.count({ where: { postId } })`
  before every single insert, on every Yjs update (no debounce, roughly once
  per keystroke across all connected editors of a post). The count scans all
  rows logged since the last save — `O(n)` per keystroke, `O(n²)` over an
  unsaved editing session. It resets to cheap on every save/publish (the log
  is wiped then), so this only degrades within a single long unsaved session.
  A `findFirst`/exists-style check would be `O(1)`-ish instead of a full count
  and should replace this if session lengths ever become a real problem.
- **`LiveHistoryViewer`'s replay** (`src/components/LiveHistoryViewer.tsx`)
  recomputes the document from scratch on every scrub-slider tick *and* on
  every new incoming update while tailing live: it re-applies the update log
  from position 0 into a fresh scratch `Y.Doc` every time, rather than
  incrementally advancing an already-materialized doc. Cost is `O(position)`
  per tick; while tailing a live session, the *n*-th keystroke anyone makes
  costs `O(n)`, so a long collaborative session watched live costs `O(n²)`
  cumulative client work. Already flagged in PLAN.md as a known limitation,
  deferred until update-log sizes actually warrant periodic checkpointing.

## 2026-07-19 — More accurate Status Line

The `(+X −Y)` revision-diff figure in the status line (see the entry above)
is not just a performance trade-off but measurably **inaccurate**, because it
reuses `diffText`'s word-level tokenization (`src/lib/diff.ts`, tokenizing on
`\S+|\s+`) for a job that needs character-level counts.

Repro: with the cursor at the end of the document, the status line read
`(−7)`. Pressing Backspace once (deleting exactly one character) changed it
to `(+4 −12)` instead of the expected `(−8)`.

Root cause: word-level LCS only matches whole tokens. As long as a word is
byte-identical to the corresponding word in the last revision, it's an
`"equal"` token and contributes nothing to the diff. The instant an edit
lands *inside* that word — not just deletions cleanly at a word boundary —
the token no longer matches anything, so the algorithm reports it as the
*entire old word deleted* + the *entire new word inserted*, rather than the
true 1-character delta. Minimal repro (inlining the same `tokenize`/`diffText`
logic): diffing `"alpha beta gamma delta wordsX"` against
`"alpha gamma delta wordsX"` gives a clean `added: 0, removed: 5` (word-
aligned deletion of `"beta "`); backspacing the trailing word's last
character (`"wordsX"` → `"words"`) changes the same comparison to
`added: 5, removed: 11` — one keystroke, but the whole 6-character word flips
from "equal" to "delete old / insert new" because it stopped matching
exactly. This makes the figure unstable for any edit inside a
previously-unchanged word, not just this one case.

**Not fixed** (explicitly deferred, per direction): the correct fix is a
character-level (not word-level) diff for this specific computation, leaving
`diffText`/word-level output alone for the revision-history page, which
genuinely wants whole-word-replacement semantics for human readability. The
trade-off to weigh when this gets picked up: a character-level LCS has a
*larger* DP table than word-level for the same text (many more tokens), on
top of a computation that's already debounced specifically because of its
existing `O(n·m)` cost (see the entry above) — so fixing accuracy here likely
means also revisiting whether the 400ms debounce and/or algorithm (e.g. a
prefix/suffix-trim-style approach, which is only valid for a single
contiguous edit region rather than the many scattered edits a whole session
against the last revision can accumulate) still holds up.

## 2026-07-19 — Editing-latency benchmark: this branch vs. pre-branch baseline

**Prompt:** "Come up with a performance test for `/posts/cmrshyi5k0000j1ng3hx8pdv5/edit`,
given what we've done in this branch. How much has editing been slowed down?
Then test something five times as long. See if you can detect any noticeable
performance degradation."

**Branch:** `author-highlight-and-live-history`, HEAD at the time (`a501532`,
"Add status-line revision diff + per-author contribution counts") compared
against `26b03dd` ("Upgrade @tiptap/* to 3.28.0..."), the commit immediately
before this branch's work started — a real `git checkout` + dev-server
restart for each side, not an estimate.

**Methodology**

- Rather than edit the real post directly, its latest revision content
  (3,689 characters across 17 paragraphs) was copied into a throwaway post.
  A second throwaway post held the same 17 paragraphs repeated 5× (85
  paragraphs, 18,445 characters) for the scaling test. The real post was
  never opened during this test.
- **Per-keystroke latency**: `document.execCommand('insertText', false, 'a')`
  called 300 times in a tight loop inside the live editor (via the browser
  pane's `javascript_exec`), timing each call with `performance.now()`. This
  drives a real ProseMirror transaction through the same path a keystroke
  would (mark-tagging, Yjs sync, decorations) without OS input-pipeline
  noise, which would otherwise dominate a true keystroke-by-keystroke
  measurement — reproducible, and valid for relative (before/after,
  1x/5x) comparison even though it isn't literal human typing speed.
- **Debounced computation cost**: `multiblogPerf.enable()`, then read the
  `revision diff` / `author-highlight walk` timings it logs ~400ms after the
  same 300-character burst settles.
- Each measurement run was followed by deleting the same number of
  characters (`execCommand('delete', false)` × N) to leave the throwaway
  post's content unchanged before switching commits or content sizes.

**Results — per-keystroke latency** (mean / p95 of the 300-call distribution):

| Content | Baseline (`26b03dd`) | HEAD (`a501532`) |
|---|---|---|
| 1x (~3.7k chars) | 0.53ms / 1.0ms | 0.48ms / 0.8ms |
| 5x (~18.6k chars) | 1.17ms / 1.9ms | 1.18ms / 1.6ms |

Statistically indistinguishable at both sizes — the mark-tagging
(`appendTransaction` in `author-highlight-extension.ts`) and custom caret
render add no measurable per-keystroke cost. The ~2.4x growth from 1x→5x is
identical on both commits, so it's pre-existing ProseMirror/Yjs overhead
(decoration rebuilding, `state.apply()`), not something this branch added.

**Results — debounced computation** (doesn't exist at all on `26b03dd`:
`window.multiblogPerf` is `undefined` there):

| Content | author-highlight walk | revision diff |
|---|---|---|
| 1x | 0.10ms | 19.7ms |
| 5x | ~0ms | **309–325ms** |

The author-mark walk stays cheap regardless of size. The revision diff is
the one real finding: ~16x slower for 5x the content — worse than linear,
consistent with the `O(n·m)` word-level-LCS cost already documented above.
Noticeable stutter at these sizes, not a freeze, but the super-linear curve
means a document meaningfully larger than 18k characters could turn that
debounced tick into a genuinely janky pause.

**Not covered by this benchmark** (different scaling axis — session/edit
count, not document size; see the "known, unaddressed hot paths" entry
above): `server/collab.ts`'s per-update `count()` query, and
`LiveHistoryViewer`'s from-scratch replay.

**Bottom line:** editing itself hasn't slowed down. The revision-diff status
line is the one place with real, measurable, super-linear cost.
