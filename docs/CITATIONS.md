# Citations and references

**Status: built, but for what "Built so far" below names, and Later.** A *citation* is an entity chip
([ENTITY_CHIPS.md](ENTITY_CHIPS.md)) that stands for one or more works at a page. It is shown as
`(BU p. 49)`, `(Radner 2012, p. 49)` or `[3, p. 49]`, depending on the doc's style. The works are
*references*: records in a library, which this file also covers. This file fills in the kit's kind
contract. The kit says how every chip is stored, rendered, quoted and searched. Citations are step
3 of the kit's order.

## Built so far

The reference library (its data, its pages and its machine door), the citation chip itself
with its popover, its Markdown both ways and a quote written in it, a doc's bibliography, and
search by cited work. Everything below not listed here is still a plan: Later.

- **The chip kind:** `src/lib/entity-chips/kinds/citation.ts` holds its fields and
  validation, its identity (the works, in any order), when one citation continues another
  (it holds every work the other did), which both the anchors and the MCP merge ask, the
  three forms with their narrative
  and author-suppressed shapes, numbering by first appearance, the year-then-key
  disambiguation of a shared abbreviation, the per-work fallback to author-date for a
  reference with no abbreviation, and Pandoc's syntax on the way out. A doc's link goes to
  the page in the work's PDF when the file is SHARED and its page labels name the locator
  (a PRIVATE file is never linked, since a rendering can't depend on who is looking), and
  otherwise to the reference's page; a post's goes to `/references/<key>#p=<page>`.
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
  an ISBN's check digit; ISBNs are read only for a whole book.
- **Keys:** made from the first creator and the year (`radner2012`, then `radner2012b`) when
  none is given, and permanent once used: `reference_key_history` keeps a renamed key
  answering, and no other reference may take it.
- **The writes:** `src/lib/reference-write.ts`, taking an `Actor`: `createReference`,
  `updateReference`, `setReferenceDeleted`, `importReferences`. AUTHOR and above
  (`canWriteReferences`). A duplicate is refused as `duplicate`, naming the record that holds
  the identifier, a deleted one included.
- **Import:** `src/lib/references/import.ts` reads pasted BibTeX, RIS or CSL-JSON, one record
  or many, written by hand rather than taken as a dependency. `/references` has the box
  (`ReferenceImport.tsx`): each record is added, shown as already in the library with the key
  it has there, or refused with why.
- **`/references`**, through the admin table kit, for signed-in members
  (`canViewReferences`); AUTHOR and above rename a key, set an abbreviation, delete and
  restore. Author(s), Year and Title sort through the `reference_listing` view (migration
  `reference_listing_view`), since they are fields of the record's jsonb.
- **`/references/[key]`** is public and reads no session: the entry as a bibliography sets
  it, the abbreviation, the DOI, ISBN and URL, and the published posts citing it. A key the
  reference used to have redirects to its current one. `CitedBy.tsx`, a client island, asks
  `referenceCitedBy` (`src/lib/reference-cited-by.ts`) for the docs and notes citing it and its
  PDF, each through its read rule, and offers the PDF at the page a post's link names.
- **The entry format:** `src/lib/references/entry.ts`, the one bibliography entry the house
  styles share.
- **MCP:** `find_refs` and `create_ref` (`src/lib/mcp/tools/references.ts`). The names are
  short because a listed name is `multiblog_` and at most eleven characters more, claude.ai's
  limit ([MCP.md](MCP.md) §21, "The names"); the spec that holds every tool to it refused the
  longer pair.

## Terms

- **Reference.** A bibliographic record (book, article, chapter), optionally tied to a PDF in
  `/files`.
- **Locator.** The printed page a citation points at, such as "49" or "49–51".

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
  - A suffix that reads as a locator becomes one: `p. 5, note` with no locator is stored as
    locator `5`, suffix `note`.
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

**Context:** the references cited, deleted ones included, with their files' page labels for
links.

**Refresh** (the kit's step 1, item 10): a reference's record changes. Page labels change only a
chip's link, which every surface computes as it shows it and a post freezes at publish, so they
call for no refresh.

**Links.**

- **In the doc's own views**, a citation with a file and a locator links to the PDF passage,
  `/pdf/<slug>#page=<sheet>`. The sheet comes from the file's `pageLabels`
  ([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md)). Without both, it links to the reference page,
  `/references/<key>`.
- **A published post always links to the reference page**, with the locator in its fragment:
  `/references/<key>#p=49`. Files aren't publicly readable ([PERMISSIONS.md](PERMISSIONS.md)), so
  a PDF link would send a signed-out reader to sign in. The reference page's client island reads
  the fragment and offers the PDF passage to whoever may read the file. A fragment, rather than a
  query string, keeps the page static.

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
    sentence. `@{radner2012}` is the same key, braced. A library key is slug-shaped, so a key in
    any other shape is refused like an unknown one.
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
- a unique, slug-shaped `key`, such as `radner2012`;
- `csl`, a jsonb CSL-JSON item;
- `short`, the abbreviation labels use, such as `BU`, optional (Labels, above);
- an optional `file_id`;
- audit columns, `deleted_at` and `search_vector`.

**Who writes them.** AUTHOR and above create and edit references.

- The writes live in `src/lib/reference-write.ts`, taking an `Actor`, and the server action and
  the MCP tool both wrap it.
- A token acts with its account's role (PERMISSIONS.md, "API tokens"), so the same rule binds
  people and agents.
- In the UI, import is by pasting BibTeX, RIS or CSL-JSON, one item or many.
- MCP agents create references through `create_ref` (MCP, below). Editing a reference stays
  in the UI.

**Duplicates are caught by DOI and ISBN.**

- **The identifiers.** A `reference_identifier` table holds `reference_id`, `scheme` (DOI or
  ISBN) and a normalized `value`, unique per scheme. `reference-write.ts` writes it from the CSL
  `DOI` and `ISBN` fields, in the same transaction as the record, on create and on edit.
- **Normalizing.**
  - A DOI loses its `https://doi.org/`, `dx.doi.org/` or `doi:` prefix, and is lowercased, since
    DOIs are case-insensitive.
  - An ISBN loses hyphens and spaces, has its check digit verified, and is stored as ISBN-13, an
    ISBN-10 being converted. So `0-631-17504-0` and `978-0-631-17504-9` are the same book.
  - An identifier that fails its check is refused, not stored.
- **What counts.**
  - Every ISBN on a book counts (hardback, paperback, ebook), so importing another format of the
    same edition is caught. A different edition is a different record, since its pages differ.
  - A chapter's ISBN is its book's, so ISBNs are registered only for whole books. Chapters are
    matched by DOI alone; otherwise a second chapter of one anthology would read as a duplicate.
  - A deleted reference keeps its identifiers, as a deleted account keeps its slug and email. A
    duplicate of it is caught, and the UI offers to restore it.
  - A record with neither identifier gets no automatic check.
- **What happens.**
  - An import shows each matching item as "already in the library as <key>", with a link, and
    imports the rest.
  - Adding an identifier that another record holds is refused, naming that record.
  - `create_ref` refuses with `duplicate`, returning the existing key and URL so the agent
    cites that record instead.

**Pages.**

- **`/references`**, through the admin table kit, for signed-in members.
- **`/references/[key]`** is public. A published post's citations link to it, and it shows what
  a bibliography prints and where the work is cited publicly.
  - The record, and the published posts citing it (found in the `citation` table), are cached
    like an author page (`revalidate = 60`).
  - What only some viewers may see comes from a client island that asks the server once the
    reader is signed in, the way `TagChips` keeps the post page static. That covers the docs and
    notes citing it, the first 20 of each with a link to `cites=` for the rest, and its PDF, at
    the page a post's link names (`#p=49`, read in the browser so the page stays one cached
    page). Each list goes through its read rule, a PDF included, so a PRIVATE file is offered
    only to its owners.
- **A key is permanent once used.** Posts link to `/references/<key>`, and Markdown exports write
  `[@key]`. So renaming a key keeps the old one redirecting through a key history, as
  `UserSlugHistory` does for users.

**The menu.** A `CiteMenu`, opened by `[@`, Pandoc's citation opener. `@` alone still opens
mentions; a `[` before the `@` keeps the mention menu shut, since `[` isn't one of its allowed
prefixes.

- It sits in the doc editor and the annotation composer.
- It searches by key, short label, title and authors.
- "radner 49" sets the locator.

**The popover** (`CitePopover.tsx`) edits what validation allows (The chip, above): each work's
page, the words before and after it, and whether its author is left out; the form; and further
works, found as the menu finds them, "radner 7" included.

- **Where.** Beside the menu, in the doc editor and the annotation composer, and only in an
  editor that can be typed in. Selecting a citation opens it, by a click or the arrow keys, and
  Enter moves into it.
- **Each edit is one attribute set** on the chip's `data`, run through the kind's validation as
  every other way in is. So the chip keeps its instance id and its place, and an anchor on it
  asks the kind whether the new fields continue the old ones (The chip, above). Removing a work
  can therefore detach an anchor, as an edit removing it by any other means would.
- **A text field writes when it is left or Enter is pressed**, not on each keystroke, since
  validation trims and would eat the space being typed. Escape puts a changed field back, and a
  second Escape returns to the editor with the citation still selected.
- **"In the sentence" is offered only where Pandoc has the form**: one work, its author shown,
  nothing before it. Otherwise the choice is disabled and says why.
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
    to, and that PDFs and comments, which cite nothing, are left out.
- The underscores match the querystring's other names (`created_from`), and the bulk export
  (MCP.md) takes the same three.

**MCP.**

- `find_refs`, by key, title, author, DOI or ISBN, beside `find_users` and `find_tags`.
- `create_ref` (the `write` scope; AUTHOR and above, by the token's account).
  - Its description tells the agent to search with `find_refs` first, as `find_tags` does
    for tag terms.
  - It refuses `duplicate` with the existing key, and `invalid` for an identifier that fails its
    check.
- `search` takes `cites`, `cited_title` and `cited_author`, and refuses a key nothing has
  ([MCP.md](MCP.md)).

## Later

- **CSL styles through citeproc-js** (CPAL-1.0 OR AGPL-1.0, about 1 MB).
  - Never inline in the Hocuspocus process, which is single-threaded on a one-CPU box: a worker,
    or the Next server.
  - Probably with a cache of label maps keyed by the doc's version, its style and its context.
- **Converting the hand-written citations.**
  - The docs hold many links such as `[BU p. 49](/pdf/…#page=53&text=…)`, about 1,830 in a stale
    copy.
  - Each becomes a citation, one position where it was several.
  - Every stored quote across one is re-stamped at the conversion, with its positions mapped
    through it and its quote re-derived. That was 58 of 140 annotation quotes in that copy.
  - An editor annotation whose mark covered only the label loses it.
  - Opted into per doc.
- **DOI lookup** on import.

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
  - `[@handle](https://x.com/handle)` staying a link.
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
    needs a reference with a file.
