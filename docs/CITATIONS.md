# Citations and references

**Status: built, but for what "Built so far" below names, and Later.** A *citation* is an entity chip
([ENTITY_CHIPS.md](ENTITY_CHIPS.md)) that stands for one or more works at a page. It is shown as
`(BU p. 49)`, `(Radner 2012, p. 49)` or `[3, p. 49]`, depending on the doc's style. The works are
*references*: records in a library, which this file also covers. This file fills in the kit's kind
contract. The kit says how every chip is stored, rendered, quoted and searched. Citations are step
3 of the kit's order.

## Built so far

The reference library (its data, its pages and its machine door), the citation chip itself
with its popover, its Markdown both ways and a quote written in it, a doc's bibliography,
search by cited work, and reading libraries from other tools and downloading works ("Import
and export"). Everything below not listed here is still a plan: Later.

- **The chip kind:** `src/lib/entity-chips/kinds/citation.ts` holds its fields and
  validation, its identity (the works, in any order), when one citation continues another
  (it holds every work the other did), which both the anchors and the MCP merge ask, the
  three forms with their narrative
  and author-suppressed shapes, numbering by first appearance, the year-then-key
  disambiguation of a shared abbreviation, the per-work fallback to author-date for a
  reference with no abbreviation, and Pandoc's syntax on the way out. A citation of one work
  at a page links, in a doc and a post alike, to `/references/<key>/p/<page>`, which sends
  whoever follows it to the PDF at that page if they may open it, and to the reference's page
  otherwise; a citation of several links to `/references/<key>,<key>,…`, the page listing them
  all (Labels, "The link").
- **Its context:** `citation-context.ts` loads the cited references, deleted ones included.
  The chip-context endpoint answers for any work asked about, a reference's record being
  public.
- **Its index and refresh:** the `citation` table (migration `citation_index`), kept by
  triggers as `mention` is, and checked by the same script. `updateReference` starts
  `scheduleCitationRefresh`, which relabels the docs and notes citing the work, and
  `check:label-refresh` holds a write to `csl` or `short` to that.
- **The menu:** `CiteMenu.tsx`, opened by `[@` in the doc editor and a note's composer. It
  searches the library by key, abbreviation, title and author, and "radner 49" sets the
  locator.
- **The popover:** `CitePopover.tsx`, beside the menu: a selected citation's pages, words,
  form and works, each edit one attribute set on the chip (below).
- **The doc's style:** a Citations row in the doc's Settings, written to the ydoc's
  `settings` map as the mention style is.
- **MCP:** a read shows a citation as its label in text and as Pandoc's syntax in Markdown,
  and every Markdown write reads that syntax back (Markdown, below).
- **Markdown, both ways:** `citation-markdown.ts` reads Pandoc's forms for the chip parse's
  tokenizer (`markdown-import.ts`), which yields a placeholder holding the keys; `resolveParsedChips`
  makes each a citation of the references they name, a key a reference used to have included,
  or refuses `unknown_chip`, in the UI's import as on every MCP write. The writer escapes text
  that would read as a citation and guards the text beside one. An edit that sends a citation's
  Markdown with a field changed keeps the chip and takes the field, and one that adds a work
  continues it. A quote may give a citation in the syntax as well as as the label a text read
  shows (below): `withQuoteChips` (`parsed-chips.ts`) reads it, `resolveQuote` finds it by
  identity, and an edit from a stale read is refused as `chip_changed` (the kit's MCP, items 3
  and 6).
- **Search by cited work** (below): `cites`, `cited_title` and `cited_author` on the page,
  MCP's `search` and the export.
- **The bibliography** (below): `citation-bibliography.ts` computes it, `Bibliography.tsx`
  and `LiveBibliography.tsx` (`src/components/bibliography/`) show it, and
  `docJsonForPostSide` appends it to a post's text.

- **Records:** the `reference` table (migration `reference_library`), its `csl` built field by
  field by `parseCslItem` (`src/lib/references/csl.ts`) on every way in and read back through
  `cslOf`. Its `search_vector` is trigger-written from the key, the abbreviation and the
  record.
- **Identifiers:** `reference_identifier`, unique per scheme, written with the record in one
  transaction. `src/lib/references/identifiers.ts` normalizes a DOI and an ISBN and verifies
  an ISBN's check digit; an ISBN identifies only a record with no container that isn't a part
  by type (`isbnIdentifies`).
- **Keys:** a source's key kept as given when it is a library key, and otherwise made from the
  first creator and the year (`radner2012`, then `radner2012b`); found in any case through
  `key_folded`; permanent once used: `reference_key_history` keeps a renamed key and a source
  key that isn't a library key answering, and no other reference may take either (Keys, below).
- **The writes:** `src/lib/reference-write.ts`, taking an `Actor`: `createReference`,
  `updateReference`, `replaceReference`, `setReferenceDeleted`, `importReferenceBatch`. AUTHOR and above
  (`canWriteReferences`). A duplicate is refused as `duplicate`, naming the record that holds
  the identifier, a deleted one included.
- **Import:** pasted, or picked or dropped as files, read in the browser by `src/lib/references/import.ts`
  (citation-js for BibTeX, biblatex, RIS and `CITATION.cff`; `nbib.ts` for PubMed), previewed,
  and sent in batches that survive a reload (`ReferenceImport.tsx`, Import and export, below).
- **Downloads:** BibTeX, biblatex, RIS and CSL-JSON, from `/api/references/export`, linked from
  a reference's page, beside a doc's and a post's References, and in `/references`
  (`src/lib/references/export.ts`).
- **`/references`**, through the admin table kit, for signed-in members
  (`canViewReferences`); AUTHOR and above rename a key, set an abbreviation, set or remove its
  PDF, delete and restore. Author(s), Year and Title sort through the `reference_listing` view
  (migration `reference_listing_view`), since they are fields of the record's jsonb.
- **A work's PDF** (Step 3, "A work's PDF"): tied from the PDF's Metadata pane
  (`FileReferencesPanel.tsx`) or the File column of `/references`, through `updateReference`,
  and by `create_ref`'s `file`. The reads are `src/lib/reference-files.ts`.
- **`/references/[key]`** is public and reads no session: the entry as a bibliography sets
  it, the abbreviation, the DOI, ISBN and URL, and the published posts citing it. A key the
  reference used to have redirects to its current one. `CitedBy.tsx`, a client island, asks
  `referenceCitedBy` (`src/lib/reference-cited-by.ts`) for the docs and notes citing it and its
  PDF, each through its read rule, and offers the PDF at the page a post's link names. The
  same route lists several works, `/references/<key>,<key>,…`, warning of the keys nothing
  answers to (Pages, below).
- **The entry format:** `src/lib/references/entry.ts`, the one bibliography entry the house
  styles share.
- **MCP:** `find_refs` and `create_ref` (`src/lib/mcp/tools/references.ts`). The names are
  short because a listed name is `multiblog_` and at most eleven characters more, claude.ai's
  limit ([MCP.md](MCP.md) §21, "The names"); the spec that holds every tool to it refused the
  longer pair.

## Terms

- **Reference.** A bibliographic record (book, article, chapter), optionally tied to its PDF in
  `/files` (Step 3, "A work's PDF").
- **Locator.** The printed page or pages a citation points at, such as "49", "49–51", "49, 51"
  or "xii", and nothing else (The chip, "The page").

## The chip

- **Chip kind** `citation`. Its `data` holds `items`, a list of
  `{ refId, locator, prefix, suffix, suppressAuthor }`, and an optional `form`: parenthetical or
  narrative.
- **Identity:** the works, `items`' `refId`s. An anchor stays attached while its chip still
  contains every work the anchor recorded. Adding a work, or correcting a locator, prefix or
  suffix, doesn't detach it. Removing a work does. A citation holding every work of an old one
  continues it, so an edit that adds a work keeps the chip's `iid` (the kit's MCP, item 5).
- **Validation.** `data` holds only what its Markdown can write, in the form that Markdown reads
  back as, so every way in stores the same value:
  - A narrative chip holds one work, with no prefix and no suppressed author. Pandoc has no form
    for the others, so "Radner (2012) and Barfield (1957)" is two chips.
  - **The page.** A locator holds pages and nothing else: digits or a well-formed Roman
    numeral, a range of two, or a list of either, as Pandoc reads `pp. 33-35, 38`. "mild" and
    "did" are words; "mix" and "liv" are numerals, as they are to Pandoc. What follows a
    locator's pages goes after the work, so "49 n. 3" is stored as page 49 and "n. 3", shown
    `(RTS p. 49, n. 3)`. A locator that opens with no page, "ch. 3" or "§ 4", goes after the
    work whole, so no label writes "p." before it. The popover says what it moved.
  - **Then the page and the words after it are stored as Markdown reads them**, since the
    writer puts both in one place. With no locator, a suffix that opens with pages gives them
    up: `p. 5, note` is stored as locator `5`, suffix `note`. A suffix that is pages joins the
    locator: page 49 and "51" are pages 49, 51. A suffix such as "p. 49 n. 3", with no comma
    after the page, stays words, since that is how Markdown reads `[@key, p. 49 n. 3]`.
  - The words before and after a work are inline Markdown, stored as Markdown (Markdown,
    "Markdown inside a citation").
  - A hyphen in a page range becomes an en dash.

## Labels

**Forms.**

| Form | Label | Narrative | Author suppressed |
|---|---|---|---|
| `short` | `(BU p. 49)` | `BU (p. 49)` | `(p. 49)` |
| `author-date` | `(Radner 2012, p. 49)` | `Radner (2012, p. 49)` | `(2012, p. 49)` |
| `numeric` | `[3, p. 49]`, numbered by first appearance | `Radner [3, p. 49]` | no effect, as in citeproc |

Pages are written `p. 49` and `pp. 49–51`, as APA, Harvard and IEEE write them, and as the notes
already do. The `short` form has no comma, matching the notes too; the other forms have one.

**Per-chip overrides**, all in `data`:

- narrative ("Radner (2012) argues");
- suppress author;
- prefix and suffix;
- several works in one chip.

