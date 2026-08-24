# Performance Notes

Running log of known performance characteristics, trade-offs, and decisions in
the collaborative editor. Add a new dated entry below for each notable
finding, fix, or deliberately-deferred issue — most recent last.

**Every measurement in this file was taken on one machine** — an Intel
i7-8700K, 6 cores / 12 threads, Windows, with Postgres and the collab server on
the same box. That holds for every entry below, including the earliest; an entry
that ever measures somewhere else must say so. These figures are sub-millisecond
and CPU-bound, so the rig matters more here than almost anywhere else in the
repo — a number with none attached cannot be checked or scaled by whoever
reads it next. Where a table carries a throttled column, that is
`Emulation.setCPUThrottlingRate` applied to *this* processor: a floor for slower
hardware, not a measurement of any.

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

## Measuring by hand

### Editing latency

`document.execCommand('insertText', false, char)` in a loop inside the editor's `.tiptap`
element, timed with `performance.now()` per call, drives a real ProseMirror transaction
through the normal path — mark-tagging, Yjs sync, decorations — without OS input-pipeline
noise. Reproducible enough for relative before/after comparisons.

`execCommand('delete', false)` undoes it the same way, character-for-character, to restore
test content afterward.

The same loop runs inside `page.evaluate` in a spec, which is one command rather than a
per-keystroke drive through the browser pane, and can print its numbers straight to stdout.

> `document.querySelector('.tiptap')` matches the **title** editor first; the body editor is
> `querySelectorAll('.tiptap')[1]`. See [docs/TIPTAP.md](docs/TIPTAP.md).

### Stress-testing at a realistic content size

Copy the target content into a throwaway post rather than editing the real one directly. That
removes any risk from a botched restore step.

### A/B-ing against actual history rather than guessing

1. Confirm `git status` is clean.
2. `git checkout <old-commit>`.
3. Stop and restart `dev:all` — checkout doesn't hot-reload cleanly across many files, and the
   collab server especially needs a real restart.
4. Measure.
5. `git checkout <branch-name>` and restart again.

With uncommitted work, `git stash push -u` / `git stash pop` does the same job without needing
a commit.

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

## 2026-07-24 — Second TipTap editor for the title: A/B against the same-day baseline

**Prompt:** "What are the performance implications of having a second TipTap
editor in the page, even if it's using the same ydoc?" → "yes, run the A/B
benchmark and record it in PERFORMANCE.md"

**Change under test:** the post title moved from a controlled React `<input>`
(plain `useState` in `PostEditor`) to its own TipTap editor bound to a second
Yjs fragment (`"title"`) of the *same* `Y.Doc` as the body — see
`CollabTitleField.tsx` and PLAN.md §3d. Two `EditorView`s on the page instead
of one.

**Method:** working tree vs. the default branch (then named `master`) at `a96ebff`, via `git stash push -u` /
`git stash pop`, with both dev servers restarted for each side (not an
estimate). Two throwaway posts held a copy of a real post's content — 3,796
chars / 17 paragraphs ("small") and 18,038 chars / 89 paragraphs ("large") —
so the real post was never opened. Content was byte-identical on both sides
(verified by character count before and after every run).

- **Body latency**: 50 warm-up + 300 timed `execCommand('insertText')` calls
  at the end of the body, `performance.now()` per call, then 350
  `execCommand('delete')` to restore. 3 runs per cell.
- **Title latency**: 20 warm-up + 100 timed keystrokes. On baseline that's a
  native-setter `value` write + `input` event (what React sees from real
  typing); on the new side it's `execCommand('insertText')` in the title's
  contenteditable.
- **Title burst**: because the contenteditable path can defer React work
  *outside* the timed call while the controlled `<input>` did it
  synchronously, per-call timing alone could flatter the new side. The burst
  metric times 100 keystrokes end-to-end plus a settle window and divides by
  100, so deferred renders are counted. It confirms the per-call figures
  rather than contradicting them.

