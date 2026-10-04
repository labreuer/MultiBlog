# MultiBlog — full-text search

**Status: built through §9's step 5**: the read rules as named `where` helpers, the index
(`add_full_text_search`, with `scripts/integrity/check-search-index.ts`), the operation
(`src/lib/search/`) with the `/search` page, typo correction and search-as-you-type, and the
quote picker on the operation. Option B and the API's endpoints are not. Where the build
departed from this plan, §10 says so. Like [ANCHORED_LINKS.md](ANCHORED_LINKS.md), this file
is the plan until the build and is then rewritten as built.

The plan is one search over docs, posts, annotations, comments and PDF pages, using Postgres's
own full-text search:

- a trigger-maintained `tsvector` on every searchable row
- accent folding through `unaccent`, and typo correction through `pg_trgm`
- filters by kind, author and date
- a section per kind on `/search`

It replaces today's `/search` ([page.tsx](../src/app/search/page.tsx)), which covers published
posts alone. On every query it loads all of them and flattens each one in JS. That was PLAN.md
§10's "no search index" call (item 8), made for hobby scale, and it was right about speed: an
unindexed `ILIKE` over the largest doc corpus takes 16 ms. What it can't do is stem, match
phrases, rank, show snippets, or apply five read rules to five kinds.

The [appendix](#appendix-the-other-options) holds the other approaches considered, each with
the reason it isn't the first step.

## 1. What is searched

Every kind already keeps its current text in a Postgres column, so **no ydoc is decoded, either
when indexing or when searching.**

| Kind | Text | Which version |
|---|---|---|
| Docs | `doc.title`, `doc.prose_json` | The live text, at most one store debounce behind ([DOCS.md](DOCS.md), "The caches") |
| Posts | `post.title`, `post.prose_json` | The published or scheduled version, searched under the post's read rule, never the doc's. A draft that was never published has no text of its own: it is found by its title, and its words are found through its doc |
| Annotations | `annotation.body_text`, `annotation.quoted_text` | The last settled body. An edit in progress isn't searchable, just as it isn't readable ([ANNOTATIONS.md](ANNOTATIONS.md), "Editing after posting") |
| Comments | `comment.body_text` | The current revision |
| PDFs | `file.title` and `file.filename`; `file_page_text.text`, one row per page | Fixed per text version; §4 covers files that have more than one |

A few seconds of staleness does no harm here. The rule against reading `Doc.proseJson`
(CLAUDE.md) is about *positioning*, and search positions nothing: a hit names a doc, and its link
opens the live one.

**Comment revisions and annotation snapshot versions are never indexed.**
[edit-grace.ts](../src/lib/edit-grace.ts) hides the fact that a silent edit happened at all, and
a hit on the old wording would reveal it. For the same reason, §6's "updated" filter never reads
`editedAt` on these two kinds.

## 2. Who sees what

Each kind uses the read rule that already governs it, expressed as a Prisma `where`:

| Kind | A hit is readable when | The rule it restates |
|---|---|---|
| Docs | SHARED, and the viewer has `canViewDocs`; or PRIVATE, and the viewer is on its byline (with `canManageDocs`). There is no ADMIN or EDITOR bypass | `canUserReadDoc` |
| Posts | Published. **A signed-in viewer also gets the unpublished posts they may edit**, drafts and scheduled | `readablePostWhere` |
| Annotations | Not a DRAFT, not deleted, and its doc or PDF is readable | `canUserAccessAnnotationYdoc`, as `/annotations` restates it |
| Comments | APPROVED, not deleted, and on a published post, for every viewer | `isCommentPublic`, but see §9, step 1 |
| PDFs | SHARED, and the viewer has `canViewFiles`; or PRIVATE, and the viewer is an owner (with `canManageFiles`) | `canUserReadFile` |

A signed-out reader therefore searches only posts and comments.

**The index holds no permission data.**

- **How a query runs.** It first asks Prisma for the ids this viewer may read, under §6's
  filters. The SQL that matches and ranks then runs only inside `id = ANY($ids)`.
- **Nothing to fall out of step.** Visibility, bylines, status and publish dates are never copied
  into the index.
- **Why.** It is the reason `/tag` runs one query per type rather than a UNION
  ([tag-browse.ts](../src/lib/tag-browse.ts)): a merged query re-implements every read rule at
  once, "the easiest leak to write and the hardest to see".
- **Soft deletion stays in one place.** Raw SQL bypasses the `$extends` filter, but the ids it is
  handed came through Prisma.

Two written rules change with this:

- **Posts move from `publishedPostWhere` to `readablePostWhere`.**
  - **What changes.** That function's comment and [PERMISSIONS.md](PERMISSIONS.md) both list
    search among the surfaces that "stay on `publishedPostWhere()`". Both are updated in the
    build.
  - **What "own" means.** "Their own drafts" means the drafts the viewer may *edit*. For an ADMIN
    or EDITOR that is every unpublished post; for an AUTHOR, the ones on their byline. `/tag`
    already widens this way, through the same function.
  - **Where these hits link.** To `/post/[id]/edit`, with a `draft` or `scheduled` marker, as
    `/tag`'s do: neither kind of post has a public URL that answers.
- **`/search` becomes different for each viewer.** It already renders dynamically, because it
  reads `searchParams` (CACHING.md). It now says so with `dynamic = "force-dynamic"`, as `/tag`
  does, and its pages are marked `noindex`.

A PENDING comment is not found here, even by the post's moderators. A hit has to link to a page
that shows it, and the post page shows only APPROVED comments. `/comments` keeps its own `?q=`.

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
`english` configuration finds neither. `ts_headline` still marks the word as written, "Gödel"
(checked).

**Installing the extensions.**

- **Trusted.** `unaccent` and `pg_trgm` are contrib extensions, and both are *trusted*: any role
  with `CREATE` on its database may install them.
- **Servers.** Every deployed instance's role owns its database, and the servers' Postgres 18
  ships both extensions (checked 2026-10-04). The migration therefore creates them under
  `prisma migrate deploy`, with no superuser step.
- **Development machines.** These need the contrib modules too, or `prisma migrate dev` can't
  build its shadow database. On Fedora that means `sudo dnf install postgresql-contrib`.

### One vector per row

| Table | `search_vector` holds (weight) | Its trigger fires on |
|---|---|---|
| `doc` | the title (A), the body's text (D) | `INSERT`, `UPDATE OF title, prose_json` |
| `post` | the title (A), the body's text (D) | `INSERT`, `UPDATE OF title, prose_json` |
| `annotation` | the body (B), the quoted passage (D) | `INSERT`, `UPDATE OF body_text, quoted_text` |
| `comment` | the body | `INSERT`, `UPDATE OF body_text` |
| `file` | the title (A), the filename as uploaded (B) | `INSERT`, `UPDATE OF title, filename` |
| `file_page_text` | the page's text | `INSERT`, `UPDATE OF text` (only the backfill updates it) |

This copies `prose_json_length`'s pattern exactly ([DATABASE.md](DATABASE.md)): a plain column
that a `BEFORE` trigger owns. Migrate can't see it, and the app never assigns it.

- **In schema.prisma** each column is
  `searchVector Unsupported("tsvector")? @map("search_vector")`, with
  `@@index([searchVector], type: Gin)`. Prisma 7.9 accepts both, and `migrate diff` produces
  clean SQL for them (checked). The client never selects an `Unsupported` field, so no vector is
  ever sent to a page.
- **Each kind's vector is a named SQL function of its columns**, such as
  `doc_search_vector(title, prose_json)`. The trigger and the integrity check (§9) both call that
  function, so they can't disagree about what the right vector is.
- **`prose_text(jsonb)`** returns a ProseMirror document's text in document order. The text
  pieces within a block are joined directly, blocks are joined by a newline, and a `hardBreak`
  becomes a newline.
  - **How.** It is `doc_length`'s recursive walk plus an ordinal path to sort by.
  - **Why order matters.** Phrase search and ranking read word positions; a length doesn't care.
  - **Cost.** It is `IMMUTABLE`, and takes about 44 µs per thousand characters (measured).
- **Why SQL rather than Node.** `prose_json` has several writers: the collab server's cache,
  `createDocWithContent`, and the importer's in-place update. A trigger covers all of them by
  construction, which is why `prose_json_length` is a trigger too. Comments and annotations
  already have a `body_text` column the app writes, and their triggers read that.
- **Every new trigger function is declared with `SET search_path = public, pg_catalog`.** A
  data-only load from `pg_dump` runs with an empty search path. `doc_sync_prose_json_length`
  already fails there, because it calls `doc_length()` without a schema. Fixing that one the same
  way is a one-line change this migration could carry (§10).
- **The backfill is a no-op `UPDATE` of a trigger column on each table**, DATABASE.md's repair
  recipe.
  - **One definition.** The update fires the triggers, so each vector's definition is written
    only once.
  - **Dates are untouched.** Raw SQL leaves `updated_at` alone, because Prisma sets `@updatedAt`
    on the client side, so the backfill moves none of the dates §6 filters on.
  - **Time.** It runs inside the migration and takes a few seconds on the largest instance.

### The vocabulary

Typo correction (§5) needs to know which words exist. The `search_lexeme(lexeme text primary
key)` table holds every lexeme (stemmed word) that appears in any vector, under a trigram index:
`@@index([lexeme(ops: raw("gin_trgm_ops"))], type: Gin)`, which Prisma 7.9 also accepts.

- **How it is fed.** Two statement-level `AFTER` triggers on each table:
  - on `INSERT`, the statement's lexemes
  - on `UPDATE`, the new rows' lexemes minus the old rows'

  Both insert with `ON CONFLICT DO NOTHING`, **in lexeme order**. Without that order, two saves
  that insert overlapping sets can deadlock on the primary key.
- **Statement-level, so a batch costs one insert.** That covers hundreds of PDF pages extracted
  together, and the migration's backfill.
- **"New minus old" misses nothing.** Every lexeme already in a stored vector is already in the
  table.
- **Neither trigger has a column list.** Postgres refuses transition tables on a trigger with a
  column list, and on a trigger for more than one event (checked), hence two triggers per table.
  - **The cost.** The update trigger runs on every `UPDATE` statement.
  - **Why that's cheap.** When the vector didn't change, the difference is empty.
- **It never shrinks by itself.** A lexeme whose last occurrence is gone does no harm, because §5
  uses no candidate that lacks a readable hit. The integrity check's `--repair` rebuilds the
  table from `ts_stat`.
- **It is global**, including words from text the viewer can't read. §5 explains why that is
  safe.

The largest doc corpus has 29,025 distinct lexemes under this configuration. Gathering them from
every vector with `ts_stat` takes 62 ms, and building their trigram index another 51 ms. The
table takes 1.2 MB and the index 1.7 MB (measured).

### What it costs

Measured on 2026-10-04, against a copy of the largest doc corpus and the dev database's PDFs, on
one core of the dev box. A Linode vCPU is perhaps two to three times slower.

| | Docs: 333, 3.3M characters | PDF pages: 1,906, 5.5M characters |
|---|---|---|
| Vectors, then their GIN index | 2.5 MB, then 2.4 MB | 5.2 MB, then 2.75 MB |
| Building every vector | 0.42 s | 0.44 s |
| Matching and ranking every hit | under 1 ms | under 1 ms |
| `ts_headline`, per hit | about 3.5 ms per long doc | about 0.3 ms per page |

- **On the servers**, the largest instances hold 3.66M characters of docs and 7.6M characters of
  PDF pages: about 6 MB and 11 MB of disk respectively.
- **No new memory is held.** Index pages sit in Postgres's cache like any other pages, and
  `shared_buffers` is 128 MB. So RAM, the one resource these 2 GB boxes run short of, doesn't
  move.
- **Each save** costs about 0.13 ms per thousand characters, once per collab cache write. That
  is 1.3 ms for a 10,000-character doc, and 11 ms for the longest (88,000 characters).
- **Snippets are the cost to manage**, so only the hits on screen get one (§4).
- **The stored column is what makes this cheap.** Computing the vector inside the query instead
  takes 256 ms per search over the same docs.

**A vector holds at most 16,383 word positions, and the longest imported docs use about 15,300.**

- **Past the cap**, positions clamp.
- **Matching** still works.
- **Phrase search and proximity ranking** degrade in the tail of the doc.

Option B in the appendix removes the limit.

## 4. Querying

**The syntax** is `websearch_to_tsquery`'s:

- words are ANDed
- "quoted phrases" match in order
- `or` gives alternatives
- `-word` excludes

A query made only of stop words parses to nothing. The page says so, rather than showing an empty
result that looks like "no matches". Input is capped at 200 characters, as
`searchQuotableTargets` caps it today.

**One kind's search** takes four steps:

1. **Prisma**: the readable ids, under §6's filters.
2. **SQL**: match and rank inside those ids, by `ts_rank_cd(search_vector, query, 32)` and then
   newest first, along with the count.
3. **SQL**: `ts_headline` for the hits on screen only. For docs and posts it runs over
   `prose_text(prose_json)`, and for the rest over the stored text.
4. **Prisma**: what the page shows, such as titles, bylines and dates.

With no text and at least one filter, steps 2 and 3 drop out. The page lists the readable rows
under the filters, newest update first, each with the start of its text.

**PDFs** rank pages inside the readable files.

- **Text versions.** A page can have rows at several text versions, because `storedPageText`
  re-extracts on demand and keeps the old rows ([PDF.md](PDF.md) §3). Hits are therefore one per
  page, using the current version's row when there is one.
- **Grouping.** Pages are grouped under their file, best page first.
- **Title matches.** A file whose title or filename matches is listed even when no page does.

**Snippets** come from `ts_headline` with private-use characters as delimiters (checked that
`ts_headline` accepts them):

- U+E000 and U+E001 surround a match.
- U+E002 separates fragments.

They are split into React nodes, with each match in a `<mark>`. **`ts_headline` doesn't escape
the text around a match**, so its output is never treated as HTML, and search uses no
`dangerouslySetInnerHTML`.

## 5. Fuzzy matching

**Accent folding** is always on, in the configuration (§3).

**Typo correction** runs when a search finds nothing:

1. **When it runs.** Only when every selected kind came back empty, and never with `exact=1`.
2. **Which words qualify.** A word qualifies if it isn't quoted or negated, has at least four
   characters, and has a lexeme, meaning it isn't a stop word.
3. **Misses.** A qualifying word is a *miss* if its lexeme on its own has no readable hit under
   the current filters.
4. **Candidates.** A miss's candidates are the five lexemes in the vocabulary most similar to it
   (`%`, with similarity at least 0.4). Each is checked for readable hits, and the one with the
   most wins.
   - **Similarity alone would pick wrong.** "wittgenstien" is closer to `wittgenst` (0.64, in
     one doc of the largest corpus) than to `wittgenstein` (0.53, in eleven).
   - **The hit count gets it right.** It also prefers `institut` (76 docs) over `institution`
     (22) for "instituion", and `macintyr` (21) over `macintyrean` (5) for "macintire".
   - **Speed.** Finding the candidates for six misspellings together takes 1.3 ms (checked).
5. **The corrected query.** `ts_rewrite` replaces each miss in the original query with its
   winner, written as a lexeme literal (`'macintyr'::tsquery`). **It never goes through
   `to_tsquery`**, which would stem a word that is already a stem, and stemming twice doesn't
   always give the same result: "agreed" stems to `agre`, and `agre` stems to `agr` (checked).
6. **What the page says.** That nothing matched the query as typed, so these are close matches,
   with a link to search exactly as typed (`exact=1`). It names no corrected word; the
   highlights in the snippets show what matched.

**Why a global vocabulary leaks nothing.**

- **What the viewer sees depends only on what they can read.** Whether correction runs depends on
  the viewer's own hits, and a candidate is used only if it has hits the viewer can read.
- **Private words make no difference.** A word that exists only in text the viewer can't read
  never changes what they see.
- **The tempting alternative would leak.** Suggesting a word whenever the typed one isn't in the
  vocabulary would let a signed-out reader probe private docs, because no suggestion would mean
  "this word exists somewhere".

**Search-as-you-type** (the quote picker, §8) treats the last word as a prefix. It matches `:*`
on that word's stem, plus every lexeme of four or more characters in the vocabulary that the
typed text begins with.

- **Why the second part.** A typed prefix can run past its word's stem. "organiza" doesn't
  prefix-match `organ` (organization), and "mediati" doesn't match `mediat` (mediating)
  (checked).
- **Why every such lexeme, not just the longest.** "organiza" begins with both `organ`
  (organization) and `organiz` (organizational, which stems differently). Taking only the
  longest would lose "organization" (checked).
- **Minimum.** It starts at two characters.

Not in this plan:

- matching inside words, which would need a trigram index over whole bodies
- "did you mean" suggestions when a search did find something

## 6. Filters

| Parameter | Meaning |
|---|---|
| `q` | The text (§4) |
| `kinds` | Any of `docs`, `posts`, `annotations`, `comments`, `pdfs`; by default every kind the viewer can read |
| `authors` | User slugs; a hit matches if any one of them is its author |
| `created_from`, `created_to`, `updated_from`, `updated_to` | Dates as `YYYY-MM-DD`, inclusive |
| `tz` | The IANA time zone those dates are in. The form fills it in, and it defaults to UTC |
| `page` | Pagination, when exactly one kind is selected |
| `exact` | `1` turns typo correction off |

The API (§8) takes the same parameters.

### Author

| Kind | Its author is |
|---|---|
| Docs | the byline (`doc_author`) |
| Posts | the post's own byline (`post_author`), which is separate from its doc's (PLAN.md §15d) |
| Annotations | the writer |
| Comments | the commenter's account; an anonymous commenter has none and matches no author |
| PDFs | the owners. Nobody listed wrote the PDF, so this is the word `/files` uses |

**The picker lists only people the viewer can already see as authors**: users who are the author
of at least one item the viewer can read, found with the same read rules.

- **Labels are names**, the way public bylines show them. `AuthorByline` leaves out users who
  have no name, and so does the picker.
- **Never an email.** The admin tables label users with `name ?? email`
  ([author-filter.ts](../src/lib/author-filter.ts)), and a signed-out reader must never see that.
- **Slugs in the URL** are checked against this list, the way `/docs` checks its own.

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

- **Where "updated" comes from.** `isVisiblyEdited`, over the version timestamps the page
  loaders already fetch (`comment-data.ts`, and `editState` in `annotation-data.ts`).
- **When it runs.** In the loader, after the text match.
- **Pagination.** Those two sections paginate in JS, which is cheap because the match set is
  small.
- **The date a hit shows.** The same answer decides the "edited" date on each hit, so search and
  the page can't disagree.

**A date is a day in the viewer's time zone.** `tz` turns it into the range from that midnight
to the next, in UTC. A small client island fills `tz` from `Intl`, for the same reason
`LocalTime` exists: the server's time zone isn't the reader's.

## 7. The page

**Sections** come in a fixed order: Docs, Posts, PDFs, Annotations, Comments.

- **Counts.** Each section heading carries its count.
- **Which sections.** Only kinds the viewer can read appear, and only the selected ones.
- **Length.** Each section shows its top five hits, then an "All N docs" link (`kinds=docs`) that
  opens a paginated list.

**What each hit shows:**

| Kind | Shows |
|---|---|
| Doc | title, byline, updated date, snippet |
| Post | title, byline, published date, snippet; a `draft` or `scheduled` marker when unpublished |
| PDF | title, then up to three pages ("p. 12"), each with its snippet |
| Annotation | its doc or PDF, the writer, the date, a snippet of the body, and the passage it quotes |
| Comment | the commenter, the post's title, the date, a snippet |

**Where each hit links:**

| Kind | Links to |
|---|---|
| Doc | `/doc/<slug>` |
| Post | its public path, or `/post/<id>/edit` when unpublished |
| PDF page | `/pdf/<slug>#page=<n>` |
| Annotation | its doc or PDF, plus the permalink fragment its card already renders |
| Comment | its post's path, plus `#` and `commentAnchorName` |

Two of these links need small changes:

- **`#page=` is new.** It follows the PDF Open Parameters convention. The viewer has a page box
  but no way to set the page from the URL today; it will read `#page=` on load.
- **The annotation fragment needs its function exported.** `anchorName` is private to
  `AnnotationNode.tsx`. It moves to a module that is safe in the browser, so the server can build
  the same fragment. `commentAnchorName` lives in its own file for the same reason.

**A doc hit doesn't land on its passage.** A text fragment (`#:~:text=`) would highlight the
static first render, which the live editor then replaces (DOCS.md, "The reading view"), so it
isn't reliable here. Landing on a passage is option B's job.

The header's search box stays as it is, and now searches everything the viewer can read. Styles
go in a CSS module and use STYLE.md's color tokens, including for `<mark>`.

## 8. Other consumers

- **The quote picker** (`searchQuotableTargets`) becomes this search over posts and comments, in
  the **public scope**.
  - **Public scope** means `publishedPostWhere`, never `readablePostWhere`, because a quotation
    may carry only what everyone can already read (PLAN.md §23e).
  - **Matching** uses search-as-you-type (§5).
  - **So the operation takes a scope**, either the viewer's read rules or the public ones, as well
    as the actor.
- **The API.** The search operation is a plain module that takes an explicit actor
  (`{ userId, role } | null`), and is never exported from a `"use server"` file. The API plan
  (`docs/API.md` on the `api-mcp` branch) sets that rule for every operation. Its search
  endpoints will call this one once the API is built; this plan doesn't build them.
- **The admin tables' `?q=`** stays on titles (PLAN.md §16l). Pointing it at bodies is a
  separate decision.

## 9. Build order

1. **Turn the read rules into named `where` helpers, without changing behavior.** Each rule is
   currently restated in several places, kept in step only by sitting near each other with a
   comment saying so:
   - **Docs**: `readableDocsWhere` (private to [doc-authz.ts](../src/lib/doc-authz.ts)),
     `listDocs` in `tag-browse.ts`, `readableDocWhere` in `/links`, and the doc half of
     `/annotations`' scope.
   - **Files**: `readableFilesFor`, `listFiles`, `readableFileWhere` in `/links`, and the file
     half of `/annotations`' scope.
   - **Annotations**: `/annotations`' scope, and the `not DRAFT` clauses in `annotation-data.ts`.
   - **Comments**: `searchQuotableTargets`, and the candidate query in
     `comment-quote-capture.ts`, alongside `isCommentPublic`.

   Export one helper per kind next to its per-row predicate, and switch the callers over.

   **Where a restatement differs from its rule, keep the difference and name it** rather than
   fixing it quietly. For example, `/annotations`' scope doesn't exclude a soft-deleted doc or
   PDF.

   **One discrepancy to settle here: `isCommentPublic`.**
   - **What it tests.** `publishedAt !== null`.
   - **Why that's wrong.** `unpublishPost` leaves `publishedAt` set, and scheduling sets it to a
     future date. So the function calls a comment on an unpublished or scheduled post public,
     which its own header says it is not ("on a post that is no longer live — is its own
     author's and the post's moderators'").
   - **Who inherits it.** The quote gate and the quote renderer.
   - **The fix.** The new `where` helper uses `publishedPostWhere()`, and the per-row check
     should match it.
2. **The index.**
   - Every development machine needs the contrib modules (§3).
   - Write one migration: the extensions, the configuration, `prose_text`, the vector functions,
     the columns, the triggers, the vocabulary and the backfill.
   - Update schema.prisma, then run `npx prisma format` and `npm run check:schema`.
   - Add `scripts/integrity/check-search-index.ts`. It checks that every vector equals its
     function's output, and that every lexeme in a vector is in the vocabulary. With `--repair`,
     it re-fires the triggers for drifted rows and rebuilds the vocabulary.
3. **The operation and the page.**
   - `src/lib/search/`: parameters, the five kinds, dates and the author picker.
   - The `/search` page itself.
   - `#page=` in the PDF viewer, and the exported `anchorName`.
   - The written rules: `readablePostWhere`'s comment, PERMISSIONS.md and CACHING.md.
4. **Fuzzy matching**: typo correction and search-as-you-type.
5. **The quote picker** moves onto the search operation. The API plan gets a note that its search
   endpoints call `src/lib/search/`.

After that comes option B (appendix), once hits in long docs need to land on their passage.

**Each step ships with:**

- **e2e specs**, run against the production build.
- **Unit tests** under `npm run test:unit` for the pure parts: parsing parameters, deciding which
  words qualify for correction, splitting a headline into nodes, and turning a date and time zone
  into a UTC range.
- **Checks**: `npm run check`, and a clean `check-search-index`.

**The e2e specs** each plant a unique word in a fixture and search for it:

- **Docs**: a PRIVATE doc's word, searched by its author, another author, an AUTHORIZED reader,
  and someone signed out.
- **Posts**: a draft's and a scheduled post's words, searched by a byline author, another author,
  an EDITOR, and someone signed out.
- **Annotations and comments**: a DRAFT annotation's word, and a PENDING comment's.
- **Filters**: author, kind, and each date range.
- **Silent edits**: a comment edited inside the grace window doesn't match an "updated" range that
  only the edit would satisfy.
- **Accents and typos**: "Godel" against "Gödel", and "macintire" against "MacIntyre".
- **PDFs**: a page hit that opens the viewer on that page.

## 10. Open decisions

1. **"Their own" drafts.** The plan reads this as "may edit", which gives an ADMIN or EDITOR every
   unpublished post. Narrowing it to the byline would make search disagree with `/tag`.
2. **A viewer's own DRAFT annotations.** Should their writer be able to find them, or should
   nobody? The plan leaves them out, as `/annotations` does.
3. **Filtering comments by author.**
   - **The problem.** A commenter's display name is fixed when their commenter row is created.
     So filtering by a user who has since changed their name finds comments shown under the old
     name.
   - **Why it matters.** Anyone who tries that filter can link the old name to the new one.
   - **As built:** an author filter leaves comments out, and the page says so. Commenters
     contribute no names to the picker.
4. **`isCommentPublic`.** §9 treats its header comment as correct and its code as wrong. Is that
   the intent? Built that way, in a commit of its own so that it can be reverted alone.
5. **Fixing `search_path` on `doc_sync_prose_json_length`** in the same migration. Built: the
   migration's last statement.
6. **Sizes.** Five hits per section, and three pages per PDF. Built as written, with 20 hits per
   page once one kind is selected.
7. **Semantic search (A.4).** Is it wanted? If so, are documents embedded by Voyage's hosted
   models, or on a desktop with the open-weights model? Either way it needs option B first.
8. **Filtering PDFs by owner.** Departs from §6's table. `/pdf/[slug]` shows no owner, so the
   picker's premise — people the viewer already sees as authors — doesn't hold for owners, and
   an owner filter would disclose who owns which file to every reader. As built, an author
   filter leaves PDFs out too, and owners contribute no names to the picker.
9. **A mark-anchored annotation's passage isn't in its vector.** The doc editor's annotations
   keep their passage in the doc's body as a mark, with `quoted_text` empty, so §1's
   "the quoted passage" covers only column anchors and PDF annotations. Those words find the
   doc instead; the hit still shows the passage, derived from the mark as `/annotations` does.
   Indexing it would mean a doc save rewriting its annotations' vectors.
10. **Listing without text** orders annotations and comments by the date readers are told
    about, which means applying `edit-grace.ts` to every readable one rather than to a page's
    worth. Fine at this scale; at thousands of comments it wants a stored column.

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

- FTS5 is built into Node 24, with its porter and trigram tokenizers (checked).
- It provides BM25 ranking, `snippet()`, and matching inside words, with no daemon.

**Costs:**

- **A second copy of the data.** Two processes write it and have to keep it in step: collab
  writes docs, and web writes comments and annotations.
- **Rebuilt on every deploy.**
- **The same after-the-fact permission filter as A.2.**
- **A JS index lives in the web process's heap**, where RAM is tightest.

**Verdict**: better ranking and matching inside words aren't worth the syncing.

### A.4 Semantic search: pgvector and embeddings

**Undecided (§10).**

**What it is.** An embedding model turns a passage into a list of about a thousand numbers: a
point in a space where passages with similar meaning sit close together, even when they share no
words. A search embeds the query the same way and returns the nearest passages.

**What it finds.** A concept written in different words, which no keyword index can: "mediating
institutions" next to "intermediary associations".

**Where it is weak.** Exactly where keywords are strong: names, quotations and rare terms. So it
runs beside option A rather than replacing it, and the two rankings are merged (reciprocal rank
fusion).

**Prerequisites:**

- **Option B's passages.** A single vector for a 15,000-word doc blurs everything in it together.
- **pgvector**, which neither server has. It is an apt package on each, which needs sudo.
- **Storage.** About 10,000 passages across the four instances, at 1,024 numbers each, comes to
  around 40 MB. That is few enough to scan exactly, with no approximate index.

**The model.** Anthropic has no embedding model of its own and points to Voyage AI. Voyage 4's
models share one vector space, so a passage embedded by one model can be found by a query embedded
by another.

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
whose text changed waits in a queue that a worker drains. Semantic results therefore lag an edit by
up to a minute, while keyword results don't lag at all.

**Per instance.** Semantic search can be switched on instance by instance. An instance that holds
other people's PRIVATE docs needs their agreement before their text goes to Voyage.

### A.5 ParadeDB `pg_search`

It brings BM25 and fuzzy matching inside Postgres. But it is a third-party extension built for
each major Postgres version, so every Postgres upgrade would have to wait for it. That is the
pdfjs lesson (CLAUDE.md) applied to the database.

### A.6 Variations on option A, set aside

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