**A reference without `short`** falls back to its author-date label in the `short` form, so a
doc mixes `(BU p. 49)` and `(Radner 2012, p. 49)` until the abbreviation is filled in.
`/references` flags such a record.

**Rules.**

- **The style owns the delimiters.** A label carries its own parentheses or brackets, so they
  belong to the chip, its link and a post's linked text, and a restyle changes them with the rest
  of the label. A prefix and further works go inside: `(see Radner 2012, p. 49; Barfield 1957)`.
- **Parentheses typed beside a chip are text.** Nothing absorbs them, so they show doubled, as
  `((Radner 2012, p. 49))`, from the moment they're typed.
- **`short` isn't unique.** When two works in one doc share a short label, the doc-order pass adds
  the year, then the key, the way it tells apart two people with the same name
  ([MENTIONS.md](MENTIONS.md)).
- **A deleted reference** shows the same label, struck through and unlinked.
- **An unknown id** shows a struck-through "unknown work".

**Context:** the references cited, deleted ones included. Nothing about their PDFs: no label
or link reads one.

**Refresh** (the kit's step 1, item 10): a reference's record changes. Nothing about a PDF calls
for one, since the link below decides when it is followed.

**The link.** A citation links to the same place for every reader, in a doc and in a post
alike. Each work it names counts once, in the order first named, at the first page of the first
item naming it that has a locator, as `firstPage` reads one, so `[@a; @a, p. 51]` links to
`/references/a/p/51`. `render` in `citation.ts` works that out, and links by the count of
distinct works.

- **One work, with a page**, to `/references/<key>/p/<first page>` (`citedPagePath`), which
  renders nothing (`src/app/references/[key]/p/[page]/page.tsx`, `citedPageTarget` in
  `src/lib/reference-cited-by.ts`). A reader who may open the work's PDF, under the files' read
  rule, is sent to `/pdf/<slug>#page=<sheet>`, the sheet found by the file's `pageLabels`
  ([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md)), or taken as the page itself for a file with
  none. Anyone else, and a page the labels don't name, goes to `/references/<key>#p=49`, where
  the page's client island offers the PDF to whoever may read it. A fragment, rather than a query
  string, since a page that reads `searchParams` can never be cached (Pages).
- **One work without one**, to `/references/<key>`. This includes
  `[@radner2012, p. 49; @radner2012, p. 51]`, which names one work.
- **Two or more works**, to the page listing them (Pages), `/references/<key>,<key>,…`, with
  each work's page in the fragment by its place (`citedWorksPath`):
  `/references/wimsatt1986,wimsatt1997,wimsatt2000#p=12,,3` for page 12 of the first work and
  page 3 of the third.
  - A work cited with no page has nothing at its place, commas at the end are left off, and a
    citation with no page at all has no fragment.
  - A fragment, as `#p=49` is on one work's page, so the server's answer for a list is the same
    whatever pages are named.
  - **By position, not by key** (`#wimsatt1986=12`). A post freezes its link. When a key in it
    is renamed later, the list redirects to the new key and the browser keeps the fragment as it
    was written, so a page named by the old key would be lost. A position survives a rename, and
    a key that isn't found keeps its place. The cost is a fragment that says less to someone
    reading it.
  - **Not through `/references/<key>/p/<page>`.** That route sends a reader into one PDF. A list
    has a PDF per work, so its page offers each one under its work, at the page cited.
  - A citation names at most `MAX_LIST_KEYS` works (`MAX_ITEMS` is set from it), so its list is
    always one the page takes.

Why the route decides, and not the label: a rendering never depends on who is looking
([ENTITY_CHIPS.md](ENTITY_CHIPS.md), rule 2), and a link straight to a PDF would show every
reader of a doc a file most of them may not open, a PRIVATE one included. Asked at the click, as
`/link/<id>` asks of its targets ([ANCHORED_LINKS.md](ANCHORED_LINKS.md)), the link names only
the reference, whose page is public, and is right for each reader: the owner of a private PDF
reaches it from their own doc, and a doc shared later, or a PDF made private or deleted, needs
nothing rewritten. A viewer who may not read the PDF gets the answer a reference with no PDF
gives, so the route says nothing about one. The cost is a redirect on the way, and a link whose
address names the reference rather than the PDF.

## Markdown

- **Citations are written in Pandoc's syntax**, so every override round-trips:
  - `[see @radner2012, p. 49]`;
  - `[-@radner2012]`, which suppresses the author;
  - `@radner2012 [p. 49]`, the narrative form;
  - `[@radner2012, p. 49; @barfield1957]`, several works.
- **Delimiters aren't in the Markdown.** `[@radner2012, p. 49]` shows as `(Radner 2012, p. 49)` or
  `[3, p. 49]`, as the style says. `([@radner2012, p. 49])` holds typed parentheses, and they show
  doubled.
- **Hand-written text in that shape** is escaped on the way out, as `\[\@radner2012\]`. The
  serializer already escapes the brackets; the `@` comes from the rule below.
- **A bare `@word` is a citation**, as in Pandoc: the narrative form, without its brackets.
  - The word is Pandoc's key: it starts with a letter, digit or `_`, continues with those and
    internal `:.#$%&-+?<>~/`, and ends before any trailing punctuation, so `@radner2012.` ends a
    sentence. `@{radner2012}` is the same key, braced. Every key Pandoc reads is looked up, in
    any case, a source key kept as an alias included (Keys, below).
  - An `@` straight after a letter or digit isn't one, as in `luke@example.com`, and neither is
    anything in code or link text. The braced form is read wherever it stands, which Pandoc doesn't
    do; the writer needs it (below).
  - The parse needs no key lookup. It makes a chip of every `@word`, and the write refuses a key
    that doesn't exist, as `unknown_chip` (the kit's MCP, item 6). A key a reference used to
    have still names it. A deleted reference is refused too, unless the body already cites it,
    so a struck-through citation can be written back; so can a work the library no longer has,
    which is written with its stored id.
  - The refusal names the word and offers the two ways out: a mention,
    `[@Name](/authors/<slug>)`, or a literal `\@`.
  - Every Markdown write that can hold a chip refuses alike: `create_doc`, `edit_doc`, a note's
    body, and the UI's import and paste box. An import lists each unknown key and creates nothing.
  - Text that already reads `@word` is written as `\@word` on the way out, so a read can be sent
    back unchanged. So is a published post's text, where a mention's label at publish reads
    `@Ada Lovelace`. Link text is left alone, since it holds no citation.
  - Keeping an unknown `@word` as text with a warning is rejected: a mistyped key would quietly
    stop being a citation.
- **Text beside a chip can't change it.** The writer guards what would:
  - `\:` and `\(` straight after a bracketed chip. `[@radner2012]: agreed.` opening a paragraph
    reads as a link reference definition, and the paragraph disappears. `[@radner2012](sic)` reads
    as a link. A `[` is already escaped everywhere.
  - `@{radner2012}` where a bare key has key characters after it, since `@radner2012-style` reads
    as the key `radner2012-style`, or a letter or digit before it, since `see@radner2012` reads as
    text. Pandoc has no form for the second case, which is why the braced form is read after a
    letter here.
- **Markdown inside a citation.** The words before and after a work are inline Markdown, as
  Pandoc reads them: `[see *especially* @buber1923, p. 49, **emphasis** added]`.
  - **What is read:** emphasis, strong emphasis, `~~strikethrough~~` and code spans, with
    backslash escapes (`inlineRuns`, `src/lib/inline-markdown.ts`). Anything else is text: a
    link, since a chip is one link already; raw HTML; and a single `~`, which is Pandoc's
    subscript. Each field is read on its own, so an unclosed `*` before a work doesn't reach the
    words after it.
  - **The parser is its own**, since the live editor runs it, and would otherwise ship marked
    for a few characters of a chip. It follows CommonMark's rules for which delimiter runs
    open and close, and its tests hold it to marked's answers, except where marked departs from
    CommonMark.
  - **How it is stored:** as the Markdown, every escape kept but a delimiter's. `[`, `]`, `;` and
    `@` mean nothing inside a field, so the chip holds them bare and the writer escapes them,
    and a trailing backslash is doubled so it can't escape what follows the field
    (`citationField`). The parse, the validator and the popover all store this form, so a field
    reads back as it was written.
  - **How it is shown:** a rendering's `label` is the text alone. Everything that reads a chip
    as text takes that: search, quotes, the cards, an MCP text read, the bibliography's lead.
    Its `runs` are the same text with its formatting, for what draws a chip: the editor, a
    static render, and a post, which gets a linked text node per run. A post's schema lets
    code carry no other mark, so there a code run is plain, still linked.
- **Link text holds no citation**, so `[@handle](https://x.com/handle)` in an upload stays an
  ordinary link rather than being refused as an unknown key. A chip can't carry a link, since
  y-tiptap stores no marks on inline nodes, so a citation there would cost the link. This departs
  from Pandoc, which reads citations inside link text. A mention is claimed before any link.
- **`scripts/import-claude-chats.ts`** parses with chips, as the `/docs` import does
  ([CLAUDE_IMPORT.md](CLAUDE_IMPORT.md)). A transcript names packages rather than works, such as
  `@playwright/test`, so each `@` in it that would read as a chip is escaped before the parse
  (`escapeChipAts`, `markdown-import.ts`), as a tag-like `<` already is: outside code spans,
  fenced code, autolinks and bare URLs, and not after a letter or digit unless a brace follows.
  Its `--markdown` files are read strictly: an unknown key, or a handle the importing account
  can't mention, refuses the file.
- **A quote copied from a Markdown read** holds this syntax, not the label, and finds its chip
  by identity (the kit's MCP, item 3). Of several citations of one work, the one whose locator
  and words also agree wins. A quote naming the right work at a different locator matches, and
  the reply reports the citation's Markdown now (`chipsNow`), unless it is an edit's target,
  which is refused as `chip_changed` with the same. A key the library doesn't know finds
  nothing, rather than being refused as it would be in a write.

## Step 3: references and citations

**Records.** A `reference` table:

- `id`;
- a unique `key`, such as `radner2012` or `Frank_1970`, and `key_folded`, the same key with A to
  Z lowercased, which every lookup reads (Keys, below);
- `csl`, a jsonb CSL-JSON item;
- `short`, the abbreviation labels use, such as `BU`, optional (Labels, above);
- an optional `file_id`, the work's PDF (A work's PDF, below);
- audit columns, `deleted_at` and `search_vector`.

