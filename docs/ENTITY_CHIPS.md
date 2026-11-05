# Entity chips (planned)

**Status: planned; only step 0 is built.** An *entity chip* is an inline node in a doc's text
that stands for an entity, such as a person or a work, and holds only *which* one. Its label is
computed whenever it is shown, from the doc's style and the entity's current record. A rename, a
corrected record or a change of style therefore changes every label at once, and no anchored
quote moves.

This file plans the kit every chip kind shares. Each chip kind has a file of its own, which fills
in the kind contract (below):

- [MENTIONS.md](MENTIONS.md): a *mention* stands for a person, a MultiBlog account, shown as
  `@Luke Breuer`, `LB` or `@luke-breuer` depending on the doc's style.
- [CITATIONS.md](CITATIONS.md): a *citation* stands for one or more works at a page, shown as
  `(BU p. 49)`, `(Radner 2012, p. 49)` or `[3, p. 49]`. That file also plans the reference library
  that citations draw on.

Step 0, the schema-version gate, is built: [YDOC.md](YDOC.md), "A tab whose schema is out of
date is refused".

## Summary

- **The ydoc holds identity, never a label.** A mention holds a user id. A citation holds works
  with their locators.
- **One node serves every chip kind.** `entityChip` records its chip kind in an attribute, so a
  new chip kind, or a new field on one, changes no schema and needs no version bump.
- **Insertion and deletion are atomic natively.** ProseMirror treats a leaf node as one
  character: the caret steps over it, and one Backspace removes it.
- **One pure function renders every chip** on every surface: the browser (editor, reading views,
  history), the collab server (`prose_json`) and the Next server (MCP, publish, the landing
  preamble). It never depends on who is looking.
- **Quoting.** An anchored quote stores U+FFFC where a chip is, so nothing a label does can
  detach it. Each anchor also records which chip instances it contains, so stored quotes can be
  shown with labels and an anchor can target one chip exactly.
- **Searching.** Labels are materialized into `prose_json` for full-text search. Each chip kind's
  filters work by identity, so they survive renames and restyles.
- **Styling.** Styles are set per doc and per chip. A published post can have its own style.
  Section styles come later, if a real doc needs them.
- **Posts and the landing preamble get labels as linked text** at publish or render, so the
  post-side schema needs no node.
- **MCP** reads each chip in its chip kind's Markdown, finds quotes across chips by identity, and
  edits through a merge that treats each chip as one unit.
- **Doc links are not chips.** `[[` links (`DocRefMenu`) stay linked text with the title frozen,
  as now.
- **Order:**
  - step 0, the gate;
  - step 1, the kit (schema version 1, the only bump the family needs), starting with a
    performance spike;
  - step 2, mentions ([MENTIONS.md](MENTIONS.md));
  - step 3, references and citations ([CITATIONS.md](CITATIONS.md)).

  Nothing exercises the kit without a chip kind, so steps 1 and 2 are built together. Section
  styles, comments, and each chip kind's own later work come after.

## Terms

- **Entity chip.** An inline leaf node standing for an entity. Its **chip kind** (`kind`) says
  what sort: `mention` or `citation`. "Chip kind" is always written out, because "kind" alone is
  full-text search's word for the sorts of object it searches ([FULLTEXT.md](FULLTEXT.md)). The
  tag chips (`TagChips`) are a different thing.
- **Label.** What a chip shows: `@Luke Breuer`, `[3]`.
- **Rendering.** A chip's label, its link, and its status: live, deleted or unknown.
- **Chip context.** The records a doc's renderings are computed from, loaded per chip kind:
  users for mentions; references and their files for citations.
- **Style.** A doc's choice of form for each chip kind, plus per-chip overrides.
- **Instance id.** A chip's `iid`: unique within its doc, kept for the chip's life.

## Why a node

A label that can change after it is written cannot be the document's text:

