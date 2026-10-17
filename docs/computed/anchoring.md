# Linking & anchoring in the DB schema

Computed 2026-09-22 against `56b785e` (branch `multiwiki`), from
[schema.prisma](../../prisma/schema.prisma), the CHECK constraints in the migrations, and the
four places that write these rows. A snapshot, not a maintained doc: re-derive it rather than
trusting it after the anchor tables change.

**One exception, added 2026-09-25:** the `embedding_member` row and the `wiki_page` target are
*planned*, not computed. They come from [../EMBEDDING.md](../EMBEDDING.md) and
[../WIKI.md](../WIKI.md), are marked ◇, and should be re-derived from the schema once built.

## Prompt

> Excluding doc_link and doc_link_group, summarize all the linking & anchoring abilities in the
> present DB schema, including:
>
> * Can the whole item be referenced?
>   * at a specific version?
> * Can some part of the item be referenced?
>   * at a specific version?
> * Can multiple parts be referenced in a grouped way?
>   * at a specific version?
> * Can multiple items be referenced in a grouped way?
>   * some of them in whole, some by part?
>   * at specific versions?
>
> Develop as tight a table as you can to show the above.

## Response

The schema supports more than the code writes today, so the table marks the two separately.

**Legend:** ● written today · ○ the schema allows it but nothing writes it · ◇ planned (docs/EMBEDDING.md), not built · — the schema can't express it · **@v** = pinned to a version

| Mechanism | Targets (○ = never written) | Whole | @v | Part | @v | Parts grouped | @v | Items grouped | Mix whole + part | @v |
|---|---|---|---|---|---|---|---|---|---|---|
| post → doc | doc | ● | ● | — | — | — | — | — | — | — |
| comment_thread | post | ●¹ | ● | ● | ● | — | — | — | — | — |
| comment reply | comment | ● | —² | — | — | — | — | — | — | — |
| annotation (root) | doc, PDF | ●³ | ● | ●⁴ | ● | —⁵ | — | — | — | — |
| annotation reply | annotation | ● | —⁶ | ● | ● | — | — | — | — | — |
| tag_assignment → tag_anchor | doc, post, PDF · annotation○ comment○ | ● | ○⁷ | ○ | ○ | ○ | ○ | ○ | ○ | ○⁷ |
| anchored_link → anchored_link_anchor | doc, PDF · post○ annotation○ comment○ | ○⁸ | ○ | ● | ● | ● | ● | ● | ○ | ●⁷ |
| comment → comment_quote_anchor | post, comment · doc○ PDF○ annotation○ | ○⁹ | ○ | ● | ● | ● | ● | ● | ○ | ● |
| embedding → embedding_member ◇ | doc, PDF, wiki page · post○ annotation○ comment○ | ◇ | ◇¹⁰ | ◇ | ◇ | ◇¹¹ | ◇ | ◇ | ◇ | ◇¹⁰ |

**What pins a version, per target:**

| Target | A version is | Pinned by |
|---|---|---|
| doc | a `ydoc_update` (or a deliberate `ydoc_snapshot`) | `ydoc_update_id`; a post publication uses `ydoc_snapshot_id` |
| annotation body | an update on its own ydoc; each settled version is a `ydoc_snapshot` | `ydoc_update_id` on the body's own log |
| post | a `post_publication_event` | `anchored_event_id` |
| comment | a `comment_revision` | `quoted_revision_id`, which exists **only** on `comment_quote_anchor` |
| PDF | nothing needed: `sha256` is the file's identity | nothing; `textVersion` in the selector pins the text extractor |
| wiki page ◇ | a `ydoc_update`, as for a doc | `ydoc_update_id`, on `embedding_member` only |

**Notes:**
1. "Whole post" is the one general thread per post. It is stored as the sentinel 0/0/"" rather than as nulls, and its required `anchored_event_id` still pins a version.
2. A reply doesn't pin the revision it answered. The only way to pin one is to quote it, which is the last row.
3. A null anchor means the annotation is on the whole document. Its `ydoc_update_id` still records the doc version the annotator saw, and a PDF needs no stamp.
4. There are two mechanisms. The reading views write offsets, `quoted_text` and a stamp. The editor writes a mark into the doc's ydoc that moves with the text, and the stamp only records where the author was looking.
5. `annotation_anchor` (§20e, "PR 2") appears in schema comments but doesn't exist yet.
6. An anchorless reply stamps the doc's log, not the parent's. An anchored reply stamps the parent's newest snapshot, which is why its part is pinned.
7. `tag_anchor` and `anchored_link_anchor` have no `quoted_revision_id`, so a comment target on either could never be pinned to a version.
8. The CHECK allows a whole-object row, but the writer never makes one ("an ordinary href already is" a whole-object link).
9. Allowed but never written ("a quotation of a whole object is not a quotation"). Doc, PDF and annotation targets are blocked by `canQuoteTargetInto` because none of them has a public tier.
10. Doc members and included wiki pages are required to be pinned, by a CHECK. A wiki page the embedding *owns* is deliberately unpinned, because it is held live. A PDF needs no pin.
11. Each member is one anchor, so an embedding groups parts only across its members: several passages, from one item or many, each one a member of its own. No member groups parts itself; that is the trigger for splitting the table in two (docs/EMBEDDING.md).

**What it adds up to:**
- **Only three mechanisms group anything:** tag assignments, anchored links, and comments through their quotes. Anchored links and comment quotes already group n parts across n items, with a version per part. Tags have the same row shape, but every assignment today is one anchor on a whole object.
- **No mechanism writes a group that mixes whole items and parts.** All three tables allow it, because the "selector all-null" CHECK applies per row.
- **Pinning a whole item to a version only happens as a side effect:** a post publishing its doc, the general comment thread, and a whole-document annotation. You can't set out to make one; tags and links could store one but don't.
- **The planned `embedding_member` would be the first deliberate writer of both gaps above:** whole items pinned to a version, and one group mixing whole items with parts. It would also be the only anchor table with a `wiki_page` leg, and the first anchor-shaped row that is a record rather than a part.
- **The "one anchor row shape" isn't quite one.** `quoted_revision_id` exists only on `comment_quote_anchor`, so letting a tag or link target a comment would take a migration.

**Some schema comments are now out of date.** The `SelectorKind` comment says only whole-object rows are written and that `POST_RANGE` is missing on purpose. `CommentQuoteAnchor`'s comment says it has "no writer". In fact, comment quotes do write post ranges, stored as `DOC_RANGE` + `anchored_event_id`.

**Not counted:** slug history (it redirects old URLs, with no version), `?at=` URLs (the version lives in the URL, not in a row), and the `proseJsonUpdateId` cache stamps.
