# PDF fragment links — a link to a passage, with no row

**Status: built** (2026-10-06), except "Copy passage link" (§8) and the MCP server's use of
the check, which comes with the MCP server. MCP.md, the MCP server's plan, is on the `api-mcp`
branch until it merges; fragment links share its PDF locator rule and its server-side quads.

A **fragment link** is a URL that names a passage of a PDF by its words:

```
/pdf/owen-barfield-saving-the-appearances#page=122&text=could+not+yet+call+his+soul+his+own
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

- **`page`** is the 1-based sheet number, exactly as `#page=` means it
  (`src/lib/pdf-open-params.ts`): never a label. It also keeps any reader of `#page=` working:
  `PdfViewer` applies it on its own, so the viewer opens at the passage's page before the
  passage is found, and a build that predates fragment links opens there too.
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
  is a miss, which the check reports (§8). Because `start,end` doesn't match the middle, an
  endpoint can step around a bad word, a footnote number, or the folio and running head at the
  foot of a page.
- **First occurrence wins**, as in Text Fragments. The reader never asks whether there is
  another; the writer guarantees the first is the one meant (§8).
- **Repeats are counted apart, never inside one another** (`countPassageOccurrences`): a `start`
  that recurs within the passage it begins is the same passage, not a second one.
- **It barely depends on the normaliser.** Every step of `normalisePageText` (spacing,
  ligatures, soft hyphens, dashes and quotation marks; PDF.md §3) leaves a skeleton unchanged,
  so a change to any of them can't break a fragment link. What can is a normaliser change that
  adds or drops letters or digits, or a pdfjs bump that extracts different ones or reorders
  them; §9 is what notices.