- a style switch;
- a rename;
- renumbering, since "[3]" becomes "[4]" when a citation is added earlier.

Every stored quote is re-found by exact text (`resolve.ts`, `doc-link-anchor.ts`,
`anchor-remap.ts`), so rewriting a label would detach every quote across it, in every doc that
holds the chip.

| Shape | Why not |
|---|---|
| Linked text with identity on the link, label frozen | Can't restyle or follow a rename without rewriting text. Numbered styles would rewrite text on every insertion. |
| Linked text, its text hidden and a computed label drawn over it | ProseMirror draws its caret inside the hidden text (`domFromPos(pos, -1)`) and maps both sides of the drawn label to one position. A read-only selection that visibly includes the label quotes without it, `Decoration.inline` highlights skip it, a corrected locator rewrites the text and detaches anchors, and the frozen text still reaches readers in snippets and copies. Checked with a real EditorView under jsdom. |
| An inline atom with its label as text inside (`content: "text*"`) | The MCP merge drops it from any edited paragraph: `atomsOf` keeps inline leaves only. A disallowed mark on its label makes current clients delete it. |
| A leaf node that also stores a frozen label (TipTap Mention's shape) | Keeps stale names and styles in storage. Not now. |
| A node type per chip kind (`mentionChip`, `citationChip`) | Each new chip kind, and each new field on one, is a schema change: a version bump that refuses every open tab at its deploy, and a new attribute on posts' links. |

A leaf node holding identity only is what remains. Its two sides are distinct positions, a
selection across it quotes it, and highlights cover it. One such node serves every chip kind.

## The rules

1. **The ydoc holds identity, never a label.** Chip kind, target ids, per-chip fields, instance
   id.
2. **A rendering is a pure function** of the chip, the effective style, the chip context and the
   doc's order. It is the same function in the browser and on the servers, and it never depends
   on the viewer.
3. **A chip's anchor text is U+FFFC, forever.** It is the node's `leafText`, so every DOC_RANGE
   path in `src/lib/anchors/`, which calls `textBetween(…, " ")` with no leaf argument, gets it
   with no flattener changed. `quotedTextAt` passes a leaf argument of its own, so it changes
   (step 1, item 7). Replaying a stamp therefore always reproduces its quote.
4. **Whatever shows or searches text uses the label**, through one display-text rule.
5. **Labels are materialized where static surfaces read them**, and refreshed when an input
   changes without an edit. A refresh never moves `Doc.updatedAt`.
6. **A chip kind adds no schema.** A new chip kind, or a new field on one, changes no node, mark
   or attribute. The gate's fingerprint stays the same, and no tab is refused for it.

## The kind contract

Each chip kind supplies the following, as one entry in the kit's registry
(`src/lib/entity-chips/`). Its own file says how.

1. **Its fields**, kept in the chip's `data`: which are identity and which are overrides, with a
   validator that every way in runs (step 1, item 2).
2. **What its identity points at:** a row (a user, a reference), a key, or a place in the same
   doc. Also when two chips count as the same entity, which the anchors' identity check and the
   MCP merge's alignment use, and when a new chip continues an old one, which the merge's pairing
   uses (MCP, item 5).
3. **Its context:** which records it loads, deleted ones included, and which changes to them call
   for a refresh.
4. **Its forms**, its default, its per-chip overrides, and what it takes from the doc-order pass:
   numbering, or telling apart two entities with the same label.
5. **Its rendering for each status**, its link included, and its placeholder for an unknown
   target.
6. **What a published post gets** in the chip's place: linked text, and where the link goes.
7. **Its Markdown:** a syntax the lowering writes and the parse reads back (MCP, item 2).
8. **Insertion:** the menu's trigger, what the menu lists, and who may insert. The same rule binds
   MCP's lookup, the `unknown_chip` check, and what the chip-context endpoint answers beyond the
   object's own chips.
9. **Its index table and search filters.**
10. **Anything else it adds**, such as a bibliography or notifications.

The contract doesn't assume a database row behind a chip. A chip kind whose identity is a key
has no deleted state and may have a static context, and its index table has no foreign key.

## Step 0: refuse a tab whose schema is out of date

**Built.** An out-of-date tab deletes a node type it doesn't know just by decoding it. So the gate
ships first, at version 0, and must have **soaked** before step 1 bumps it to 1: connections
arriving with no `schema` parameter must have stopped. The design, its prior art and what it
doesn't cover are in [YDOC.md](YDOC.md).

## Step 1: the kit (schema version 1)

1. **Performance spike, first.** The server-side cost is known. On the largest local doc, with
   each of its 638 `/pdf/` links made a chip (563 citations and the reference list's 75 entries,
   over 75 works):
   - a whole-doc label pass takes 0.13–0.15 ms, numbering included;
   - materializing labels into `prose_json` takes 0.06 ms;
   - an MCP Markdown read takes 4.6 ms, against 3.7 ms without chips;
   - for scale, today's Yjs decode on that doc is about 1.2 ms.

   Still to measure, with a large explore doc whose `/pdf/` links are converted into chips in a
   copy:
   - the chip-context query;
   - the editor and reading view with hundreds of chip node views: first render, and keystroke
     latency through PERFORMANCE.md's tool;
   - a refresh across many docs.

   A database cache of labels or context is added only if these show a need. House styles are
   not expected to need one. CSL styles probably will ([CITATIONS.md](CITATIONS.md), Later).
2. **The node**, `entityChip`, in `tiptap-schema.ts`'s `docContentExtensions`. It has three
   attributes, and they never change:
   - `kind`, the chip kind;
   - `iid`, the instance id;
   - `data`, an object holding the chip kind's own fields.

   Inline, atom, no content. `leafText` returns U+FFFC; it is set through `extendNodeSchema`,
   because TipTap's `renderText` never reaches `leafText`. The rest:
   - `renderText` returns the label, from the editor's current renderings, so TipTap's clipboard
     text carries labels.
   - `renderHTML` writes the chip kind, the instance id, `data` as JSON, and the label.
   - The parse rule has a priority above Link's `a[href]`. It runs the chip kind's validator,
     drops a chip that fails it, and never reads a label back into the ydoc.
   - y-tiptap compares object attributes deeply (`equalAttrs`), so `data` is written to the ydoc
     only when it changes.
   - Not in `contentExtensions`: the post-side schema never meets a chip (item 9).
3. **Instance ids.**
   - Each chip gets a random `iid` when it is inserted.
   - A client that makes a duplicate, by pasting a copy, gives the copy a new id at once, as
     TipTap's UniqueID does.
   - Concurrent changes can still leave two chips with one id: one tab restores a chip by undo
     while another pastes a copy of it. Every client then gives the later chip in doc order a new
     id derived from its Yjs item id (client and clock). Every client sees that item id alike, so
     their fixes write the same value.
   - Until then, a resolver treats a shared id as ambiguous and falls back to the text, rather
     than picking a chip.
   - Cut and paste keeps the id; undo restores it; the MCP merge keeps it; a chip the server
     creates gets a fresh one.
4. **The rendering function**, in browser-safe `src/lib/entity-chips/`.
   - `chipRenderings(doc, style, context)` returns an iid → rendering map in one pass in doc
     order, which numbering and disambiguation need. Each chip kind contributes its own part.
   - House styles only in v1 (Styling, below).
   - The statuses:
     - **live:** the label, linked;
     - **deleted:** the same label struck through, and unlinked. The context loader reads deleted
       rows, through `prismaIncludingDeleted` where the default client hides them. Restoring the
       row clears the strikethrough, because nothing is stored;
     - **unknown:** an id that resolves to nothing, such as a hard-deleted row or a chip pasted
       from another instance, shows the chip kind's struck-through placeholder, such as
       "unknown person".
   - Markdown wraps a deleted or unknown chip in `~~ ~~`, and a post gets a `strike` mark on its
     label at publish.
   - A tab whose code predates a chip kind keeps that kind's chips intact and shows a neutral
     placeholder. Reloading shows them.
5. **The chip context.**
   - Server-side, `loadChipContext(chips)` makes one query per chip kind.
   - Browsers get it from `GET /api/chip-context`, keyed on the object that holds the chips (a
     doc or an annotation) and gated by that object's read rule, the way `useAuthorColors` uses
     `/api/users/colors`. It is fetched once per mount, refetched when an unknown id appears, and
     seeded by the menus with the record they inserted.
   - It answers for the ids its object holds, and for those each chip kind's insertion rule lets
     this viewer see anyway (the kind contract, item 8). So a chip that a collaborator has just
     inserted resolves before the next store, and the endpoint can't be used to look up any other
     record.
   - The doc's first paint gets its renderings as props, so the swap from the static body to the
     live editor doesn't flash.
6. **Node views and decorations.** The editor, the reading views and side-by-side render chips as
   node views. Renderings reach them as node decorations recomputed on every change, so an
   insertion that renumbers later chips redraws them all, not just the chips the transaction
   touched.
7. **One display-text rule.** A chip's text, in "anchor" mode (U+FFFC) or "display" mode (the
   label), comes from one function that every flattener uses, with a parity test across them:
   - `blockText` and the MCP lowering;
   - Markdown (`renderMarkdown` on the node);
   - the clipboard;
   - `Annotation.bodyText`;
   - `extractMarkedText` (`/annotations`);
   - the CSV export (`table-grid.ts`, which drops unknown leaves today);
   - `quotedTextAt` (`comment-quote-match.ts`), behind MCP quotes, comment quotes and the edit
     conflict check. Its `" "` leaf argument overrides `leafText`, so a chip reads as a space. It
     passes a function instead: a hard break stays a space, and a chip gives U+FFFC.

   This is the leaf-text cleanup: today about nine flatteners each hard-code their own rule.