**Who writes them.** AUTHOR and above create and edit references.

- The writes live in `src/lib/reference-write.ts`, taking an `Actor`, and the server action and
  the MCP tool both wrap it.
- A token acts with its account's role (PERMISSIONS.md, "API tokens"), so the same rule binds
  people and agents.
- In the UI, import is by pasting, picking or dropping a library in any common export format, one item or
  many (Import and export, below).
- MCP agents create references through `create_ref` and correct a record through
  `update_ref` (MCP, below). Renaming a key and setting an abbreviation or a PDF stay in the UI.

**Duplicates are caught by DOI and ISBN.**

- **The identifiers.** A `reference_identifier` table holds `reference_id`, `scheme` (DOI or
  ISBN) and a normalized `value`, unique per scheme. `reference-write.ts` writes it from the CSL
  `DOI` and `ISBN` fields, in the same transaction as the record, on create and on edit.
- **Normalizing.**
  - A DOI loses its `https://doi.org/`, `dx.doi.org/` or `doi:` prefix, and is lowercased, since
    DOIs are case-insensitive.
  - An ISBN loses hyphens and spaces, has its check digit verified, and is stored as ISBN-13, an
    ISBN-10 being converted. So `0-631-17504-0` and `978-0-631-17504-9` are the same book.
  - An identifier that fails its check is refused, not stored: by `create_ref` and
    `update_ref`, which an agent can correct, while an import drops it and keeps the record
    (The import box, below).
- **What counts.**
  - Every ISBN on a book counts (hardback, paperback, ebook), so importing another format of the
    same edition is caught. A different edition is a different record, since its pages differ.
  - A chapter's ISBN is its book's, so an ISBN is registered only for a record with no container
    that isn't a part by type (What a record keeps, below). Chapters are matched by DOI alone;
    otherwise a second chapter of one anthology would read as a duplicate.
  - A deleted reference keeps its identifiers, as a deleted account keeps its slug and email. A
    duplicate of it is caught, and the UI offers to restore it.
  - A record with neither identifier gets no automatic check.
- **What happens.**
  - An import shows each matching item as "already in the library as <key>", with a link, and
    imports the rest.
  - Adding an identifier that another record holds is refused, naming that record.
  - `create_ref` refuses with `duplicate`, returning the existing key and URL so the agent
    cites that record instead.

**A work's PDF.** A reference can name one file as the work's PDF, and several references can
name one PDF, an anthology's chapters, say. A citation of the work at a page then opens that
page of it for whoever may read it (Labels, "The link").

- **What it may be.** A PDF the writer may read, live: `updateReference` refuses anything else,
  as `requireFile`. Writing it is an edit of the reference, so AUTHOR and above.
- **Where it is set.**
  - **On the PDF's page**, in its Metadata pane, where you are right after uploading:
    `FileReferencesPanel.tsx` lists the references the PDF is the PDF of, and offers a writer a
    search of the library, as the citation menu searches it, to add one, and a way to remove
    one. A reference tied to another PDF says that adding it here moves it. The panel keeps its
    own list from each action's answer, since it sits inside the viewer's `ssr: false` island,
    where a refresh delivers nothing. Removing a reference unties it only if it is still tied to
    this PDF (`untieReferenceFromFile`).
  - **In the File column of `/references`**, where you are when tidying the library: a writer's
    ✎ opens a search of the PDFs they may read, by title, slug or file name, and a way to remove
    the PDF.
  - **By `create_ref`**, as its `file` (MCP, below). Changing one afterwards stays in the UI.
- **A private PDF says so.** A citation opens it only for people who may read it, its owners,
  and everyone else gets the reference's page. The PDF's panel says this, and the File column
  marks it private.
- **Who sees which PDF.** A reference's record is public, but its PDF is under the files' read
  rule (`readableFilesWhere`). So the File column names a PDF only to a viewer who may read it,
  and shows any other as "a PDF you can't open", which a writer needs to know before replacing
  it. It sorts by whether a reference has a PDF, never by the PDF's title, since a sort by a
  title some viewers can't see would let them find it out a row at a time. `find_refs` names a
  PDF only to an agent whose account may read it. The PDF's own panel lists its references to
  whoever may read the PDF, the page's own gate.

**Pages.**

- **`/references`**, through the admin table kit, for signed-in members.
- **`/references/[key]`** is public. A published post's citations link to it, and it shows what
  a bibliography prints and where the work is cited publicly.
  - The record, and the published posts citing it (found in the `citation` table), read no
    session, so the page is one a cache could hold. It has none: a dynamic route with no
    `generateStaticParams` is rendered on every request in this version of Next, whatever its
    `revalidate = 60` says, as an author page is ([CACHING.md](../CACHING.md), 2026-11-10).
  - What only some viewers may see comes from a client island that asks the server once the
    reader is signed in, the way `TagChips` keeps the post page static. That covers the docs and
    notes citing it, the first 20 of each with a link to `cites=` for the rest, and its PDF, at
    the page the citation's route names (`#p=49`, read in the browser, so the server's answer
    is the same whatever page is named). Each list goes through its read rule, a PDF included, so a PRIVATE file is
    offered only to its owners.
- **`/references/<key>,<key>,…`** lists several works, where a citation of several links
  (Labels, "The link"). The same route serves it (`src/app/references/[key]/page.tsx`), so a
  list costs no second route, and a key in another case or an old alias still redirects.
  - **The load.** A list goes through one call to `referencesByKeys(parts)`, which answers by
    each key as it was asked, and then `referencesById` for the rows, deleted ones included. The
    load is wrapped in React's `cache()`, so `generateMetadata` and the page share one lookup;
    nothing else spares the second, the page having no cache.
  - **A list in which at least one key names a work is a page**, and one in which none does is a
    404, as a single unknown key is. A key whose record can't be read counts as not found:
    `referencesByKeys` finds it and `referencesById` drops it, and the single page is a 404 for
    it.
  - **The keys nothing answered to are reported at the top**, in a box with `--warning`'s
    border holding the page's full address, from `appUrl(path)`, with its keys as they were
    asked and not percent-encoded. Every character a library key may hold stands in a path as it
    is, so what is shown is the address and is also readable. It is text, not a link. Each key
    nothing answered to is in `--error`, and carries a visually hidden "(not found)", since
    colour alone fails WCAG 1.4.1. Under it: "Keys in red were not found in the database." The
    works found are listed below it as usual.
    - **The box sits on the page's background, with no fill.** `--error` on `--fill-warning` is
      4.4:1 in the light theme, under the 4.5:1 WCAG AA asks of text; on the page it is 5:1.
      `--danger` passes on that fill but is the token for delete controls.
    - **What a stranger can make the box show** is at most 20 keys of 80 characters each, in
      letters, digits and `_`, `:`, `.` and `-`, under a line saying they were not found.
      Nothing else in an address reaches the page: a part that is no library key is a 404, and
      the `~` form never renders.
  - **One redirect, to the list as it should be written.** If a found key is an old alias or in
    another case, or a work is named twice (by two keys, or by one key twice), the page redirects
    permanently to the list written with each found work's current key, once, in the order first
    named. A key nothing answered to stays where it was first written, as it was written there,
    once (a repeat in another case included), so the warning still shows it. A list that comes
    down to one key, such as `a,a`, redirects to `/references/a`. Dropping a repeat moves the
    keys after it up one place, and their pages in `#p=` with them; no citation writes such a
    list. A browser keeps the fragment across the redirect, so `#p=` survives a renamed key.
  - **What it shows:** a kicker, `References · <key>, <key>, …`, and an `<h1>` naming how many
    works it lists; for each work, in order, a `<section>` labelled by its title, an `<h2>` here,
    holding what the single page shows (its entry, its details table with downloads, the
    removed-from-the-library line for a deleted one, and its `CitedBy`); then one "Cited in
    posts" list of the published posts citing any of the works, in the order every listing uses,
    rather than one per work, which would repeat a post citing several of them under each.
  - **`CitedBy` on a list** takes two more props, and without them is what it is on one work's
    page. `headingLevel` makes "Cited in docs" and "Cited in notes" `<h3>`s under a work's
    `<h2>`. `position`, the work's place in the list as written, is where the island reads its
    work's page in `#p=`, and it offers the PDF at it, so `#p=49` on a list names the first
    work's page alone. With a `position` it drops its own `aria-label`: the work's section is the
    named region, and twenty regions of one name tell a screen reader nothing. Each island asks
    for its own answer, up to `MAX_LIST_KEYS` server-action calls on one page; one batched action
    is the alternative if a long list's calls are a problem ([PERFORMANCE.md](../PERFORMANCE.md),
    "A reference list's page asks once per work").
  - **Its title** is the first work's title, then "and 2 more".
  - **Not indexed:** `robots: { index: false }` on a list, as `/search` has. Every order of the
    same keys is its own address, and each repeats the single pages. A single key's page stays
    indexed.
  - **No cache, as the single page has none.** A list is rendered on every request, so it shows
    an edit, or a work added under a key once reported missing, at once. It reads no session and
    no `searchParams`, so it stays a page a cache could hold. **Before the route gains a cache,
    lists need a rule**: every order of the same keys, and every list with an unknown key beside
    a real one, is a 200 page a stranger could add to it.
- **`/references/[key]/p/[page]`** is the citation's link at a page (Labels, "The link").
- **A key is permanent once used.** Posts link to `/references/<key>`, and Markdown exports write
  `[@key]`. So renaming a key keeps the old one redirecting through a key history, as
  `UserSlugHistory` does for users.

**The menu.** A `CiteMenu`, opened by `[@`, Pandoc's citation opener. `@` alone still opens
mentions; a `[` before the `@` keeps the mention menu shut, since `[` isn't one of its allowed
prefixes.

- It sits in the doc editor and the annotation composer, and in a comment's rich editor, which
  lists the post's works first (ENTITY_CHIPS.md, "Chips in comments", "The menus").