**Results — body typing** (mean of 3 runs; p95 range across runs):

| Content | Baseline `a96ebff` | With title editor |
|---|---|---|
| 3.8k chars | 0.22ms / p95 0.3–0.4ms | 0.24ms / p95 0.3–0.4ms |
| 18.0k chars | 0.25ms / p95 0.4–0.5ms | 0.26ms / p95 0.4ms |

Body typing is unchanged: +0.02–0.03ms per keystroke, at the edge of the
0.1ms `performance.now()` granularity and well inside run-to-run spread. This
is the cell that was actually in question. y-prosemirror attaches its
expensive listener per *fragment* (`type.observeDeep`, y-tiptap.js:830), so
body edits never run the title binding's `_typeChanged`; what it *does*
attach per **document** is `beforeAllTransactions` (y-tiptap.js:828), whose
handler computes `getRelativeSelection` over its own binding's state. That
means every body keystroke now also runs that hook for the title binding —
but scoped to a one-paragraph fragment, which is why it doesn't show up here.

**Results — title typing** (per-call mean; burst = ms/char including settle):

| Content | Baseline (`<input>`) | Title editor |
|---|---|---|
| 3.8k chars | 2.1ms / p95 4.0–5.6ms | 0.19ms / p95 0.2–0.4ms |
| 3.8k chars, burst | 1.87ms/char | 0.38ms/char |
| 18.0k chars | 2.5ms / p95 4.4–7.4ms | 0.16ms / p95 0.2–0.3ms |
| 18.0k chars, burst | 2.14ms/char | 0.30ms/char |

Title typing got **~5–11x faster**, which was not the expected direction. The
cause isn't Yjs — it's that the old `<input>` was a *controlled* React input:
every character ran `setTitle` synchronously inside the event dispatch, which
re-rendered all of `PostEditor` including `PostSettingsPanel`'s revision
table, and got worse with body size (2.1ms → 2.5ms) even though the body
wasn't involved. The contenteditable is uncontrolled: ProseMirror updates the
DOM itself and the mirrored `setTitle` re-render no longer sits in the typing
path. The burst numbers confirm the win survives counting deferred work.

**Costs this benchmark does not capture**, all per-title-keystroke and all
new:

- Each title keystroke is now a Yjs update, so it hits `server/collab.ts`'s
  `onChange` — including the per-update `postCollabUpdate.count()` already
  flagged as `O(n)` per keystroke / `O(n²)` per unsaved session in the
  2026-07-19 entry above. Retitling a post now feeds that counter; it
  previously cost nothing server-side until save.
- `collectAuthorHighlightStats` runs undebounced on each title keystroke
  (deliberate — one paragraph — but inconsistent with the body's 400ms
  debounce).
- `CollabTitleField` and `CollabEditorBody` each own a `useAuthorColors`
  cache, so an author appearing in both fragments can be fetched twice from
  `/api/users/colors` on load.

**Bottom line:** a second editor on the shared `Y.Doc` costs nothing
measurable on body typing, and title typing is several times faster than the
controlled `<input>` it replaced. The real new costs are server-side
(per-keystroke update logging), not in the editor.

**Measurement notes for whoever runs this next**

- The first baseline pass measured body-large at 0.36–0.43ms; a second pass
  after a fresh server restart measured 0.25ms for the identical code and
  content. The first pass was contaminated by Next dev-server compile work
  right after startup. **Load the page, then discard a first run** before
  recording anything.
- `requestAnimationFrame` never fires and `setTimeout` is throttled while the
  Browser pane is hidden, which silently turns any rAF-based settle into a
  30s tool timeout. Use a `MessageChannel` round-trip instead — it's also
  what React's own scheduler uses.

## 2026-07-28 — New `ydoc_update` append path has no per-keystroke count()