8. **`prose_json` materialization.**
   - Chips keep their node shape in `prose_json`, which seeds the rail, so its positions must
     match the ydoc's. The cache write (`server/doc-cache.ts`) adds each chip's `label` as an
     attribute.
   - Links are not materialized. Every surface that shows a link computes it, and a post freezes
     its links at publish.
   - A migration teaches `prose_text` to read `attrs.label` on `entityChip`, then re-indexes.
   - `check-doc-integrity.ts` recomputes labels before comparing.
   - So DOCS.md's "`prose_json` is the document" becomes "the document, plus each chip's label as
     of the write".
9. **Posts and the landing preamble.**
   - `postContentFromYdoc`, at publish, and front-page.ts's strip, at each render of `/`, replace
     each chip with linked text. That text is the chip's label, linked where its chip kind sends a
     post's reader, and it carries the chip as one `chip` attribute on the link, holding the chip
     kind and its identity.
   - The static renderer throws on an unknown node, so these are the only paths by which doc JSON
     reaches a post-side surface.
   - Republishing refreshes the labels. `remapThreadsToEvent`'s survival test (anchor-remap.ts)
     treats a run whose chip identity matches as unchanged and rewrites the thread's quote. So a
     rename or a restyle between publishes doesn't detach comment threads.
10. **The refresh.** Some label inputs change without any edit:
    - a record that a chip kind's context reads, each chip kind listing which changes count;
    - the instance default style, for every doc that hasn't set its own.

    A doc's own style lives in its ydoc (Styling, below), so changing it is an edit, and the
    ordinary store relabels the doc.

    For the others, a job finds the affected docs and annotations through the index tables and
    recomputes their labels:
    - **A doc** is recomputed from `prose_json`'s own chip attributes, and only `prose_json` is
      written. The write is raw SQL, a compare-and-set on `prose_json_update_id`:
      - a store that won the race already wrote fresh labels, so it is never overwritten;
      - nothing decodes a ydoc;
      - `Doc.updatedAt` and the last editor don't move.
    - **An annotation** gets its `bodyText` recomputed from its `proseJson`. No date moves
      either: an annotation's "updated" date is the edit its card tells readers about
      ([FULLTEXT.md](FULLTEXT.md) §6).

    Re-running a store would move both, and one rename would make hundreds of docs look freshly
    edited. The search triggers follow the writes.