- It searches by key, short label, title and authors.
- "radner 49" sets the locator.

**The popover** (`CitePopover.tsx`) edits what validation allows (The chip, above): each work's
page, the words before and after it (inline Markdown, as in the Markdown), and whether its author
is left out; the form; and further works, found as the menu finds them, "radner 7" included.

- **Where.** Beside the menu, in the doc editor, the annotation composer and a comment's rich
  editor, and only in an editor that can be typed in. Selecting a citation opens it, by a click or the arrow keys, and
  Enter moves into it.
- **Each edit is one attribute set** on the chip's `data`, run through the kind's validation as
  every other way in is. So the chip keeps its instance id and its place, and an anchor on it
  asks the kind whether the new fields continue the old ones (The chip, above). Removing a work
  can therefore detach an anchor, as an edit removing it by any other means would.
- **A text field writes when it is left or Enter is pressed**, not on each keystroke, since
  validation trims and would eat the space being typed. Escape puts a changed field back, and a
  second Escape returns to the editor with the citation still selected.
- **Page holds pages only** (The chip, "The page"). Text typed there that isn't all pages is
  moved, as validation moves it: "49 n. 3" leaves 49 in Page and puts "n. 3" in After, and the
  popover says what went, until the next edit or until it closes.
- **"In the sentence" is offered only where Pandoc has the form**: one work, its author shown,
  nothing before it. Otherwise the choice is disabled and says why. In a comment it is always
  disabled, since a comment has no narrative form.
- **Open while it is wanted.** It shows while the editor has focus and its selection is the
  citation. Once focus moves into the popover, by a press, a key or a script, it holds the
  popover open until focus or a press goes somewhere else.

**The bibliography** is the works a doc's citations name, in the doc's style, shown after the
doc in the reading view, the editor and side-by-side. Like a label, it is computed wherever the
doc is shown and never stored in the doc. A post gets it as text at publish, alongside the
post's labels, and a republish refreshes both.

- **One function computes it.** `citationBibliography`
  (`src/lib/entity-chips/kinds/citation-bibliography.ts`) takes the doc's chips in order, its
  styles and the chip context, the same inputs the labels take. It reads the labels' doc-order
  pass (`citationLabelling` in `citation.ts`), so a work's number in the list is the number its
  citations show, and a shared abbreviation is told apart in the list as in the text.
- **What it lists.** Each work once.
  - A `numeric` doc lists works by number, which is their order of first citation. The other
    styles list them alphabetically by first author, a work with no author by its title, then
    by year.
  - Each entry leads with what the doc's citations call the work: `[3]` in the `numeric` style,
    and the abbreviation in the `short` style. A work with no abbreviation has no lead, since its
    author-date label already finds it by author and year.
  - A deleted reference is listed struck through and unlinked, as its citations show it. A work
    the context doesn't hold is left out, as its citation shows "unknown work". A citation its
    kind refuses numbers nothing, here or in the text.
- **Each entry** is the house format (`src/lib/references/entry.ts`, split into runs by
  `entryParts`): authors, year, title, then the container or publisher. A whole work's title is
  in italics, a part's in quotation marks. The title links to the reference's page, which is
  public, so a post's reader can follow it as a doc's can.
- **Where it is shown.**
  - The reading view and side-by-side render it on the server with their static first paint
    (`StaticBibliography`).
  - Every live surface follows its editor: `LiveBibliography` recomputes whenever the chip
    plugin's renderings do (`node.ts`), when a citation comes, goes or changes, or the style or
    context changes, and never for typing.
  - In the doc editor the list sits inside the scrolling box, after the text, so it scrolls
    with the doc rather than taking room under it. It isn't editable.
- **On a post** `docJsonForPostSide` (`post-content.ts`) appends a "References" heading and a
  paragraph per work, so the landing page's preamble gets one too. The lead is bold and a
  deleted work is struck, in the marks a post's schema has. Being the post's text, it is
  searched, quoted and commented on like the rest.
- **Not in a doc's own text.** A doc's search text and its Markdown, an MCP read's included,
  leave it out: it is generated, and an edit sent back with it would write it in as prose.
- A CSL style's bibliography comes with citeproc (Later) and replaces this format for that doc.

**Search** ([FULLTEXT.md](FULLTEXT.md), "Cited works"):

- `cites=<key>` finds what cites a work. Several keys find what cites any of them, and a key a
  reference used to have still names it.
- `cited_title=<text>` and `cited_author=<text>` find what cites a work whose title, or whose
  authors and editors, have those words, each as a prefix.
  - The text matches against `reference.search_vector` by weight: its A is the key, the
    abbreviation and the title, and its B the people (`referenceIdsMatching`,
    `src/lib/reference-data.ts`). Deleted references count, since a citation of one still names
    the work.
  - The matching references' ids then go through the `citation` index table, inside each kind's
    readable `where` (`citedWhere`, `src/lib/search/context.ts`), so no citing doc's own vector
    changes.
  - Each filter set must be met at once: `cites=radner2012&cited_author=barfield` finds what
    cites both.
  - The page labels them "Cites a work with the key…", "titled…" and "by…", since the existing
    `authors` filter is who wrote the item found, not the work cited. It says what it narrowed
    to, and that PDFs, which cite nothing, are left out.
- The underscores match the querystring's other names (`created_from`), and the bulk export
  (MCP.md) takes the same three.

**MCP.**

- `find_refs`, by key, title, author, DOI or ISBN, beside `find_users` and `find_tags`.
- `find_refs` answers each work's PDF, as `pdf: "/pdf/<slug>"`, where the agent's account may
  read it.
- `update_ref` (the `write` scope; AUTHOR and above): a work's key and a whole CSL-JSON record,
  through `replaceReference`, so an agent can correct a record it added. A deleted work is
  refused, never restored (Replacing a record, below).
- `create_ref` (the `write` scope; AUTHOR and above, by the token's account).
  - Its `file` ties the work to its PDF, by `/pdf/<slug>` or id, refused as not found unless the
    account may read it.
  - Its description tells the agent to search with `find_refs` first, as `find_tags` does
    for tag terms.
  - It refuses `duplicate` with the existing key, and `invalid` for an identifier that fails its
    check.
- `search` takes `cites`, `cited_title` and `cited_author`, and refuses a key nothing has
  ([MCP.md](MCP.md)).

## Import and export

Reading a library from the tools people keep one in, without losing what the library can hold,
and downloading works in the formats those tools read: one work, a doc's or a post's references,
the library as `/references` searches it, and the bulk export's bibliography. The readers are
`src/lib/references/import.ts` and `nbib.ts`, the writers `export.ts`, and the writes
`src/lib/reference-write.ts`.

### What each source exports

| Source | Its export to read | Read by |
|---|---|---|
| Zotero, Mendeley, JabRef, LaTeX | BibTeX or biblatex | the BibTeX reader |
| Zotero with Better BibTeX | biblatex, or CSL-JSON | the BibTeX reader, or `parseCslItem` |
| EndNote | RIS ("RefMan (RIS) Export"), or BibTeX | the RIS or BibTeX reader |
| Web of Science, Scopus | RIS | the RIS reader |
| PubMed | `.nbib`, its only citation-manager format | a MEDLINE reader |
| Crossref, doi.org | BibTeX, RIS or CSL-JSON | any of the three |
| arXiv, INSPIRE, ADS, dblp | BibTeX | the BibTeX reader |
| HeinOnline | RIS or BibTeX | the RIS or BibTeX reader |
| Software (GitHub, Zenodo) | `CITATION.cff`, or Zenodo's BibTeX | a CFF reader, or the BibTeX reader |

**Refused, naming the export to use instead:** EndNote XML and `.enw`, Web of Science's plain
text and tab-delimited files, Scopus CSV, RefWorks' tagged format, CSL-YAML, MODS and MARC. Each source above has an
export that is read, so the refusal says which, not just "That isn't BibTeX, RIS or CSL-JSON."

### The readers

- **They run in the browser only.** The import box and "Replace record" parse there and send
  CSL-JSON, which the server runs through `parseCslItem` as it does `create_ref`'s (The import
  box). So no reader is a server dependency, and `importReferenceBatch` takes records, not text.
  `import.ts` holds the detection and the passes below over what citation-js yields, and
  `readAs` calls a format's reader by name.
- **Detection is ours.** `parseReferences` sniffs the format (`detectFormat`: `.nbib` by its
  `PMID- `, a CFF by its `cff-version:`, each refused format by its own mark) and calls that format's reader by name: citation-js's synchronous
  `plugins.input.chain` with `forceType`. A library's own detection is never used, and neither
  is an asynchronous form (`chainAsync`, `Cite.async`). citation-js's detection reads a URL as
  something to fetch, and only its asynchronous forms can fetch. Called by name, its BibTeX and
  RIS readers read a URL or a DOI as no records.
- **BibTeX and biblatex: citation-js** (`@citation-js/plugin-bibtex` 0.9, MIT), as
  `@biblatex/text`.
  - **What it reads:** every TeX accent, `\H`, `\L`, `\=`, `\i` and an unbraced `\v r`
    included; `@string` macros; `crossref` inheritance; BibTeX's name grammar
    (`von Last, Jr, First`), as particles and a suffix; a month and a day; biblatex's
    `@software` and `@dataset`; translators. It keeps `url` and `doi` verbatim, so a URL's `~`
    isn't a space nor its `--` a dash. An entry's key comes as written, its case and
    punctuation kept.
  - **Rejected: a reader of our own.** A real `.bib` needs a TeX parser.
  - **A file that doesn't parse whole** is read an entry at a time, each after the file's
    `@string`s, so a broken entry is reported alone and the rest are read. `crossref` doesn't
    reach across entries then.
  - **What a pass after it mends:**
    - `and others` comes as an author named "others", and is dropped.
    - `eprint` is not mapped, with `archivePrefix`, arXiv's own form, or with `eprinttype`,
      biblatex's. Neither is `shorthand`. The pass reads them from the entries, which the chain
      yields with `target: "@biblatex/entries+list"`. An arXiv id becomes `archive` and
      `archive_location`, and `shorthand` the abbreviation (What a record keeps).
    - ADS writes a journal as an AASTeX macro (`\prl`), which comes through as written. A table
      of those macros names the journal.
    - A bare word no `@string` defines (`journal = PNAS`) is dropped, and the preview says the
      field was. The entries hold it as an empty value, as they hold an empty field, so the
      preview says the same of either.
    - A month joined to a day, `month = jun # "~15"`, the form BibTeX's manual gives, comes as
      a year alone. The entries hold it as `06~15`, which the pass reads as both.
  - `parse.sentenceCase` stays `never`, its default, so a title's case is as written and the
    braces that protect capitals leave nothing behind. `\emph{…}` and `\textit{…}` come as
    `<i>…</i>` (What a record keeps, "Markup in a field").
