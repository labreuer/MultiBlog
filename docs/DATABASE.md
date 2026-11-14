# Postgres, and the migration recipes that need one

The operational half — where the generated client lives, why `prisma generate` fails while
the dev server runs, why a new model needs a restart — stays in CLAUDE.md, because it bites
on ordinary work. This file holds what you only need when you are touching the database
itself.

## The cluster

Local **Postgres 18** (Windows service `postgresql-x64-18`), owning port 5432. The
`multiblog` role and database connect passwordless — the 18 instance trusts all local
connections, so `psql -U multiblog -h 127.0.0.1 -d multiblog` just works. Restarting the
service needs an elevated shell.

**Two databases in that one cluster**, one per slot: `multiblog` (slot A) and `multiblog_b`
(slot B). They are separate precisely so two branches can hold divergent
migration state without either one's `prisma migrate dev` detecting drift and offering the
full reset described below — which is the failure this arrangement exists to prevent, and
the reason a second checkout must never be pointed at the first's `DATABASE_URL`. Adding a
third: [DEV_SLOTS.md](DEV_SLOTS.md).

**The cluster needs the contrib modules.** `add_full_text_search` creates the `unaccent`
and `pg_trgm` extensions ([FULLTEXT.md](FULLTEXT.md) §3), and so does every shadow
database `prisma migrate dev` builds, so a cluster without them can't migrate at all. The
Windows installer ships them; on Fedora it is `sudo dnf install postgresql-contrib`, and the
servers install `postgresql-contrib` with Postgres (DEPLOY.md §2e). Both extensions are
*trusted*, so the database's owner creates them with no superuser step.

## What Postgres 18 does *not* change, having been checked directly

Worth recording because each of these looks like it should help and doesn't.

### `jsonb_path_query` still double-counts

`jsonb_path_query(doc, '$.**.text')` double-counts on 18.4, exactly as it did when
`add_doc_length_function` was written — its header records the finding. A lone
`{"type":"text","text":"hello"}` inside an array still yields `["hello","hello"]`, so
`doc_length`'s recursive CTE is not a workaround waiting to be retired. `JSON_TABLE` (new in
17) doesn't help either: it needs a known shape, and a TipTap document nests arbitrarily.

### Virtual generated columns reject user-defined functions

18's headline feature, and now the default, refuses outright: *"Virtual generated columns
that make use of user-defined functions are not yet supported."* So `doc_length(prose_json)`
cannot become one.

A `STORED` column *is* accepted, and Prisma reads and sorts it correctly — but `migrate
diff` reads the generation expression as a column default and permanently emits `ALTER
COLUMN … DROP DEFAULT`, so every `migrate dev` would offer to strip the generated-ness.

Hence `Doc.proseJsonLength` being a plain column plus a trigger
(`doc_sync_prose_json_length`) instead: Migrate doesn't introspect triggers, so the trigger
is invisible to it and the diff stays clean.

> **Never assign to `Doc.proseJsonLength`.** The trigger owns it, on `INSERT` and on any
> `UPDATE` naming `prose_json`. A bypass (`DISABLE TRIGGER`, `COPY`, a restore) drifts
> silently; the `length-cache` check in `scripts/integrity/check-doc-integrity.ts` is what
> catches it, and a no-op `UPDATE doc SET prose_json = prose_json WHERE id = …` re-fires the
> trigger to repair.