11. **Anchors.**
    - **The chip record.** Each anchor records the chips inside its range: offset, chip kind,
      identity, `iid`.
      - It goes in the DOC_RANGE selector of tag, link and comment-quote anchors.
      - On an annotation it goes in a new jsonb column beside its anchor columns, until §20's
        `annotation_anchor` exists.
      - Surfaces that show `quotedText` without opening a ydoc substitute current labels from it:
        `/link/[id]`, its banner and tray, `/links`, `/annotations`, MCP thread reads and the
        annotation search vector.
    - **Identity checks.** The resolvers check identity, by the chip kind's rule for when two
      chips are the same entity. So an anchor whose chip became a different person or work
      detaches, while a corrected locator doesn't.
    - **Instance anchoring.** A range that starts or ends on a chip records that chip's `iid` as
      an edge, and resolves its chip edges by instance:
      - a text part resolves as today: the mark hull in the editor, offsets and quote in the
        reading views;
      - a lone chip resolves by instance alone;
      - when the chip is deleted, the anchor degrades as today.

      This is what lets an annotation target one chip, on every surface. The editor's mark can't
      do it, because y-tiptap stores no marks on inline nodes (`createTypeFromElementNode` writes
      attributes only). And U+FFFC alone can't tell two chips apart.
12. **Index tables, one per chip kind** (`mention`, `citation`), of one shape:
    - the target, as the chip kind's identity points at it: a foreign key, for a row;
    - the chip's `iid`;
    - exactly one source foreign key (doc, post or annotation, and comment later), under a
      hand-written CHECK;
    - when the chip was first seen.

    The shape is shared and the tables are per chip kind, as with the anchor tables
    ([PLAN.md](../PLAN.md) §20a). So a new chip kind costs one migration, but no schema bump.
    Triggers on `prose_json` read the chip nodes, and the `chip` attribute on posts' links. They
    diff, so a chip keeps its first-seen time. An id that doesn't exist is skipped, never raised.
    An integrity script with `--repair` checks the tables. *Who* inserted a chip comes from the
    collab server's `clients` map, never from the JSON.