- **RIS: citation-js** (`@citation-js/plugin-ris` 0.9), as `@ris/file`. It maps `SN` by type:
  an ISBN for a book, an ISSN for a serial, the report number for a report. Two `SN` lines come
  as a list, which the pass joins, as it joins any text field given twice. Rejected: reading
  `SN` as an ISBN for every type but a chapter, which shows a journal's ISSN as its ISBN and
  refuses a report's number.
- **`.nbib` (MEDLINE):** by hand, the size of a RIS reader: `PMID`, `PMC`, `TI`, `FAU`/`AU`,
  `DP`, `JT`, `VI`, `IP`, `PG`, `AID … [doi]` and `LID … [doi]`, which is where a paper online
  ahead of print keeps its DOI, `AB`, `IS`, `PT`. citation-js's PubMed plugin only fetches a
  record by its id. `CN`, a group author, is a name that isn't split; a record with no `FAU`
  takes `AU`'s short form, `Polack FP`; the full stop MEDLINE puts after every title is
  dropped; and a `PT` of `Preprint` is an `article`.
- **`CITATION.cff`:** citation-js's `plugin-cff` (0.7), reached as `@else/yaml`, never the
  fetchers packaged beside it in `plugin-software-formats`. It brings `plugin-yaml` and
  `js-yaml`.
  - Only the file's own work is taken, the record the plugin marks `_cff_mainReference`. The
    plugin also yields every entry of the file's `references` list, which are the works the
    software cites, not the software.
  - That record comes with no type, and is a `software`.
  - CSL-YAML stays refused: Pandoc's form of it, a `references:` list between `---` lines,
    doesn't parse as one YAML document.
- **Loaded with the import panel** and the row's "Replace record" box, by a dynamic import, never
  in an editor or a reading view.
  Never `plugin-csl`, which brings citeproc and its licences (Later).

### What a record keeps

- **Every variable of the CSL 1.0.2 schema**, each by its schema type (text, number, names,
  date). `parseCslItem` builds the record field by field with the same bounds, and drops what
  isn't in the schema, such as Crossref's `reference` list and `plugin-cff`'s `_orcid`.
  - **But for seven**: the five a processor computes for a citation rather than a record holds
    for a work (`citation-label`, `citation-number`, `first-reference-note-number`, `locator`,
    `year-suffix`), and `id` and `citation-key`, which are the reference's key and are written
    from it on the way out. `custom` and `categories` are dropped too.
  - `journalAbbreviation` and `shortTitle`, the names Zotero still writes, are read as
    `container-title-short` and `title-short`.
  - **Crossref's own type names**, `journal-article` and the rest, are read as CSL's, and the
    preview says so. A list where CSL has one value is one value: a title's first entry, and any
    other field's entries joined, as Crossref gives a journal's two ISSNs.
- **A bound that cuts is reported.** A text field is cut at 4,000 characters and a list of names
  at 200, and a run of white space, a paragraph break included, becomes one space. The preview
  names each field it cut (The import box), since a collaboration's paper has more than 200
  authors.
- **All 45 CSL types**, and `document` for any other, which the preview reports. Two rules read
  the record rather than a list of types:
  - `entry.ts` shows a container for any record that has one, so a blog post shows its blog and
    a case its reporter. A title is in quotation marks when the record has a container and in
    italics otherwise (`isPart`), so a new type needs no list kept.
  - An ISBN identifies a record that has no container and whose type is not a part's by name:
    `chapter`, `paper-conference`, and the types that begin `article`, `entry`, `post` or
    `review` (`isbnIdentifies`, `identifiers.ts`). A chapter's or a conference paper's ISBN is
    its book's, and `crossref` inheritance hands a paper its proceedings' ISBN.
    - Rejected: the container alone. An `@inproceedings` with no `booktitle` has none, so a
      second paper from one proceedings would match the first by the proceedings' ISBN, be
      refused as its duplicate, and be offered as its replacement.
- **Names keep their particles and suffix** (`non-dropping-particle`, `dropping-particle`,
  `suffix`), so "van Beethoven" and "King, Jr." survive. The BibTeX reader gives every particle
  as non-dropping, BibTeX having one kind. A dropping one comes from CSL-JSON, as Zotero
  writes it.
  - **A non-dropping particle is part of the family name wherever a name is used**, through one
    function beside `shortName` (`familyName`, `csl.ts`): a label, `(van Beethoven 1801)`; an entry, "van Beethoven,
    L."; the bibliography's order, under V; and a made key, `vanbeethoven1801`. That is APA's
    rule.
  - A dropping particle follows the initials, "Humboldt, A. von", and a suffix follows both,
    "King, M. L., Jr.". Neither is in a label.
  - **Two pieces of SQL read a name's parts, these three included**: the `reference_listing`
    view's `people`, which `/references` shows and sorts by, its non-dropping particle in the
    family name (`reference_family()`), and `reference_people()`, which feeds the search vector
    (migration `reference_keys_and_records`).
- **Markup in a field.** A CSL-JSON text field may hold a little markup: `<i>`, `<b>`, `<sup>`,
  `<sub>`, and a `<span>` for small capitals or `nocase`. Crossref's titles hold it, and
  citation-js's BibTeX reader writes `\emph{…}` as `<i>…</i>`.
  - **A title keeps those tags** (`title`, `container-title`, `collection-title`), each in one
    spelling, and one function splits such a field into runs, as `inlineRuns` does a chip's
    words (`titleRuns`, `src/lib/references/markup.ts`).
  - **What draws an entry takes the runs** (`TitleRuns.tsx`): a doc's bibliography, a
    reference's page, and a post's appended References, in the marks a post's schema has,
    italics and bold. Italics inside a title that
    is itself set in italics are roman, as CSL sets them: the play's name in a book whose
    title is `A Commentary on <i>Hamlet</i>`.
  - **Everything else takes the text alone**: a label, a made key, the citation menu,
    `/references`' Title column and its sort, and the search vector. So the view and the vector
    function take the tags out too (`reference_title_text()`).
  - **No reader is handed a marked-up title as a string.** `cslOf` gives each of the three
    fields as its text and its runs, a type no string slot takes, so the compiler finds every
    reader that hasn't chosen one. A reader that forgot would otherwise show the tags as
    written, and no check would fail.
  - **Every other tag is removed on the way in**, and every tag in a field that isn't a
    title, the text inside it kept: Crossref's abstracts are JATS XML.
    - A tag is a `<`, a `/` or not, and a letter, up to the next `>`. Any other `<` is text, so
      "p < 0.05" keeps its sign.
    - Character references are decoded before the tags are read: `&amp;`, `&lt;`, `&#x2013;`.
      Crossref writes them, and its `&lt;i&gt;` is italics it meant.
  - Rejected: taking all markup out on the way in. A species' name, or a book's title inside an
    article's, would lose its italics in every entry and every download.
- **Dates keep their month and day** from every format, as CSL-JSON's already do.
- **The size limit measures the record after its fields are chosen**, not the input, since
  Crossref's CSL-JSON is mostly its list of cited works. DOI lookup (Later) needs this too.
- **ISSN, PMID and PMCID are kept as fields.** Only DOI and ISBN find duplicates, as now.
- **biblatex's `shorthand`** becomes the abbreviation (`short`) of a reference that has none.

### Keys

- **The source key** is a CSL `id` or `citation-key`, a BibTeX entry key, or a RIS `ID`. An `id`
  that is a URL is not a key: Zotero's CSL-JSON writes the item's URI there for an item with no
  citation key, and a key is made instead.
- **A source key is kept as given** when it fits. A library key becomes ASCII letters of either
  case, digits, `_`, and `:`, `.` or `-` between them, at most 80 characters, which is inside
  Pandoc's key grammar, BibTeX's and a URL segment's, unique ignoring case. So `Frank_1970` and
  `radnerOriginIdeas2012` stay as they are, and a manuscript, the person's own `.bib` and
  MultiBlog's downloads agree.
- **A source key that doesn't fit**, such as dblp's `DBLP:conf/nips/VaswaniSPHGTS17` with its
  `/` or a key with an accented letter, gets a key made from the record, as a record with no
  source key does. The source key is kept as an alias in `reference_key_history`, which
  `referencesByKeys` already reads, in Unicode's composed form (NFC), so one accented letter
  is one spelling.
- **A source key another reference holds**, as its key or as an alias, ignoring case, gets a
  made key too, and no alias: the key stays the other reference's, and the preview says so.
- **A key someone asks for is taken as given or refused**: `create_ref`'s `key` and the rename
  box. Neither is altered to fit, since the key asked for is the one a manuscript will hold.
- **The shapes are `src/lib/references/keys.ts`'s**: `isLibraryKey`, `foldKey`, and
  `isKeyShaped`, what a lookup checks before any query, which is anything a library key or a
  kept alias can be: at most 200 characters, with no white space and no brace. A source key
  with either isn't kept even as an alias, and the preview says so.
- **A lookup ignores case**, in a URL, in Markdown and in `cites`, and a URL in another case
  redirects to the key's own. `/references/[key]` decodes its param, since Next hands it over
  percent-encoded and a `:` arrives as `%3A`. A rename that changes only a key's case rewrites
  the key and leaves no old key behind.
