# Residual

Context from the 2026-09-22 to 2026-09-25 session on embeddings that isn't written down
anywhere else. Delete each item once it has a proper home, and the file once it's empty.

## State

- **Parked, 2026-10-17.** The user decided to do something much simpler for now: wiki pages
  that are docs, addressed by author (`/wiki/[author]/[name]`), which stay out of the RSS
  feed, can be made public, and can be forked and diffed. This branch keeps the fuller,
  embedding-based design, committed as it stood on 2026-09-25. Nothing on it is built.
- **`docs/computed/anchoring.md` is staged but deliberately not committed**, at the user's
  request. It now carries the planned embedding row, marked ◇.

## Where the thinking lives

- **Research:** [docs/research/multiwiki/](docs/research/multiwiki/README.md), two studies.
  `forkable-embeddings/discussion.md` holds the MacIntyre answer and the naming discussion.
- **Plan:** [docs/EMBEDDING.md](docs/EMBEDDING.md), which ends with the comparison with
  tags, and [docs/WIKI.md](docs/WIKI.md). Open questions are at the end of each.
- **How the plan got to its current shape, in order:**
  1. Relations between members were dropped.
  2. `embedding_affirmation` was dropped: re-pinning now updates in place, recording
     `affirmed_by_id` and `affirmed_at`.
  3. `embedding_entry` was folded into `embedding_member`.
  4. "Steward" became "owner".
  5. Wikis were added, owned through `is_owner`, and forked on write by embeddings that don't
     own them.
  6. Names moved onto `embedding_member.slug`, so every embedding is a namespace, and the URLs
     were simplified:
     - `/wiki/[name]` is always the commons, an ordinary embedding with a reserved slug;
     - `/embedding/[e]/wiki/[name]` is every other embedding's page;
     - `/wiki/[name]/all` lists the versions.

     Links bind late, in their own page's embedding. Context comes from the Referer, as a
     hint only, and never from a query string (WIKI.md, "URLs"). A "last embedding you were
     in" tracker and a `last_worked_at` column for choosing the fork target were both
     discussed and dropped: the fork target comes from the new-page rules instead.

  7. The `wiki` table became `wiki_page`, because a row is one page. The URLs and the ydoc
     namespace keep `wiki` (WIKI.md, "Data model").

  EMBEDDING.md's "Deferred" names the ways back for relations, pin history and the
  entry/anchor split.

## Not yet written where it belongs

- **CLAUDE.md has no rows yet** for `docs/EMBEDDING.md` and `docs/WIKI.md`. Add them once
  they're committed.
- **CLAUDE.md's "two sub-namespaces" line** must change when wikis add `ydoc:wiki:`
  (WIKI.md, "The ydoc and the collab server").
- **The WJWR PDF, for checking quotations,** is the University of Notre Dame Press 1988
  edition, in the user's book library under MacIntyre. `pdftotext -layout` gives clean text,
  and the running heads carry the page numbers. The study's card names the edition.

## Loose ends

- **`forkable-embeddings/notes/cross-tradition-understanding.md` still quotes MacIntyre
  secondhand** in places the report has since corrected. The card logs this; the notes are
  unchanged.
- **Two schema comments are out of date:** `SelectorKind`'s and `CommentQuoteAnchor`'s,
  flagged in `docs/computed/anchoring.md`. `schema.prisma` hasn't been fixed.
- **Some quotations in `discussion.md` were checked only through secondary sources:** the
  Giddens wording on disembedding and re-embedding, and the page number (p. 4) for the Kuhn
  quote from *Structure*.
- **The first implementation decision** (WIKI.md, "Routes") is whether the doc surfaces take
  the kind of entity as a parameter, or wiki pages get thin wrappers around them.
