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
(slot B, `~/git/MultiBlog`). They are separate precisely so two branches can hold divergent
migration state without either one's `prisma migrate dev` detecting drift and offering the
full reset described below — which is the failure this arrangement exists to prevent, and
the reason a second checkout must never be pointed at the first's `DATABASE_URL`. Adding a
third: [DEV_SLOTS.md](DEV_SLOTS.md).

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

### Self-join elimination does not rescue a view over its own base table

It is on by default and does work — an inner join of a table to itself on the primary key
collapses to one scan — but it only fires for `INNER` joins, and Prisma emits a `LEFT JOIN`
for a to-one relation ordering no matter how the relation is declared. See
`add_post_metrics_view` and PLAN.md §16l.

### B-tree skip scan changes nothing here

Every composite index this schema relies on — `post_publication_event(post_id, created_at)`,
`post_author` and `doc_author`'s composite primary keys — is already queried on its leading
column.

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