- **No worker is needed.** PDF.md §4 keeps its fuzzy step off the main thread because it is
  slow. A skeleton match is one `indexOf` over a page, and nothing here is fuzzy.

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
thinks: one `pageIndex` per target. Each half is outlined on its own page, and the viewer jumps
to the first. The booktext copy marks the break inline ("…but it [p. 42] is detected primarily
without"), so an author quoting from it knows where to split. The CLI, holding only the whole
quote, finds the split itself (`splitAcrossPages`, §8): it tries each word boundary between page
n and page n+1, and keeps the split where both halves match on their pages.

This is the case the selection capture gets wrong. A selection across a page break keeps the
quads on its first page only, and its quote is lost, because the selected text isn't on that
page (`captureTextTarget`, `capturePdfTextAnchor`).

## 6. The viewer

`usePdfFragment` (`src/components/pdf/use-pdf-fragment.ts`) resolves the fragment on arrival
and on every `hashchange`, and `PdfAnnotationSurface` draws what it finds. `PdfViewer` applies
`#page=` on its own, so the viewer opens on the right page before the passage is found.

1. **Parse** `location.hash` into passages with `parseFragmentPassages`
   (`src/lib/pdf-fragment.ts`).
2. **Find each passage.** Each page a passage names is read once per document, from
   `pdf.getPage(n).getTextContent()` through `normalisePageText`: the same text the stored page
   text came from. The passage is matched by skeleton (§4), and only on the page it names; the
   check and the CLI look further (§8).
3. **Measure its quads from the items' geometry**, with `quadsForRange`
   (`src/lib/pdf-quads.ts`). The offsets map the range to items, and each item's transform,
   width, and font ascent and descent (from `getTextContent`'s `styles`) place its run on the
   page.
   - **Where a run starts and ends inside an item is measured**, the way pdfjs's text layer
     measures it. A canvas measures the item's string in the item's CSS font, and the run's
     edges are those advances' share of the item's width. The text layer scales each span to
     the item's width by the same measurement, so the outline's edges fall where a selection's
     do. On the e2e fixture, where each line is one item, even spacing missed a real selection
     by 13.5px, while measured spacing is within 2px. Without a canvas (on a server) the
     function spaces characters evenly.
   - **Not a DOM range over pdfjs's text layer.** The jump needs the quads before the page is
     scrolled into view and its text layer exists. Mapping spans to items would also tie the
     outline to which span pdfjs draws for which item, which is not a public API (PDF.md §0,
     invariant 6).
4. **Draw and jump** as a followed anchored link does: `PdfTarget`s held in memory, drawn
   through `entriesForPage` as `variant: "link"` regions (the same outline), with
   `jumpToTarget` on the first passage found. A reader sees the same thing whichever kind of
   link they followed.
   - **The jump happens once per fragment**: on arrival, and again when a `hashchange` names
     new passages.
   - **On arrival a followed `?sel=` link keeps its own jump.** The two can arrive together,
     and both are drawn.
5. **A banner** lists the passages as jump handles. It is `PdfFragmentBanner`, a sibling of
   `AnchoredLinkBanner` on the same stylesheet, because nearly all of that one is about a row a
   fragment link doesn't have: a name, Edit, the excerpt page, other targets. The two banners
   stack in one overlay rather than covering each other.
   - **A passage that isn't found is listed as "Not found on page n"**, and its row goes to
     that page. An anchored link's banner lists a part that resolves nowhere without saying so.
     Here the reader can read the PDF, so saying so leaks nothing, and a miss is worth knowing
     about: the link is wrong, or extraction changed (§9).
   - **The banner shows the PDF's words at the match, never the URL's.** Otherwise a crafted
     URL could make the page present arbitrary text as a quotation from the file. This is
     PLAN.md §12i's "the selected text is a request field only" again. So a row reads as the
     stored text does, artifacts and all ("Every thing proclaims the glory o f God").

An annotation's permalink fragment has no `=` and is unaffected.

## 7. Arriving signed out, or by an old slug

**Sign-in hands the fragment on.** The PDF route's gate sends a signed-out reader to
`signInPath(pathWithQuery(…, { sel }))`. No gate can put a fragment in `callbackUrl`, since
none reaches a server, but the browser carries it onto `/sign-in?callbackUrl=…#page=…` (RFC
9110 §10.2.2). The form then navigates through `withArrivalFragment`
(`src/lib/sign-in-redirect.ts`), which appends that fragment when `callbackUrl` has none of its
own. Search's `#page=` links and annotation permalinks ride along the same way. The no-JS path
can't see the hash, and can't run the viewer either.

**A renamed slug needs nothing.** The slug-history redirect's `Location` has no fragment, so the
browser re-applies this one. That rule governs real HTTP redirects. Prose links are plain
`<a>`s, so following one is a full navigation and both redirects here are real ones.

`e2e/pdf-fragment-links.spec.ts` covers both, and its sign-in case fails without the form's
change.

## 8. Writing them

**The pure half** is `src/lib/pdf-fragment.ts`, under `npm run test:unit` because its rejection
surface is the point: parsing and formatting the fragment, the skeleton and the match, the
writer's form, and the cross-page split.

**The writer's form** (`writerForm`). A passage of eight words or fewer goes whole. A longer one
goes as its first three and last three words, each extended a word at a time until the
passage's first occurrence on the page is the one meant. A prefix is added only when extending
can't tell two occurrences apart, as with a short quote the page repeats. All 65 sample quotes
take that form without a prefix (§3).

**Writing one needs nothing from the instance.** An author quoting from a corrected extraction,
such as booktext's, writes the writer's form straight into the Markdown:

- **the sheet number** from the extraction's own page map (booktext's header gives it, as
  "pdf page = printed page -1");
- **the words** from the corrected copy, since its skeleton and the stored text's agree (65 of
  65 in the sample);
- **uniqueness** judged on the corrected copy's page, for the same reason.

The import stores hrefs as written and checks none of them. §9's script is what confirms them,
with `--doc` for the one doc just imported. Nothing before the import touches the instance,
which is what replaces the minting scripts. CLAUDE_IMPORT.md §8 has the steps.

**The check** (`src/lib/pdf-fragment-check.ts`) is shared by everything that confirms links.
Every link mark whose href is a fragment link, relative or on the instance's own origin
(`APP_URL`), is resolved against the file's stored page text. It reports, per link:

- ok;
- **no match**, with where the skeleton stops matching and what the PDF has there, and the page
  the passage is on when it occurs exactly once elsewhere in the file;
- **a warning when the passage repeats on its page**, since the link points at the first
  occurrence and only the author knows which one was meant;
- a page out of range;
- **an unknown file**: no live file has the slug, past slugs followed. A link naming a past slug
  is a warning, since the redirect still carries it.

Two properties of the check:

