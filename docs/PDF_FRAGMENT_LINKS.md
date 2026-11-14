# PDF fragment links — a link to a passage, with no row

**Status: built** (2026-10-06), except "Copy passage link" (§8). §13 is a plan, not an account:
how the viewer shows the words a quotation leaves out (`...`). Fragment links share the PDF
locator rule and the server-side quads of [MCP.md](MCP.md), the MCP server's plan.

A **fragment link** is a URL that names a passage of a PDF by its words:

```
/pdf/owen-barfield-saving-the-appearances#sheet=122&text=could+not+yet+call+his+soul+his+own
```

Following it opens the PDF at that page with the passage outlined, exactly as a followed
[anchored link](ANCHORED_LINKS.md) draws one. Making it writes nothing: the URL is the whole
record.

**Why.** A research summary quotes its sources dozens of times, and without fragment links every
quote is an anchored link. That means two rows and a stored target of about 500 bytes for each
quote, minted through a signed-in session, because that is the only way in. The sample these
figures were measured on is a summary of a 190-page book that quotes it 65 times (Appendix A).
Making those links took a script that ran pdfjs over a local copy of the PDF to compute each
passage's quads, and a second script that drove the site's server actions with a session cookie.
With fragment links, the summary's Markdown import is the only write the summary needs.

**Anchored links stay** for everything a fragment link can't do (§1). Fragment links are a second
kind of passage link, and replace nothing.

## 1. What it is, beside an anchored link

| | Anchored link | Fragment link |
|---|---|---|
| Where it lives | `anchored_link` + `anchored_link_anchor` rows | the href, and nowhere else |
| Targets | docs and PDFs, several in one link | one PDF |
| Passages | parts, each one page or one doc range | one or more, each on one page (§5) |
| Following it | `/link/<id>`: redirect, excerpts, or an empty page, per viewer | the PDF route itself, behind its own gate |
| Unreadable target | omitted silently; the landing names nothing | the PDF route's sign-in, Forbidden or 404 |
| Names, editing, `/links` | yes | no: to change it, edit the href |
| Found by | its stored quads, which never need re-finding (PDF.md §4) | its words, found again on every open (§4) |
| Discloses to the doc's readers | an opaque id | the PDF's slug and the passage's words (§10) |

**PDFs only, because a version's bytes never change.** A version's `sha256` is its identity,
so a passage named by its words is always in the same place in it. A file can be given other
bytes, which become its next version ([PDF.md](PDF.md) §13), so a link also says which version
it names: `v=` (§2), and a link without one names the file's first, as every link written
before a second version existed did. The same URL into a doc would need COLLAB.md's drift
machinery to stay true. Passages in docs, including the section links in imported chats, stay
anchored links.

**The fragment grants nothing.** The PDF route's gate runs exactly as for a bare `/pdf/<slug>`,
the same rule as `?sel=` (ANCHORED_LINKS.md, "Following a link"), and the fragment can only
name passages inside the file that gate allowed.

**Any text that can hold a link can hold one**: a doc, a post, a comment or an annotation's
body. Comments need one change for it (§8).

## 2. The URL

```
/pdf/<slug>#sheet=<n>[&v=<version>]&text=<passage>[&sheet=<n>[&v=<version>]&text=<passage>…]
/pdf/<slug>#p=<label>[&v=<version>]&text=<passage>[&p=<label>[&v=<version>]&text=<passage>…]
/pdf/<slug>/v/<version>#…          the same, on a version's own address

passage = [<prefix>-,]<segment>*("..." <segment>)[,-<suffix>]
segment = <start>[,<end>]
prefix, start, end, suffix = word *("+" word)
```

- **`sheet`** is the 1-based sheet number (`src/lib/pdf-open-params.ts`): never a label.
  `PdfViewer` applies it on its own, so the viewer opens at the passage's sheet before the
  passage is found.
- **`page` is read as `sheet` for good**, and nothing writes it. It is RFC 8118's name for a
  sheet, and every link written before `sheet=` uses it. Beside `p`, "page" is the word a
  reader takes for the printed page, which is why the written form is `sheet` (PDF.md §13,
  "Links into the file"). A tab whose bundle predates `sheet=` ignores it, as one that
  predates `p=` ignores that (§6).
- **`p`** is the page printed on the sheet, its label, found by the rule below. A reader of a
  book names the page printed on it, so an author quoting from a corrected copy writes the page
  the copy cites rather than converting it to a sheet by hand.
  `/references/<key>#p=49` uses `p` for a printed page too (CITATIONS.md, Pages). One link may
  use both forms.
- **`v`** is the version of the file whose sheets a `sheet` counts and whose labels a `p` is
  read on: the number in that version's address ([PDF.md](PDF.md) §13, "Links into the
  file", which has the reasons).
  - **It belongs to the `sheet`, `page` or `p` before it**, and a writer puts it straight
    after that page (`formatPageName`). It stamps every `text` of its page. One before any
    page is ignored, a page's second is ignored, and one that doesn't read (`v=0`, `v=x`) is
    no stamp at all.
  - **A link without one names the file's first version, always.** That holds for every link
    written before a file's second version existed, and changes nothing while a file has
    one. So once a file has a second version every link the app writes into it carries `v=`,
    a link to version 1 included.
  - **On a version's own address a link without one names that version**:
    `/pdf/book/v/2#sheet=49` is sheet 49 of version 2. The address says which version is
    shown, and `v=` whose sheets the link counts.
  - **A `p=` takes one as a `sheet=` does**: a set of drafts has a page 5 each.
  - A tab whose bundle predates `v=` ignores it, and reads the sheet on whichever version it
    shows.
