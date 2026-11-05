# Citations and references (planned)

**Status: partly built; "Built so far" below says which parts.** A *citation* is an entity chip
([ENTITY_CHIPS.md](ENTITY_CHIPS.md)) that stands for one or more works at a page. It is shown as
`(BU p. 49)`, `(Radner 2012, p. 49)` or `[3, p. 49]`, depending on the doc's style. The works are
*references*: records in a library, which this file also plans. This file fills in the kit's kind
contract. The kit says how every chip is stored, rendered, quoted and searched. Citations are step
3 of the kit's order.

## Built so far

The reference library's data and its machine door. Everything below not listed here is still a
plan: the pages, the import box, the citation chip kind, the menu, the bibliography and the
search filters.

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
- **Import parsing:** `src/lib/references/import.ts` reads pasted BibTeX, RIS or CSL-JSON, one
  record or many, written by hand rather than taken as a dependency. Nothing in the UI calls
  it yet.
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
    that doesn't exist, as `unknown_chip` (the kit's MCP, item 6).
  - The refusal names the word and offers the two ways out: a mention,
    `[@Name](/authors/<slug>)`, or a literal `\@`.
  - Every Markdown write that can hold a chip refuses alike: `create_doc`, `edit_doc`, a note's
    body, and the UI's import and paste box. An import lists each unknown key and creates nothing.
  - Text that already reads `@word` is written as `\@word` on the way out, so a read can be sent
    back unchanged. The serializer doesn't escape `@` today, so this is new.
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
- **`scripts/import-claude-chats.ts` escapes `@` in a transcript** before the parse, outside code
  and autolinks, as it already escapes a tag-like `<`. A transcript names packages rather than
  works, such as `@playwright/test`, and 6 of 354 local docs hold one. `escapeInline`, for quoted
  excerpts, file names and search queries, gains `@` too. Its `--markdown` files parse strictly.
- **A quote copied from a Markdown read** holds this syntax, not the label, and finds its chip by
  identity (the kit's MCP, item 3). A quote naming the right work at a different locator matches,
  and the reply reports the current locator, unless it is an edit's target, which is refused.

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
- **`/references/[key]`** is public. A published post's citations link to it, and it shows only
  what a bibliography prints.
  - The record, and the published posts citing it, are cached like an author page
    (`revalidate = 60`).
  - What only some viewers may see comes from a client island that asks the server on open, the
    way `TagChips` keeps the post page static. That covers the docs and notes citing it, and its
    PDF, at the page a post's link names. Each list goes through its read rule.
- **A key is permanent once used.** Posts link to `/references/<key>`, and Markdown exports write
  `[@key]`. So renaming a key keeps the old one redirecting through a key history, as
  `UserSlugHistory` does for users.

**The menu.** A `CiteMenu`, opened by `[@`, Pandoc's citation opener. `@` alone still opens
mentions; a `[` before the `@` keeps the mention menu shut, since `[` isn't one of its allowed
prefixes.

- It sits in the doc editor and the annotation composer.
- It searches by key, short label, title and authors.
- "radner 49" sets the locator.
- The chip's popover edits what validation allows (The chip, above):
  - the locator;
  - prefix and suffix;
  - the form;
  - further works in the same citation.

**The bibliography** is generated from the doc's citations in the doc's style. It is shown after
the doc in the reading view, the editor and side-by-side. On a post it is appended as text at
publish, alongside the post's labels, and refreshed on republish.

- The house styles share one entry format, from the CSL-JSON fields: authors, year, title, and
  the container or publisher, each entry linked to its reference page. A `numeric` doc lists
  entries by number; the others list them alphabetically by first author.
- A CSL style's bibliography comes with citeproc (Later) and replaces this format for that doc.

**Search.**

- `cites=<key>` finds what cites one work.
- `citedTitle=<text>` and `citedAuthor=<text>` find what cites any work whose title or authors
  match.
  - The text matches against `reference.search_vector`. The matching references' ids then go
    through the `citation` index table, inside each kind's readable `where`, so no citing doc's
    own vector changes.
  - `citedAuthor` is the author of a *cited work*. The existing `authors` filter is who wrote the
    item, so the UI labels them "cites a work titled…" and "cites a work by…".

**MCP.**

- `find_refs`, by key, title, author, DOI or ISBN, beside `find_users` and `find_tags`.
- `create_ref` (the `write` scope; AUTHOR and above, by the token's account).
  - Its description tells the agent to search with `find_refs` first, as `find_tags` does
    for tag terms.
  - It refuses `duplicate` with the existing key, and `invalid` for an identifier that fails its
    check.
- `search` gains `cites`, `cited_title` and `cited_author`.

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
  - the bibliography's entry format and its order in each form;
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
  - a post's citation linking to the reference page, and the page offering the PDF to a member.
