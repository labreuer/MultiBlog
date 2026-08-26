# Test data: throwaway, durable, and imported

Three different things live under `scripts/`, with three different containment rules. Mixing
them up is how real content gets destroyed, so the distinction is the point of this file.

| | address / naming | lifetime | swept by e2e teardown |
|---|---|---|---|
| throwaway (`test-*.ts`) | `@example.com`, `ydoc:test-` | until you delete it | yes |
| durable sample (`seed-sample-data.ts`) | `@sample.invalid`, no `E2E ` prefix | survives runs | **no** — deliberately |
| one-shot imports | real addresses | permanent | n/a |

## Throwaway scripts

**Each script's header comment documents its own flags — read that rather than a copy here,
which is what will go stale.** What follows is only what each one is *for*.

- **`scripts/test-user.ts`** — create/delete accounts of any role, optionally with a
  `Commenter` row for trust/moderation states (`--trusted`, `--force-moderate`).
- **`scripts/test-doc.ts`** — create/delete docs, optionally seeded with body text.
- **`scripts/test-post.ts`** — create/delete posts against a `--doc <id>`, draft or
  published, with a moderation policy. PLAN.md §15: a post is always a snapshot of some doc,
  never independently authored.
- **`scripts/test-comment.ts`** — list a post's comments and their statuses.
- **`scripts/test-file.ts`** — create/list/delete uploaded PDFs. It *generates* its own
  document via `scripts/make-test-pdf.ts` and pushes it through the real storage and
  extraction path, so a fixture file is indistinguishable from an uploaded one.
- **`scripts/test-tag.ts`** — create/tag/untag/list/delete throwaway tags (PLAN.md
  §20). Writes **whole-object anchors** only, the one shape PR 1 creates, and goes through the
  same find-first dedup the server action does.
- **`scripts/test-ydoc.ts`** — create/list/delete standalone documents in the ydoc stack
  (PLAN.md §11). `--garbage` writes bytes that aren't a valid Yjs update at all, to exercise
  `/ydoc-debug`'s "not TipTap-compatible" error path on purpose.

Defaults worth knowing without opening anything: `test-admin@example.com`, role `ADMIN`,
password always `testpass123`.

### The containment guard

`test-user.ts`, `test-doc.ts`, `test-post.ts`, `test-comment.ts` and `test-file.ts` all
refuse to touch anything but `@example.com` accounts and docs/posts/files authored or owned
solely by them, so they cannot reach real data by mistake. `test-ydoc.ts` uses the
equivalent containment for a table with no email column: it only ever creates ids under the
`ydoc:test-` prefix (`src/lib/ydoc-names.ts`) and refuses to `delete` anything else.

`test-tag.ts` needs **two** guards, and the second one is the non-obvious half. The first
is the usual one: the term's creator must be an `@example.com` account. The second is that
deleting a tag *cascades its assignments*, so a throwaway term a **real** account has
since applied to something is no longer throwaway data — `delete` refuses it and names who
tagged with it. There is no flag that widens this; retract the real tags first if you mean
it. The e2e suite guards the same table differently, by the `E2E ` name prefix, because §20c
makes a term's name unique case-insensitively and a fixture therefore can't collide with a
real term.

### Deletion order

The guard has a consequence that looks like a bug the first time:

- **Delete a post or doc *before* its author.** Once its only author is gone, "no authors" is
  indistinguishable from a real one that lost its author some other way, so `delete` refuses
  it.
- **Delete a post *before* its doc.** `Post.docId` has no `ON DELETE CASCADE` (PLAN.md §15),
  so a doc with a post still pointing at it can't be removed underneath it.

## `scripts/seed-sample-data.ts` — the odd one out

It seeds *durable* sample content for a freshly rebuilt database, and deliberately inverts
the convention above: four docs, four posts spanning draft/scheduled/published, six comments
across every status (one thread quote-anchored), and four annotations — one left
document-level on purpose so `/annotations` has a row exercising that state.

Its addresses are `@sample.invalid` (RFC 2606, guaranteed unroutable) rather than
`@example.com`, and its titles carry no `E2E ` prefix, precisely so the e2e teardown
*doesn't* sweep it back out.

- **Re-running is idempotent rather than additive**: it clears its own content first, and
  `--reset` does only that clearing step. Both paths empty the content tables wholesale, so
  both refuse unless the doc count is 0 (fresh database) or exactly `SAMPLE_DOCS.length` (its
  own output). `--force` is the deliberate override, and the check counts soft-deleted docs
  too, since a doc in the trash is still content the clear would destroy.
- **User rows are the exception no flag widens**: only the three `@sample.invalid` addresses
  are ever deleted, so an account someone actually signed up with survives both paths. Sample
  accounts use the same `testpass123` as the throwaway scripts.
- **The collab server has to be running**, or the anchored annotations quietly degrade to
  document-level — `applyAnnotationMark` reaches the doc's live ydoc through it (PLAN.md
  §12i). A doc's title is seeded into its own Yjs fragment as well as the column, because the
  fragment is canonical (§3d) and `server/doc-cache.ts` would otherwise write an empty title
  straight over the column on first flush.

## The e2e suite needs none of this

Its fixtures create and clean up their own rows (`e2e/db-worker.ts`, same `@example.com`
guard, plus the `ydoc:test-` prefix guard for `e2e/ydoc-debug.spec.ts`), and a teardown
project sweeps whatever a crashed run left behind. See [../e2e/README.md](../e2e/README.md).

## One-shot data imports

Two, both carrying their rationale in a long file header rather than here — read the header
before touching either, and prefer copying their shape to inventing a third one:

- **`scripts/import-legacy.ts`** — a pre-§15 MultiBlog database into the present schema.
- **`scripts/etherpad/import-etherpad.ts`** — an Etherpad Lite `dirty.db`, preserving full
  per-revision edit history: each pad becomes a Doc plus one `ydoc_update` row per Etherpad
  revision, timestamped and attributed. `--verify` replays the whole file and checks it
  against the atext Etherpad itself stored at every 100th revision and at head, without
  touching the database; `--list-authors` prints the `--authors` mapping skeleton;
  `--dry-run` does the real import and rolls it back. **Run all three, in that order, before
  a live run.** Full rationale: `scripts/etherpad/README.md`.

### Conventions both share

- An existing user is matched by email and never duplicated.
- Slugs are claimed through the transaction (`claimSlug`) — `uniqueDocSlug`/`uniqueUserSlug`
  query the global client and can't see rows the same import just created.
- The `ydoc` blob is always recomputed as `Y.mergeUpdates` over the rows being written, never
  copied from a source.
- `@updatedAt` columns need raw SQL to backdate.

### Afterwards

`scripts/integrity/` is the acceptance test — run all of its checks, **ydoc first**: a
bad blob makes the doc- and annotation-side checks report faults that evaporate once it's
repaired. See [../scripts/integrity/README.md](../scripts/integrity/README.md) for which link
of the `ydoc_update → ydoc.ydoc → doc.*` chain each one covers, and why
`check-annotation-anchors` is the odd one out: it verifies a *claim written down once* ("at
update N, characters [a, b) read exactly this") rather than a derived value, which is why
nothing recomputes it and why a break there is silent.