- **`text`** is [Text Fragments](https://wicg.github.io/scroll-to-text-fragment/)' grammar, minus
  its encoding rules:
  - `start` alone is the whole passage;
  - `start,end` runs from the first word of `start` to the last word of `end`, and nothing
    between them is matched;
  - `prefix-,` and `,-suffix` are words that must come immediately before or after. They exist
    only to tell repeats apart.
- **`...` joins a passage's segments**, the runs a quotation keeps around the words it leaves
  out. `start,end` is a length device over words quoted in full, and outlines everything between
  them; `...` marks words the quoter left out, so the two can be told apart.
  - **One `text` value is still one passage.** Two `text`s on one page are two passages, each
    matched at its first occurrence.
  - **The separator is three dots.** `…` (U+2026) reads as the same separator, as the character
    or as `%E2%80%A6`, which is what `location.hash` holds for one. It is the one marker read in
    its encoded form: `,` and `-` are syntax only unencoded. A single `.` stays punctuation,
    which readers ignore, and so do two. Of the 5,832 `text` values measured on explore, 140 hold
    a single `.` and none holds `...` or `…`, so no link written before `...` changes meaning
    (Appendix A).
  - **Precedence.** The value splits on `...` first. A `prefix-,` belongs to the first segment
    and a `,-suffix` to the last; on any other segment either makes the value unreadable. Each
    segment may still be shortened to its ends with `,`, by the writer's form's rule (§8): a long
    segment misses on one OCR error, and `start,end` steps around it (§4). A short one goes
    whole.
  - **An ellipsis at either end is dropped**, and so is a second one straight after the first.
    One at an end says only that the quotation starts or stops mid-sentence, and would leave an
    empty segment.
- **Pairing.** Parameters are read left to right, as RFC 8118 reads a PDF's own. Each `text`
  belongs to the nearest `sheet`, `page` or `p` before it, so a `text` with no page before it
  is ignored, and a page whose value doesn't read forgets the one before it. A `sheet`, a
  `page` or a `p` with no `text` after it is a **page link**, opened as a bare `#sheet=` is
  (§6). Anything else is
  ignored too, as `pdf-open-params.ts` already ignores what it doesn't support.
- **Words are letters and digits only.** Writers drop punctuation, quotation marks, dashes,
  hyphens and apostrophes, fold accents to their base letters, keep case as written, and join
  words with `+`. Readers ignore everything but letters and digits anyway (§4), so a
  hand-written `%20`, comma inside a quote or curly apostrophe does no harm. The exceptions are
  `,` and a `-` beside a comma, which are syntax. So a writer's URL needs no percent-encoding at
  all, except for letters with no ASCII base letter, such as Greek.
- **A label is percent-encoded** where it holds anything but ASCII letters, digits, `.` and `-`
  (`formatPageName`). A label in a PDF is free text, but nearly every one is digits or a Roman
  numeral and needs none. A reader takes `+` in one as a space, as in a `text` value, and trims
  it.
- **Relative.** Writers emit `/pdf/…` and never an origin, so a doc keeps working on a copy of
  its instance. An absolute URL on the instance's own origin, as pasted from the address bar,
  is the same link and is read the same way. A slug that later changes is handled by the
  slug-history redirect (§7).

**Examples**, all from the sample. Each resolves to exactly the passage its anchored link
stores today:

```
#sheet=122&text=could+not+yet+call+his+soul+his+own                  a whole passage
#sheet=8&text=a+direction+in,a+beatific+consummation                 first words, last words
#sheet=30&text=law+of+participation                                  the first of two on the page
#sheet=30&text=identity+but+of+the-,law+of+participation             the second, by its prefix
#sheet=40&text=It+may+also,within+but+it&sheet=41&text=is+detected+primarily+without
                                                                     one quote across a page break
#p=8&text=a+direction+in...a+beatific+consummation                   words left out between two
#p=12&text=the+human+soul...is+detected,primarily+without            a shortened second segment
```

**Why the fragment, not the query string.**

- **A fragment names part of a resource** (RFC 3986), and every precedent for a place in a PDF
  is one: RFC 8118's `page=`, `highlight=` and `search=`, and this viewer's own `#sheet=`.
- **It never reaches a server.** There's nothing in access logs, no proxy limit on URL length,
  and nothing in a `Referer`.
- **There is nothing for the server to do with it.** The viewer is a client island behind
  `ssr: false` and finds the passage itself (§6). Only a miss asks the server where the
  passage is instead, with its words in a request body.
- **A redirect carries it for free.** Browsers re-apply a fragment the `Location` lacks
  (RFC 9110 §10.2.2), where `?sel=` has to be re-appended by hand in both of the route's
  redirects. The one place it needs help is sign-in (§7).

**Why not `#:~:text=`**, which is Text Fragments' own syntax. Browsers take everything after
`:~:` out of the URL before script can see it. The spec says the directive "is removed from the
URL before the URL is set to the session history entry … This prevents it from being visible
to script APIs", so this viewer could never read it.

**Why not the stored target in the URL.**

- **Quads are most of its size.** A quad is eight full-precision floats per line, and the
  sample's targets are 495 bytes at the median. As base64 in a URL that is 370 to 1,270
  characters (§3).
- **The viewer can measure quads itself** from text it already extracts (§6).
- **`position` and `textVersion` aren't needed**, because the match ignores everything the
  normaliser changes (§4).

### Which sheet

A `p` is a label as `pagesLabelled` reads one (`src/lib/pdf-page-labels.ts`): trimmed, case
ignored, against **the labels the file itself gives**, in the version the link names
(`sheetsLabelled`). The viewer reads them from pdfjs (§6), and the check from that version's
`file_version.page_labels` (§8).

1. **A file with usable labels**: the sheets whose own label is `p`, in order. There can be
   several, since front matter and body can each have a "1" (`pageLabelFor`).
2. **A file without them**: `p=N`, with N in digits, is sheet N, which is how a citation's page
   is read on such a file (§8). Any other label names no sheet. `usablePageLabels` rejects a
   file whose labels are all empty, and one labelled 1…N, where the two forms agree anyway.
3. **The passage is its first occurrence on the first of those sheets that holds it**, which is
   §4's "first occurrence wins" extended across sheets. A page link opens at the first of them.
4. **A label no sheet carries** names no page, as a sheet past the end names none. Each is a
   finding of the check (§8), and the viewer asks where the passage is instead (§6).

**A filled-in number is not a label.** `usablePageLabels` says whether a file has labels worth
using, and fills an empty one with its sheet's number for the page box. On a file with usable
labels, `p=5` never names a sheet whose own label is empty, in a link or in a citation: only
`sheet=` names such a sheet. So a `p` is matched against the labels as read, and never against
what `usablePageLabels` returns.

### A quotation's segments

Where a passage's words come from a written quotation rather than from a URL, one pair of
functions turns them into segments (`src/lib/pdf-passage-pieces.ts`). A citation's passage
uses both (CITATIONS.md, "A passage in a citation"), and the one-quote CLI the second (§8).

- **`quotationText(quotation, { shorten })`** writes the quotation as a `text` value, with no
  page in sight: what a citation's link carries.
  - An ellipsis, written `...`, `…` or `. . .`, bare or bracketed (`[…]`, `[...]`), is a gap.
  - **A bracket standing alone** is a gap too: `[sic]`, `[emphasis added]`, or `[the soul]` in
    place of "it". `[sic]` then covers no words. A substitution's own words in the PDF fall
    inside the gap, since they weren't quoted verbatim. The gap takes what is attached to the
    bracket up to the next space, so the `'s` of `[the soul]'s` is no word of its own. A bracket
    holding a space is no word's letters, and stands alone. A bracket that is the source's own
    text reads as an insertion and becomes a gap, which shows its words as elided and is
    harmless.
  - **A bracket attached to a word** keeps its brackets, `%5BT%5Dhe`, `form%5Bs%5D`: whether its
    letters are the source's is a question only the page text answers.
  - With `shorten`, a segment longer than eight words goes as its first three and last three,
    the writer's form's length rule without its step for uniqueness, which needs the page.
- **`passagePieces(text, pages, startSheets, throughSheet)`** settles such a value against the
  stored text of the pages, and answers each page's share in the writer's form (§8), holding
  no bracket.
  - **Each attached bracket** is tried with its letters kept, then dropped, and whichever matches
    the page is used. A skeleton is contiguous letters, so neither fixed rule works: "[T]he"
    matches only with them kept, and "form[s]" against a source's "form" only with them dropped.
  - **The passage starts on the first of `startSheets` that holds it**, as a whole on one page
    first, prefix and suffix included.
  - **Then across pages**, segment by segment, never past eight pages and never past
    `throughSheet(start)`. A segment that isn't on the page the one before it ended on is looked
    for whole on the pages after, since the elision before it may straddle the break. Then, if
    it is whole (not `start,end`, whose middle no page text gives), it is split at a word
    boundary, its first part at its last match on the page, nearest the break, as
    `splitAcrossPages` splits a quote (§5). Each page's share is then its own passage, paired
    with its page.

The viewer only ever receives plain segments.

## 3. How big

Measured over the sample's 65 quotes, as relative URLs on that file's 36-character slug. The
fixed part, `/pdf/<slug>#page=&text=`, is 53 characters of each, as the sample was measured:
`sheet=` adds one to every figure below that holds a page.

| Encoding | median | p90 | max |
|---|---|---|---|
| The quote itself | 38 chars (7 words) | 97 | 251 |
| Today's stored target (`anchored_link_anchor.selector`) | 495 bytes | 622 | 1,000 |
| … as base64 in a URL | 618 chars | 782 | 1,270 |
| Fragment link, whole quote | 91 chars | 149 | 303 |
| **Fragment link, writer's form** (whole up to 8 words, otherwise 3+ words at each end) | **87 chars** | **100** | **113** |

For comparison, a relative `/link/<id>` is 31 characters, and the absolute ones in the sample
doc are 64. The sample's 65 fragment links come to 5.6 KB of hrefs, against 4.2 KB of
`/link/` hrefs today. Those 4.2 KB also stand for 130 rows holding 31 KB of stored targets.

**So length needs no limit.** `start,end` keeps a long passage as short as a short one, which
is why Text Fragments has it. Hrefs are mark attributes, which `prose_text` never reads, so they
add nothing to the search index. Two caps remain, and neither is about size:

- **A passage lies on one page.** A quote that crosses a page break is two passages (§5).
- **A link names at most eight passages**, so a pathological URL can't make the viewer extract
  text from a hundred pages.

## 4. Matching: the skeleton

A passage matches the page text when **their skeletons are equal**. A skeleton is the text's
letters and digits, in order, after NFKD with combining marks dropped and case folded. The match
must also start and end on a word boundary of the page text.

**The PDF's text is the reason.** Its stored text breaks words apart ("bea tific", "imagin
ation", "W e", and "o f" 2,643 times in the sample book alone), runs words together ("ofAge"),
keeps line-end hyphens ("inter- national") and folds quotation marks to ASCII. A corrected
extraction such as booktext's, or a model's own quote, differs from it in exactly the
characters a skeleton drops. In the sample, all 65 quotes as written from the corrected copy
resolve to exactly the range their stored anchors cover.

- **The word-boundary rule** stops "the totem" from matching the end of "breathe totem". The
  sample doesn't need it, but short quotes do. Its cost: a quote ending at a word the PDF has
  run into the next one ("Comes of" before "ofAge") misses, and the writer extends it by a word.
- **It forgives typography, never a word.** An OCR error that changes letters ("AGB" for "AGE")
  is a miss, which the check reports (§8). Because `start,end` doesn't match the middle, an
  endpoint can step around a bad word, a footnote number, or the folio and running head at the
  foot of a page.
- **First occurrence wins**, as in Text Fragments. The reader never asks whether there is
  another; the writer guarantees the first is the one meant (§8). A `p` naming several sheets
  extends it across them: the first sheet that holds the passage (§2, "Which sheet").
- **Repeats are counted apart, never inside one another** (`countPassageOccurrences`): a `start`
  that recurs within the passage it begins is the same passage, not a second one.
- **It barely depends on the normaliser.** Every step of `normalisePageText` (spacing,
  ligatures, soft hyphens, dashes and quotation marks; PDF.md §3) leaves a skeleton unchanged,
  so a change to any of them can't break a fragment link. What can is a normaliser change that
  adds or drops letters or digits, or a pdfjs bump that extracts different ones or reorders
  them; §9 is what notices.
- **No worker is needed.** PDF.md §4 keeps its fuzzy step off the main thread because it is
  slow. A skeleton match is one `indexOf` over a page, and nothing here is fuzzy.
- **Segments match in order.** Each is matched as a passage is, at its first match after the
  previous segment ends, which is never worse for the segments after it than a later match
  would be. The passage's range runs from the start of the first segment to the end of the last,
  the words left out inside it. A gap may match no words at all, which is what lets a `[sic]`
  stand between two segments. Only the last segment answers to the suffix, so it alone is looked
  for past its first match, as Text Fragments looks for an `end` past its first.

All of this is `src/lib/pdf-fragment.ts`. **MCP.md's PDF locator uses the same rule** (MCP.md
§7, §8), and the sample shows why. Exact matching after folding quotation marks, dashes and
whitespace finds 34 of its 62 whole quotes, and a pass that tolerates line-end hyphens adds
none; the skeleton finds all 62. MCP.md's stance that "only an exact match anchors" survives: a
skeleton is exact in every letter and lenient only in typography.

