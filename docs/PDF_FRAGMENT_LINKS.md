# PDF fragment links — a link to a passage, with no row

**Status: planned; nothing here is built.** Like [MCP.md](MCP.md), this file is the plan until
the build and is then rewritten as built. MCP.md, the MCP server's plan, is on the `api-mcp`
branch until it merges. This plan shares its PDF locator and its server-side quads.

A **fragment link** is a URL that names a passage of a PDF by its words:

```
/pdf/owen-barfield-saving-the-appearances#page=122&text=could+not+yet+call+his+soul+his+own
```

Following it opens the PDF at that page with the passage outlined, exactly as a followed
[anchored link](ANCHORED_LINKS.md) draws one. Making it writes nothing: the URL is the whole
record.

**Why.** A research summary quotes its sources dozens of times, and today every quote is an
anchored link. That means two rows and a stored target of about 500 bytes for each quote,
minted through a signed-in session, because that is the only way in. The sample this plan was
measured on is a summary of a 190-page book that quotes it 65 times (Appendix A). Making those
links took a script that ran pdfjs over a local copy of the PDF to compute each passage's
quads, and a second script that drove the site's server actions with a session cookie. With
fragment links, the summary's Markdown import is the only write the summary needs.

**Anchored links stay** for everything a fragment link can't do (§1). This plan adds a second
kind of passage link and replaces nothing.

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

**PDFs only, because their bytes never change.** A file's `sha256` is its identity, so a
passage named by its words is always in the same place in that file. The same URL into a doc
would need COLLAB.md's drift machinery to stay true. Passages in docs, including the section
links in imported chats, stay anchored links.

**The fragment grants nothing.** The PDF route's gate runs exactly as for a bare `/pdf/<slug>`,
the same rule as `?sel=` (ANCHORED_LINKS.md, "Following a link"), and the fragment can only
name passages inside the file that gate allowed.

**Any text that can hold a link can hold one**: a doc, a post, a comment or an annotation's
body. Comments need one change for it (§8).

## 2. The URL

```
/pdf/<slug>#page=<n>&text=<passage>[&page=<n>&text=<passage>…]

passage = [<prefix>-,]<start>[,<end>][,-<suffix>]
prefix, start, end, suffix = word *("+" word)
```

- **`page`** is the 1-based sheet number, exactly as `#page=` means it today
  (`src/lib/pdf-open-params.ts`): never a label. It also keeps old readers working. A viewer
  that reads only `#page=`, as this one does now, still opens at the passage's page.