- **Case is ignored through a stored column, `key_folded`**, on `reference` and on
  `reference_key_history`: the key with its ASCII capitals lowercased, held to that by a CHECK,
  uniquely indexed, and written beside `key` by `reference-write.ts`, the only writer. Every
  lookup by key reads it, with the asked key folded alike, so `findUnique` and `in` work as
  they do now.
  - **Only A to Z are folded**, by one rule in the CHECK (`translate`) and in the code. A
    library key holds no other letter. An alias may, and its other letters match in their own
    case.
  - Rejected: `lower()` in the CHECK beside `toLowerCase()` in the code. The two disagree on
    some letters an alias may hold (`İ`, a final `Σ`), and `lower()` follows the database's
    locale, so the CHECK would refuse an alias the code had folded.
  - Rejected: a unique index on `lower(key)` alone. Prisma can't read an index on an expression
    through `findUnique` or `in`.
  - Rejected: Prisma's `mode: "insensitive"`. It is `ILIKE`, in which the `_` a key may now hold
    matches any character, so `Frank_1970` would also find `FrankX1970`.
- **A list of keys is one segment, the keys joined by commas**: `/references/<key>,<key>,…`
  (Pages), each percent-encoded as `referencePath` encodes one, in the order the citation names
  them, each work once. `parseReferenceSegment` (`keys.ts`) reads a decoded segment as one key,
  a list, or nothing, by these rules:
  - **A comma, because no key a citation writes holds one.** A chip writes a work's current key,
    which is always a library key. Pandoc's bare key holds none either (`BARE_KEY`,
    `citation-markdown.ts`).
  - **A segment with a comma is a list, whatever the library holds.** Each part must be a library
    key (`isLibraryKey`), which every key a citation writes is, and every key a rename leaves
    behind. There are at most `MAX_LIST_KEYS` (20) parts. Anything else is a 404 before any
    query, as a segment no key can be is.
  - **`~` before a key that itself holds a comma.** Only an alias kept at import can: a CSL `id`
    or `citation-key`, or a RIS `ID`, since `isKeyShaped` refuses only white space and braces.
    A segment that opens with `~` and holds a comma is one key, what follows the `~`. It is looked
    up whole and never renders: it redirects permanently to the work's page, or is a 404. Without
    a comma a segment is a plain key, a leading `~` included. No library key opens with `~`, so
    no list does, and an alias that opens with `~` and holds a comma is written `~~…`.
    `referencePath(key)` writes the `~` for a key holding a comma; `encodeURIComponent` leaves
    `~` as it is.
  - **Decoded before it is split.** Next hands a param over percent-encoded, so a comma arrives
    as `%2C` and a key's `:` as `%3A`.
  - **Rejected: asking for the whole segment as a key before splitting it.** The address would
    mean whatever the library held that day. Adding an alias `a,b` would turn the list of `a` and
    `b` into one work's page, behind permanent redirects a browser keeps.
  - **Rejected: refusing a comma in `isKeyShaped`.** It would drop such an alias everywhere,
    `@{a,b}` in an imported manuscript included, to settle what only the address asks.
  - **Not a word of its own under `/references/`**, such as `/references/works/<key>/<key>`. Any
    such word is also a valid key, the reason the downloads sit under `/api` (Downloads).
  - **Not `/references?keys=`.** `/references` is the members' admin table, and a page that
    reads `searchParams` can never be cached (Pages).
- **A key made from a record** is the first creator's family name, its accents taken off, and
  the year: `radner2012`, then `radner2012b`; `muller1901` for Müller.
