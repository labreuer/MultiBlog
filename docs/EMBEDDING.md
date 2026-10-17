# Embeddings — owned, forkable sets of pinned members

**Status: planned, first cut; nothing is built.** This is the plan for exploring the idea, and
it is expected to change once there is something to use. The research behind it is
[research/multiwiki/](research/multiwiki/README.md): what others built (the
`labeled-viewpoints` and `forkable-embeddings` studies), and why several choices below follow
MacIntyre (`forkable-embeddings/discussion.md`). Wiki pages, the one kind of content an
embedding owns, are [WIKI.md](WIKI.md).

## What an embedding is

An **embedding** is a named set of **members**, owned by a few people, that can be forked. A
member is a whole object or one passage of it: a doc, a PDF or a wiki page now, and posts,
annotations and comments later. Each member is pinned to the revision it was added at. An
embedding can also **own** wiki pages, which exist only within it and which its owners write.

It is meant for comparing schools of thought, rival tellings of a history, and rival
theoretical framings, and for following a discipline's changes over time. The first cut
builds the structure those need (membership, pinning, forking, and comparison within a
lineage) and none of the comparison across lineages yet ("Deferred").

**It is the §20 anchor envelope's first consumer that is also a record.** Every other anchor
table is a part under an owner row, such as `tag_assignment` → `tag_anchor`. An embedding
member is one anchor-shaped row that also carries who added it, when, a note, a soft delete
and fork provenance. It goes through `src/lib/anchors/` like every other anchor table
(CLAUDE.md's "one anchor row shape"). What it departs from is `TagAnchor`'s "an anchor is a
part of a record, not a record", and the schema comment should say so. If discontiguous
members turn out to matter, that is the trigger for splitting it into an entry plus anchors.

## Data model

Mock SQL, with foreign keys written inline; the migration is Prisma's plus the hand-written
CHECKs and partial indexes, as for the other anchor tables. `wiki_page` is in WIKI.md.

```sql
-- The container. Soft-deleted, like tag and anchored_link.
CREATE TABLE embedding (
  id                  text PRIMARY KEY,                                  -- cuid
  slug                text NOT NULL UNIQUE,                              -- its own namespace: /embedding/<slug>
  name                text NOT NULL,
  description         text,
  visibility          doc_visibility NOT NULL DEFAULT 'PRIVATE',         -- PRIVATE: owners only; SHARED: canViewDocs
  forked_from_id      text REFERENCES embedding(id) ON DELETE SET NULL,
  forked_at           timestamp(3),                                      -- when the fork's copy was taken
  created_by_id       text NOT NULL REFERENCES "user"(id),
  created_at          timestamp(3) NOT NULL DEFAULT now(),
  deleted_by_user_id  text REFERENCES "user"(id),
  deleted_at          timestamp(3),
  CHECK (forked_from_id IS NULL OR forked_at IS NOT NULL)
);

-- Who may edit the embedding and write its wiki pages. The creator is the first row.
CREATE TABLE embedding_owner (
  embedding_id  text NOT NULL REFERENCES embedding(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  added_at      timestamp(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (embedding_id, user_id)
);

-- One member: a whole object or one passage. Re-pinning UPDATEs the row in place.
CREATE TABLE embedding_member (
  id                     text PRIMARY KEY,
  embedding_id           text NOT NULL REFERENCES embedding(id) ON DELETE CASCADE,
  -- the object arc: exactly one non-null. Deleting a target hard-deletes the member.
  doc_id                 text REFERENCES doc(id) ON DELETE CASCADE,
  wiki_page_id           text REFERENCES wiki_page(id) ON DELETE CASCADE,  -- the only anchor table with this leg
  post_id                text REFERENCES post(id) ON DELETE CASCADE,
  file_id                text REFERENCES file(id) ON DELETE CASCADE,
  target_annotation_id   text REFERENCES annotation(id) ON DELETE CASCADE,
  target_comment_id      text REFERENCES comment(id) ON DELETE CASCADE,
  -- the part selector: all null means the whole object
  selector_kind          selector_kind,
  anchor_from            integer,
  anchor_to              integer,
  quoted_text            text NOT NULL DEFAULT '',          -- derived server-side from the stamped state
  selector               jsonb,
  -- the version pins, one per kind of target
  ydoc_update_id         bigint,                            -- doc, wiki page or annotation-body log position
  anchored_event_id      text REFERENCES post_publication_event(id) ON DELETE SET NULL,
  quoted_revision_id     text REFERENCES comment_revision(id) ON DELETE CASCADE,   -- unused; completes the shape
  -- ownership: this embedding owns the page, and its owners write it (WIKI.md)
  is_owner               boolean NOT NULL DEFAULT false,
  -- this embedding's name for a page it owns or includes; the page's URL (WIKI.md, "URLs")
  slug                   text,
  -- the record
  note                   text,                                                      -- optional: why it belongs
  forked_from_member_id  text REFERENCES embedding_member(id) ON DELETE SET NULL,   -- identity across forks
  created_by_id          text NOT NULL REFERENCES "user"(id),
  created_at             timestamp(3) NOT NULL DEFAULT now(),
  affirmed_by_id         text NOT NULL REFERENCES "user"(id),        -- the adder, until someone re-pins
  affirmed_at            timestamp(3) NOT NULL DEFAULT now(),        -- when the current pin was captured
  deleted_by_user_id     text REFERENCES "user"(id),
  deleted_at             timestamp(3),
  CHECK (num_nonnulls(doc_id, wiki_page_id, post_id, file_id, target_annotation_id, target_comment_id) = 1),
  CHECK ((selector_kind IS NULL) = (anchor_from IS NULL AND anchor_to IS NULL AND selector IS NULL)),
  CHECK (doc_id IS NULL OR ydoc_update_id IS NOT NULL),                       -- a doc member is pinned
  CHECK (wiki_page_id IS NULL OR is_owner OR ydoc_update_id IS NOT NULL),     -- an included page is pinned
  CHECK (NOT is_owner OR (wiki_page_id IS NOT NULL AND selector_kind IS NULL AND ydoc_update_id IS NULL)),
                                                                              -- an owned page is whole and live
  CHECK (slug IS NULL OR (wiki_page_id IS NOT NULL AND selector_kind IS NULL)),  -- only whole pages are named, for now
  CHECK (NOT is_owner OR slug IS NOT NULL)                                    -- an owned page always has a name
);

CREATE INDEX ON embedding_owner (user_id);
CREATE INDEX ON embedding_member (embedding_id) WHERE deleted_at IS NULL;
CREATE INDEX ON embedding_member (doc_id);                          -- plus one per arc column, as on tag_anchor
CREATE UNIQUE INDEX ON embedding_member (wiki_page_id) WHERE is_owner AND deleted_at IS NULL;   -- one owner per page
CREATE UNIQUE INDEX ON embedding_member (embedding_id, slug) WHERE slug IS NOT NULL AND deleted_at IS NULL;
                                                                    -- names are unique within an embedding
-- no whole object twice in one embedding
CREATE UNIQUE INDEX ON embedding_member (embedding_id, doc_id)       WHERE selector_kind IS NULL AND doc_id       IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX ON embedding_member (embedding_id, wiki_page_id) WHERE selector_kind IS NULL AND wiki_page_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX ON embedding_member (embedding_id, file_id)      WHERE selector_kind IS NULL AND file_id      IS NOT NULL AND deleted_at IS NULL;
```

## Members and their pins

| Member | Pinned by | Stale when |
|---|---|---|
| a whole doc, or a whole wiki page someone else owns | `ydoc_update_id` | the target's `ydoc.last_update_id` > the stamp |
| a passage of a doc or wiki page | offsets, `quoted_text`, stamp | the target changed since the stamp |
| a PDF, whole or passage | nothing: `sha256` is its identity | never |
| a wiki page this embedding owns | nothing: it is held live | never |

**An embedding holds other people's things as they were, and its own pages as they are.**
Pinning records what the owners actually looked at. A page the embedding owns is its own
living text, so pinning it would only record the embedding disagreeing with itself.

**Adding a passage works like "Add to link".** It is posted and captured on the server at
once, with the stamp resolved by `resolveCaptureStamp` and the text by `captureAnchorInYdoc`
or `capturePdfTextAnchor`. What lands in `quoted_text` is the server's own reading of the
stamped state (docs/ANCHORED_LINKS.md). A failed capture stores nothing.

**Re-pinning updates the member in place, and only an owner may do it.** The embedding page
flags a stale member as "changed since pinned", with links to `?at=<stamp>` and to the
current text. For a passage, `resolveAnchorInDoc` finds it in the current state, the owner
confirms or reselects, and the row is re-captured at the new stamp. `affirmed_by_id` and
`affirmed_at` record the latest re-pin only; earlier pins are overwritten ("Deferred"). A
passage that no longer resolves can be reselected or removed. Nothing re-pins automatically.

## Forking an embedding

**A fork copies members, never content.** One transaction creates the new embedding, with
`forked_from_id`, `forked_at`, the forker as its only owner, and `PRIVATE` visibility. It then
copies every member whose target the forker can read, each with `forked_from_member_id`.
Members the forker can't read are skipped silently.

**The parent's own pages become pinned, unowned members of the fork**, with `is_owner =
false`, `ydoc_update_id` set to each page's newest update at fork time, and the same names.
The fork owns none of them yet. When one of its owners writes one, that page alone forks
(WIKI.md, "Fork on write"). So forking a whole embedding is cheap, and content diverges page by
page, only where someone actually writes.

**Comparison in the first cut stays within one lineage**: a fork against its parent, or
siblings against each other. Members are matched through `forked_from_member_id`, and the page
reports three things:

- members added or removed since the fork;
- members pinned at different revisions;
- pages the fork now owns and the parent's originals, linked through
  `wiki_page.forked_from_page_id`.

This is the tractable case. Within one lineage there are shared standards (*Whose Justice?
Which Rationality?*, p. 328): does the fork solve its parent's problems, or resolve its
incoherences? Across lineages
there are none, and comparison needs the machinery that is deferred.

## Permissions

| | Who |
|---|---|
| Create an embedding | signed in with `canViewDocs`, the floor tags use for creating a term |
| Read a `PRIVATE` embedding | its owners only, with no ADMIN/EDITOR bypass, like a `PRIVATE` doc |
| Read a `SHARED` embedding | `canViewDocs` |
| Rename, describe, change visibility, add or remove owners | an owner |
| Add a member | an owner who can read the target |
| Re-pin or remove a member | an owner |
| Fork | anyone who can read the embedding |

**Members render per target, as anchored links do:** a member whose target the viewer can't
read is omitted silently, with no count or placeholder (docs/ANCHORED_LINKS.md, "Following a
link"). An embedding grants nothing over the docs, PDFs and other people's wiki pages it
contains. Its own pages are the exception, since their read and write rules *are* the
embedding's (WIKI.md). The commons, the embedding behind `/wiki/[name]`, follows these same rules, with
its own owners and visibility (WIKI.md, "The commons"). docs/PERMISSIONS.md gets an
"Embeddings" section when this is built.

## Surfaces

- **`/embedding/[slug]`** shows the members grouped by target, with excerpts for passages and
  a stale flag with a Re-pin action. It also has the owners, the lineage (forked from, and
  forks), a Fork button, "New page", and a compare link to each relative in the lineage.
- **The reading views** `/doc/[slug]`, `/pdf/[slug]` and a wiki page's routes (WIKI.md, "URLs")
  get "Add to embedding…" beside "Add to link" in the selection popover, and a whole-object
  add in the header.
- **`/embedding/[slug]/compare/[other]`** is the lineage diff above. It refuses two embeddings
  that don't share a lineage.
- **`/embeddings`** is built with the admin-table kit, with an `embedding_metrics` view.

## Checks

- **The CHECKs above**: exactly one target, the selector columns null together, and the
  pinning and ownership rules.
- **`scripts/integrity/`**: replaying each member on a doc or wiki page to its stamp must
  reproduce `quoted_text`, as for the other anchor tables.
- **A unit test for the lineage matcher**, which is a pure function.
- **One e2e spec**: add a whole doc and a passage, edit the doc and see the member go stale,
  re-pin it, fork the embedding, write a wiki page in the fork and see it fork, then compare.

## Deferred

- **Relations between members.** A directed, labelled relation between two members was in an
  earlier draft and is out of the first cut. When it returns, it is a new consumer family
  with roles on each end, not an overload of membership (docs/research/multi-anchoring.md,
  recommendation 2).
- **A history of pins.** Re-pinning overwrites, so "what did this embedding hold at time T"
  can be answered for membership (`created_at`, `deleted_at`) but not for which revision
  each member was pinned at. It comes back as a table of dated pins, backfilled one row per
  member from `affirmed_by_id` and `affirmed_at`.
- **Comparison across lineages**, including renderings of one embedding in another's terms
  and rival histories of a discipline (`forkable-embeddings/discussion.md`).
- **An embedding's own name for a doc or PDF it shares with others**, such as MacIntyre's Doire
  Columcille and Londonderry. Wiki pages already have this: every embedding names the pages it
  owns or includes, and those names are their URLs (WIKI.md, "URLs"). `embedding_member.slug` is
  the column that would extend to other targets.
- **An embedding's list of unsolved problems** (MacIntyre's "problematic"), and allegiance as
  a relation separate from ownership.
- **Posts, annotations and comments as member targets.** The columns are there and nothing
  writes them.
- **Fork notifications, and a visual diff between two versions of a member.** `?at=` links
  stand in for now.
- **Timelines.**
- **Merging embeddings.** Never automatic.

## Open questions

- **Naming.** The research suggested *school* for the container and *embedding* for the act
  of pinning something into it (`forkable-embeddings/discussion.md`). This plan keeps
  "embedding" for the container.
- **Deleting a doc hard-deletes the members that pin it.** Should the member instead stay,
  visibly retired?
- **The initial visibility of a fork.** It is `PRIVATE` here. Should it inherit the parent's?

## Embeddings and tags

Suppose tags gained part-anchors, which §20's PR 2 plans, and version pins. What would still
separate the two?

**What they share.** Both are named sets of anchor-shaped rows over the same targets, going
through `src/lib/anchors/`. Both attribute each addition to the person who made it. Both are
filtered per target: a chip is exactly as private as what it is on, and a member the viewer
can't read is omitted.

**How they differ:**

1. **A tag's name is its identity; an embedding's isn't.** Tags are one site-wide
   vocabulary: `lower(name)` is unique, and "a term belongs to the site"
   (docs/PERMISSIONS.md). Applying "institution" says the thing is about institutions in the
   one shared sense. Two embeddings can both be called "institution" and mean different
   things, which is the research's "names are not synonyms." This is also what makes forking
   coherent: an embedding isn't identified by its name, whereas a forked tag would be two
   terms fighting over one name.
2. **Who answers for the set.** A tag's members are an aggregate of separate acts. Each
   assignment belongs to whoever made it, and nobody owns "everything tagged X." An
   embedding's members are one claim that its owners answer for as a whole.
3. **Ownership and governance.** An embedding has owners. A term is governed by role: anyone
   AUTHORIZED or above creates and applies terms, and EDITORs rename, delete, or remove
   anyone's assignment.
4. **Forking.** An embedding and its members fork, and a tag can't (see 1).
5. **Re-pinning.** Once tags are pinned, re-pinning an assignment is the same operation as
   re-pinning a member. What differs is who may do it, which is policy rather than mechanism.
6. **Visibility of the grouping itself.** A `PRIVATE` embedding hides the fact that it
   groups these things, even from someone who can read every member. A tag can't hide that a
   doc bears it from anyone who can read the doc.
7. **Direction of display.** A tag is read from the object: chips appear on every doc for
   anyone who can read it, and are carried over when a post is made from the doc. An
   embedding is read from its own page. Whether a doc shows which embeddings it is in is a
   separate choice, and with `PRIVATE` embeddings it can't be unconditional.
8. **A note per member.** `embedding_member.note` exists and a tag assignment has no text.
   Trivial to add to tags.
9. **Owning content.** An embedding owns wiki pages and decides who writes them. A tag owns
   nothing it labels.

Items 3 to 8 are governance, and governance could be added to tags, which suggests building
embeddings as a mode of tags. Item 1 is why not: a tag's whole value is the single shared
vocabulary, and an embedding has to refuse exactly that. Item 9 now makes the difference
structural as well.
