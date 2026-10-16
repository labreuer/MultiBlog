# Tags

**Status: built for whole objects.** Docs, posts and PDFs carry tags, with chips on their pages,
a browse page per term, an admin table of terms, and a Tags column in `/docs` and `/files`.
Passage-level tags are not built: `tag_anchor`'s part columns exist, constrained, with no
writer. That is PR 2 of the plan, which stays in [PLAN.md](../PLAN.md) §20e–§20f along with the
anchor row shape every consumer shares (§20a–§20b). Who may do what is tabled in
[PERMISSIONS.md](PERMISSIONS.md)'s Tags section; this file is the mechanism.

## What a tag is

Three things with three different owners, and keeping them apart is most of the design:

- **A term** (`tag`) is vocabulary and belongs to the site: a name, a description, a slug for
  its page at `/tag/<slug>`. A term carries no visibility of its own. Knowing that
  "Epistemology" exists reveals nothing about what has been tagged with it.
- **An assignment** (`tag_assignment`) is one person's act of tagging and belongs to them: who
  applied which term, and when. It is the `doc_link_group` analogue, owning one or more anchor
  rows, so an act spanning three passages would be one record, undone as one. Today every
  assignment owns exactly one anchor.
- **An anchor** (`tag_anchor`) names what was tagged. It is the canonical instance of the
  anchor row shape that `comment_quote_anchor` and `anchored_link_anchor` share (PLAN.md
  §20a–§20b, CLAUDE.md's "One anchor row shape"): an exclusive arc of object FKs plus a part
  selector. **All part columns null means the whole object**, which is every row written today.

## Schema

`tag`, `tag_assignment`, `tag_anchor` and `tag_slug_history`, from migrations `add_tags` and
`add_mcp_api`. The schema comments on each model are the detailed account. What they establish:

- **A term's name is unique case-insensitively**, through the hand-written
  `tag_name_lower_key` on `lower(name)`. Slug uniqueness alone would admit "Epistemology" and
  "epistemology" as two terms. The *name* is what identifies a term, not the slug.
- **Slugs are their own namespace** (`/tag/*`), and a re-slugged term keeps its old slug in
  `tag_slug_history`, which `/tag/[slug]` follows with a permanent redirect, as the doc and file
  routes follow theirs.
- **The arc has five legs**, `doc_id`, `post_id`, `file_id`, `target_annotation_id` and
  `target_comment_id`, exactly one non-null (`tag_anchor_one_target_check`). They are real FKs
  with cascades, so deleting an object takes its anchors with it. A new targetable kind is
  therefore a migration, the cost PLAN.md §20a accepted. Only the first three have chip UI; the
  annotation and comment legs are live in the gate and the write layer, and reachable through
  the MCP server.
- **The part columns stay null together** (`tag_anchor_selector_columns_check`):
  `(selector_kind IS NULL) = (anchor_from IS NULL AND anchor_to IS NULL AND selector IS NULL)`.
  That is a group-wide equality, not a per-kind rule, so a `DOC_RANGE` row with offsets and no
  `selector` blob is legal. That is deliberate: it is the shape PR 2's annotation backfill writes.
- **Soft deletes live on terms and assignments, never on anchors.** Removing a tag
  soft-deletes its assignment; an anchor is part of a record, not a record. Deleting a term is
  also soft, and keeps its assignments, so a restore brings back exactly who had applied it to
  what.
- **`tag` joins the `$extends` soft-delete filter and `tag_assignment` deliberately does
  not.** The filter intercepts top-level operations only, and assignments are read almost
  entirely through `tag_anchor` includes, which it cannot reach. A model that joined the filter
  and was then read nested would look protected and not be. So every read of an assignment says
  `deletedAt: null` itself, and so does every nested read of a term.

## Writing

**The rules live in [src/lib/tag-write.ts](../src/lib/tag-write.ts)**, as functions taking an
`Actor`: the server actions in [src/app/actions/tags.ts](../src/app/actions/tags.ts) wrap them
with the session, and the MCP server's `tag` and `untag` tools with a token's user
([MCP.md](MCP.md) §11). A rule added to only one front door binds only that one (CLAUDE.md, "A
write the UI and the MCP server share").

- **`mintTag`** returns the existing term when the name matches case-insensitively, rather than
  erroring: from the tagger's side, "add Epistemology" means the same thing whether or not
  someone typed it first. A soft-deleted term still holds its name, so minting it again is
  refused with a message saying an admin or editor can restore it, rather than silently
  resurrecting something deliberately binned.
- **`applyTags`** is the one writer of whole-object anchors. It checks the gate, skips terms this
  person has already applied to this object (an app-level find-first; the database doesn't
  enforce it), and writes every assignment and anchor in one transaction. That is what makes the
  post editor's "Add all" all-or-nothing. A lost race leaves a duplicate assignment, which
  shows as one chip with its tagger counted twice.
- **`removeTagAssignment`** soft-deletes one assignment: one's own, or anyone's as ADMIN or
  EDITOR.
- **Curating terms** (rename, describe, re-slug, delete, restore, and their bulk forms on
  `/tags`) is in the actions alone, gated by `canCurateTags`.
- **Revalidation** goes to the tagged object's own page, worked out by `pathForTarget`, plus
  `/tags` for its usage counts. A draft post has no public page to revalidate. CACHING.md's
  "Tags" section has the reasons.

## Who may tag

**You may tag what you may read, plus a role floor.**
[src/lib/tag-authz.ts](../src/lib/tag-authz.ts)'s `canUserTagTarget` is `canApplyTags`
(AUTHORIZED and up) ANDed with each kind's own existing read gate, reused rather than restated:
`canUserReadDoc`, `canUserReadFile`, `readablePostWhere`, an annotation's container (a DRAFT
being its author's alone), and `canUserReadComment`. A soft-deleted object reads as absent, so
nothing in the trash can be tagged.

- **Minting a term is the same permission as applying one**, so AUTHORIZED users grow the
  vocabulary. Restricting minting to AUTHOR and up is a one-line change if the vocabulary ever
  drifts rather than grows.
- **The role floor holds on posts too.** Commenting on a published post is open to COMMENTER
  and to signed-out readers, but a tag is curatorial where a comment is conversational: it
  changes what a term denotes and what `/tag/[slug]` lists, for everyone.
- **A draft or scheduled post is taggable by whoever may edit it**, since tagging is most useful
  while a piece is being written. `readablePostWhere` is what lets it, and `/tag/[slug]`
  wears the same predicate, so the gate and the browse page can't disagree about who may see a
  draft.

## Reading

[src/lib/tag-data.ts](../src/lib/tag-data.ts) **does no permission work, on purpose.** Every
caller has already passed its page's own gate, so a PRIVATE doc's chips are as private as the
doc by construction rather than by a second check that could disagree with the first.

- **`tagsForTarget`** is one indexed `tag_anchor` query by the target's arc column, through live
  assignments to live terms, collapsed per term in JS. Each chip carries `taggerCount` and this
  viewer's own `ownAssignmentId`, which is what makes a chip removable without a second round
  trip.
- **`listTagOptions`** is the whole vocabulary, unfiltered: the tagger's picker offers every live
  term to anyone who may tag anything.
- **`tagsNotYetOn`** returns the terms on one object that aren't yet on another, as bare
  `TagOption`s, since a count or an assignment id describing the *source* would mean nothing
  beside a control that writes to the *target*.
- **`parseTagList`** reads the jsonb the admin tables' tag views build (below), checked rather
  than cast.

## Chips

- **`TagChips`** is the server component an object page renders. It takes a resolved
  `AnchorTarget` rather than a slug, so it can't be mounted on a surface that hasn't gated first,
  and it **reads no session**. The public post page is statically generated, and a dynamic API
  there throws at build, so everything viewer-shaped lives in the client island below.
- **`TagStrip`** is that island: the chips plus, for whoever may tag, the tagger. Its role check
  is an affordance, not a gate; every action asks again on the server. It has two variants,
  and the question they answer is whether the strip must name itself. A **section** carries a
  "Tags" label, for a container that says nothing about what the row is. A **bare** one
  carries none, for one that already says so: a byline, a labelled fieldset.
- **`TagChipList`** is the chips alone, each a link to `/tag/<slug>` with "Applied by *n*
  people" on hover when more than one person reached for it. `TagStrip` and the admin tables'
  cells both render it, so a chip looks the same everywhere.
- **`TagTagger`** is the popover. It fetches `loadTaggerState` (whether you may tag, the
  vocabulary, and what is applied) only when opened, so pages pay nothing for a control most
  readers never touch.

**Where chips appear:**

| Surface | Form | Gate it sits behind |
|---|---|---|
| `/doc/[slug]` | A second line of the byline, bare: what a doc is about is the same kind of fact as who wrote it | The page's `canUserReadDoc` |
| A post page | A section | `publishedPostWhere` |
| `/pdf/[slug]` | The Metadata tab of the side panel, since a strip would take height from the PDF permanently | The page's `canUserReadFile` |
| `/doc/[slug]/edit` | A Tags field in the Settings panel: `TagStrip` itself, bare under a `<legend>` | `canUserTagTarget`, through `loadTaggerState` |
| `/post/[id]/edit` | A section above the doc's read-only render, plus the doc's offer (below) | Ownership or `canEditAnyPost` |

The editor's Settings panel is the one surface that fetches its chips when it opens rather than
having them server-rendered, so neither the actions' `revalidatePath` nor `router.refresh()`
reaches it. `TagTagger`'s `onChange`, passed through `TagStrip`, is what refreshes it.

### Carrying a doc's tags onto its post

`/post/[id]/edit` offers the source doc's terms that aren't yet on the post, as dashed
one-click chips, with "Add all *n*" when there is more than one (`DocTagOffer`). Its
behaviour:

- **It is an offer, not a copy, and the doc keeps its tags.** A doc's tags are a working
  filing system and a post's are public taxonomy, and they differ often enough for a silent
  copy to be wrong. That is why this deliberately doesn't behave like the byline, which
  `createPostFromDoc` does seed. Applying one is a fresh act of tagging by this viewer, through
  `tagObjectMany`: one gate, one transaction, one revalidation. Since the offer is worked out
  each time the editor opens, terms added to the doc later are offered too.
- **A term that vanished between render and click** makes a single chip's `tagObject` throw,
  since that click was a question about that term, while "Add all" (`tagObjectMany`) skips it,
  since that was a question about whatever is still available.
- **It is the one place a page shows another object's tags, so it needs the other object's
  gate.** A post author need not be an author of the doc the post came from, and inheriting the
  editor's own gate would disclose a PRIVATE doc's terms to whoever holds the post's byline. The
  page runs `canUserReadDoc` as well and renders an empty offer when it fails: the conjunction
  of the two objects' read rules. *Applying* a term needs no doc-read, since a term carries no
  visibility.
- **It reads `post.docId`, not the publisher's selected doc.** "Change doc…" moves only what the
  scrub bar previews, so the label says `Doc "<title>"` rather than echoing the publisher's
  "From doc …" status line, and the row's test handle is `data-doc-tag-offer`.
- **It empties itself**, subtracting every term already on the post by anyone.

`tagsForTarget(post)` therefore runs twice on this page, once inside `TagChips` and once inside
`tagsNotYetOn`. That is accepted rather than hoisted: hoisting means feeding `TagStrip` directly
and giving up `TagChips`' own read from a resolved target, which is what keeps it from being
mounted on an ungated surface. One more indexed query on a gated editor page is the cheaper
side of that trade.

## `/tag/[slug]`

**The browse page is three per-type queries, never one UNION**
([src/lib/tag-browse.ts](../src/lib/tag-browse.ts)). Each section wears the predicate that
already governs its type: `readableDocsWhere`, `readablePostWhere` and `readableFilesWhere`.
An interleaved timeline would re-implement three permission models in one query, the easiest
leak to write and the hardest to see.

- **Each section is capped at 50** (`PAGE_CAP`), with a "showing the first 50" line, rather than
  paginated: three `?page=` params on one page make a URL nobody can read, for sections that
  hold a handful of rows each.
- **Its counts come from those filtered queries, never from `tag_metrics`**, which counts
  everything live and has no viewer.
- **An unpublished post is listed only to whoever may edit it**, linking into `/post/[id]/edit`
  with a `draft` or `scheduled` marker, since neither has a public URL that answers.
- **It renders `force-dynamic`**, because it is shaped per viewer.
- **Annotations and comments get no section.** Neither has a page of its own to link to.

## `/tags`

The vocabulary's admin table, through the table kit (`tags-query.ts`). Every usage column sorts
through **`tag_metrics`**, a view keyed 1:1 on `tag_id`: assignments, docs, posts, files,
annotations, and last used. It is built by grouping assignments and anchors, **never `FROM
tag`**, which would scan the base table twice on every sort through it. Every aggregate in it is
cheap, so it stays a view rather than a trigger-maintained column until sorting by usage
measures badly at real scale (PLAN.md §16l's rule).

- **Its counts are declared nullable.** A term nobody has used has no view row, and Postgres puts
  NULLs first in a descending sort. Declared nullable, the page can sort `nulls: "last"`, so
  "most used" doesn't lead with terms nobody has applied.
- **It sets the same bar as every other admin table** (`canManageDocs`, AUTHOR and up), not
  `canApplyTags`. An AUTHORIZED user reaches the vocabulary through the tagger and
  `/tag/[slug]` instead.
- **A deleted term keeps its usage numbers**, which `/tags` shows only under "show deleted".

## The Tags column in `/docs` and `/files`

Both tables have a **Tags** column, hidden by default so nobody's table widens by a column of
chips unasked. It draws the object's terms as `TagChipList` and sorts in Postgres like every
other column.

- **It reads two views of its own, `doc_tag_summary` and `file_tag_summary`** (migration
  `add_tag_summary_views`). Each is a plain `GROUP BY` over `tag_anchor`, through live
  assignments to live terms, and yields `names` (the names joined in order, the sort key) and
  `terms` (`[{slug, name, taggerCount}]` in the same order, what the cell draws). Both come out
  of one subquery, so what is shown is what is sorted. Terms are ordered by name, then slug;
  `names` is never split back apart, so a comma inside a name costs nothing.
- **They are deliberately not columns of `doc_metrics`/`file_metrics`.** Those views are a
  `FULL OUTER JOIN` of aggregates keyed on a `COALESCE`, which Postgres can neither prune nor
  push the page's `doc_id IN (…)` into, so every read of them builds the whole view, whichever
  columns it asks for. A plain `GROUP BY` takes the page's ids down into `tag_anchor`, so
  drawing a page of chips is an indexed lookup for that page's rows.
- **A page not showing Tags reads no tag view at all.** Each page resolves its visible columns
  the way the table will (`?cols=` or the stored preference, else `codeDefaultColumns`) and
  selects the relation only when Tags is among them. Sorting by Tags builds the whole view, as
  any sort through a view does.
- **A soft-deleted doc keeps its chips under "Show deleted"**, as it keeps its byline. The views
  read neither `doc` nor `file`, so an object's own `deleted_at` isn't consulted.

**Under the ADMIN "Show all docs/files" override, tags are withheld.** Every row either table
lists by default is one its viewer may read. The override is not: it lists PRIVATE objects the
admin has no byline or ownership on, and which terms are on such an object is the object's to
disclose.

- **The page sends `tags: null` for those rows**, keeping the terms out of the RSC payload rather
  than merely out of the cell. The read test is `canUserReadDoc`/`canUserReadFile` inlined per
  row (SHARED, or the viewer's own), the way `canEdit` beside it inlines the edit rule.
- **The cell draws a muted dash that says why on hover**, since a blank would claim "untagged".
- **Tags doesn't sort while the override is on.** The page drops the key from the sort
  (`withoutSortKey`), and the table takes the header's arrows off to match, since an order by
  tags would hint at what the cells withhold.
- **The override's other columns are unchanged.** Title, byline, length and annotation count
  were already what it discloses.

This is the one surface whose chips don't come through `TagChips`, so the row-level read test,
rather than a page's gate, is what keeps them as private as the thing they are on.

## Elsewhere

- **The MCP server** tags and untags through the same write layer, reads an object's tags after
  its read gate, finds terms by name (`find_tags`), and filters search by term. Where it differs
  from the UI it is stricter: tagging a published or scheduled post needs `manage`, since the
  chip lands on a public page at once, and `tag` checks an annotation's container for deletion
  ([MCP.md](MCP.md) §11).
- **Search's `tags` filter** (`taggedWhere` in `src/lib/search/context.ts`) narrows each kind's
  ids to those carrying any of the named terms, inside the ids its read rule already chose.

## Verification

- **`e2e/tags.spec.ts`** covers tag → chip → browse → untag, minting and applying as one
  gesture, a signed-out reader seeing a post's chips, a PRIVATE doc's chips staying private,
  unpublished posts, the doc-to-post offer and its gate, `/tags` sorting through its view,
  the Tags column and its withholding, the part columns staying unwritten, and the Settings
  panel's fetch on open.
- **`scripts/integrity/check-tag-constraints.ts`** proves the hand-written DDL refuses what it
  claims to: both CHECKs and the case-insensitive name index, by attempting each violation in a
  rolled-back transaction. Nothing else can see the schema: every violation is a well-typed
  Prisma call, and the UI never attempts one.
- **`scripts/integrity/check-annotation-anchors.ts`** walks `tag_anchor` with the same replay
  invariant as annotations. It is trivially green while every row is whole-object, and becomes
  the parity gate when PR 2 writes parts.
- **`scripts/test-tag.ts`** creates, applies, lists and deletes throwaway tags
  ([TEST_DATA.md](TEST_DATA.md)), and refuses to delete a term a real account has used.

## Not built

- **Passage-level tags.** The part columns have no writer. Settling PLAN.md §20f's semantics
  comes first, after [research/multi-anchoring.md](research/multi-anchoring.md). Part-tags are
  planned to use the column mechanism on every surface, the doc editor included, a recorded
  deviation from annotations' "mechanism follows the surface" (PLAN.md §20f).
- **Merging two terms.** Renaming is an update; merging means re-pointing assignments and
  deduplicating collisions per object. It waits for the first real duplicate pair.
- **Database-enforced dedup.** It needs `tag_id` denormalised onto the anchor for a partial
  unique index, and waits until concurrent tagging of one object by one person happens.
- **Chips on annotations and comments.** The gate and the write layer answer for both; no
  surface draws them.
- **In the admin tables:** a Tags filter (under the override it would have to apply only to
  readable rows, or it discloses the same thing through which rows match), the column on
  `/posts`, and a bulk "tag these" action.
- **Around the doc-to-post offer:** tagging the doc from the post (a doc can source several
  posts, so that is a picker, not a row), move semantics, and offers between other pairs (file →
  post, annotation → doc).