- **Where keys are read:**
  - `/references/[key]` and `citedPageTarget` read their segment through
    `parseReferenceSegment`, which tests a key with `isKeyShaped` and a list's parts with
    `isLibraryKey`, before any query. So `/references/<list>/p/<page>` is a 404, a list being
    no work, and `/references/~<alias>/p/<page>` reaches the alias's work;
  - `search`'s `cites` in the MCP schema and the bulk export's `cites` check test a key with
    `isKeyShaped` before any query;
  - `parseCites` (`search/params.ts`) keeps a key as given, one key in two cases being one
    filter;
  - every lookup reads `key_folded`: `referenceByKey`, `referencesByKeys`,
    `resolveReferenceKey` and `keyTaken`. `referencesByKeys` answers by the key as it was
    asked, since each caller looks up its own spelling;
  - `createReference` and `updateReference` take an asked key as given or refuse it, and
    `updateReference` frees a key the reference once had by its folded form;
  - the search vector takes the key with every character but a letter or a digit as a space.
    Postgres reads `smith.jones-2012` as a host name and a number, while a search sends the
    words `smith`, `jones` and `2012`, so the key would otherwise be missed by `/references`'
    box, by the citation menu, and by `create_ref` reading back the work it made;
  - the Markdown parse looks up every key Pandoc reads (Markdown, "A bare `@word` is a
    citation").
- **Rejected: slug-shaped keys, with the source key only as an alias.** `[@Frank_1970]` would
  resolve, but the library and its downloads would name the work `frank-1970`, so a manuscript
  written back out of MultiBlog would no longer match the person's own `.bib`.

### The import box

- **Files, picked or dropped**, beside the paste box, several at once. Both are read in the
  browser into one list.
  - **"Add files…" and a drop each add to the files chosen**, which are listed below the
    button, each with a × to remove it. The picker is cleared after each pick, so a second pick
    adds rather than replacing. A file already chosen, by its name, size and modified time, is
    skipped, so a file dropped twice isn't previewed twice.
  - **The drop target is the whole panel**, not only the box, and a file dragged onto the closed
    panel opens it. A drag of selected text is the browser's, so it still lands in the box. A
    drag of files has its default prevented across the panel even while a preview is shown,
    where it is refused, since the browser's default opens the file in place of the page
    (`src/components/useFileDrop.ts`).
- **A preview before anything is written.** It shows each record's title, people, year and type, and the key it will get, with why that
  differs from its source key. It also shows what was dropped, cut or mapped (a field no CSL
  variable holds, a field cut at its bound, a type read as another, an identifier that failed
  its check), and whether the library already holds it, with the title it has there.
  - **The server answers what only it knows** (`previewReferenceImport`): which records the
    library holds, asked by identifier, and which keys are free, five hundred records to a
    question, each told the keys earlier records of the import were given. A key in the preview
    is the one the import would give now, and the report says the one it gave.
- **Parsed in the browser, checked on the server.** Import sends the parsed records in
  batches, one server action each, with a running count (`cutBatches`,
  `src/lib/references/batches.ts`). Every record is sent, a duplicate included, so each has a
  receipt and the report covers the whole import. Each record is sent as `parseCslItem`
  built it in the browser, with its source key and its `shorthand`, so one is never larger than
  a stored record may be. A batch is at most a hundred records and at most 500,000 bytes as
  UTF-8, half of Next's 1 MB body limit, which counts bytes: a record may be 20,000 characters
  and a character three bytes, so a hundred of the largest would not fit. The server runs each
  record through `parseCslItem` and the identifier checks, as it does `create_ref`'s, so
  nothing the browser parsed is trusted. A library of thousands of records needs no larger body
  limit, and shows its progress.
- **An import survives a reload.** When Import is pressed, the browser keeps the records still
  to send, with the preview's choices, in IndexedDB under the import's id and the user's
  (`src/lib/reference-import-store.ts`), and
  drops each batch once the server has answered it, so nothing it keeps is in the database yet.
  On load the panel offers an unfinished import ("2,300 of 5,000 records left") to resume or
  discard. Resuming starts at the oldest batch with no answer, the one in flight when the page
  went away.
- **A record is imported once.** Each carries the import's id and its place in the import, and
  the server writes a receipt for it, `reference_import_receipt` (the user, the import's id, the
  place, the outcome and the key). The record itself is written straight into the library, in
  the same transaction; a receipt only says what became of it.
  - A record sent again answers what its receipt says: after a reload, from a second tab, or in a
    batch the server died part-way through. A record with no DOI or ISBN would otherwise be
    added twice.
  - **The receipt is the first write of the transaction** that creates or replaces the
    reference. The three are unique together, so of two sends at once the second waits on the
    first's receipt, fails, and reads it. Written later in the transaction, the second would fail first on
    the reference's key or identifier, and report the record as a duplicate of its own first
    send.
  - **Every outcome has a receipt.** A record refused, or reported as a duplicate, gets its
    receipt written alone, there being no reference to write it with. So a resumed import's
    report is read from the receipts, and the browser keeps no copy of it.
  - **But for a failure another try might not meet**, such as a key taken while the record was
    being saved. That writes no receipt, and the record is tried again when it is sent again.
  - Rejected: a receipt per batch, claimed as `src/lib/api/idempotency.ts` claims a write. That
    helper runs a failed or abandoned claim again, which is right for one write and wrong for a
    hundred of which sixty are already in.
  - **An import may be sent for six days, and its receipts are kept for seven**
    (`src/lib/references/batches.ts`). The browser offers an unfinished import for six days
    from its start, and the server refuses a batch of an import whose first receipt is older
    than that, whole, and the browser then drops what it kept. A user's receipts older than
    seven days are deleted when they next send a batch, so nothing sweeps them. The day between
    the two is what keeps a receipt from being deleted while its import may still be sent: a
    send that crosses the sixth day stops, rather than resending records whose receipts are
    gone, which would add a second copy of each with no DOI or ISBN.
    - A receipt answers only a record of its own import: a second import of the same file has
      another id, and finds what the library holds by DOI and ISBN, as any import does.
- **An identifier that fails its check drops the identifier, not the record**, and the preview
  says so, so it can be corrected in the box first. Kept without it, the record has nothing to
  catch a later copy of the work by. An ISBN field keeps the ISBNs that pass, written as
  ISBN-13s. Before the check, an ISBN is found by its shape inside the field, so `9780631175049 (pbk.)`, and two ISBN-10s with one space between them, read as ISBNs.
  `create_ref` still refuses a bad identifier, since an agent can correct it.

### Replacing a record

`updateReference` edits a key, an abbreviation and a PDF, `create_ref` only creates, and an
import matching a held DOI or ISBN, deleted or not, is a duplicate. So three ways replace a
reference's record with another, each through `replaceReference` (`reference-write.ts`).

- **A duplicate in the preview offers "Replace its record"** with the one being imported, a
  duplicate at a time or all of them at once. Its key, abbreviation, PDF and citations stay,
  and the citations are relabelled.
- **A record that matches two references replaces neither**, its DOI one's and its ISBN
  another's. The preview names both.
- **A deleted duplicate is restored with it**, in one write, `replaceReference` in
  `reference-write.ts`: `updateReference` refuses a deleted reference, and a restore followed
  by an update could stop between the two.
- **"Replace record" on a row of `/references`** (the ↺ in its Title cell,
  `ReferenceReplaceBox.tsx`): paste one record in any format the import
  reads, parsed in the browser as the box parses, see which fields change, and save. A field
  the pasted record lacks is removed. This is the repair for a record with no DOI or ISBN,
  which no import can match. The box starts from the reference's CSL-JSON download, and a
  file dropped on it, one only, puts its text in the box. A deleted
  reference has none: restore it first.
- **`update_ref`**, an MCP tool beside `create_ref`: a reference's key and a CSL-JSON record,
  through `replaceReference`, so an agent can correct a record it added. `create_ref` refuses
  the corrected record as a duplicate of the one it corrects. A deleted reference is refused,
  never restored: a person deleted it.

### Downloads

- **Four formats**, written by one function (`writeReferences`, `src/lib/references/export.ts`)
  from a list of records, so every place below agrees. Their endings and media types are
  `export-formats.ts`, which a link drawn in the browser reads without the writers:
  - **CSL-JSON** (`.json`, `application/vnd.citationstyles.csl+json`): the stored record, with
    `id` and `citation-key` set to the key. Nothing the library holds is left out.
  - **BibTeX** (`.bib`, `application/x-bibtex`): citation-js's `bibtex` writer, between two
    passes of ours, the file every TeX tool reads, biber included.
    - `useIdAsLabel`, so an entry's key is the library's, and `checkLabel` off, since it
      otherwise takes the `:`, `.` and `-` out of a key.
    - TeX for every character the writer has TeX for (`asciiOnly`, its default), since every
      BibTeX reads that: `{\" u}` for "ü". "H₂O" is written "H2O".
    - **A character it has no TeX for stays in the file as UTF-8.** The writer writes such a
      character as nothing: a Cyrillic author comes out as `{, }`, a Japanese title as `{}`, and
      a Latin word loses its `ə`. A given name's `ё` or `й` leaves its accent with no letter
      under it, `{\" }`, which stops LaTeX. So a pass before the writer puts a marker of ASCII
      letters in place of each, and a pass after it puts the character back. Which characters
      those are is read from the writer's own tables (`lib/input/constants.js`). `bibtexu` and
      biber read the file whole. Old `bibtex` carries the bytes through and cuts a letter by
      the byte wherever a style takes a name's first letters. So `abbrv` breaks such a name's
      initials, and `alpha` the label it makes from the family names.
    - **Both of a name's particles are written as BibTeX's `von` part**, `de La Gaulle,
      Charles`. The writer alone leaves a dropping particle out, so a pass before it joins the
      two. BibTeX has one kind of particle, so the file read back gives both as non-dropping.
    - It writes what classic BibTeX has a field for: no abstract, translator, language or page
      count, and `@misc` for software, a legal case, a web page or a thesis with no genre,
      without its container.
    - **After it**, the pass adds an arXiv id as `eprint` with `archivePrefix = {arXiv}`,
      arXiv's own form, which the writer leaves out, and mends two entries a classic style
      would print wrongly:
      - **A month** becomes BibTeX's macro, `month = jun`, and a day its own field,
        `day = {15}`. The writer puts both in a braced `month`, `{jun 15}`, and a month alone as
        `{6}`. A braced value is a string, so a style prints it as written. A style ignores
        `day`, and citation-js reads the two fields back as the whole date. Rejected:
        `month = jun # "~15"`, which citation-js reads back as no month.
      - **A chapter** becomes `@incollection`. The writer makes it `@inbook` with a `booktitle`,
        and the standard styles' `@inbook` takes `title` for the book's and reads no
        `booktitle`. citation-js reads either as a chapter. The biblatex file keeps `@inbook`,
        which has a `booktitle` there.
  - **biblatex** (`.biblatex.bib`, `application/x-bibtex`): citation-js's `biblatex` writer,
    with the same key settings, between two passes as BibTeX's is, the one for particles the
    same. It keeps what BibTeX can't: the abstract, translators, a whole date, `@software`, a
    web page's site and a case's reporter. For biber, and for Pandoc, which reads a `.bib` file
    as biblatex.
    - **Every character outside ASCII stays as UTF-8**, by the same markers, put in place of
      all of them: what biber and Pandoc read, and what a biblatex file holds. But for a page
      range, left to the writer, which writes its en dash `--`, every reader's range.
    - **A quotation mark inside a title is braced with its word.** The writer braces a title's
      capitalised words, in this file and in BibTeX's, and takes a mark beside one into the
      braces: `{A {“Black} {Box”} of {Stakeholder} {Thinking}}`. Pandoc then prints the marks
      as written, double inside a quoted title, where from the CSL-JSON file it makes them
      single (TODO.md, "Pandoc prints a title's inner quotation marks as written").
    - Rejected: `asciiOnly` off. The writer then escapes nothing, so a title's `&`, `%`, `#` or
      `_` goes into the file bare and stops LaTeX.
    - **After it**, a pass adds an arXiv id as `eprint` with `eprinttype = {arxiv}`, unless the
      writer has put a PubMed id in `eprint`, the one id it writes there.
    - Rejected: biblatex alone. Classic `bibtex` reads no `date` or `journaltitle`, so its
      entries would have no year and no journal.
    - Rejected: BibTeX alone, which loses the fields above for everyone.
    - The two file names differ, so both can be saved to one folder, and a file named
      `<name>.bib` is always the one classic BibTeX reads.
  - **RIS** (`.ris`, `application/x-research-info-systems`): citation-js's writer, between two
    passes of ours.
    - **Before it**, a non-dropping particle is joined to the family name, a dropping one is
      put after the given name, "Humboldt, Alexander von", and the markup is taken out of a
      title. Its writer drops both particles and writes the markup as tags.
    - **After it**, two mendings, in this order:
      - **A value is made one line again.** The writer breaks every value after each 70
        characters, inside a word as readily as between two, and Zotero joins the pieces with a
        space. A line that follows a line holding exactly 70 characters of a value is more of
        that value, and no other line is: a stored value holds no line break.
      - **A page range** it wrote whole, `SP  - 635-641`, becomes an `SP` line and an `EP`
        line, RIS's own form and what Zotero writes, so no reader is asked to take a range in
        `SP`.
    - Rejected: the writer's older layout (`spec: "old"`), which has an `EP` and fills both
      wrongly: pages 635–641 come out as `SP  - 6` and `EP  - 3`.
    - It writes no reporter and no page for a legal case, and no arXiv id, which RIS has no tag
      for: the record's URL carries it.
    - Zotero reads back every field it writes, among them a book's editor from `A3`, its series
      number from `M1` and its page count from `SP`. Those three tags look like mistakes for a
      book and are not.
- **The writers run on the server**, for the route and the bulk export, so citation-js's core
  and its BibTeX and RIS plugins are server dependencies. No reader is called there.

**One route**, `GET /api/references/export?format=csl-json|bibtex|biblatex|ris`, with one
selection. It sits under `/api` because `/references/export` would hide a reference keyed
`export`. The File column below gives each selection's name as BibTeX; the ending follows the
format.

| Selection | Works | Gate | File |
|---|---|---|---|
| `key=<key>` | that one | none: a record is public | `<key>.bib` |
| `doc=<id>` | the works the doc cites | `canUserReadDoc`; 404 otherwise | `<doc slug>.bib` |
| `post=<id>` | the works the post cites | `readablePostWhere`; 404 otherwise | `<post slug>.bib` |
| `/references`' querystring | what its search matches, every page | `canViewReferences` | `references.bib` |
| `ids=<id>,…` | the rows selected in `/references` | `canViewReferences` | `references.bib` |

- **A doc's and a post's works come from the `citation` table**, which holds the works their
  References list. A doc's rows are kept from its `prose_json` cache, so they lag a live edit by
  seconds. A post's are kept from the citations in its published text. A deleted reference is
  included, as the References list it struck through. The records are the library's current
  ones, so a corrected record downloads corrected before a post is republished.
- **Every selection is in the library's order**, by author and then year. A `.bib` file's order
  means nothing to the tools that read it.
- **A `:` in a key is `_` in the file's name**, since Windows allows no `:` in one.
- **Every file is sent as an attachment**, `Content-Disposition: attachment` with the File
  column's name. Zotero's Connector then imports a BibTeX, biblatex or RIS download into Zotero
  in place of saving it, in Firefox and in Vivaldi alike. Served inline, Vivaldi's Connector did
  not always. Neither imports CSL-JSON. (Checked by hand: Later, "Zotero's Connector".)

**Where the links are.** Every one is a plain link with `rel="nofollow"`, so a crawler that
reads a public page doesn't fetch four files for each work on it.

- **`/references/[key]`:** a row, "Download: BibTeX · BibLaTeX · RIS · CSL-JSON", beside the DOI
  and ISBN. The links are plain URLs, so the page stays static.
- **A doc's References:** a download icon beside the heading, in `BibliographyList`, wherever the
  list is shown: the reading view, side-by-side and the editor. It opens a menu of the four
  formats, a `<details>`, so it works in a static first paint. The `<details>` sits in a row
  with the `<h2>`, not inside it, where only text-level elements may go.
- **A post's References:** the same icon beside the heading. The References are the post's text,
  appended at publish, so the icon is added where the text is drawn and never written into it:
  by the static render, and by a widget decoration in the read-only editor that replaces it
  (`AnnotatableArticle`). Neither changes the text, so search, quotes, comments and the feed
  never see it (`src/lib/post-references-download.ts`). The heading is found by its place, the
  post's last level-2 heading reading "References" in a post that cites a work, since
  `docJsonForPostSide` always appends it last.
  - **Where it sits.** The heading is the post's text, so the icon can't share its row: it is
    drawn before the heading, floated right at the heading's own size, top margin and line
    height, so the two make one line. A doc's sits at the right of its heading's row to match.
- **The landing page's preamble** gets no icon. Its References are a doc's, drawn as a post's,
  and the doc may be one its readers can't open.
- **`/references`:** a Download menu beside the column picker for the rows its search matches,
  on every page, and a bulk action, "Download as…", for the rows selected, offered to every
  member, where the table's other bulk actions are an author's. The route reads the querystring
  with `parseReferencesFilters` and the page's own `where` (`src/lib/references-where.ts`), so
  when the table's search grows, its download follows with no change of its own. That search
  is the box's words, each a prefix, and the deleted toggle.
- **The bulk export** ([MCP.md](MCP.md) §5): the tar carries `references.json` and
  `references.biblatex.bib`, every work the exported docs cite, so
  `pandoc --citeproc --bibliography=references.json <doc>.md` resolves the `[@key]`s its
  Markdown holds. The manifest lists both. The second is biblatex, the fuller of the two `.bib`
  forms, and Pandoc reads it as well. A title's inner quotation marks print right only from
  the first (biblatex, above).

**MCP:** `find_refs` keeps answering text, and the bulk export is an agent's way to the records.

### Checks

- **Unit tests:**
  - `src/lib/references/record.test.ts`: every CSL type and variable kept, a bound that cuts
    reported, markup kept in a title in one spelling and taken out of every other field,
    character references, a title with markup as a label, a key and an entry's runs, italics
    inside an italic title, both particles and a suffix, the ISBN rule with two papers of one
    proceedings, and keys: their shape, the fold and a composed alias;
  - `readers.test.ts`: a fixture per source (`fixtures/`, public records trimmed and hand-made
    cases) with the CSL it must yield, each reader's mended cases, the formats refused, a URL
    or a DOI handed to each reader by name, and batches cut by bytes with records of three
    bytes to the character;
  - `export.test.ts`: a round trip through BibTeX, biblatex and RIS and back through the
    readers above, a title holding `&` and `%`, Cyrillic and Japanese, both particles through
    each format, a RIS value of 69, 70, 71, 140 and 141 characters and one whose 71st
    character begins what reads as a tag, a surrogate pair, `SP` and `EP`, the BibTeX month
    and day and `@incollection`, and biblatex's PubMed `eprint`.
- **e2e:** `e2e/reference-import-export.spec.ts`: an import with a duplicate replaced and a
  deleted duplicate replaced and restored; an import whose second batch the server wrote but
  the browser never heard, reloaded and resumed with nothing added twice; one import resumed
  from two tabs at once; one resumed past its six days, refused and dropped; files picked and
  dropped into one list, a file chosen twice skipped and one removed left out; `update_ref`
  correcting a record in another case and refusing a deleted one; and every download, an
  attachment under its name, behind its gate. And in
  `e2e/references.spec.ts`, the preview and a key in another case redirecting to its own.
  - Not covered: a batch the server died part-way through, with only some of its records
    written. Its receipts answer it record by record, as they answer the batch above.
  - Not covered: `Frank_1970` not finding `FrankX1970`, an alias with an accented capital, and
    a rename in case alone, which need the database and so no unit test.
- **Checked by hand**, 2026-11-10, with TeX Live 2026 (`bibtex` 0.99e, `bibtexu` 4.03, biber
  2.22) and Pandoc 3.7.0.2:
  - a Cyrillic author and a Japanese title: the BibTeX file through `bibtex`, `bibtexu` and
    biber, the biblatex file through biber, and all three files through Pandoc. Each prints
    them whole, but for old `bibtex` under `abbrv` and `alpha` (BibTeX, above);
  - `export.test.ts`'s chapter and article, dated to the day, through `bibtex` under `plain`,
    `unsrt`, `alpha` and `abbrv`. The month prints by name with the day left out, and the
    chapter with its editor and its book's title. With the writer's own `@inbook` and braced
    `month`, the same styles print "jun 15 1990" and leave the editor and the book's title out;
  - the bulk export's Markdown with each of its two files, for three docs citing 81 works,
    through `pandoc --citeproc`: every key resolved, with no warning.
- **Not yet checked by hand:**
  - a chapter and an article dated to the day, as BibTeX, into Zotero, whose reading of `day`
    and of `@incollection` is unchecked. Its Connector check (Later) read the writer's output
    without the pass;
  - a title and an abstract over 70 characters, as RIS, into Zotero. The Connector check's
    longest value was 69.

## Later

- **CSL styles through citeproc-js** (CPAL-1.0 OR AGPL-1.0, about 1 MB). A doc's Citations
  setting offers a CSL style beside the three house forms. For a doc set to one, citeproc-js
  computes its labels and its bibliography from the `csl` records, in place of `citation.ts`'s
  forms and `entry.ts`'s format, and the style decides numbering, telling works apart and
  "ibid.". To settle here before it is built:
  - **Where it runs.** Never inline in the Hocuspocus process, which is single-threaded on a
    one-CPU box. Either every editor of such a doc loads the 1 MB and labels its chips itself,
    as it does today, or the Next server labels them and editors fetch the labels, so a new
    citation waits a round trip for its own. The second probably needs a cache of label maps
    keyed by the doc's version, its style and its context.
  - **The licence.** Both of citeproc-js's licences bind software used over a network.
  - **Note styles.** A notes-and-bibliography style puts a citation in a footnote, and a doc
    has no footnotes: leave such styles out, or build footnotes first.
  - **Which styles.** A few bundled, or any from the CSL repository, which needs somewhere to
    upload one, and the locale files the styles need.
- **Converting the hand-written citations.**
  - The docs hold many links such as `[BU p. 49](/pdf/…#page=53&text=…)`, about 1,830 in a stale
    copy.
  - Each becomes a citation, one position where it was several.
  - Every stored quote across one is re-stamped at the conversion, with its positions mapped
    through it and its quote re-derived. That was 58 of 140 annotation quotes in that copy.
  - An editor annotation whose mark covered only the label loses it.
  - Opted into per doc, and done last, once the rest is built.
- **Zotero's Connector, through unAPI**, so its button saves a work from the page it is on. A
  `<link rel="unapi-server">` on `/references/[key]`, a doc's reading view and a post's page, an
  `<abbr class="unapi-id">` for each work, and `/api/unapi` answering a work in RIS from the
  downloads' function (`src/lib/references/export.ts`). The Connector then saves the work, or
  offers a doc's or a post's works as a list.
  - **What it adds is the button.** Zotero already gets the works without it: the Connector
    imports every download but CSL-JSON (Downloads, "sent as an attachment"). unAPI lets a
    reader save from the Connector's own button without finding a download link, and pick some
    of a doc's works in place of all of them.
  - **Where each `abbr` goes:** beside the download links on `/references/[key]`; inside each
    entry of a doc's References; and for a post, whose entries are its text, a widget
    decoration per entry, placed as the download icon is.
  - **What `/api/unapi` answers**, from a check by hand against a stub serving three works: in
    Vivaldi (Chrome 152) saving one work and a list of three, in Firefox 156 opening the
    pages, 2026-11-09.
    - The Connector asks for the format list with no `id`, then for `?id=<key>&format=<name>`.
      It never asks for one work's list, the `300` the spec gives, so the bare request is the
      one that must answer.
    - Offered `ris` and `bibtex`, it takes `ris`, and Zotero read every field of a book, a
      chapter and an article from it. So RIS is the one format. A second, if one is wanted, is
      biblatex under the name `bibtex`, which it also took whole. Classic BibTeX lost the
      abstract, the translator, the language and the page count.
    - A key with `:`, `.` or `-` arrives intact.
    - The saved item's Library Catalog is the site's host, and a work with a URL gets an
      Accessed date, as an item saved from any site does.
  - Rejected: COinS, which carries only OpenURL's handful of fields; and Highwire `citation_*`
    meta tags on a reference's page, which would describe that page as the work itself, to
    Google Scholar as well as to Zotero.
- **DOI lookup** on import. A DOI pasted alone fetches its record as CSL-JSON from doi.org, by
  content negotiation, and the record goes through `parseCslItem` like any other. The fetch
  goes to doi.org alone, never to a URL the user gives.

## Checks

- **Unit tests:**
  - each form with its delimiters, its narrative and author-suppressed shapes, a page range,
    numbering, the `short` disambiguation, and the fallback for a reference without `short`;
  - the bibliography's entry format, its order and leads in each form, its numbers matching the
    labels', and what it leaves out or strikes through;
  - a bare `@word`: a known key makes a chip, an unknown one is refused, and `\@`, an email address
    and code stay text;
  - the identity rule for a citation of several works, and an edit adding a work keeping the
    chip's `iid`;
  - validation: each refused combination, and each stored form;
  - DOI and ISBN normalizing: prefixes, case, hyphens, check digits, ISBN-10 to ISBN-13;
  - the Pandoc round trip, every override included, and text straight beside a chip: `:`, `(`
    and key characters after it, a letter before a bare one, and `@radner2012.` ending a sentence;
  - `[@handle](https://x.com/handle)` staying a link;
  - `parseReferenceSegment`'s keys, lists and `~` form, and what it refuses; `referencePath` for
    a key holding a comma; a citation's link for one work, one work twice, and several, by
    where their pages are.
- **e2e:**
  - a duplicate refused, from an import and through `create_ref`;
  - a post's citation linking to the reference page, and the page offering the PDF to a member;
  - the bibliography in the editor, following a change of style, in the reading view, and in a
    post's text;
  - the popover: a page, the words before, the author left out, the narrative form offered only
    where it applies, a work added and removed on one chip, and Escape and Enter between it and
    the editor;
  - search by key, title and author, each at once, through MCP and the page, and an unknown key
    refused by MCP;
  - a reference's page listing the posts citing it to everyone and the docs only to a reader
    who may read them. Not covered: the PDF offered at the page a post's link names, which
    needs a reference with a file;
  - a list of works (`e2e/reference-lists.spec.ts`): the warning, the 404s, each redirect to its
    written form, the `~` form, a doc's citation linking to the list, and each work's PDF offered
    at its place in `#p=`, also after a renamed key redirects.