13. **Annotation bodies.** Notes are their own schema, and the family's one bump covers them too.
    - The node goes into `annotationContentExtensions` and its mirror,
      `annotationEditorExtensions`, in this step. The gate's fingerprint already covers the
      annotation editor ([YDOC.md](YDOC.md)), so adding it in a later step would be a second bump.
    - Cards compute renderings at render, since `Annotation.proseJson` is the settled snapshot and
      stays label-free.
    - `bodyText` (the RAISED email and the annotation vector) is written with labels, and is
      refreshed (item 10).
    - Replies anchor into bodies, so the anchor rules (item 11) apply to them.
    - Which chip kinds a composer offers is each chip kind's own rule, through its menu.
14. **MCP** (below).
15. **The version.** This step bumps `SCHEMA_VERSION` to 1. Later chip kinds need no bump
    (rule 6).

## Styling

**Forms** belong to each chip kind ([MENTIONS.md](MENTIONS.md), [CITATIONS.md](CITATIONS.md)).
A style picks one per chip kind.

**Per doc.**

- The style lives in a `Y.Map("settings")` in the doc's own ydoc, beside the `clients` map that
  every doc already has. It is cached to a `Doc` column on store, as `title` is.
  - Open editors therefore update live.
  - History shows the style each version had.
  - Forks carry it, and an out-of-date tab can't touch it.