PLAN.md §11 built a second, fully parallel update-log table (`ydoc_update`,
written by `server/ydoc-hooks.ts`) alongside the existing `post_collab_update`
one — not a replacement yet, since nothing that edits a post is wired to it.
Worth recording here because it directly resolves the first bullet of the
2026-07-19 "known, unaddressed hot paths" entry above, just not for the table
that entry was about.

- **Post path (`post_collab_update`, unchanged):** still `1 count() + 1
  insert` per keystroke — `prisma.postCollabUpdate.count({ where: { postId
  } })` before every write, to decide full-state-vs-delta. `O(n)` per
  keystroke, `O(n²)` over an unsaved session, exactly as measured before.
- **New stack (`ydoc_update`):** `1 insert`, full stop. The full-state-vs-delta
  decision is made exactly once, at document creation (`ydocStore.
  createIfAbsent`'s two-row transaction — the row-#1-is-a-full-state
  invariant, PLAN.md §11b) rather than re-derived from a count on every
  single change. `onChange` (`ydocOnChange` in `server/ydoc-hooks.ts`) is
  one `appendUpdate` call, serialized per document by an in-process promise
  queue rather than a database read.

The saving isn't from a smarter query (the count-based check could just as
well be replaced by a cheaper `findFirst`-style existence probe, as the
2026-07-19 entry already suggested) — it's from not needing to *ask* the
database at all, because the log this table backs is never truncated on save.
`post_collab_update`'s count-based branch only exists because that table
*is* truncated on every save, which destroys the "row #1 is a full state"
invariant every time and forces re-deriving it per write. Truncation was the
cost driver, not the query shape.

Not yet measured end-to-end against the same editing-latency benchmark the
2026-07-19/07-24 entries used (no keystroke reaches this path until a post
editor is wired to it) — the comparison above is by inspection of the two
code paths, not a timed run.

## 2026-08-13 — One read-only TipTap editor per annotation: measured against annotation count

**Prompt:** "Search the web for performance talk about having N readonly tiptap
editors." → "Measure that situation."

**Branch:** `annotation-rework`, HEAD `7a0f2e6`. The design under test is
PLAN.md §13p's `AnnotationBodyReader`, which renders every posted annotation's
body through an `editable: false` editor instead of the static React tree
`annotation-entries.ts` produces. That was taken deliberately, over a lazier
scheme, on the grounds that mounting an editor mid selection-gesture would be a
worse bug than the cost it avoids — with the cost itself unmeasured. This is
that number.