- **`text`** is [Text Fragments](https://wicg.github.io/scroll-to-text-fragment/)' grammar, minus
  its encoding rules:
  - `start` alone is the whole passage;
  - `start,end` runs from the first word of `start` to the last word of `end`, and nothing
    between them is matched;
  - `prefix-,` and `,-suffix` are words that must come immediately before or after. They exist
    only to tell repeats apart.
- **Pairing.** Parameters are read left to right, as RFC 8118 reads a PDF's own. Each `text`
  belongs to the nearest `page` before it, so a `text` with no `page` before it is ignored.
  Anything else is ignored too, as `pdf-open-params.ts` already ignores what it doesn't
  support.
- **Words are letters and digits only.** Writers drop punctuation, quotation marks, dashes,
  hyphens and apostrophes, fold accents to their base letters, keep case as written, and join
  words with `+`. Readers ignore everything but letters and digits anyway (§4), so a
  hand-written `%20`, comma inside a quote or curly apostrophe does no harm. The exceptions are
  `,` and a `-` beside a comma, which are syntax. So a writer's URL needs no percent-encoding at
  all, except for letters with no ASCII base letter, such as Greek.
- **Relative.** Writers emit `/pdf/…` and never an origin, so a doc keeps working on a copy of
  its instance. An absolute URL on the instance's own origin, as pasted from the address bar,
  is the same link and is read the same way. A slug that later changes is handled by the
  slug-history redirect (§7).

**Examples**, all from the sample. Each resolves to exactly the passage its anchored link
stores today:

```
#page=122&text=could+not+yet+call+his+soul+his+own                   a whole passage
#page=8&text=a+direction+in,a+beatific+consummation                  first words, last words
#page=30&text=law+of+participation                                   the first of two on the page
#page=30&text=identity+but+of+the-,law+of+participation              the second, by its prefix
#page=40&text=It+may+also,within+but+it&page=41&text=is+detected+primarily+without
                                                                     one quote across a page break
```

**Why the fragment, not the query string.**

- **A fragment names part of a resource** (RFC 3986), and every precedent for a place in a PDF
  is one: RFC 8118's `page=`, `highlight=` and `search=`, and this viewer's own `#page=`.
- **It never reaches a server.** There's nothing in access logs, no proxy limit on URL length,
  and nothing in a `Referer`.
- **There is nothing for the server to do with it.** The viewer is a client island behind
  `ssr: false` and finds the passage itself (§6).
- **A redirect carries it for free.** Browsers re-apply a fragment the `Location` lacks
  (RFC 9110 §10.2.2), where `?sel=` has to be re-appended by hand in both of the route's
  redirects. The one place it is lost today is sign-in (§7).

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

## 3. How big

Measured over the sample's 65 quotes, as relative URLs on that file's 36-character slug. The
fixed part, `/pdf/<slug>#page=&text=`, is 53 characters of each.

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
  is a miss, which the writer reports (§8). Because `start,end` doesn't match the middle, an
  endpoint can step around a bad word, a footnote number, or the folio and running head at the
  foot of a page.
- **First occurrence wins**, as in Text Fragments. The reader never asks whether there is
  another; the writer guarantees the first is the one meant (§8).
- **It barely depends on the normaliser.** Every step of `normalisePageText` (spacing,
  ligatures, soft hyphens, dashes and quotation marks; PDF.md §3) leaves a skeleton unchanged,
  so a change to any of them can't break a fragment link. What can is a normaliser change that
  adds or drops letters or digits, or a pdfjs bump that extracts different ones or reorders
  them; §9 is what notices.
- **No worker is needed.** PDF.md §4 keeps its fuzzy step off the main thread because it is
  slow. A skeleton match is one `indexOf` over a page, and nothing here is fuzzy.

**MCP.md's PDF locator uses the same rule** (MCP.md §7, §8), and the sample shows why. Exact
matching after folding quotation marks, dashes and whitespace finds 34 of its 62 whole quotes,
and a pass that tolerates line-end hyphens adds none; the skeleton finds all 62. MCP.md's stance
that "only an exact match anchors" survives: a skeleton is exact in every letter and lenient
only in typography.

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
thinks: one `pageIndex` per target. Each half is outlined on its own page, and the viewer jumps
to the first. The booktext copy marks the break inline ("…but it [p. 42] is detected primarily
without"), so an author quoting from it knows where to split. A selection in the viewer knows
too (§8). A writer holding only the whole quote finds the split itself: it tries each word
boundary between page n and page n+1, and keeps the split where both halves match on their
pages.

This is the case today's capture gets wrong. A selection across a page break keeps the quads on
its first page only, and its quote is lost, because the selected text isn't on that page
(`captureTextTarget`, `capturePdfTextAnchor`).

## 6. The viewer

`PdfAnnotationSurface` owns the targets and `jumpToTarget`, so the fragment is resolved there,
on `ready` and on `hashchange`. `PdfViewer` keeps applying `#page=`, so the viewer opens on the
right page before the passage is found.

1. **Parse** `location.hash` into passages: a pure function beside `pageFromHash`.
2. **Find each passage.** Take the page's text items through the surface's `capturePageFor`
   (cached per PDF.md §3), run `normalisePageText` over them, and match the skeleton (§4). That
   gives offsets into the normalised text.
3. **Measure its quads from the items' geometry**, mapping the offsets to items through
   `offsets` and interpolating within each item from its transform, width and font ascent and
   descent. This is MCP.md §8's server-side quads, written once as an isomorphic function that
   both use. Its e2e check, a real selection's quads against the computed ones, covers both.
   The sample's 65 anchors in use today were drawn with an offline version of it, and some of
   them were checked against page renders.
   - **Not a DOM range over pdfjs's text layer.** The jump needs the quads before the page is
     scrolled into view and its text layer exists. Mapping spans to items would also tie us to
     which span pdfjs draws for which item, which is not a public API (PDF.md §0, invariant 6).
4. **Draw and jump** as a followed anchored link does: `PdfTarget`s held in memory, prepended to
   `entriesForPage` as `variant: "link"` regions (the same outline), with `jumpToTarget` on the
   first. A reader sees the same thing whichever kind of link they followed.
5. **A banner** lists the passages as jump handles, `AnchoredLinkBanner` with no name, no
   excerpts link and no Edit.
   - **A passage that isn't found is listed as "not found on page n"**, and the viewer stays on
     that page. An anchored link's banner lists a part that resolves nowhere without saying so.
     Here the reader can read the PDF, so saying so leaks nothing, and a miss is worth knowing
     about: it means extraction changed (§9).
   - **The banner shows the PDF's words at the match, never the URL's.** Otherwise a crafted
     URL could make the page present arbitrary text as a quotation from the file. This is
     PLAN.md §12i's "the selected text is a request field only" again.

`?sel=` and a fragment can arrive together, and both are drawn. An annotation's permalink
fragment has no `=` and is unaffected.

## 7. Arriving signed out, or by an old slug

**Sign-in drops the fragment today.**

- The route's gate redirects to `signInPath(pathWithQuery(…, { sel }))`, and the browser carries
  the fragment onto `/sign-in?callbackUrl=…#page=…`.
- But `sign-in-form.tsx` then sends the reader on with `router.push(callbackUrl)`, which has no
  fragment.
- Search's `#page=` links and annotation permalinks lose theirs the same way.

**The fix is one line.** The form appends `location.hash` when `callbackUrl` has none, and
`safeCallbackUrl` already keeps `url.hash`. The no-JS path can't see the hash, and can't run the
viewer either. One spec covers it: a signed-out reader follows a fragment link, signs in, and
lands on the outlined passage.

**A renamed slug needs nothing.** The slug-history redirect's `Location` has no fragment, so the
browser re-applies this one. That rule governs real HTTP redirects. Prose links are plain
`<a>`s, so following one is a full navigation and both redirects here are real ones. A spec pins
it, since the `?sel=` precedent shows how quietly passages can go missing at that redirect.

## 8. Writing them

**A pure module**, isomorphic and under `npm run test:unit`, whose rejection surface is the point:

- parsing and formatting the fragment;
- the skeleton and the match;
- the writer's form;
- the cross-page split.

**The writer's form.** A passage of eight words or fewer goes whole. A longer one goes as its
first three and last three words, each extended a word at a time until the passage's first
occurrence on the page is the one meant. A prefix is added only when extending can't tell two
occurrences apart, as with a short quote the page repeats. All 65 sample quotes take that form
without a prefix (§3).

**Writing one needs nothing from the instance.** An author quoting from a corrected extraction,
such as booktext's, writes the writer's form straight into the Markdown:

- **the sheet number** from the extraction's own page map (booktext's header gives it, as
  "pdf page = printed page -1");
- **the words** from the corrected copy, since its skeleton and the stored text's agree (65 of
  65 in the sample);