## 5. Cross-page passages

**One passage can't span a page break.** A page's stored text ends with its folio and running
head, and the next page's may begin with a chapter heading:

```
…It may also sometimes be detected within, but it 4 1 Original Participation
is detected primarily without. The human soul may be one o f …
```

So the quote's skeleton isn't contiguous across the break. Measured on that quote, the whole
quote is no match, while its two halves match exactly.

**It is two passages, split where the page breaks**, which is also how the stored target already
thinks: one `pageIndex` per target. Each half names its own page, in either form, and is
outlined on its own page, and the viewer jumps
to the first. The booktext copy marks the break inline ("…but it [p. 42] is detected primarily
without"), so an author quoting from it knows where to split. The CLI, holding only the whole
quote, finds the split itself (`splitAcrossPages`, §8): it tries each word boundary between page
n and page n+1, and keeps the split where both halves match on their pages.

A written quotation is split the same way by `passagePieces` (§2, "A quotation's segments"),
which also lets an elision straddle the break: the segment after it then starts the next page's
passage.

This is the case the selection capture gets wrong. A selection across a page break keeps the
quads on its first page only, and its quote is lost, because the selected text isn't on that
page (`captureTextTarget`, `capturePdfTextAnchor`).

## 6. The viewer

`usePdfFragment` (`src/components/pdf/use-pdf-fragment.ts`) resolves the fragment on arrival
and on every `hashchange`, and `PdfAnnotationSurface` draws what it finds. `PdfViewer` applies
`#sheet=` (or `#page=`) and `#p=` on its own (`pageFromHash`), so the viewer opens on the right
page before the passage is found.

**Each page is read by the version it names** (`readPage`, `src/lib/pdf-link-reading.ts`;
[PDF.md](PDF.md) §13, "Links into the file"). The steps below are for a page that names the
version shown, which on a file with one version is every page.

- **From the bare address, a link that names another version goes to that version's own
  address**, `/pdf/<slug>/v/<n>#…`, with the link as written, before the viewer mounts
  (`PdfSurfaceClient`). No version has a page map yet, so no link is carried to the latest
  instead.
- **On a version's own address the viewer stays.** A passage that names another version is
  not looked for: its row in the banner offers it at that version's address. `PdfViewer`
  opens at no sheet for it (`opensAt`), since the sheet named is one of other bytes.
- **A page that names an abandoned version, or one the file never had,** has no version to
  open. Its passage is looked for by its words alone, on every sheet of the version shown,
  and drawn where exactly one holds it once; its row says it was found that way, or that it
  wasn't. A link without words gets a line saying which of the two it is. One that names a
  version the file never had still opens the sheet as written.

**A `p=` waits for the labels**, which pdfjs reads on load (`usablePageLabels` in
`PdfViewer.tsx`). The handle keeps them as read (`ownPageLabels`) beside the filled-in ones it
shows (`pageLabels`), since `p` is matched against the first (§2, "Which sheet"). NULs are
dropped from the first, as the copy stored on `file` drops them, so the viewer and the check
name the same sheets.

1. **Parse** `location.hash` into passages with `parseFragmentPassages`
   (`src/lib/pdf-fragment.ts`). Each names a sheet or a label (`PageName`,
   `src/lib/pdf-open-params.ts`).
2. **Find each passage on the sheets its page names**, in order (`sheetsNamed`): one for
   `sheet=`, every sheet carrying the label for `p=`. Each page is read once per document, from
   `pdf.getPage(n).getTextContent()` through `normalisePageText`: the same text the stored page
   text came from. The passage is matched by skeleton, each segment after the one before (§4).
   **The outline covers the whole range**, the words left out between segments included; how
   the viewer shows them apart is not settled (§13).
3. **A miss looks beyond its page.** When none of those sheets holds a passage, in either form,
   the viewer asks the server where it is instead: `locateFragmentMisses`
   (`src/app/actions/pdf-fragment.ts`), once for every miss of the fragment.
   - **The answer is a sheet** when the passage occurs exactly once in the file outside the
     sheets named, by the rule the check uses for "the page the passage is on" (§8,
     `passageElsewhere`), and nothing otherwise. The viewer reads that one page and draws the
     passage there.
   - **The request is gated by `canUserReadFile`**, as the bytes are, and an unreadable file
     answers every miss as a file that holds none of them does (§8, "It reads as the
     operator"). It searches the stored page text (`FragmentChecker.sheetHolding`), so the
     viewer extracts no page beyond the one answered.
   - This is what carries a `p=` link through labels that were corrected, and a `sheet=` link
     through a sheet added or removed before it.
4. **Measure its quads from the items' geometry**, with `quadsForRange`
   (`src/lib/pdf-quads.ts`). The offsets map the range to items, and each item's transform,
   width, and font ascent and descent (from `getTextContent`'s `styles`) place its run on the
   page.
   - **Where a run starts and ends inside an item is measured**, the way pdfjs's text layer
     measures it. A canvas measures the item's string in the item's CSS font, and the run's
     edges are those advances' share of the item's width. The text layer scales each span to
     the item's width by the same measurement, so the outline's edges fall where a selection's
     do. On the e2e fixture, where each line is one item, even spacing missed a real selection
     by 13.5px, while measured spacing is within 2px. Without a canvas (on a server) the
     function measures in standard widths instead ([PDF_QUADS.md](PDF_QUADS.md)).
   - **Not a DOM range over pdfjs's text layer.** The jump needs the quads before the page is
     scrolled into view and its text layer exists. Mapping spans to items would also tie the
     outline to which span pdfjs draws for which item, which is not a public API (PDF.md §0,
     invariant 6).
5. **Draw and jump** as a followed anchored link does: `PdfTarget`s held in memory, drawn
   through `entriesForPage` as `variant: "link"` regions (the same outline), with
   `jumpToTarget` on the first passage found. A reader sees the same thing whichever kind of
   link they followed.
   - **The jump happens once per fragment**: on arrival, and again when a `hashchange` names
     new passages. The fragment is published once, after the server has answered for its
     misses, so a passage found elsewhere doesn't move the view a second time.
   - **On arrival a followed `?sel=` link keeps its own jump.** The two can arrive together,
     and both are drawn.
6. **A banner** lists the passages as jump handles. It is `PdfFragmentBanner`, a sibling of
   `AnchoredLinkBanner` on the same stylesheet, because nearly all of that one is about a row a
   fragment link doesn't have: a name, Edit, the excerpt page, other targets. The two banners
   stack in one overlay rather than covering each other.
   - **A passage that isn't found is listed as "Not found on page n"**, and its row goes to
     that page. An anchored link's banner lists a part that resolves nowhere without saying so.
     Here the reader can read the PDF, so saying so leaks nothing, and a miss is worth knowing
     about: the link is wrong, or extraction changed (§9).
   - **A passage found elsewhere** names both pages, the one the link gave and the one it was
     found on: "On page 50, not 49:" before its words, since the row clamps them.
   - **Every page is named by its label**, as the rest of the viewer names it
     (`pageLabelFor`), whichever form the link used. So a `sheet=53` miss reads "Not found on
     page 49" where sheet 53 is labelled 49. A `p=` whose label no sheet carries is named as
     the link wrote it, and its row goes nowhere, since no page is the one it names.
   - **The banner shows the PDF's words at the match, never the URL's.** Otherwise a crafted
     URL could make the page present arbitrary text as a quotation from the file. This is
     PLAN.md §12i's "the selected text is a request field only" again. So a row reads as the
     stored text does, artifacts and all ("Every thing proclaims the glory o f God").

An annotation's permalink fragment has no `=` and is unaffected.

**A tab whose bundle predates `...`** ignores every `.`, so it reads an elided link as one
unbroken passage, misses, and says "Not found".

**A tab whose bundle predates `p=`** ignores it: it opens such a link at the first page and draws
nothing. In a link that mixes the two forms it pairs a `p=`'s `text` with the `page=` before it,
and reports that passage not found there.

**A tab whose bundle predates `sheet=`** ignores it in the same way: it opens such a link at the
first sheet and draws nothing, and pairs its `text`s with the `page=` or `p=` before them, if
any.

## 7. Arriving signed out, or by an old slug

**Sign-in hands the fragment on.** The PDF route's gate sends a signed-out reader to
`signInPath(pathWithQuery(…, { sel }))`. No gate can put a fragment in `callbackUrl`, since
none reaches a server, but the browser carries it onto `/sign-in?callbackUrl=…#sheet=…` (RFC
9110 §10.2.2). The form then navigates through `withArrivalFragment`
(`src/lib/sign-in-redirect.ts`), which appends that fragment when `callbackUrl` has none of its
own. Search's page links and annotation permalinks ride along the same way, and a `p=` exactly
as a `sheet=` does. The no-JS path can't see the hash, and can't run the viewer either.

**A renamed slug needs nothing.** The slug-history redirect's `Location` has no fragment, so the
browser re-applies this one. That rule governs real HTTP redirects. Prose links are plain
`<a>`s, so following one is a full navigation and both redirects here are real ones.

`e2e/pdf-fragment-links.spec.ts` covers both, and its sign-in case fails without the form's
change.

## 8. Writing them

**The pure half** is under `npm run test:unit`, because its rejection surface is the point:
parsing and formatting the fragment, its segments, the skeleton and the match, the writer's form
and the cross-page split (`src/lib/pdf-fragment.ts`); a written quotation's segments, its
brackets and its page breaks (`src/lib/pdf-passage-pieces.ts`); a page and its label (`src/lib/pdf-open-params.ts`,
`src/lib/pdf-page-labels.ts`); and the check's reading of an href and its findings
(`src/lib/pdf-fragment-findings.ts`).

**The writer's form** (`writerForm`). A passage of eight words or fewer goes whole. A longer one
goes as its first three and last three words, each extended a word at a time until the
passage's first occurrence on the page is the one meant. A prefix is added only when extending
can't tell two occurrences apart, as with a short quote the page repeats. All 65 sample quotes
take that form without a prefix (§3). A passage with words left out goes segment by segment
(`segmentedWriterForm`): each whole up to eight words and otherwise by its ends, every long one
extended alike.

**Every link a writer emits carries its stamp** (`formatPageName` takes a page with one,
`StampedPageName`, so the compiler names a writer that leaves it off): the version its writer
read, once the file has a second version, and nothing while it has one (`pageStampFor`).
A parser's `PageName` is a different type, where a missing stamp is a reading and not an
omission. The check's and MCP's corrected forms are written the same way.

**Which page form a writer takes** (`pageNameForSheet`, `src/lib/pdf-page-labels.ts`):

- **`p=` when the file has usable labels, and `sheet=` otherwise.** A `p=` written against a file
  without labels is a sheet number by §2's rule 2, and would turn into a printed page the day
  the file gained labels. The check warns on one, giving its `sheet=` form.
- **`sheet=` also where the label repeats** and an earlier sheet with that label holds the
  passage, since rule 3 would draw it there.
- **`sheet=` also for a sheet whose own label is empty**, which no `p` names.
- **The writer's form is unchanged.** Uniqueness is still judged on the sheet that holds the
  passage.
- **Search's page links** (`src/lib/search/pdfs.ts`) **and the cited-page route's redirect**
  (`pdfPageHref`, `src/lib/entity-chips/kinds/citation.ts`) **follow the same rule.** They are
  the page links nobody chooses the form of, and are copied into bodies from the address bar.
  - A page link has no passage for rule 3 to find, so it opens at the first sheet carrying its
    label.
  - A search hit starts from a sheet. It writes `p=` when that sheet is the first carrying its
    own label, and `sheet=` otherwise, as for a sheet whose own label is empty. It reads the
    stored labels only, as its label does, so a file whose labels haven't been read yet is
    linked by sheet.
  - The redirect starts from a label (`pageNameForLabel`). On a file with usable labels it
    writes `p=`, with the label as the file gives it, and on one without, `sheet=` with the
    page as the sheet itself, if the file has that many. Its sheet is found by §2's rule, so a
    citation and a `p=` link of the same page land on the same sheet: a label matches trimmed
    and in any case, and a file whose labels are all empty takes the page as a sheet number. A
    file whose labels haven't been read yet has them read and stored on the first citation
    followed into it (`pdfMetadata`, MCP.md §8).
- **Existing `page=` links stay as written**, and are read as `sheet=` (§2). Most of them are
  hand-written citations, which
  CITATIONS.md's "Converting the hand-written citations" turns into citation chips. A URL that
  conversion keeps as a referent gets `p=` where its file has usable labels.

**Writing one needs nothing from the instance.** An author quoting from a corrected extraction,
such as booktext's, writes the writer's form straight into the Markdown:

- **the page**: the printed page the copy cites, as `p=`, where the PDF's labels agree with it,
  so a corrected copy that cites printed pages needs no conversion; and otherwise the sheet
  number from the extraction's own page map (booktext's header gives it, as "pdf page =
  printed page -1");
- **the words** from the corrected copy, since its skeleton and the stored text's agree (65 of
  65 in the sample);
- **uniqueness** judged on the corrected copy's page, for the same reason.

The import stores hrefs as written and checks none of them. §9's script is what confirms them,
with `--doc` for the one doc just imported. Nothing before the import touches the instance,
which is what replaces the minting scripts. CLAUDE_IMPORT.md §8 has the steps.

**The check** (`src/lib/pdf-fragment-check.ts`, with its findings in
`src/lib/pdf-fragment-findings.ts`) is shared by everything that confirms links. Every link
mark whose href is a fragment link, relative or on the instance's own origin (`APP_URL`), is
resolved against the file's stored page text, on the sheets its page names (§2, "Which
sheet"). It reports, per link:

- ok, also for a passage found on a later sheet of a repeated label;
- **no match**, with where the skeleton stops matching and what the PDF has there, and the page
  the passage is on when it occurs exactly once elsewhere in the file. A segment that matches
  nowhere after the one before it is a miss, with where it stops after that one;
- **a warning when the passage repeats on its page**, since the link points at the first
  occurrence and only the author knows which one was meant;
- a page out of range, which is also a `p=N` past the end of a file without usable labels;
- **a label no sheet carries**, with the page the passage is on when it occurs exactly once in
  the file;
- **a warning for a `p=` on a file without usable labels**, with its `sheet=` form;
- **an unknown file**: no live file has the slug, past slugs followed. A link naming a past slug
  is a warning, since the redirect still carries it.

**It reads page links too**: an href to `/pdf/<slug>` with a `sheet`, a `page` or a `p` and no `text`
(`parseFragmentLinkHref`). A page past the end and a label no sheet carries are findings for
one as for a passage, and so is a `p=` on a file without usable labels, in the integrity script
and in MCP's write check.

Three properties of the check:

- **It holds only the pages links name.** A run reads each named page once and keeps it, so
  what it holds grows with the links rather than with the books they cite. A miss is the one
  finding that reads past its page (the page it is on instead), so a miss reads that file
  whole, and the check keeps one whole file at a time. The CLI asks for the whole file
  outright. Holding every page of every file a run touched was enough to exhaust the web
  process's heap: one doc linking into 75 books named 26,000 pages.
- **It is read-only.** It reads the latest version's `file_page_text` directly rather than
  through `storedPageText`, which would extract a file that lacks the current version. It takes the current version where
  the file has one, and otherwise the greatest it has, as search does (FULLTEXT.md §4); a
  skeleton barely depends on the version (§4).
- **It reads labels only for a `p`.** It reads `file_version.page_labels`, and a file whose labels
  haven't been read yet (NULL, since they are filled on first read, MCP.md §8) has them read
  from its bytes and not stored, since the check writes nothing.
- **It reads as the operator**, since the scripts that call it hold the database's credentials.
  A front door that reads as a user, as MCP's write check and the viewer's miss do, must ask
  `canUserReadFile` first and answer an unreadable file as not found. Otherwise the check would
  answer "does this PRIVATE file contain these words?"

It runs in:

1. **The integrity script** (§9), over everything or over one doc.
2. **A one-quote CLI**, `npx tsx scripts/pdf-fragment-link.ts <slug> <sheet> "<quote>"`, or
   `--page <label>` in place of `<sheet>` (`--label`, its older name, is read the same). It prints the writer's form in whichever page form the
   file takes, or the reason there isn't one, for checking a quote before writing it.
   - The page is a hint: it tries the page given, then its neighbours, then the one page in the
     file that holds the quote once. A label is tried on every sheet carrying it first, then on
     the first one's neighbours; the search works in sheets.
   - The quote is read as a written quotation (§2, "A quotation's segments"): an ellipsis or a
     bracket standing alone is a gap, and an attached bracket is tried with its letters and
     without. A quote elided with "…" or "..." comes back with its segments joined by `...`.
   - A quote that runs across a page break comes back as two passages (`passagePieces`), split
     inside a segment or at an elision.
3. **The MCP server.** Every body a call writes is checked before anything is written:
   `create_doc`'s, `edit_doc`'s replacements and appends, and `add_note`'s and `edit_note`'s. A
   miss, a page past the end or a label no sheet carries refuses the call with `no_match`, as
   MCP.md §7 answers an anchor (MCP.md §8), and a `p=` on a file without labels is a warning.
   `create_doc`'s description tells the model to write the printed page, and `read` takes a
   `p=` link as it takes a `sheet=` one.

**Any text that holds a link holds them.**

- **Docs, posts and annotation bodies** take relative hrefs through StarterKit's Link.
- **A comment's link passes `isAllowedCommentHref`** (`src/lib/comment-body.ts`). It takes
  absolute http, https and mailto URLs, and a root-relative path the URL parser settles under
  `/pdf/` on this origin, so `/pdf/../elsewhere` and `/pdf/\host` are refused.
- **A relative href resolves wherever it is shown.** Nothing renders a comment body off the
  site: no email carries one, and the RSS feed carries a post's first 300 characters as plain
  text.

**Not built yet: "Copy passage link"** in the viewer's selection popover, beside Annotate and
Add to link. It would split the selection by page, take each part's writer's form against that
page's normalised text, and copy the result, making no request and writing nothing. It is the
one way a cross-page link could be made from the UI.

## 9. Keeping them true

A fragment link is found again on every open, so it stays correct only while extraction yields
the same letters in the same order. The guard is `scripts/integrity/check-pdf-fragment-links.ts`
(`--doc <idOrSlug>`, `--verbose`).

- **What it checks.** It runs §8's check over every fragment link and page link in docs'
  `proseJson`, posts' `proseJson`, comment bodies and annotation bodies, none of them deleted.
  It checks every citation's passage too, by the link it renders or the link a post froze
  (CITATIONS.md, "Its checks").
- **What fails it.** It exits non-zero on an ERROR: a miss, an unknown file, a page out of range,
  a label no sheet carries, a `text` parameter that doesn't parse, or a `v=` naming a version
  the file never had. A repeated passage, a past slug and a `p=` on a file without usable
  labels are warnings.
- **It reads a link as the viewer does**: each page on the version it names, a link to a
  version's own address included (`/pdf/<slug>/v/<n>#…`). So words the latest version lacks
  are no fault in a link that names an earlier one, and `--verbose` lists such a link. A
  link naming an abandoned version is a warning, since nothing can confirm it, and so is one
  on a version's own address that names another.
- **It warns of a link without `v=` written after its file's second version was uploaded**,
  which only a hand can have typed and whose writer most likely meant the latest. It dates
  the link by the update log (`src/lib/pdf-link-dating.ts`), which the viewer can't
  ([PDF.md](PDF.md) §13, "Links into the file").

When to run it:

- **After importing a doc that carries fragment links.** `--doc` checks just that one.
- **On a pdfjs bump, after `upgrade-pdf-text-version.ts`** (PDF.md §10). That is where a break
  would come from.

`Doc.proseJson` lags the live doc by seconds, which is fine for a check that positions nothing.

## 10. What a fragment link gives up

- **A landing page.** A reader who can't open the PDF meets the PDF route's gate, not an
  excerpt page that names nothing.
- **Privacy from the doc's own readers.** The href carries the PDF's slug and the passage's
  words to everyone who can read the doc, whether or not they can open the PDF. An anchored
  link's id carries neither.
  - **In a PRIVATE research doc** the readers are its byline, and in the sample 60 of the 65
    links' text *is* the quote. The other five shorten or elide it.
  - **A SHARED doc, a post published from one, or a comment on a published post shows both to
    all its readers.** Publishing copies hrefs as they are. Where a private file's slug or words
    matter, use an anchored link.
- **Backlinks.** Nothing indexes hrefs, so `/links` lists none, and "links into this file"
  can't see them. Full-text search still finds the docs, since the quoted words are in their
  text. A derived index (`doc_id`, `file_id`, `page`), rebuilt from `proseJson`, is possible
  later but not planned.
- **Measured once.** PDF.md §4's quads never need re-finding, and a fragment link's do (§9).
  MCP.md §8 rejects quad-less *stored* anchors for that reason, and the rejection stands for
  them. A fragment link is not a stored anchor.
- **Names and editing in place.** There's nothing to name, and changing a link means editing
  its href.
- **Text it can't see.** A scanned PDF with no text layer has nothing to match, and MCP.md §8's
  caveat about CJK text and predefined CMaps applies here as well.

## 11. Where it lives

| | |
|---|---|
| `src/lib/pdf-fragment.ts` | the grammar and its segments, the skeleton match, the writer's form, the cross-page split; unit-tested, with pairing by `sheet`, `page` and `p` |
| `src/lib/pdf-passage-pieces.ts` (`quotationText`, `passagePieces`) | a written quotation as segments, and those settled against the pages: brackets and page breaks; unit-tested |
| `src/lib/pdf-open-params.ts` | a page as a fragment names it, `sheet=` (or `page=`, read only) or `p=` (`PageName`), read and written; unit-tested |
| `src/lib/pdf-page-labels.ts` (`sheetsLabelled`, `sheetsNamed`, `pageNameForSheet`, `pageNameForLabel`) | which sheet a label names, and which form a writer takes; unit-tested: repeated labels, a file without labels, a label no sheet carries, a sheet whose own label is empty |
| `src/lib/pdf-quads.ts` | the quads of a range of normalised text, from text items; unit-tested |
| `src/components/pdf/use-pdf-fragment.ts` | the viewer's resolution, with the canvas measurer |
| `src/app/actions/pdf-fragment.ts` (`locateFragmentMisses`) | where a missed passage is instead, gated by `canUserReadFile` |
| `src/components/pdf/PdfFragmentBanner.tsx` | the banner |
| `src/components/pdf/PdfAnnotationSurface.tsx` | the regions, the jump, and the overlay both banners share |
| `src/lib/sign-in-redirect.ts` (`withArrivalFragment`) | the fragment through sign-in; unit-tested |
| `src/lib/comment-body.ts` (`isAllowedCommentHref`) | `/pdf/` hrefs in comments; unit-tested |
| `src/lib/pdf-fragment-findings.ts` | which hrefs are fragment links or page links, and what each comes to against a file's pages; unit-tested, page links and labels included |
| `src/lib/pdf-fragment-check.ts` | the check: the pages and labels it reads, and `sheetHolding` for the viewer's miss |
| `scripts/integrity/check-pdf-fragment-links.ts` | the integrity script |
| `scripts/pdf-fragment-link.ts` | the one-quote CLI |
| `e2e/pdf-fragment-links.spec.ts` | whole, `start,end`, prefixed and cross-page passages, a miss, a hashchange, the outline against a real selection, a renamed slug, signing in; and on a fixture with page labels, a `p=` passage on a page whose label differs from its sheet, a label shared by two sheets, a page link, a miss found on another page, and a label no sheet carries |

**Not built:** Copy passage link (§8).

## 12. Deviations from the plan

- **Quads are placed by measured spacing in the browser** (§6), not by even spacing within an
  item, after the e2e spec showed even spacing 13.5px off a real selection.
- **The check reads stored page text directly**, not through `storedPageText`, so that it never
  writes (§8).
- **A repeat is counted apart, never inside itself** (§4). Counted the planned way, "To be able
  … that is imagination" would have warned of a repeat because its second "to be able" falls
  inside the passage.
- **The CLI also reads an elided quote** ("…" or "..."), now as segments (§8).
- **The two banners share one overlay**, stacked (§6).

From the printed-page plan (`p=`):

- **The check's pure half is its own file**, `src/lib/pdf-fragment-findings.ts`, since a unit
  test can't import the half that reads the database. The plan's unit tests of a page link and
  its findings need it.
- **A label no sheet carries is its own finding** (`no-such-label`), an ERROR as a page out of
  range is, rather than that finding itself, and it says where the passage is when it occurs
  once in the file. A `p=N` past the end of a file without usable labels is a page out of
  range, since it is a sheet number there.
- **"`p=5` never names a sheet whose own label is empty" holds on a file with usable labels.**
  On a file without them `p=N` is sheet N whatever its own label says (§2, rule 2), as the
  plan's rule for a file whose labels are all empty requires.
- **The viewer drops NULs from the labels it matches**, as the stored copy drops them, so it
  and the check never name different sheets.
- **The viewer asks for every miss at once**, and publishes the fragment once, after the
  answer, so the jump still happens once per fragment (§6).
- **A miss whose label no sheet carries is a plain row**, not a button: there is no page to go
  to.
- **The cited-page redirect reads a file's labels on first use** (`pdfMetadata`), storing them,
  where they haven't been read yet, rather than taking the page as a sheet number for such a
  file. The plan didn't say.
- **MCP's `read` takes `p=`** for a passage and for a page link, beside the write check the plan
  names, since a model reads back the links it writes.
- **MCP's write check now refuses a page link to a PDF that doesn't exist** or isn't the
  actor's to read, as it refuses such a fragment link, since page links are checked.

From the elided-passage plan (`...`):

- **The CLI reads a quote through `passagePieces`**, not just its `...`: it settles brackets as a
  citation's passage does, and splits at an elision as well as inside a segment.
- **Two ellipses in a row are one gap**, and a prefix or a suffix on an inner segment makes the
  value unreadable. The plan said only "exactly three dots"; four read as `...` and a `.`.
- **`. . .` and `[. . .]` are gaps** in a written quotation, beside `…`, `...`, `[…]` and
  `[...]`.
- **A bracket standing alone takes what is attached to it** up to the next space, so `[the
  soul]'s` leaves no `s` to miss, and **a bracket holding a space stands alone**. The plan had
  neither case.
- **More than four attached brackets in one passage** are tried all kept and all dropped only,
  rather than every combination.
- **A segment that straddles a break is looked for whole on the next page first**, then split,
  and an elision may straddle a whole page. The plan named the two cases without an order.

## 13. Planned: how the viewer shows elided words

**Not built, and held.** The viewer receives a passage's segments and outlines its whole range,
the words left out between segments included (§6). How the outline and the banner show the gaps
apart from the quoted words is not settled.

## Appendix A. How the numbers were measured

- **The sample.** A 190-page born-digital book and a 65-quote summary of it, whose links are
  65 single-part `PDF_TEXT` anchored links.
  - Each quote was written from a corrected text extraction with printed page numbers. The
    PDF's sheet number is the printed page minus one through most of the book.
  - Three of the quotes were given as first and last words, and the rest whole.
- **Stored page text.** `file_page_text` at the anchors' text version, `6.2.108/2`.
- **"Resolves"** means the skeleton match (§4), run over that text, returns exactly the
  `position` range the anchor stores.
  - The whole authored quotes and authored pairs: 65 of 65.
  - The writer's form, built from the authored words: 65 of 65, none needing a prefix.
  - Without the word-boundary rule: also 65 of 65.
  - For comparison, exact matching after folding quotation marks, dashes and whitespace found
    34 of the 62 whole quotes, with or without a pass that tolerates line-end hyphens.
- **Sizes** are character counts of relative URLs, or bytes of the stored jsonb's text for the
  stored targets.
- **Checked by hand after the build**, with the book ingested into a dev database:
  - the CLI linked all 65 quotes on the sheet numbers their author would write, with no page
    corrected;
  - the summary, rewritten with those links and imported with `import-claude-chats.ts
    --markdown`, kept every href intact, and the integrity script found all 65. Its one
    warning was true: "law of participation" occurs twice on its page, and the first is the
    one meant;
  - the viewer drew all 65 on their glyphs. One of them steps around the PDF's own OCR error,
    "were bom when" for "were born when", because a `start,end` passage's middle isn't matched.

**For `...`**, measured on explore's docs on 2026-11-10: every live doc holding a fragment
link, 33 docs with 5,662 links, all written by Claude. An author's own docs will likely hold
more `[sic]`, `[T]he` and `[…]`. The classifier is a heuristic, which matches runs of quoted
words by skeleton, and not the finder a citation's `quote:prev` has.

| | |
|---|---|
| Quotations directly before a link | 4,947 |
| … holding an ellipsis | 102 (2.1%). 4 hold two |
| … holding a bracket | 11: 4 attached to a word (`form[s]`, `correct[ed]`, `[a]ll`), 1 `[sic]`, and 6 standing alone (`[of the soul]`, `[the rich]`, `[already]`) |
| Block quotes holding a link's words | 68: 8 with an ellipsis, one of those with two, and 1 with `[sic]` |
| Links with two `text`s on one page | 0 |
| `text` values holding a single `.` | 140 of 5,832. None holds `...` or `…` |

In a copy of 2026-10-19, 10 docs with 1,793 links, 57 of the 58 quotations holding an ellipsis
had the gap inside, and in 32 of those the `start,end` link covered the elided words. Not
measured again.

## Appendix B. Prior art

- **Text Fragments** (WICG, [spec](https://wicg.github.io/scroll-to-text-fragment/)).
  - `#:~:text=[prefix-,]start[,end][,-suffix]`, with several directives allowed in one URL.
  - The spec recommends `start,end` so that a long passage doesn't bloat the URL.
  - Its dash, ampersand and comma are percent-encoded wherever they occur in the text. Dropping
    punctuation altogether removes that rule here.
  - The directive is hidden from script, which is why it can't be used here (§2).
- **RFC 8118, the `application/pdf` media type** ([RFC](https://www.rfc-editor.org/rfc/rfc8118.html)).
  - Fragment parameters such as `page=`, `nameddest=`, `highlight=<l,r,t,b>` and `search=<words>`,
    separated by `&` and processed left to right.
  - `#page=` is what this viewer reads, as `sheet=`'s older name (§2); `highlight=` is the
    geometric form rejected in §2.
- **W3C Selectors and States** (2017, [note](https://www.w3.org/TR/selectors-states/), §5).
  - The general form: `#selector(type=TextQuoteSelector,exact=…,prefix=…,suffix=…)`.
  - The note itself warns that such URLs grow long.
- **RFC 9110 §10.2.2.** A redirect whose `Location` has no fragment inherits the request's,
  which is what carries a fragment link through the slug-history redirect (§7).
- **The sample's offline script**: a letters-and-digits skeleton, the page given plus or minus
  one, and quotes as first and last words. The rule in §4 is that script's, with a word-boundary
  rule added.