- It is written through the editor's provider, and, for MCP, inside `/admin/doc-edit`. Not
  through `/admin/doc-apply-update`, which returns 409 when anyone has typed since its state
  vector was taken.
- `doc-create` seeds it. MCP's `since` reports a change to it.
- The instance default applies until a doc sets its own. Changing the default is the one style
  change the refresh handles (step 1, item 10). A private doc and a shared one are set up the
  same way: visibility never decides a label.

**Per chip.** Overrides are fields in the chip's `data`, each chip kind listing its own, so the
anchor text is unchanged.

**Per post.** A post can be published in its own style, defaulting to the doc's: for example,
initials and short titles while drafting, full names and author-date in the post.

**Sections** come later, if a real doc needs them. The design that fits is stable heading ids,
with section styles keyed by id in the settings map.

- It needs a UniqueID-style dedupe, because TipTap's `keepOnSplit` makes Enter copy an id.
- It needs an MCP merge that keeps attributes Markdown can't express. Today `build(next, …)`
  takes the new block's attributes.

A style attribute on the heading itself would scope implicitly: changing a heading's level would
silently re-scope its chips. Section containers and range marks are ruled out.

## MCP

A leaf chip already survives today's merge, as one "\n" atom, but it is invisible:

- a replacement spanning it deletes it and returns ok;
- a changed field is ignored;
- a hard break written where it was keeps it.

So:

1. **Reads show each chip in its chip kind's Markdown.** A mention's carries its current label; a
   citation's carries its keys and locators ([MENTIONS.md](MENTIONS.md),
   [CITATIONS.md](CITATIONS.md)). Text reads show labels. The read's header reports the doc's
   styles. A chip whose kind this server doesn't know reads as the neutral placeholder a tab
   shows, and its paragraph can't be edited (item 6).