- **uniqueness** judged on the corrected copy's page, for the same reason.

The import stores hrefs as written and checks none of them. §9's script is what confirms them,
and it can be pointed at the one doc just imported. Nothing before the import touches the
instance, which is what replaces both of the sample's scripts.

**The check**, shared by everything that confirms links. Every link mark whose href is a fragment
link, relative or on the instance's own origin, is resolved against the file's stored page text
(`storedPageText`), at the current text version. It reports, per link:

- ok;
- **no match**, with where the skeleton stops matching and what the PDF has there. When the
  passage occurs exactly once elsewhere in the file (the check tries the page's neighbours, then
  the whole file), it also names that page;
- **a warning when the passage repeats on its page**, since the link points at the first
  occurrence and only the author knows which one was meant;
- a page out of range;
- **an unknown file.** Scripts read as the operator, as every integrity check does. The MCP
  server reads as its actor, so for it a PRIVATE file the actor can't read is unknown. That way
  the check never answers "does this file contain these words?"

It runs in:

1. **The integrity script** (§9), over everything or over one doc.
2. **A one-quote CLI**, `scripts/pdf-fragment-link.ts <slug> <page> "<quote>"`, which prints the
   writer's form or the reason there isn't one, for checking a quote before writing it.
3. **The MCP server**, on every body a call writes: `create_doc`'s, `edit_doc`'s replacements
   and appends, and `annotate`'s and `edit_annotation`'s. A miss refuses the call with
   `no_match`, as MCP.md §7 answers an anchor, so an agent fixes the quote in the same turn
   rather than leaving it for a reader to find broken (MCP.md §8).