**Why it was in doubt.** The canonical prior art
([tiptap#1478](https://github.com/ueberdosis/tiptap/discussions/1478)) reports
~30 *empty* editors taking **roughly 8+ seconds** of initial render, and
ProseMirror's own answer to many instances is that there isn't one — Marijn:
*"your only option is going to be to find a way to not render some of those
editors."* If 8s were representative, §13p would be unshippable rather than
merely costly.

**Methodology**

- A throwaway spec (`e2e/perf-annotations.spec.ts`) plus a temporary
  `createPerfAnnotations` handler in `e2e/db-worker.ts`; both deleted after the
  run, and the seeded rows cascade away with their fixture doc.
- N document-level `LIVE` annotations on one doc, each with real `proseJson`
  (~115 characters, one paragraph) rather than the empty bodies #1478 used.
  Document-level on purpose: those render in the stacked list below the doc
  regardless of viewport, so the card count is deterministic.
- `about:blank` → `/doc/[slug]`, with Chrome DevTools Protocol
  `Performance.getMetrics` read on both sides and diffed, so each figure covers
  that one navigation and nothing before it. Wall clock is measured to the
  point where every annotation body has mounted its editor (`[aria-label=
  "Annotation"]` count ≥ N), which is the thing being paid for.
- Median of 3 runs per cell. Throttled runs use
  `Emulation.setCPUThrottlingRate`.
- The **static arm** stubs `AnnotationBodyReader` to render `staticBody` alone,
  no editor — i.e. the pre-§13p behaviour.

**Results — `next dev`, unthrottled** (ms; the A/B, both arms)

| n | editors: task / script / wall | static: task / script / wall |
|---|---|---|
| 0 | 185 / 64 / 396 | 178 / 55 / 358 |
| 10 | 319 / 209 / 592 | 142 / 46 / 374 |
| 30 | 511 / 364 / 878 | 135 / 39 / 458 |
| 60 | 636 / 459 / 1205 | 167 / 37 / 617 |

The load-bearing observation is the shape, not the magnitude: **the static arm
is flat in annotation count** (script 55 → 37 across a 60× range, i.e. noise)
and the editor arm is not. Everything else on the page costs the same either
way, so the entire difference is editor construction — and `n=0` in the editor
arm is therefore a valid baseline on its own, which is why the production runs
below needed only one arm.

**Results — `next start` (production build), editor arm**

| n | unthrottled task / script / wall | 4× CPU task / script / wall |
|---|---|---|
| 0 | 88 / 18 / 149 | 489 / 85 / 599 |
| 10 | 134 / 58 / 187 | 645 / 258 / 738 |
| 30 | 165 / 84 / 231 | 1132 / 577 / 1269 |
| 60 | 237 / 133 / 346 | 1512 / 887 / 1729 |

Marginal wall-clock over the `n=0` baseline:

| n | prod, unthrottled | prod, 4× CPU |
|---|---|---|
| 10 | +38ms | +139ms |
| 30 | +82ms | +670ms |
| 60 | +197ms | +1130ms |

**The 8-second figure does not reproduce, by three orders of magnitude.** 30
editors cost ~66ms of script in unthrottled production and ~325ms in dev,
against ~8000ms claimed. The likely explanation is version: that report predates
Tiptap v3 flipping `shouldRerenderOnTransaction` to **off** by default —
verified in our installed `@tiptap/react@3.29.0`, where an unset value is
handled identically to `false` (`dist/index.js:519`). That flag is the
difference between paying construction once and paying a React re-render per
transaction per editor, which is what turns a linear cost into a quadratic one.

**Cost per editor falls as count rises** — 16 → 11 → 7ms in dev at n=10/30/60,
as JIT warmup and shared extension setup amortise. Under 4× throttling the
curve flattens (17 → 16 → 13ms), which is expected: throttling scales
steady-state work harder than one-time warmup. So this degrades gracefully
rather than hitting a cliff.

**Not covered by this benchmark**

- Long annotation bodies. Every seeded body was one short paragraph; per-editor
  cost scales with content, so a doc full of essay-length annotations costs
  more than these figures imply.
- Real mobile hardware. 4× CPU throttling models the processor only, not slower
  memory or GPU, so the throttled column is a **floor** for a mid-range phone
  rather than an estimate of one.
- Steady-state cost. This measures mount only. Nothing here says what N mounted
  editors cost per remote keystroke afterwards — plausibly near zero, since
  they have no live tap and `shouldRerenderOnTransaction` is off, but unmeasured.
- `next dev` absolute values are inflated ~4× against production and are useful
  only for the A/B, where both arms pay the same inflation.

**Bottom line.** Not the catastrophe the prior art suggested, and the eager
design is fine at small counts — but ~0.7s of added main-thread work at 30
annotations and ~1.1s at 60, on a 4×-throttled build, on a page that is also
opening a websocket and running the margin-notes layout pass. The break-even
against a static render is somewhere around 10–15 annotations on a slow device.
A doc that accumulates annotations over its life lands above that.

The fix this points at costs almost nothing, because **only one editor is ever
needed at a time**: pre-split reply highlights into the static render
server-side (a posted annotation body is immutable in practice, so its
highlights need no live tracking — unlike the doc, where tracking is the entire
point), and mount an editor on `pointerenter`/`focusin`, which fires before a
selection gesture can start. That collapses the editor column to the static
column above, i.e. flat in N. What it depends on — annotation bodies staying
immutable — is the subject of docs/COLLAB.md's 2026-08-13 log entry, which is
where the design consequences live.