2. **Chips in Markdown.**
   - Each chip kind owns a syntax. The parse keys on that syntax, never on a label, so a chip
     reads back the same whatever the doc's style.
   - The lowering is one-to-one: text that would read back as a chip is escaped on the way out.
     CommonMark and Pandoc both read `\@` as a literal `@`, so hand-written `[@radner2012]` goes
     out as `\[\@radner2012\]`. The serializer already escapes the brackets; the `@` is new.
   - The new escapes need a subclass of `MarkdownManager`. `escapeMarkdownSyntax` is a fixed regex
     with no hook, and overriding it keeps its caller's skipping of code, which an output pass
     would have to redo. The escapes that depend on a neighbouring chip (CITATIONS.md, "Text
     beside a chip") go in `renderNodeToMarkdown(node, parentNode, index)`, the one method that
     sees a text node's siblings. The round-trip test catches a TipTap rename.
   - Each `MarkdownManager` gets its own `new Marked()`, through the constructor's `marked`
     option. All three in `markdown-import.ts` share marked's global instance today, so a chip
     tokenizer registered for the doc parse would also run in the comment parse. That parse has
     no chip node and drops the token, so a comment saying "@Andrew, see this" would lose
     "@Andrew".
   - A chip whose target is gone is written with its stored id where its slug or key would go, so
     a round trip keeps it.
3. **Chips in quotes.** Every quote an agent sends resolves through `resolveQuote`
   (quote-resolve.ts): a note's, a link's or a tag's quote, an edit's target, `around`, and a
   reply's quote into its parent (`anchorInParent`). It is matched as written, then retried as
   the text its Markdown yields. `resolveQuote` takes one target today and gains a second, so each
   try has its own text, and each verifies with its own derivation: `quotedTextAt` gives U+FFFC
   where a target holds a label or a code point. Each try gains a rule for chips:
   - **As written**, a quote is matched against the doc's display text, where each chip reads as
     its label. A quote copied from a text read lands here. A note's or a link's match whose edge
     falls inside a label widens to the whole chip; an edit's is refused (item 6). Verification
     compares a range's text with the quote, which a widened range fails, so the resolver returns
     the match with the chip its edge fell in, and the caller widens or refuses.
   - **The Markdown retry** parses with every chip kind's codec. Today it parses with
     `contentExtensions`, which has no chips, so a citation in a quote stays literal text and
     never matches. When the parse holds chips, the quote is matched against the doc's *identity
     text* instead. There each chip is one private-use code point per identity, the text the
     merge aligns (item 5). So `[see @radner2012, p. 49]`, copied from a Markdown read, finds
     its chip whatever style, number or label the doc shows now. Where several chips of that
     identity fit, the one whose other fields also agree wins.
   - **A quote whose fields disagree** names the right chip with, say, the wrong page.
     - One chip fits: the quote matches, and the reply reports the chip's current fields. A refusal
       would cost a round trip and land on the same chip.
     - One chip fits and the quote is an edit's target: refused as `chip_changed` (item 6). The
       merge takes fields from the new text, so an edit from a stale read would silently undo a
       correction made since. An agent changes a field by quoting its current value.
     - Several chips fit and none agrees: `ambiguous`, as today.
   - A quote naming a chip that isn't there misses like any other, and its near misses come from
     the display text.

   Matches map back to storage positions, and are captured on the storage node with chip
   records. `findOne` already re-derives its hint there (annotation-writes.ts). PDF text holds no
   chips, so PDF quotes keep `markdownToText`.
4. **One label map per edit.** It is computed on the Next server and sent to the collab server in
   the `EditRequest`, beside `annotations` and `linkParts` (server/doc-edit.ts). `planEdits` then
   matches display text against the same labels on both sides, so a rename between an agent's
   read and its edit can't cause a spurious conflict. The conflict check (`expectText`) compares
   chip identities as well as text. Every chip reads U+FFFC in `quotedTextAt`, so one chip swapped
   for another between the read and the edit would otherwise pass.
5. **A chip-aware merge.**
   - The Markdown parse turns each chip kind's syntax into chips (item 2).
   - Link titles are stripped on the way in, because TipTap's Link parse stores them as an
     attribute.
   - `atomsOf` gives each chip *identity* its own BMP private-use code point in place of "\n".
     Each one is allocated so it doesn't appear in either text, since extracted PDF text contains
     private-use characters. `tokenizeFine` keeps each such character a token of its own.
   - A chip therefore only aligns with the same chip, whatever label the agent typed. Fields its
     chip kind's Markdown can't express (`iid`, some overrides) are kept from the old node; fields
     it can express are taken from the new one.
   - Chips of different identities don't align, so a chip that changes identity reads as one
     deleted and one inserted. After the diff, the merge pairs them where the chip kind says the
     new one continues the old (the kind contract, item 2), and the new one keeps the old `iid`.
     It pairs only when exactly one pairing is possible. Otherwise both stand, and the reply
     reports them.
6. **Refusals:**
   - `splits_chip`: an edit edge inside a label;
   - `chip_as_text`: a chip deleted and its label inserted as plain text in its place;
   - `unknown_chip`: a chip the old text didn't hold, whose target doesn't exist or isn't one its
     chip kind's insertion rule allows. It points to that chip kind's lookup;
   - `chip_changed`: an edit's target that matches a chip but names different fields (item 3). It
     returns the chip's current Markdown;
   - `unknown_kind`: an edit of a paragraph holding a chip of a kind this server doesn't know,
     after a rollback or a removed kind. That kind has no Markdown, so the merge can't keep the
     chip. An opaque token would keep it, at the cost of a syntax for a rare case.

   Deleting a chip on purpose is allowed, and is reported.
7. **Settings and export.**
   - `edit_doc` gains `settings`.
   - `download` and `create_doc` speak the same Markdown, keyed by slugs and keys rather than ids,
     so a doc moves between instances.
   - Each chip kind adds its own lookups and filters.

**Unchanged:** the tool shapes, the quote-targeted edit model, the collab write-back, and refusing
or reporting rather than guessing.

## Quoting, surface by surface

- **The doc editor.**
  - An annotation's text is marked as today.
  - Chips at its edges, or a lone chip, are recorded by instance (step 1, item 11).
  - A chip carries no mark, so bold over a chip isn't kept. The chip is styled by CSS anyway.
- **The reading views** (annotations, replies, anchored links, tags): offsets and a quote with
  U+FFFC, the chip record, and instance edges.
- **Comment quotes** quote posts, which hold linked text, so nothing changes.
- **MCP notes, links, edits and `around`:** display text or identity text, mapped back (MCP,
  item 3).
- **Stored quotes shown elsewhere** get current labels from the chip record.

Because anchors never contain a label, no restyle, rename or renumbering detaches one.

## Searching

- **Full text.** Labels are materialized into `prose_json`, so "Breuer" finds `@Luke Breuer`.
- **Short labels such as "LB" and "[3]"** are poor search terms. Each chip kind's filters are the
  way to find a person or a work.
- **Filters.** Each chip kind's filters (`mentions=`, `cites=`, …) join `SearchParams` beside
  `authors` and `tags`.
  - Each applies inside each kind's readable `where`, through the chip kind's index table, as
    `taggedWhere` does.
  - With no query text they list matches, newest first.

## Later

- **Section styles** (Styling, above).
- **Comments.** The comment schema and its Markdown box gain the node. `parseCommentBody` then
  runs each chip kind's validator, since the schema no longer checks a chip's fields. Each chip
  kind decides what its menu offers a commenter.
- Each chip kind's own later work is in its file.

## Risks and what is untested

1. **Live editing around an atom** (caret, IME, iOS and Android selection handles, drag). This is
   standard ProseMirror behaviour, but it is untested here. Build it behind an e2e spec first.
2. **Dedupe of instance ids under a concurrent paste.**
3. **The display-text rule's coverage.** A flattener that misses it shows nothing, or U+FFFC. The
   parity test is the guard.
4. **Every path from doc JSON to a post-side surface must convert chips**, or the page throws.
5. **The refresh job:** compare-and-set correctness, and fan-out for a prolific author's rename or
   a change of the instance default.
6. **Out-of-date tabs:** the gate, and its soak.
7. **A tab whose code predates a chip kind** must keep that kind's chips exactly as they are.

## Checks

- **Unit tests:**
  - the rendering function: each status, the doc-order pass, a chip kind the code doesn't know;
  - the display-text parity across flatteners, with a hard break still a space in `quotedTextAt`;
  - the chip-aware merge and its refusals, and pairing a chip with its continuation, including
    when two pairings are possible;
  - the conflict check catching one chip swapped for another;
  - the Markdown round trip: escapes, and deleted and unknown targets;
  - quotes matching by label when copied from a text read, and by identity when copied from a
    Markdown read;
  - a match whose edge falls inside a label: widened on a note, `splits_chip` on an edit;
  - a quote whose fields disagree: reported on a note, refused on an edit's target, `ambiguous`
    when several chips fit;
  - a comment parse after the doc parse has run, keeping its `@word` as text;
  - `iid` dedupe, including the derived id;
  - chip records and instance edges in capture and resolve;
  - step 0's schema fingerprint.
- **Integrity scripts:**
  - the index tables against `prose_json`, with `--repair`;
  - materialized labels against recomputed ones;
  - chip records against the stamped state.
- **e2e:**
  - inserting and deleting chips; the caret stepping over one; Backspace removing one;
  - annotating a lone chip, in the editor and in the reading view;
  - a restyle and a rename leaving every anchor attached;
  - publish converting chips;
  - an MCP edit round trip;
  - a refused out-of-date tab.

Each chip kind's file lists its own checks.