- **It is read-only.** It reads `file_page_text` directly rather than through `storedPageText`,
  which would extract a file that lacks the current version. It takes the current version where
  the file has one, and otherwise the greatest it has, as search does (FULLTEXT.md §4); a
  skeleton barely depends on the version (§4).
- **It reads as the operator**, since both its callers are scripts holding the database's
  credentials. A front door that reads as a user must ask `canUserReadFile` first and answer an
  unreadable file as not found. Otherwise the check would answer "does this PRIVATE file contain
  these words?"

It runs in:

1. **The integrity script** (§9), over everything or over one doc.
2. **A one-quote CLI**, `npx tsx scripts/pdf-fragment-link.ts <slug> <page> "<quote>"`. It prints
   the writer's form, or the reason there isn't one, for checking a quote before writing it.
   - The page is a hint: it tries the page given, then its neighbours, then the one page in the
     file that holds the quote once.
   - A quote elided with "…" or "..." is read as `start,end`.
   - A quote that runs across a page break comes back as two passages (`splitAcrossPages`).
3. **The MCP server**, when it is built. Every body a call writes is checked before anything is
   written: `create_doc`'s, `edit_doc`'s replacements and appends, and `annotate`'s and
   `edit_annotation`'s. A miss refuses the call with `no_match`, as MCP.md §7 answers an anchor
   (MCP.md §8).

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

- **What it checks.** It runs §8's check over every fragment link in docs' `proseJson`, posts'
  `proseJson`, comment bodies and annotation bodies, none of them deleted.
- **What fails it.** It exits non-zero on an ERROR: a miss, an unknown file, a page out of range,
  or a `text` parameter that doesn't parse. A repeated passage and a past slug are warnings.

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
| `src/lib/pdf-fragment.ts` | the grammar, the skeleton match, the writer's form, the cross-page split; unit-tested |
| `src/lib/pdf-quads.ts` | the quads of a range of normalised text, from text items; unit-tested |
| `src/components/pdf/use-pdf-fragment.ts` | the viewer's resolution, with the canvas measurer |
| `src/components/pdf/PdfFragmentBanner.tsx` | the banner |
| `src/components/pdf/PdfAnnotationSurface.tsx` | the regions, the jump, and the overlay both banners share |
| `src/lib/sign-in-redirect.ts` (`withArrivalFragment`) | the fragment through sign-in; unit-tested |
| `src/lib/comment-body.ts` (`isAllowedCommentHref`) | `/pdf/` hrefs in comments; unit-tested |
| `src/lib/pdf-fragment-check.ts` | the check |
| `scripts/integrity/check-pdf-fragment-links.ts` | the integrity script |
| `scripts/pdf-fragment-link.ts` | the one-quote CLI |
| `e2e/pdf-fragment-links.spec.ts` | whole, `start,end`, prefixed and cross-page passages, a miss, a hashchange, the outline against a real selection, a renamed slug, signing in |

**Not built:** Copy passage link (§8), and the MCP server's use of the check, which comes with
the MCP server.

## 12. Deviations from the plan

- **Quads are placed by measured spacing in the browser** (§6), not by even spacing within an
  item, after the e2e spec showed even spacing 13.5px off a real selection.
- **The check reads stored page text directly**, not through `storedPageText`, so that it never
  writes (§8).
- **A repeat is counted apart, never inside itself** (§4). Counted the planned way, "To be able
  … that is imagination" would have warned of a repeat because its second "to be able" falls
  inside the passage.
- **The CLI also reads an elided quote** ("…" or "...") as `start,end` (§8).
- **The two banners share one overlay**, stacked (§6).

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
  - `#page=` is what this viewer reads; `highlight=` is the geometric form rejected in §2.
- **W3C Selectors and States** (2017, [note](https://www.w3.org/TR/selectors-states/), §5).
  - The general form: `#selector(type=TextQuoteSelector,exact=…,prefix=…,suffix=…)`.
  - The note itself warns that such URLs grow long.
- **RFC 9110 §10.2.2.** A redirect whose `Location` has no fragment inherits the request's,
  which is what carries a fragment link through the slug-history redirect (§7).
- **The sample's offline script**: a letters-and-digits skeleton, the page given plus or minus
  one, and quotes as first and last words. The rule in §4 is that script's, with a word-boundary
  rule added.
