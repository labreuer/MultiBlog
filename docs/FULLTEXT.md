# MultiBlog — full-text search

One search over docs, posts, PDF pages, annotations and comments, in Postgres's own full-text
search:

- a trigger-maintained `tsvector` on every searchable row, under a configuration that folds
  accents
- typo correction from a `pg_trgm` vocabulary, which leaks nothing about text the searcher
  can't read
- filters by kind, author and date
- a section per kind on `/search`, and the quote picker's search over what everyone may read

| Where | What |
|---|---|
| `src/lib/search/` | The operation: `search(actor, params, opts)`, one module per kind, the SQL, the pure parsers |
| `src/app/search/` | The page, its form and its results |
| `add_full_text_search` | The index: extensions, configuration, functions, columns, triggers, vocabulary, backfill |
| `scripts/integrity/check-search-index.ts` | The index's guard, with `--repair` |
| `e2e/search.spec.ts` | The read rules end to end, the filters, correction, the PDF page link |

Scanning text in JS on every query is fast enough at this scale — an unindexed `ILIKE` over the
largest doc corpus takes 16 ms — but it can't stem, match phrases, rank, show snippets, or
apply five read rules to five kinds. The [appendix](#appendix-the-other-options) holds the other
approaches, each with the reason it isn't this one.

## 1. What is searched

Every kind keeps its current text in a Postgres column, so **no ydoc is decoded, either when
indexing or when searching.**

| Kind | Text | Which version |
|---|---|---|
| Docs | `doc.title`, `doc.prose_json` | The live text, at most one store debounce behind ([DOCS.md](DOCS.md), "The caches") |
| Posts | `post.title`, `post.prose_json` | The published or scheduled version, searched under the post's read rule, never the doc's. A draft that was never published has no text of its own: it is found by its title, and its words through its doc |
| Annotations | `annotation.body_text`, `annotation.quoted_text` | The last settled body: an edit in progress isn't searchable, just as it isn't readable ([ANNOTATIONS.md](ANNOTATIONS.md), "Editing after posting"). The quoted passage is a column only for a reading-view or PDF annotation; the doc editor's keep theirs as a mark in the doc's body, so those words find the doc instead (§10, item 9) |
| Comments | `comment.body_text` | The current revision |
| PDFs | `file.title` and `file.filename`; `file_page_text.text`, one row per page | Fixed per text version; §4 covers files that have more than one |

A few seconds of staleness does no harm. The rule against reading `Doc.proseJson` (CLAUDE.md)
is about *positioning*, and search positions nothing: a hit names a doc, and its link opens the
live one.

**Comment revisions and annotation snapshot versions are never indexed.**
[edit-grace.ts](../src/lib/edit-grace.ts) hides the fact that a silent edit happened at all, and
a hit on the old wording would reveal it. For the same reason, §6's "updated" filter never reads
`editedAt` on these two kinds.

## 2. Who sees what

Each kind uses the read rule that already governs it, through the one `where` helper that
states it as a filter:

| Kind | A hit is readable when | Through |
|---|---|---|
| Docs | SHARED, and the viewer has `canViewDocs`; or PRIVATE, and the viewer is on its byline (with `canManageDocs`). There is no ADMIN or EDITOR bypass | `readableDocsWhere` — `canUserReadDoc`'s rule |
| Posts | Published. **A signed-in viewer also gets the unpublished posts they may edit**, drafts and scheduled: every one for an ADMIN or EDITOR, the ones on their byline for an AUTHOR | `readablePostWhere` |
| Annotations | Not a DRAFT, not deleted, and its doc or PDF is live and readable | `readableAnnotationsWhere` — `canUserAccessAnnotationYdoc`'s rule |
| Comments | APPROVED, not deleted, and on a post that is published and not deleted, for every viewer | `publicCommentsWhere` — `isCommentPublic`'s rule |
| PDFs | SHARED, and the viewer has `canViewFiles`; or PRIVATE, and the viewer is an owner (with `canManageFiles`) | `readableFilesWhere` — `canUserReadFile`'s rule |

A signed-out reader therefore searches only posts and comments.

**The index holds no permission data.**

- **How a query runs.** Each kind first asks Prisma for the ids this viewer may read, under §6's
  filters, through its helper. The SQL that matches and ranks then runs only inside
  `id = ANY($ids)`.
- **Nothing to fall out of step.** Visibility, bylines, status and publish dates are never copied
  into the index.
- **Five queries, never one UNION.** That is why `/tag` runs one query per type
  ([tag-browse.ts](../src/lib/tag-browse.ts)): a merged query re-implements every read rule at
  once, "the easiest leak to write and the hardest to see".
- **Soft deletion stays in one place.** Raw SQL bypasses the `$extends` filter, but the ids it is
  handed came through Prisma. A helper reached through a relation spells out its own
  `deletedByUserId: null`, since the extension doesn't follow relations.
- **One helper per rule.** Each sits beside its per-row predicate and is the only statement of
  that rule as a filter; `/tag`, `/links` and `/annotations` go through the same ones. Where
  some other listing restates a rule differently, TODO.md names it.

**Posts are on `readablePostWhere`**, the third surface after `/tag/[slug]` and
`canUserTagTarget`. An unpublished hit links to `/post/[id]/edit` with a `draft` or `scheduled`
marker, as `/tag`'s do: neither kind of post has a public URL that answers. The quote picker
stays on `publishedPostWhere` (§8).

**`/search` is different for each viewer**, so it says `dynamic = "force-dynamic"`, as `/tag`
does (CACHING.md), and every results page is `noindex`.

**A PENDING comment and a DRAFT annotation are found by nobody** — not the post's moderators,
not the annotation's own writer. A hit has to link to a page that shows it, the post page shows
only APPROVED comments, and no list shows a DRAFT. `/comments` keeps its own `?q=`.

**`isCommentPublic` tests what `publicCommentsWhere` filters on**, row for row: a live
publication, a go-live date that has arrived, and a post that isn't deleted. `publishedAt`
alone is not enough — unpublishing leaves it set, and scheduling sets it to a future date — and
the quote gate, the citation renderer and tagging all ask this function.

## 3. The index

### The configuration

`public.english_unaccent` is Postgres's `english` configuration with `unaccent` ahead of the
stemmer, for the token types that can carry accents:

```sql
CREATE TEXT SEARCH CONFIGURATION public.english_unaccent (COPY = pg_catalog.english);
ALTER TEXT SEARCH CONFIGURATION public.english_unaccent
  ALTER MAPPING FOR hword, hword_part, word WITH public.unaccent, pg_catalog.english_stem;
```

With it, "Godel" finds "Gödel" and "naive" finds "naïve", in both directions, where the stock
`english` configuration finds neither. `ts_headline` still marks the word as written, "Gödel".
Every function names the configuration schema-qualified, so none depends on the search path to
find it.

**The extensions.**

- **Trusted.** `unaccent` and `pg_trgm` are contrib extensions, and both are *trusted*: any role
  with `CREATE` on its database may install them, so the migration creates them under
  `prisma migrate deploy` with no superuser step.
- **Servers.** Every deployed instance's role owns its database, and the servers' Postgres
  ships both extensions (`postgresql-contrib`, DEPLOY.md §2e).
- **Development machines** need the contrib modules too, or `prisma migrate dev` can't build its
  shadow database ([DATABASE.md](DATABASE.md), "The cluster").

### One vector per row

| Table | `search_vector` holds (weight) | Its trigger fires on |
|---|---|---|
| `doc` | the title (A), the body's text (D) | `INSERT`, `UPDATE OF title, prose_json` |
| `post` | the title (A), the body's text (D) | `INSERT`, `UPDATE OF title, prose_json` |
| `annotation` | the body (B), the quoted passage (D) | `INSERT`, `UPDATE OF body_text, quoted_text` |
| `comment` | the body | `INSERT`, `UPDATE OF body_text` |
| `file` | the title (A), the filename as uploaded (B) | `INSERT`, `UPDATE OF title, filename` |
| `file_page_text` | the page's text | `INSERT`, `UPDATE OF text` (only a backfill or a repair updates it) |

This is `prose_json_length`'s pattern exactly ([DATABASE.md](DATABASE.md)): a plain column that
a `BEFORE` trigger owns. Migrate can't see the trigger, and the app never assigns the column.

- **In schema.prisma** each column is
  `searchVector Unsupported("tsvector")? @map("search_vector")`, with
  `@@index([searchVector], type: Gin)`. The client never selects an `Unsupported` field, so no
  vector is ever sent to a page; search reads them through raw SQL.
- **Each kind's vector is a named SQL function of its columns**, such as
  `doc_search_vector(title, prose_json)`. The trigger and the integrity check (§9) both call that
  function, so they can't disagree about what the right vector is.
- **`prose_text(jsonb)`** returns a ProseMirror document's text in document order. The text
  pieces within a block are joined directly, blocks are joined by a newline, and a `hardBreak`
  becomes a newline.
  - **How.** A recursive walk down `content` arrays carrying each node's ordinal path; `int[]`
    compares element-wise, so ordering by the path is document order.
  - **Why order matters.** Phrase search and ranking read word positions, and `ts_headline` reads
    the text; a length doesn't care.
  - **Checked** against every doc in the largest corpus: exactly the text leaves' characters plus
    one newline per block boundary and per `hardBreak`. About 28 µs per thousand characters.
- **Why SQL rather than Node.** `prose_json` has several writers: the collab server's cache,
  `createDocWithContent`, and the importer's in-place update. A trigger covers all of them by
  construction, which is why `prose_json_length` is a trigger too. Comments and annotations
  already have a `body_text` column the app writes, and their triggers read that.
- **Every trigger function is declared with `SET search_path = public, pg_catalog`**, and so is
  `doc_sync_prose_json_length`, which calls `doc_length()` without a schema. A data-only load
  from `pg_dump` runs with an empty search path, and would fail on the first row otherwise.
- **The backfill is a no-op `UPDATE` of a trigger column on each table**, DATABASE.md's repair
  recipe, inside the migration. The update fires the triggers, so each vector's definition is
  written only once; and raw SQL leaves `updated_at` alone, because Prisma sets `@updatedAt` on
  the client side, so no date §6 filters on moves.

### The vocabulary

Typo correction (§5) needs to know which words exist. The `search_lexeme(lexeme text primary
key)` table holds every lexeme (stemmed word) that appears in any vector, under a trigram index:
`@@index([lexeme(ops: raw("gin_trgm_ops"))], type: Gin)`.

- **How it is fed.** Two statement-level `AFTER` triggers on each table:
  - on `INSERT`, the statement's lexemes
  - on `UPDATE`, the new rows' lexemes minus the old rows'

  Both insert with `ON CONFLICT DO NOTHING`, **in lexeme order**. Without that order, two saves
  that insert overlapping sets can deadlock on the primary key.
- **Statement-level, so a batch costs one insert**: hundreds of PDF pages extracted together, or
  the backfill.
- **"New minus old" misses nothing.** Every lexeme already in a stored vector is already in the
  table.
- **Neither trigger has a column list.** Postgres refuses transition tables on a trigger with a
  column list, and on a trigger for more than one event, hence two triggers per table. The
  update trigger runs on every `UPDATE` statement, and costs 0.5 ms for the longest doc when its
  vector didn't change, since the difference is then empty.
- **It never shrinks by itself.** A lexeme whose last occurrence is gone does no harm, because §5
  uses no candidate that lacks a readable hit. The integrity check's `--repair` rebuilds the
  table from `ts_stat`.
- **It is global**, including words from text the viewer can't read. §5 explains why that is
  safe.
- **A data-only load leaves its data out** (`--exclude-table-data=search_lexeme`): the triggers
  refill it as the content tables load, and its own `COPY`, which comes after theirs, would then
  collide on the key ([DATABASE.md](DATABASE.md)). A full dump restores cleanly, since `pg_dump`
  creates triggers after the data.

The largest doc corpus has about 29,000 distinct lexemes under this configuration: a 1.2 MB
table and a 1.7 MB trigram index.

### What it costs

Measured on 2026-10-04 against the largest doc corpus and the dev database's PDFs, on one core
of the dev box. A Linode vCPU is perhaps two to three times slower.

| | Docs: 333, 3.3M characters | PDF pages: 1,906, 5.5M characters |
|---|---|---|
| Vectors, then their GIN index | 2.5 MB, then 2.4 MB | 5.2 MB, then 2.75 MB |
| Building every vector (the backfill) | 0.45 s | 0.44 s |
| Matching and ranking every hit | under 1 ms | under 1 ms |
| `ts_headline`, per hit | about 3 ms per long doc | about 0.3 ms per page |

- **A whole search**, every kind, snippets included, takes 3–60 ms; one that falls back to typo
  correction 15–55 ms in all.
- **On the servers**, the largest instances hold 3.66M characters of docs and 7.6M characters of
  PDF pages: about 6 MB and 11 MB of disk respectively.
- **No new memory is held.** Index pages sit in Postgres's cache like any other pages, so RAM,
  the one resource the 2 GB boxes run short of, doesn't move.
- **Each save** costs about 0.13 ms per thousand characters, once per collab cache write: 11 ms
  for the longest doc (88,000 characters), beside the 7 ms `doc_length` already cost it.
- **Snippets are the cost to manage**, so only the hits on screen get one (§4).
- **The stored column is what makes this cheap.** Computing the vector inside the query instead
  takes 256 ms per search over the same docs.

**A vector holds at most 16,383 word positions, and the longest imported docs use about 15,300.**
Past the cap positions clamp: matching still works, but phrase search and proximity ranking
degrade in the tail of the doc. Option B in the appendix removes the limit.

## 4. Querying

**The syntax** is `websearch_to_tsquery`'s:

- words are ANDed
- "quoted phrases" match in order
- `or` gives alternatives
- `-word` excludes

A query made only of stop words parses to nothing, and the page says so rather than showing an
empty result that looks like "no matches". Input is capped at 200 characters.

**Each kind is two halves** (`KindSearch`, [context.ts](../src/lib/search/context.ts)):

1. **`match`** — the readable ids under the filters (Prisma, through §2's helper), then match
   and rank inside them (SQL, `ts_rank_cd(search_vector, query, 32)`, newest first on a tie).
   With no text, the readable rows newest update first. Its length is the section's count.
2. **`hits`** — for the ids on screen only: snippets (`ts_headline`, over
   `prose_text(prose_json)` for docs and posts and over the stored text for the rest), and what
   the page shows, such as titles, bylines and dates.

Each kind's readable ids are read once per search however many queries then run over them,
because typo correction (§5) counts hits with `match` a dozen times. A query is always joined in
as a one-row subselect, since a cast lexeme isn't a valid `FROM` item.

**PDFs** rank pages inside the readable files.

- **Text versions.** A page can have rows at several text versions, because `storedPageText`
  re-extracts on demand and keeps the old rows ([PDF.md](PDF.md) §3). Each page is matched at
  one version only: the one this server extracts when the page has it, otherwise its latest
  other. Words only in a superseded extraction find nothing.
- **Grouping.** Pages are grouped under their file, best page first, and a file ranks by its
  best page or its title.
- **Title matches.** A file whose title or filename matches is listed even when no page does.

**Snippets** come from `ts_headline` with private-use characters as delimiters: U+E000 and
U+E001 surround a match, U+E002 separates fragments. They are parsed into strings
([headline.ts](../src/lib/search/headline.ts)) and each match rendered in a `<mark>`.
**`ts_headline` doesn't escape the text around a match**, so its output is never treated as
HTML, search uses no `dangerouslySetInnerHTML`, and the source text has the three characters
stripped first so it can't forge one.

- **A body of 280 characters or fewer is shown whole**, every match marked — most comments and
  annotations. Fragments drop words of three letters or fewer at their edges, which in a
  two-line comment loses its "A" or "I".
- **A longer one is cut to its best two passages** of 10–24 words, joined by an ellipsis.
- **Titles** are shown whole with their matches marked.
- **With no text**, a hit shows the first 240 characters.

## 5. Fuzzy matching

**Accent folding** is always on, in the configuration (§3).

**Typo correction** ([correct.ts](../src/lib/search/correct.ts)) runs when a search finds
nothing:

1. **When it runs.** Only when every selected kind came back empty, and never with `exact=1`.
2. **Which words qualify.** A word qualifies if it isn't quoted or negated, has at least four
   characters, and is a single lexeme under the configuration, meaning not a stop word
   ([words.ts](../src/lib/search/words.ts)).
3. **Misses.** A qualifying word is a *miss* if its lexeme on its own has no readable hit under
   the current filters.
4. **Candidates.** A miss's candidates are the five lexemes in the vocabulary most similar to it
   (`%`, with similarity at least 0.4). Each is counted for readable hits the same way, and the
   one with the most wins.
   - **Similarity alone would pick wrong.** "wittgenstien" is closer to `wittgenst` (0.64, in
     one doc of the largest corpus) than to `wittgenstein` (0.53, in eleven).
   - **The hit count gets it right.** It also prefers `institut` (76 docs) over `institution`
     (22) for "instituion", and `macintyr` (21) over `macintyrean` (5) for "macintire".
5. **The corrected query.** `ts_rewrite` replaces each miss in the query as parsed with its
   winner, so phrases, `or` and negations keep their shape. The winner is written as a lexeme
   literal (`'macintyr'::tsquery`) and **never goes through `to_tsquery`**, which would stem a
   word that is already a stem — and stemming twice doesn't always give the same result:
   "agreed" stems to `agre`, and `agre` to `agr`.
6. **What the page says.** That nothing matched the query as typed, so these are close matches,
   with a link to search exactly as typed (`exact=1`). It names no corrected word; the
   highlights in the snippets show what matched. If the corrected query finds nothing either,
   the page says nothing matched, which is what happened.

**Why a global vocabulary leaks nothing.**

- **What the viewer sees depends only on what they can read.** Whether correction runs depends on
  the viewer's own hits, and a candidate is used only if it has hits the viewer can read.
- **Private words make no difference.** A word that exists only in text the viewer can't read
  never changes what they see. Checked: a typo whose only near neighbour is in someone's PRIVATE
  doc is corrected for that doc's author and for nobody else.
- **The tempting alternative would leak.** Suggesting a word whenever the typed one isn't in the
  vocabulary would let a signed-out reader probe private docs, because no suggestion would mean
  "this word exists somewhere".

**Search-as-you-type** ([as-you-type.ts](../src/lib/search/as-you-type.ts)), the quote
picker's mode, treats the last word as a prefix. It matches `:*` on that word's stem, plus every
lexeme of four or more characters in the vocabulary that the typed word begins with (folded and
lowercased, and looked up by key, one per prefix length).

- **Why the second part.** A typed prefix can run past its word's stem. "organiza" doesn't
  prefix-match `organ` (organization), and "mediati" doesn't match `mediat` (mediating).
- **Why every such lexeme, not just the longest.** "organiza" begins with both `organ`
  (organization) and `organiz` (organizational, which stems differently). Taking only the
  longest would lose "organization".
- **Not a prefix:** a word inside an open quote or negated, where completing it would change the
  question rather than finish it.
- **Minimum.** Nothing is searched under two characters, and a last word under two is taken
  as typed.
- **Never corrected**: a half-typed word is not a typo.

Not done: matching inside words, which would need a trigram index over whole bodies; and "did
you mean" suggestions when a search did find something.

## 6. Filters

| Parameter | Meaning |
|---|---|
| `q` | The text (§4) |
| `kinds` | Any of `docs`, `posts`, `pdfs`, `annotations`, `comments`, comma-joined or repeated; by default every kind the viewer can read. A kind the viewer can't search is dropped |
| `authors` | User slugs, comma-joined or repeated; a hit matches if any one of them is its author. A slug not on this viewer's picker is dropped |
| `created_from`, `created_to`, `updated_from`, `updated_to` | Dates as `YYYY-MM-DD`, inclusive |
| `tz` | The IANA time zone those dates are in; UTC when absent or unknown |
| `page` | Pagination, when exactly one kind is selected: 20 hits a page |
| `exact` | `1` turns typo correction off |

[params.ts](../src/lib/search/params.ts) is the one reading of these, browser-safe, and writes
them back for every link the page builds, leaving out defaults and keeping `tz` only beside a
date. Anything malformed falls back to its default rather than reaching a query.

### Author

| Kind | Its author is |
|---|---|
| Docs | the byline (`doc_author`) |
| Posts | the post's own byline (`post_author`), which is separate from its doc's (PLAN.md §15d) |
| Annotations | the writer |
| Comments | none — an author filter leaves comments out (§10, item 3) |
| PDFs | none — an author filter leaves PDFs out (§10, item 8) |

**The picker lists only people the viewer can already see as authors**
([authors.ts](../src/lib/search/authors.ts)): users on the byline of a doc or post the viewer
can read, or who wrote an annotation they can read, found through those kinds' read rules.

- **Labels are names**, the way public bylines show them. `AuthorByline` leaves out users who
  have no name, and so does the picker.
- **Never an email.** The admin tables label users with `name ?? email`
  ([author-filter.ts](../src/lib/author-filter.ts)), and a signed-out reader must never see that.
- **Slugs in the URL** are checked against this list, the way `/docs` checks its own.
- **Comments and PDFs take no author.** A comment's name is fixed when its commenter row is
  made, so filtering by an account would tie an old name to a renamed one. A PDF has owners
  rather than authors, and its page names none, so filtering by owner would disclose who owns
  which file. Neither contributes names to the picker, and the page says why they are left out.

### Dates

| Kind | Created | Updated |
|---|---|---|
| Docs | `createdAt` | `updatedAt`, which moves on every collab cache write. It is the date the reading view's byline shows |
| Posts | `publishedAt ?? createdAt`: the go-live date the post shows, which survives a republish | Whichever is later: that date, or the `createdAt` of the live publication event. The event is later only after a republish (PLAN.md §15c) |
| Annotations | `postedAt`, when readers could first see it. `createdAt` is when the composer opened, and nothing measures from it | The last edit readers are told about; otherwise `postedAt` |
| Comments | `createdAt` | The last edit readers are told about; otherwise `createdAt` |
| PDFs | `createdAt`, the upload | `updatedAt`: changes to title, visibility or owners. Page text never changes |

**Comments and annotations never filter on `editedAt`.** It is stamped on silent edits too. A
range over it would let a reader find a silent edit by narrowing the dates, which is exactly what
edit-grace.ts hides.

- **Where "updated" comes from.** The cards' own rule, over the same version timestamps:
  `isCommentVisiblyEdited` (comment-data.ts) and `visibleAnnotationEditDates`
  (annotation-data.ts), which fetches the posted replies that might quote each annotation, as a
  thread load would have them in hand.
- **Where it runs.** In `match`, once per search for every readable candidate, so those two
  kinds are filtered and ordered in JS (§10, item 10).
- **The date a hit shows.** The same answer decides the "edited" date on each hit, so search and
  the card can't disagree.

**A date is a day in the viewer's time zone.** `tz` turns it into the range from that midnight
to the next, in UTC ([dates.ts](../src/lib/search/dates.ts), with no date library: `Intl` knows
every zone's offsets). Where a daylight-saving change skips midnight itself, the day begins at
the first instant that exists. The form fills `tz` from the browser's `Intl` at submit time,
for the same reason `LocalTime` exists: the server's time zone isn't the reader's.

## 7. The page

**Sections** come in a fixed order: Docs, Posts, PDFs, Annotations, Comments.

- **Counts.** Each section heading carries this viewer's own filtered count.
- **Which sections.** Only kinds the viewer can read appear, only the selected ones, and only
  those with a hit; one line names the selected kinds that had none.
- **Length.** Each section shows its top five hits, then an "All N docs" link (`kinds=docs`) to a
  list paginated 20 at a time.

**What each hit shows:**

| Kind | Shows |
|---|---|
| Doc | title, byline, updated date, snippet |
| Post | title, byline, published date (linking to its day's archive, as every byline's does); "goes live" and a date with a `scheduled` marker, or "not published" with a `draft` marker; snippet |
| PDF | title, "PDF" and its date, then up to three pages ("p. 12"), each with its snippet, and how many more pages matched |
| Annotation | "*writer* on *doc or PDF*", the date and any edit readers are told about, the passage it quotes, a snippet of the body |
| Comment | "*commenter* on *post*", the date and any visible edit, a snippet |

**Where each hit links:**

| Kind | Links to |
|---|---|
| Doc | `/doc/<slug>` |
| Post | its public path, or `/post/<id>/edit` when unpublished |
| PDF page | `/pdf/<slug>#page=<n>` |
| Annotation | its doc or PDF, plus the permalink fragment its card renders (`annotationAnchorName`) |
| Comment | its post's path, plus the fragment its card renders (`commentAnchorName`) |

- **`#page=` follows the PDF Open Parameters convention**
  ([pdf-open-params.ts](../src/lib/pdf-open-params.ts)). The viewer reads it once the document
  is laid out, and again on `hashchange`.
- **Each fragment is built by one shared function** that the card uses too, so a link can't
  miss its card.
- **An annotation's writer is a name, never an email.** `displayNameOf`
  ([display-name.ts](../src/lib/display-name.ts)) labels an account with no name "Anonymous",
  on the hit and on the card alike, so the fragment built from it still matches.
- **A doc hit doesn't land on its passage.** A text fragment (`#:~:text=`) would highlight the
  static first render, which the live editor then replaces (DOCS.md, "The reading view"), so it
  isn't reliable here. Landing on a passage is option B's job.

**What the page says** instead of, or above, the sections: an invitation, naming the kinds this
viewer can search, when nothing was asked; that the query is all stop words; that none of the
selected kinds is one they can search; which kinds an author filter left out, and why; that
these are close matches, when corrected; and that nothing they can read matches.

**The form** is one GET form and works without JavaScript: a plain submit sends every field,
and the parser reads repeated checkbox values and ignores empty ones. Nothing checked under "Only
these kinds" means every kind. With a script, the form drops empty fields, joins repeated ones,
and adds `tz` from the browser beside a date. The page remounts it whenever the search changes,
since its fields are uncontrolled.

The header's search box is unchanged, and searches everything the viewer can read. Styles are
in `page.module.css` and use STYLE.md's color tokens, `<mark>` included.

## 8. Other consumers

- **The quote picker** (`searchQuotableTargets`) is this search over posts and comments in the
  **public scope**, with search-as-you-type.
  - **Public scope** means `publishedPostWhere` and `publicCommentsWhere` whoever is asking,
    never the viewer's wider rules, because a quotation may carry only what everyone can already
    read (PLAN.md §23e). So the action still needs no session.
  - **The host post and its comments are left out**, through an option, and the picker gets
    eight of each kind, showing the matched passage as plain text.
- **The API.** The operation is a plain module that takes an explicit actor
  (`{ userId, role } | null`) and a scope, and is never exported from a `"use server"` file. The
  API plan (`docs/API.md` on the `api-mcp` branch) sets that rule for every operation, and its
  search endpoints call this one with the token's user as the actor. Not built.
- **The admin tables' `?q=`** stays on titles (PLAN.md §16l). Pointing it at bodies is a
  separate decision.

## 9. Checks

- **`e2e/search.spec.ts`** plants a word no other row contains and searches for it as several
  people: a PRIVATE doc (its author, another author, an AUTHORIZED reader, an EDITOR, someone
  signed out); a draft and a scheduled post (a byline author, another author, an EDITOR, an
  ADMIN, someone signed out); a DRAFT annotation and a PENDING comment beside posted, approved
  twins; kind, author and created-date filters, a time zone among them; a silent edit across
  midnight against the "updated" filter; accents; a typo, corrected and then undone; a
  stop-word query; and a PDF page hit opening the viewer on its page.
  - **Planted words are random letters**, so two of them share almost no trigrams.
  - **Every check that something is *not* found searches with `exact=1`.** When nothing
    matches, correction looks for a near word the viewer can read and searches for that — a
    feature, and one that would turn "the draft isn't found" into "something else is" whenever a
    neighbouring test's word happens to be near.
- **Unit tests** cover the pure parts: the parameters, dates (every day of a year in zones whose
  rules are awkward), headlines, which words qualify for correction, and `#page=`.
- **`scripts/integrity/check-search-index.ts`**: every trigger exists and is enabled, every
  vector equals its function's output, every lexeme is in the vocabulary (an ERROR each), and
  vocabulary rows no vector holds (a WARN). `--repair` re-fires the triggers for drifted rows
  and rebuilds the vocabulary under a lock that holds the triggers' own inserts off.
- **Deploying it**: `prisma migrate deploy` creates the extensions and backfills in about a
  second. Run the integrity check afterwards, and after any data-only load (DATABASE.md).

## 10. Decisions

Settled 2026-10-04, except item 7. The numbers are cited from the code.

1. **"Their own" drafts** means the drafts the viewer may edit: every unpublished post for an
   ADMIN or EDITOR, the byline's for an AUTHOR. Narrowing it to the byline would make search
   disagree with `/tag`.
2. **A DRAFT annotation is found by nobody**, its writer included, as `/annotations` leaves it
   out.
3. **Comments take no author filter.** A commenter's display name is fixed when their commenter
   row is created, so filtering by a user who has since changed their name would find comments
   shown under the old name, and anyone could link the two.
4. **`isCommentPublic`'s header was the intent and its code the bug** (§2).
5. **`doc_sync_prose_json_length` sets its search path**, in the same migration (§3).
6. **Sizes.** Five hits per section, 20 a page for one kind, three pages per PDF, eight of each
   kind in the quote picker.
7. **Open: semantic search (A.4).** Is it wanted? If so, are documents embedded by Voyage's
   hosted models, or on a desktop with the open-weights model? Either way it needs option B
   first.
8. **PDFs take no author filter.** `/pdf/[slug]` shows no owner, so the picker's premise —
   people the viewer already sees as authors — doesn't hold for owners, and an owner filter
   would disclose who owns which file to every reader.
9. **A mark-anchored annotation's passage isn't indexed.** The doc editor's annotations keep
   their passage in the doc's body as a mark, with `quoted_text` empty. Those words find the doc
   instead, and the hit still shows the passage, derived from the mark as `/annotations` does.
   Indexing it would mean a doc save rewriting its annotations' vectors.
10. **Annotations and comments are dated in JS.** Their "updated" date is the cards' rule applied
    to every readable one, once per search, which is fine at this scale; at thousands of
    comments it wants a stored column, and that column would have to be as silent as the cards.

## Appendix: the other options

### A.1 Option B: passages

**What it is.** A `search_passage` table, written by an `AFTER` trigger on `prose_json` that
rewrites only the sections whose text changed. It holds:

- one row per section of a long doc or post: top-level blocks grouped into roughly 1–2k
  characters, or one turn of an imported chat
- one row per PDF page
- one row per comment or annotation

It could reuse the anchor tables' shape (PLAN.md §20a): five nullable foreign keys with exactly
one set, so that each hit is a target plus a location.

**Gains:**

- A hit lands on its passage.
- A snippet only has to process a passage, not a whole doc.
- The 16,383-position cap goes away.
- A long doc that mentions a word once stops outranking a short doc about it.
- It is the unit that any later semantic search would need.

**Costs:**

- more trigger SQL
- rewriting a doc's changed sections on every save
- a few thousand rows for the largest instance

**When**: once hits in long docs need to land on their passage. That will show first in the
imported chat sessions, which average about 10,000 characters.

### A.2 A search server: Meilisearch or Typesense

**Gains**: typo tolerance, search-as-you-type and BM25-style ranking, out of the box.

**Costs:**

- **A daemon permanently in memory on each box.** These are 2 GB boxes whose builds already have
  to be capped to keep the neighbouring instance out of swap.
- **Delayed updates**, through an outbox and a worker. A silent edit stays searchable until the
  index catches up.
- **Permissions.** Either they are copied into the engine (visibility, bylines, scheduled publish
  times), which is the leak risk §2 avoids. Or they are applied in Postgres afterwards, which
  gives up most of what the engine offers.
- **Another service** to secure and upgrade on two boxes.

**When**: with 4 GB boxes, or a corpus a hundred times this size.

### A.3 An in-process index: SQLite FTS5 or a JS library

**Gains:**

- FTS5 is built into Node 24, with its porter and trigram tokenizers.
- It provides BM25 ranking, `snippet()`, and matching inside words, with no daemon.

**Costs:**

- **A second copy of the data.** Two processes write it and have to keep it in step: collab
  writes docs, and web writes comments and annotations.
- **Rebuilt on every deploy.**
- **The same after-the-fact permission filter as A.2.**
- **A JS index lives in the web process's heap**, where RAM is tightest.

**Verdict**: better ranking and matching inside words aren't worth the syncing.

### A.4 Semantic search: pgvector and embeddings

**Undecided (§10, item 7).**

**What it is.** An embedding model turns a passage into a list of about a thousand numbers: a
point in a space where passages with similar meaning sit close together, even when they share no
words. A search embeds the query the same way and returns the nearest passages.

**What it finds.** A concept written in different words, which no keyword index can: "mediating
institutions" next to "intermediary associations".

**Where it is weak.** Exactly where keywords are strong: names, quotations and rare terms. So it
would run beside this search rather than replacing it, and the two rankings would be merged
(reciprocal rank fusion).

**Prerequisites:**

- **Option B's passages.** A single vector for a 15,000-word doc blurs everything in it together.
- **pgvector**, which neither server has. It is an apt package on each, which needs sudo.
- **Storage.** About 10,000 passages across the four instances, at 1,024 numbers each, comes to
  around 40 MB. That is few enough to scan exactly, with no approximate index.

**The model.** Anthropic has no embedding model of its own and points to Voyage AI. Voyage 4's
models share one vector space, so a passage embedded by one model can be found by a query
embedded by another.

- **Hosted (`voyage-4`, `voyage-4-large`).**
  - **Cost.** Each account gets its first 200M tokens free per model, and the whole corpus is
    about 3M tokens, so cost doesn't matter.
  - **Privacy.** Every passage's text, PRIVATE included, goes to Voyage.
  - **Queries.** Every search makes one API call.
- **Open weights (`voyage-4-nano`, Apache 2.0).**
  - **Size.** About 340M parameters, run from Python: too large for a 2 GB box, but comfortable
    on a desktop.
  - **Privacy.** A batch job there keeps document text away from any third party.
  - **Queries** can still use the hosted API, because the vector space is shared.

**Writes.** Embedding is an API call or a model run, so it can't happen in a trigger. A passage
whose text changed waits in a queue that a worker drains. Semantic results would therefore lag an
edit by up to a minute, while keyword results don't lag at all.

**Per instance.** Semantic search could be switched on instance by instance. An instance that
holds other people's PRIVATE docs needs their agreement before their text goes to Voyage.

### A.5 ParadeDB `pg_search`

It brings BM25 and fuzzy matching inside Postgres. But it is a third-party extension built for
each major Postgres version, so every Postgres upgrade would have to wait for it. That is the
pdfjs lesson (CLAUDE.md) applied to the database.

### A.6 Variations on this design, set aside

- **Prisma's `fullTextSearchPostgres` preview.** Prisma's query compiler filters with
  `to_tsvector(concat_ws(…))`, computed per row with no configuration argument. No index can
  serve that: it takes 256 ms per search, against under 1 ms.
- **An expression index instead of a stored column.** The index would match, but ranking would
  recompute the vector for every hit: milliseconds per long doc, on every search.
- **One search table for every kind.** Its permissions would either be copied in, which is §2's
  leak risk, or re-applied per kind on the way out, which is §2's design with an extra table.
- **Writing the text from Node.** Every writer of `prose_json` would have to remember to do it
  (§3).
- **Indexing comment revisions and annotation versions.** That would reveal silent edits (§1).
- **A generated column for the vector.** `prose_json_length`'s reason applies unchanged: Migrate
  reads the generation expression as a default and offers to drop it on every `migrate dev`
  (DATABASE.md).