The six `search_vector` columns (`doc`, `post`, `annotation`, `comment`, `file`,
`file_page_text`) are the same arrangement for the same reason (`file`'s reads its filename
from the file's latest version, [PDF.md](PDF.md) §13), with one more trigger pair
per table feeding the `search_lexeme` vocabulary ([FULLTEXT.md](FULLTEXT.md) §3). Never
assign to them either; `scripts/integrity/check-search-index.ts` is their guard, and its
`--repair` runs the no-op `UPDATE` for every drifted row.

`reference.search_vector` is a seventh, written by its own trigger from `key`, `short` and
`csl` ([CITATIONS.md](CITATIONS.md)). It feeds no vocabulary: the reference library is searched
on its own page and through `find_refs`, never by the site search's typo correction.

The `mention` table is a whole table of the same kind ([ENTITY_CHIPS.md](ENTITY_CHIPS.md),
step 1, item 12): triggers on `doc.prose_json`, `annotation.prose_json` (and its `status`) and
`post.prose_json` keep one row per mention chip, by a diff, so a row's `first_seen_at` is when
its chip first appeared. Never write to it; `scripts/integrity/check-mentions.ts` is its guard,
and its `--repair` runs the same diff.

### Self-join elimination does not rescue a view over its own base table

It is on by default and does work — an inner join of a table to itself on the primary key
collapses to one scan — but it only fires for `INNER` joins, and Prisma emits a `LEFT JOIN`
for a to-one relation ordering no matter how the relation is declared. See
`add_post_metrics_view` and PLAN.md §16l.

### B-tree skip scan changes nothing here

Every composite index this schema relies on — `post_publication_event(post_id, created_at)`,
`post_author` and `doc_author`'s composite primary keys — is already queried on its leading
column.

## A data-only load into an existing schema

Moving content between instances with `pg_dump --data-only` into a migrated database runs
every trigger as the rows go in. Two things follow:

- **Every trigger function sets its own `search_path`**, because a data-only load runs with
  an empty one and a function calling `doc_length()` or `prose_text()` without a schema
  would fail on the first row. A new trigger function needs `SET search_path = public,
  pg_catalog` too.
- **Leave `search_lexeme`'s data out** (`--exclude-table-data=search_lexeme`). The
  vocabulary triggers refill it as the content tables load, and its own `COPY` would then
  collide on the primary key and abort the load. Run
  `scripts/integrity/check-search-index.ts` afterwards.
- **Leave `mention`'s and `citation`'s data out too** (`--exclude-table-data=mention
  --exclude-table-data=citation`), for the same reason:
  the triggers write its rows as the docs, notes and posts load, and its own `COPY` would
  collide with them. The cost is that every `first_seen_at` becomes the load's time. Run
  `scripts/integrity/check-mentions.ts` afterwards.

- **`file` and `file_version` name each other** ([PDF.md](PDF.md) §13): a file's
  `current_version_id` is a key into `file_version`, whose `file_id` is a key into `file`.
  It is a second pair of tables whose keys form a cycle, beside `post` and
  `post_publication_event`, and `pg_dump` warns of both; a data-only load of them needs
  `--disable-triggers`, or the pointer set after both tables are in. Not tried here.
- **A file's row loaded before its versions gets a search vector without its filename**: the
  trigger reads the filename through `current_version_id`, and the version isn't there yet.
  `scripts/integrity/check-search-index.ts --repair` refills it.

A full dump restored into an empty database has none of these problems: `pg_dump` creates
triggers and foreign keys after the data, so none of them fires during the load.

## Keeping `schema.prisma` format-clean

`npx prisma format` is the canonical formatter and there is no `--check` flag for it (checked
against `prisma@7.9`). Two things follow, and the second is the one that bites.

**It rewrites the whole file, not the block you edited.** Alignment is per-block and derived
from the longest field name in that block, so adding a field longer than the current longest
legitimately realigns everything around it — that part is a real consequence of your change
and reads fine in a diff. What does not read fine is what happens on a file that has *drifted*:
every misalignment anyone ever left behind gets swept into whatever commit happened to run the
formatter. That is not hypothetical. It is how this file came to be reformatted as a side
effect of adding the tag models (PLAN.md §20), where 249 of 399 changed lines were
whitespace and `git blame` on them pointed at a commit about tags. The reformat was split
back out into its own commit, which is where the rule below comes from.

**So: run it every time, and read the diff before staging.** The file is clean, so a run is a
no-op plus your own block's realignment. Anything it touches *outside* your edit is
pre-existing drift — commit that separately. Once, on its own, with a message saying so.

### The LF pin

`.gitattributes` carries `*.prisma text eol=lf`. `prisma format` always writes LF, and this is
a Windows checkout with `core.autocrlf=true`, so without the pin every single run rewrote all
~1100 lines from CRLF to LF — which made "did the formatter change anything?" a question no
byte comparison could answer, and printed `LF will be replaced by CRLF` on every `git add` of
the schema.

**Nothing in the repository changed when that line was added, and nothing will.** Git already
stored this file as LF: `core.autocrlf` converts CRLF→LF on the way *in*, so the blob, the
index and every past commit are already LF. The pin only stops the conversion happening on the
way back *out*, at checkout. Verified by A/B: re-checkout without the rule gives 1088 CR bytes,
with it gives 0, and `git diff` is empty either way.

Extending the pin to the rest of the tree is a separate decision with a real cost and no
urgency: the repo is overwhelmingly CRLF in the working tree (216 `.ts`, 109 `.tsx`, 54 `.css`
at the time of writing), so `* text=auto eol=lf` would rewrite every one of those files on disk
— again with zero repository diff, but touching every mtime and every open editor buffer. The
schema earns the pin on its own because a *tool* rewrites it; nothing rewrites the `.tsx` files
but you.

### The check

`npm run check:schema` fails if the schema isn't what the formatter would produce, and
`npx tsx scripts/check-schema-format.ts --write` fixes it. Three things about that script are
deliberate and worth not "simplifying" away:

- **It never leaves the file modified.** A check that silently rewrites your working tree is a
  formatter wearing a check's name, and this whole section exists because unasked-for rewrites
  are the hazard.
- **It does not use `prisma format && git diff --exit-code prisma/schema.prisma`.** That
  one-liner conflates "the schema is misformatted" with "the schema has uncommitted edits" —
  and the second is true exactly when you are mid-schema-change, which is precisely when you
  would run the check. It would cry wolf on every real use and be ignored within a week. The
  script compares the file against its own formatted self and says nothing about git.
- **It still normalises line endings before comparing**, even with the pin above. The pin
  governs what *git* writes at checkout; it does not stop an editor, a script, or a
  copy-paste from putting CRLF back, and a check that reports a difference on content identical
  line for line is a check that gets ignored.

## `migrate dev` does not regenerate the client

Under Prisma 7, `npx prisma migrate dev` applies the migration and stops: the client in
`src/generated/prisma` is still the one from before it. Run `npx prisma generate` after it,
with the dev server stopped, and start the server fresh. Skipping it reads like a bug in the
code just written: `tsc` complains about a model or column that is plainly in
`schema.prisma`, or, with a server that was left running, `prisma.<newModel>` is `undefined`
at the first query.

## A relation is loaded in a statement of its own

A read that names a relation in `include` or `select` is not one statement. Prisma sends the
rows' statement, then one more for each relation, keyed by the ids the first returned.
`/comments`' page of comments is five: the comments, their commenters, their threads, the
users who moderated them, and the threads' posts. No transaction joins them, so each sees the
database as it is when it runs.

**A parent row hard-deleted between two of them arrives as null, in a field typed as never
null.** Prisma raises nothing. The caller's first read of the field throws, and a page answers
500 with `Cannot read properties of null`. The row that lost its parent is gone by then too:
its foreign key cascaded, or would have refused the delete.

- **`rowsWithParents`** (`src/lib/rows-with-parents.ts`) leaves such rows out, and a listing
  that reads a required relation takes its rows through it: `/comments`, `/annotations`,
  `/files`, `/tags`, `/links`, `/references`, and the parts of the links into a doc or a file
  (`linkPartsInto`). `/posts`, `/docs` and `/users` read no required relation.
- **An optional relation is named only where its foreign key is set.** `/annotations` throws
  for a note with no container and `/files` for a file with no latest version. Each is a fault
  in the data and stays loud. A row whose key names a row that didn't arrive is the delete,
  and is left out.
- **What hard-deletes a parent.** The app soft-deletes posts, users, docs, files, tags and
  references. On an instance that leaves a draft link discarded by its own creator from
  another tab, which the two reads of a part's link allow for. Everything else takes the e2e
  suite's cleanup, a throwaway-data script ([TEST_DATA.md](TEST_DATA.md)) or SQL by hand,
  landing during the load. The suite is where it shows: its workers share one database, and
  one's teardown hard-deletes what another's admin table is listing.
- **The total beside a table is counted by a statement of its own**, so for that one load it
  can be one more than the rows listed.
- **The other reads of a required relation are not guarded** (TODO.md, "A required relation
  read without `rowsWithParents`…").

Two other ways to close it, and why neither is used:

- **One statement.** The `relationJoins` preview feature loads relations by lateral join. On,
  it is the default for every read in the app at once, the view-backed columns of the admin
  tables among them (PLAN.md §16e), and confining it means naming
  `relationLoadStrategy: "query"` on every other call.
- **One snapshot.** A transaction at repeatable read gives every statement the same view of
  the database; one at the default level does not, since each statement of a read-committed
  transaction sees the latest commit. It costs a transaction for each page load, and inside
  one Prisma sends a row's sibling relations together down the transaction's one connection,
  which `pg` reports as deprecated ("Calling client.query() when the client is already
  executing a query").

`e2e/admin-table.spec.ts` makes a delete land between two of `/comments`' statements
(e2e/README.md, "A hard delete is made to land between two statements of a page's read").

## Adding a required column to a table that already has rows

`prisma migrate dev` normally prompts interactively for how to backfill existing rows, which
doesn't work non-interactively. Instead:

1. Add the field **nullable** and migrate.
2. Backfill via `psql` or a script.
3. Drop the `?` and migrate again — the second migration is a plain
   `ALTER COLUMN … SET NOT NULL` with no prompt, since every row already has a value.

`adminInitials`' two migrations (`add_admin_initials_nullable`,
`make_admin_initials_required`) are the worked example.

## Editing a migration file after it has been applied

This makes the next `migrate dev` demand a full database reset, and the message says so in a
way that is easy to accept by reflex:

> *"The migration `…` was modified after it was applied. We need to reset the `public`
> schema … All data will be lost."*

Prisma records a SHA-256 of each `migration.sql` in `_prisma_migrations.checksum`, and any
edit — **including appending a hand-written backfill to a file `migrate dev` just
generated** — invalidates it.

**Do not reset a dev database holding real content.** When the database genuinely already
reflects the edited file (the DDL ran, and the backfill was applied by hand), the schema and
the file agree and only the recorded checksum is stale. Correct that instead:

```bash
sha256sum prisma/migrations/<name>/migration.sql
psql -U multiblog -h 127.0.0.1 -d multiblog \
  -c "UPDATE _prisma_migrations SET checksum='<hash>' WHERE migration_name='<name>';"
```

Take a `pg_dump` first — `.db-backups/` is the convention that directory exists for.
(`pg_dump` on `PATH` is 18.4, matching the server.)

Better still: put the backfill in the file *before* the first `migrate dev` run, or in its
own follow-up migration.