**Comments** are the one body that refuses the href today.

- **Why it is refused.** `isAllowedCommentHref` (`src/lib/comment-body.ts`) accepts http, https
  and mailto, and a relative URL doesn't parse without a base. So `hardenCommentLinks` drops a
  relative link and keeps its text.
- **The change.** It gains root-relative `/pdf/` paths. An absolute URL on the site's own origin
  already passes.
- **Why that is safe.** Nothing renders a comment body off the site: no email carries one, and
  the RSS feed carries a post's first 300 characters as plain text. So a relative href resolves
  wherever it is shown.

Docs, posts and annotation bodies take relative hrefs already, through StarterKit's Link.

**Later: "Copy passage link"** in the viewer's selection popover, beside Annotate and Add to
link. It splits the selection by page, takes each part's writer's form against that page's
normalised text, and copies the result. It makes no request and writes nothing, and it is the
one way to make a cross-page link from the UI.

## 9. Keeping them true

A fragment link is re-measured on every open, so it stays correct only while extraction yields
the same letters in the same order. The guard is
`scripts/integrity/check-pdf-fragment-links.ts`. It runs §8's check over every fragment link
in docs' `proseJson`, posts' `proseJson`, comment bodies and annotation bodies, reading as the
operator. It fails on a miss, an unknown slug or a page out of range, while a repeated passage
is only a warning. Given `--doc <slug>`, it checks that one doc, which is how an author confirms
what they have just imported.

- It joins the integrity checks that run after every deploy.
- It joins PDF.md §10's list for a pdfjs bump, after `upgrade-pdf-text-version.ts`. That is
  where a break would come from.
- `Doc.proseJson` lags the live doc by seconds, which is fine for a check that positions nothing.

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

## 11. Build order

1. **The pure module and the quads function**, with unit tests. The fixtures:
   - a page with split, joined and letter-spaced words;
   - a repeated phrase;
   - a footnote number inside a passage;
   - the folio-and-running-head break.
2. **The viewer**: §6, and §7's sign-in fix. `e2e/pdf-fragment-links.spec.ts` covers:
   - a passage on page 2, a `start,end` passage and a cross-page pair, using
     `scripts/make-test-pdf.ts`;
   - a miss's banner row;
   - the signed-out round trip and the slug-rename redirect;
   - computed quads against a real selection's.
3. **The check, the CLI and the integrity script** (§8, §9), and comments' `/pdf/` hrefs, with
   `isAllowedCommentHref`'s unit cases. Add the script to the deploy wrapper's set.
4. **The MCP server's use of the check**, when the MCP server is built (MCP.md §8).
5. **Later: Copy passage link** in the viewer (§8).

When built:

- PDF.md gains fragment links as a reader of page text (§3, §4) and a bump-list entry (§10).
- ANCHORED_LINKS.md points here for a single-PDF passage.
- PERMISSIONS.md records that the fragment grants nothing.
- COMMENTS.md's link rule gains `/pdf/` paths.
- CLAUDE_IMPORT.md documents writing fragment links into imported Markdown.
- CLAUDE.md gains a row.

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
  - `#page=` is what this viewer reads today; `highlight=` is the geometric form rejected in §2.
- **W3C Selectors and States** (2017, [note](https://www.w3.org/TR/selectors-states/), §5).
  - The general form: `#selector(type=TextQuoteSelector,exact=…,prefix=…,suffix=…)`.
  - The note itself warns that such URLs grow long.
- **RFC 9110 §10.2.2.** A redirect whose `Location` has no fragment inherits the request's,
  which is what carries a fragment link through the slug-history redirect (§7).
- **The sample's offline script**: a letters-and-digits skeleton, the page given plus or minus
  one, and quotes as first and last words. This plan's rule (§4) is that script's, with a
  word-boundary rule added.
