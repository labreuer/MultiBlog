# Entity chips (planned)

**Status: partly built; "Built so far" below says which parts.** An *entity chip* is an inline node in a doc's text
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

  Nothing exercises the kit without a chip kind, so steps 1 and 2 are built together. Chips in
  comments came after (below); section styles and each chip kind's own later work are still to
  come.

## Built so far

Steps 0 to 3 are built but for the items each entry says are not; step 3's are in
[CITATIONS.md](CITATIONS.md), "Built so far". Everything below not listed here is still a plan.

- **Step 0, the gate:** all of it ([YDOC.md](YDOC.md)).
- **Step 1, item 1:** the spike, with its result.
- **Item 2, the node:** `entityChip` (`src/lib/entity-chips/node.ts`) in the doc,
  annotation-body and comment schemas, with `leafText`, the parse rule and its validation.
- **Item 3, instance ids:** a random id at insertion, and a fresh one for a pasted copy
  (`repairChipIids`). A duplicate that concurrent changes leave is repaired by every editor
  that receives it, with an id derived from the later chip's Yjs item (`repairSharedIids`,
  `shared-iids.ts`), so their repairs agree. It runs only right after a remote change, when
  the editor's document and the Yjs one hold the same chips, and is kept out of undo.
- **Item 4, the rendering function:** `chipRenderings` (`renderings.ts`), the three statuses, and
  the placeholder for a chip kind the build doesn't know. Not the `~~ ~~` in Markdown. A
  rendering's `label` is plain text. When a chip kind's label carries formatting (a citation's
  words before and after a work, CITATIONS.md "Markdown inside a citation"), its `runs` hold
  the same text formatted, and the node view, `StaticChip` and `chipsToLinkedText` draw those.
- **Item 5, the chip context:** `loadChipContext`, `GET /api/chip-context` with its per-viewer
  rule (`context-for.ts`), and `useChipInputs`, which refetches for a target it doesn't hold and
  shows `…` meanwhile. The doc reading view's first paint gets its context as props.
- **Item 6, node views and decorations:** in the doc editor, the doc reading view and
  side-by-side. A static render goes through `renderWithChips` (`static.tsx`).
- **Item 7, the display-text rule:** `src/lib/entity-chips/text.ts` holds it: a chip's anchor
  text, and its display text from computed labels or from a label on the JSON node. Through it
  go `extractText` (a note's `bodyText`, a collapsed card's excerpt and word count),
  `extractMarkedText`, the table grid a CSV is written from, and `quotedTextAt`, with
  `text.test.ts` running them over one body, and `blockText`, `flattenForMatch` and the
  Markdown writer, which take labels from the MCP doc state (`quote.test.ts`).
- **Item 8, `prose_json` materialization:** every writer of `Doc.proseJson` goes through
  `docCacheFromYdoc`, which adds each chip's label (`materializeChipLabels`); `prose_text` reads
  it (migration `chip_labels_in_prose_text`), so a doc's search vector and snippets hold the
  label; and `check-doc-integrity.ts` compares without labels and reports a stale one as
  `chip-labels`. No re-index was needed, since no doc could hold a chip before this.
- **Item 9, posts and the landing preamble:** `docJsonForPostSide` (`post-content.ts`) replaces
  each chip with its label as linked text, struck through when its target is gone, and records
  the chip on the link's `chip` attribute. On a republish, `remapThreadsToEvent` compares a
  quote that holds a label whole by who its chips stand for (`post-chip-runs.ts`), follows a
  chip at the quote's edge by instance id, and rewrites the thread's `quotedText` to the new
  label, so a rename between publishes detaches no comment thread. A quote that cuts through
  a label is compared as text.
- **Item 10, the refresh, for mentions:** `refreshMentionLabels` (`refresh.ts`) finds the docs
  and notes that mention a person through the `mention` table and rewrites a doc's
  `prose_json` labels, a note's `bodyText`, and the chip records of the anchors into either
  (item 11), each as a compare-and-set on the text it read, in raw SQL so no date moves. `scheduleMentionRefresh` runs it in the background after a
  change to a name, initials, a handle or a bot's person, and once more past the store
  debounce's ceiling. Not the instance default style, which doesn't exist yet.

  A record whose chip has left the body its anchor points into (the mention was deleted, and
  the note on it stayed) has no label there to take, and its doc may not be in the index at
  all. `refreshOrphanRecords` finds such a record by what its fields name (the chip kind's
  `naming`, read by jsonb containment) and labels it alone, in the kind's default style: a
  number, or the extra that tells two same-named people apart, needs a body's doc-order pass.
  No index serves the containment, so the pass reads every anchor row that has records.
- **Item 11, anchors:** `src/lib/anchors/chips.ts`.
  - **The chip record** is written by the one capture (`captureAnchorInNode`), into the
    DOC_RANGE selector's `chips` and, for an annotation, into `annotation.anchor_chips`
    (migration `anchor_chip_records`). A record holds where the chip's U+FFFC is in the quote,
    its chip kind, its instance id, the chip's *fields* rather than only its identity, and its
    *label as of the write*. The fields are what a label is computed from, and the identity
    is derived from them. The stored label is what lets a table of a hundred quotes, and the
    annotation search vector (`anchor_quote_text`), show a name without a chip context per
    row. It is kept as `prose_json`'s labels are: the rename refresh rewrites it, and so does
    every store of the doc the anchor points into (`refreshAnchorRecords`), from that doc's
    own labels by instance id. An anchor into a note's body (a reply's quote, a tag or link
    on the note) is relabelled when that body is settled (`writeSettledBody` calls
    `refreshAnchorsIntoNote`), since a note's readers see only settled text. A record whose
    chip that body no longer holds is relabelled only by the refresh (item 10), when its
    target changes.

    So a record has two clocks. Its fields are the chip's as of the anchor's version and are
    never rewritten, which is what `chips-at-stamp` checks and what the continues rule below
    is asked of. Its label is as of the last write. Show a record by its label, never by a
    label computed from its fields.
  - **Shown with labels:** a card's quote line, the annotation popover, "Your private notes",
    `/annotations`, `/links`, `/link/[id]` with its banner and tray, search hits and MCP's
    thread and link reads go through `quoteWithChipLabels` or `shownQuote`. The cards beside
    a doc (the reading view's list and the editor's rail) hand it the labels that page's
    editor is drawing (`useLiveChipLabels`), which win over the stored ones, so a card and
    the passage beside it agree before a rename's refresh has run. Except a doc-editor note's
    quote line: the server builds it from `prose_json`'s labels (`markAnchoredQuote`), so it
    lags by the seconds until the refresh or the doc's next store, which is tolerated.
  - **Identity checks:** `resolveAnchorInDoc` takes the records. A candidate counts only if
    its chips stand for the recorded entities in order, and several that pass are told apart
    by instance id. The highlight plugin, MCP's reads and the edit endpoint's "what it
    touched" all pass them. An anchor with no record resolves by its text.
  - **A chip that was edited is still the recorded chip.** Where the chip's identity is no
    longer the recorded one, `chipMatch` asks its chip kind whether the chip there continues
    the record (`chipContinues`), and takes a yes only from the recorded instance: another
    chip that happens to hold the same works and more is not what the anchor was put on.
  - **Instance anchoring:** a quote that is chips and nothing else resolves by instance
    alone. In the doc editor, whose anchor is a mark, the row records the passage's *edge*
    chips (before its first character, after its last, or all of them for a chip alone), and
    the plugin finds them by instance id and stretches the mark's hull over them, only
    within the hull's own textblock ([ANNOTATIONS.md](ANNOTATIONS.md), "Anchoring").
  - `check-annotation-anchors.ts` checks each record's fields against the stamped state
    (`chips-at-stamp`), and its label against the label its chip has now in the body the
    anchor points into (`record-labels`, a warning: a refresh that was lost).

  Not built of item 11: the selector's `before`/`after` context still holds U+FFFC for a
  chip beside the passage, and a tag's anchor is whole-object, so it has no record to keep.
- **Item 12, the index table, for mentions:** `mention` (migration `mention_index`), one row per
  chip with its person, its instance id, its one source and when it was first seen. Triggers on
  `doc.prose_json`, `annotation.prose_json` and `post.prose_json` keep it by a diff; a post's
  rows come from its links' `chip` attribute, and a DRAFT note has none.
  `scripts/integrity/check-mentions.ts` checks it, with `--repair`. Nothing reads who inserted
  a chip yet.
- **Item 13, annotation bodies:** the node is in their schema, and every surface that draws a
  note's body labels its chips: the cards (`buildAnnotationEntries` loads one context for every
  note on the page), the read-only editor over each card, the composer and the edit session,
  and the earlier versions in the history panel. `bodyText` is written with labels
  (`annotationBodyText`) and refreshed (item 10).
- **Item 15:** `SCHEMA_VERSION` is 1.
- **Item 14, MCP, the reading half:** reads show each chip as its label in text and in its chip
  kind's Markdown (`ChipKind.markdown`, `chipMarkdowns`, `docContentToMarkdown`), in docs, notes
  and thread passages, with a hand-written link of a mention's shape written `[\@…]`. A quote
  is matched against the doc's display text and verified against it (`flattenForMatch` with
  labels), and what is stored stays the anchor text. A quote that begins or ends inside a
  label takes the whole chip (`QuoteMatch.widened`): a note, a link and `around` anchor on
  it, and an edit refuses it as `splits_chip`.
- **Item 14, MCP, the writing half:** `edit_doc`, `add_note` and `edit_note` read a chip kind's
  syntax as a chip. The parse yields a placeholder holding what the Markdown named
  (`markdownToBlocks` with `chips`), and `resolveParsedChips` makes it a chip under the kind's
  insertion rule, or refuses `unknown_chip`; a chip the body already holds may always be
  written back. The merge gives each chip identity one private-use character
  (`ChipMerge`, doc-edit.ts), so a chip written back is the old node again, instance id and
  all. A chip whose label came back as plain words is refused `chip_as_text`; one left out is
  removed and reported (`mentionsRemoved`); the conflict check compares chip identities
  (`expectChips`) beside the text. The collab server labels the live doc from the records the
  client's read used (`chipInputs` in the edit request).

  `create_doc` reads the same syntax (`markdownToDocContent` with `chips`), under the rule
  for a doc that doesn't exist yet, and `download` writes it, so a doc moves between
  instances by handle and key. `/docs`' Markdown import reads it too, and leaves a mention it
  can't resolve as the link its Markdown also is (`unresolved: "link"`), where MCP refuses; a
  citation it can't resolve refuses the import on both (CITATIONS.md, "Markdown").

  An edit whose passage holds a chip of a kind the server doesn't know is refused as
  `unknown_kind`, since the new text can't write that chip back; the words beside it can
  still be edited, and the merge keeps it. The chip-aware parse stores no link title, and
  leaves no whitespace inside a mark against a chip (`parseWithChips`): `**see [@k]**` reads
  as bold "see", a plain space, then the chip, which is where the writer puts that space, so a
  doc made from Markdown is the doc its own Markdown reads back as.

  The merge pairs a chip that continues another (`pairContinuations`, doc-edit.ts): where a
  textblock lost one chip and gained one its chip kind says continues it, and no other pairing
  is possible either way, the new chip takes the old one's instance id. An edit reaches it by
  a citation's Markdown with a work added. A chip that lines up with itself keeps its node and
  instance id and takes its fields from the new text (`chipFieldsFrom`), so a citation sent
  back with another page has that page.

  A quote that gives a chip in its chip kind's syntax finds it by identity (MCP item 3):
  `withQuoteChips` (`parsed-chips.ts`) reads each part of the quote through the chip parse and
  looks up the handles and keys it names, read-only (`chipsForFinding`, `placeholders.ts`), and
  `resolveQuote` matches the result in the doc's identity text (`flattenForIdentity`). An edit
  whose quote gives a chip other fields than it holds is refused as `chip_changed`.
- **Styling, per doc and per post:**
  - **The doc's style** is in a `Y.Map("settings")` in its ydoc, one key per chip kind
    (`settings.ts`), cached to `Doc.chipStyles` by the store. `DocSettingsPanel` writes it
    through the editor's connection; open editors and reading views follow it live
    (`useChipInputs` observes the map), and the next store relabels `prose_json` and the
    anchors' chip records. Every server path that labels a doc's body takes the doc's style:
    the cache write, the first paint, the chip-context endpoint, MCP's doc state, anchor
    capture, the refresh and the integrity check.
  - **MCP:** a doc read carries `styles` when the doc has set any, `edit_doc` takes
    `settings` and writes it inside `/admin/doc-edit` with the edit, and `since` reports a
    change of style.
  - **A post's own style** is `Post.chipStyles`, set in `PostSettingsPanel`, each kind it
    names winning over the doc's when the post's chips become linked text. Changing it makes
    the live version publishable again, and the server's no-op check now compares the
    content a publish would write, so a rename alone is also something to republish.
  - **A note's body has no style of its own**, and shows each chip kind's default wherever
    it is read. A note is shown away from its doc as often as beside it (`/annotations`,
    search, the RAISED email), and its stored `bodyText` would otherwise depend on another
    object's setting, with a refresh of every note for each change of a doc's style.

  Not built of Styling: an instance default (each chip kind's own default stands in), a
  control for a single chip's override (a mention's `form` field is honoured and nothing
  sets it), the scrub bar showing each version in the style it had (it shows the current
  one), and sections: all under Later.
- **Mentions:** the chip kind's fields, forms and labels, its context loader, the rule for who
  may be mentioned, the `@` menu in the doc editor and in a note's composer, the `mentions=`
  search filter with `@handle` in the search box, and the dashboard's "Mentions of you" card
  ([MENTIONS.md](MENTIONS.md)).
- **Chips in comments** (below): the node in the comment schema and its checks, the Markdown
  box's forms, the rich editor's `@` and `[@` menus and citation popover for a commenter signed
  in or out, the comment style on every surface, `body_text` with labels and its refresh, the
  index tables' comment source with search and the dashboard, and a quotation that copies a
  passage's chips.

`/docs`' Length counts a chip as no characters.

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
   on the viewer. A planned citation whose referent is `quote:prev` or `quote:next` stretches
   this: its link is computed from the text beside the chip as well (CITATIONS.md, "Planned: a
   passage in a citation"). That text is in the same body as the chip, so whatever renders the
   chip has it, but an edit to the quotation changes the citation's link.
3. **A chip's anchor text is U+FFFC, forever.** It is the node's `leafText`, so every DOC_RANGE
   path in `src/lib/anchors/`, which calls `textBetween(…, " ")` with no leaf argument, gets it
   with no flattener changed. `quotedTextAt` passes a leaf argument of its own, so it changes
   (step 1, item 7). Replaying a stamp therefore always reproduces its quote.
4. **Whatever shows or searches text uses the label**, through one display-text rule.
5. **Labels are materialized where static surfaces read them**, and refreshed when an input
   changes without an edit. A refresh never moves `Doc.updatedAt`.
6. **A chip kind adds no schema.** A new chip kind, or a new field on one, changes no node, mark
   or attribute. The gate's fingerprint stays the same, and no tab is refused for it. The cost
   is that a tab on an older bundle validates `data` with only the fields it knows. So it drops
   a new field wherever it writes a chip's `data` from its own validation: an edit in a
   popover, or a cut and paste through `parseHTML`. Nothing refuses that tab. A plan adding a
   field says why the loss is acceptable or how it is avoided (CITATIONS.md, "Planned: a
   passage in a citation").

## The kind contract

Each chip kind supplies the following, as one entry in the kit's registry
(`src/lib/entity-chips/`). Its own file says how.

1. **Its fields**, kept in the chip's `data`: which are identity and which are overrides, with a
   validator that every way in runs (step 1, item 2).
2. **What its identity points at:** a row (a user, a reference), a key, or a place in the same
   doc. Also when two chips count as the same entity, which the anchors' identity check and the
   MCP merge's alignment use, and when a new chip continues an old one, which the merge's pairing
   (MCP, item 5) and the anchors on that instance (step 1, item 11) use. And the fragment of
   its fields that names one target, which a stored chip record is found by when that target
   changes (step 1, item 10).
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

**Built.** An out-of-date tab deletes a node type it doesn't know just by decoding it, so the
collab server refuses it, and a bundle's local copy of a doc is named by its schema version so
that no tab reads a newer one's. Step 1's bump to version 1 can deploy with the gate: a tab from
before the gate states no version, which counts as 0. The design, its prior art and what it
doesn't cover are in [YDOC.md](YDOC.md).

## Step 1: the kit (schema version 1)

1. **Performance spike: done, and no cache is needed.** Measured on the largest local doc
   (135,000 characters), with each of its 638 `/pdf/` links made a chip (563 citations and the
   reference list's 75 entries, over 75 works).

   Server-side, in Node:
   - a whole-doc label pass takes 0.13–0.15 ms, numbering included;
   - materializing labels into `prose_json` takes 0.06 ms;
   - an MCP Markdown read takes 4.6 ms, against 3.7 ms without chips;
   - the chip-context query takes 2–4 ms (median; 75 distinct targets);
   - for scale, today's Yjs decode on that doc is about 1.2 ms.

   In the browser, with 638 chip node views against the same doc with none (chromium, a
   production build, 2026-11-04, on an AMD Ryzen 9 9950X under Fedora 44 whose load average was
   20–30 from other work, so each figure is a range over four runs):
   - the editor and the reading view load no slower: 0.3–0.5 s either way;
   - a keystroke costs the same: a median of 0.9–1.5 ms at the doc's start and 1.3–2.4 ms at
     its end, against 0.8–3.8 ms and 1.5–6.1 ms without chips;
   - relabelling every chip at once (the context arriving, a restyle, a rename) takes 4–11 ms.

   The keystroke figure depends on one thing. The plugin maps its decoration set through a
   transaction that touches no chip, and rebuilds it only when a chip comes or goes, has its
   attributes set (an `AttrStep`, whose step map is empty, so it is looked for by name), or the
   inputs change. Rebuilding on every keystroke doubled typing latency at the doc's end, because
   ProseMirror then compares every block's decorations.

   Not measured, because it isn't built: a refresh across many docs (item 10).

   So no database cache of labels or context is planned for house styles. CSL styles probably
   will need one ([CITATIONS.md](CITATIONS.md), Later).
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
    - exactly one source foreign key (doc, post, annotation or comment), under a hand-written
      CHECK;
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
     out as `\[\@radner2012\]`, the serializer escaping the brackets.
   - The escapes are written into the JSON before the serializer runs, as a private-use stand-in
     wherever a backslash belongs, replaced with one in its output (`serializeWithEscapes`). The
     serializer offers no hook: `escapeMarkdownSyntax` is private, and inline text is written by
     a private path that sees no sibling, which the escapes beside a chip (CITATIONS.md, "Text
     beside a chip") need. The pass skips code, as the serializer's own escaping does. The
     round-trip tests (`citation-markdown.test.ts`) catch a TipTap change that breaks it.
   - Each chip parser has its own `new Marked()`, through the constructor's `marked` option, and
     the other managers in `markdown-import.ts` share marked's global instance. A chip tokenizer
     registered on that instance would also run in every parse without chips, which drops the
     token, so a body saying "@Andrew, see this" would lose "@Andrew". A comment's parse has an
     instance of its own too, with the bracketed citation tokenizer only (Chips in comments).
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
   - **The Markdown retry** parses with every chip kind's codec. When the parse holds chips,
     the quote is matched against the doc's *identity text* instead. There each chip is one private-use code point per identity, the text the
     merge aligns (item 5). So `[see @radner2012, p. 49]`, copied from a Markdown read, finds
     its chip whatever style, number or label the doc shows now. Where several chips of that
     identity fit, the one whose other fields also agree wins. The parse runs on the Next server,
     where the handles and keys are looked up (`withQuoteChips`); the quote carries the result,
     as JSON, to the collab server for an edit. A handle or key that names nothing is kept as
     written, which is how a chip whose target is gone is written, so it finds that chip only.
     When the identity text holds no match, the quote is matched as its plain parse's text, as a
     quote with no chip is: `**Ask** @Ada Lovelace` still finds a mention shown as
     `@Ada Lovelace`, though the chip parse takes `@Ada` for a citation.
   - **A quote whose fields disagree** names the right chip with, say, the wrong page.
     - One chip fits: the quote matches, and the reply reports the chip's current Markdown
       (`chipsNow`, in `around`'s occurrence and a note's `passage`). A refusal would cost a round
       trip and land on the same chip. A link reports no passage, and so nothing.
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
- **Comment quotes** of a post quote linked text, so nothing changes; of a comment, they find a
  chip by its label and copy it into the reply as a chip (Chips in comments, "Quoting a comment
  that holds a chip").
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

## Chips in comments

Mentions and citations in a comment's body, written in the Markdown box or put in by the rich
editor's menus. Four things set a comment apart from a doc or a note, and each shapes what is
built:

- its body is JSON that `parseCommentBody` has accepted, with no ydoc behind it
  ([COMMENTS.md](COMMENTS.md), "The body");
- its commenter may be a stranger, signed out;
- it is shown on a post's page, which is statically generated and open to anyone;
- its default way in is a Markdown box, and "@Andrew, see this" is how one commenter
  addresses another.

### The body

- **The node is in `commentContentExtensions`.** It is `entityChip`, as in a doc or a note:
  identity only, with the label computed wherever it is shown. So a rename relabels every
  comment that mentions the person.

  **Freezing labels as linked text, as a post does at publish, is rejected.** A comment has no
  republish to refresh them. Its rich editor would also let a commenter retype a label while the
  link went on claiming the chip.
- **No `SCHEMA_VERSION` bump.** The gate fingerprints the live editors' schemas, and a comment
  has no ydoc.

  An old tab's rich editor drops a chip from a comment it edits, since it doesn't know the node.
  This holds for a tab opened before the deploy, and it is tolerated: a reload fixes it. The
  Markdown box parses on the server, so it is safe.
- **`conformCommentChips`** (`src/lib/comment-body.ts`), inside `parseCommentBody`, puts each
  chip through its chip kind's validator, since the schema checks only that `data` is there,
  and refuses a chip of a kind the build doesn't know or one its validator refuses, such as a
  Markdown placeholder nobody resolved. It also:
  - keeps no mark on a chip but a quotation's `quote`, which can span one;
  - drops a citation's narrative form, which a comment doesn't have (The Markdown box, below);
  - gives a missing or repeated instance id a fresh one, the first holder keeping its own;
  - refuses more than 20 chips (`MAX_CHIPS_PER_COMMENT`), as quotations are capped at 20
    (`MAX_QUOTES_PER_COMMENT`). The comment rate limits bound how many comments there are, and
    this bounds what one of them holds, so a single comment can't mention everyone on the
    site. The cap is on what the commenter submits; the chips a quotation copies come after.
- **Every chip a submitted body holds passes the insertion check** (`checkCommentChips`,
  `src/lib/comment-chips.ts`).
  - It must be one the commenter may insert (Who may insert, below), or, on an edit, one the
    comment already holds (`freshCommentChipTargets`).
  - `resolveCommentBody` runs it after the parse, for both front doors, so rich JSON can't
    name an account the Markdown box wouldn't take. It runs once the post is known, since who
    a comment may mention is asked of the post.
  - A quotation's chips are written by the server's rewrite after the check (Quoting, below).

### The style

**A comment's chips have one fixed style, `COMMENT_CHIP_STYLES`: a mention shows a name, and a
citation is author-date.** It reads `(Radner 2012, p. 49)`, never `(BU p. 49)`.
- **Why not `short`:** a short label is a doc's shorthand, and a stranger reading the post has no
  way to learn it.
- **Why not numbers:** a comment's `[1]` would collide with the post's own.
- **Why not the post's style:** like a note's style, this one depends on nothing else, so
  `body_text` never changes because another object's setting did.

A chip's own overrides still apply. The cost is that a comment can show a work in a different
form from the post above it. A comment has no bibliography, and its citations link as a doc's do.

### Who may insert

A commenter is offered what the site already shows them (`commentMentionableAmong`).

- **Mentions.**
  - **Anyone, signed in or not,** may mention the post's byline and the people on the landing
    page's contributor list. These are the "public names" MENTIONS.md's Later promised.
  - **An AUTHOR or above** may also mention everyone the doc rule offers them, with the post's
    doc as "this doc" (MENTIONS.md, "Who is listed").
  - **Commenting on the post puts no one in the list.** A comment never carries its commenter's
    user id (COMMENTS.md, "What the page source holds"). Mentioning a commenter would tie the
    name they commented under to their account's current name.
- **Citations.** Any work in the library, deleted ones aside, since every reference's page is
  public. A key typed into the Markdown box resolves for anyone. The `[@` menu offers a
  signed-out commenter less than that (The menus, below).

### The Markdown box

The comment parse (`markdownToCommentContent`) reads the bracketed forms only, into the
placeholders a doc's parse makes, and `resolveCommentBody` resolves them
(`resolveParsedCommentChips`).

- **A mention:** `[@Luke Breuer](/authors/luke-breuer)`, in a doc's syntax (MENTIONS.md,
  "Markdown"). If the commenter may not mention that person, or nobody has the handle, it stays
  the ordinary link it also is, as the `/docs` import leaves one. A comment's link may name an
  author page for that reason (`isAllowedCommentHref`).
- **A citation:** `[see @radner2012, p. 49]`, `[-@radner2012]`, `[@a; @b]`. An unknown key
  refuses the submit, as a doc does. The message names the key and offers `\@`, since otherwise
  a mistyped key would quietly stop being a citation.
- **A bare `@word` stays text.** Comments depart from docs here, where a bare `@word` is always
  a citation:
  - "@Andrew, see this" is ordinary in a comment;
  - a commenter is often not a member, and so has no key to mistype;
  - refusing would bounce ordinary replies.

  So a comment has no narrative form, and `@radner2012 [p. 49]` is what it says.
- **The writer** (`commentMarkdownOf`) writes each chip in its chip kind's syntax, labelled in
  the comment style, and escapes as a doc's writer does, except for a bare `@`
  (`serializeWithEscapes`'s `bareAts: false`). Text that reads `@word` is written as it is, so
  the edit box shows commenters their own words. A `[` is already escaped, and hand-written
  link text that starts with `@` is written `[\@…]`.
- **The comment parse has its own `new Marked()`**, which carries the bracketed tokenizer and
  not the bare one.

### Showing a comment

- **Every surface that draws a comment body labels its chips**, through `renderWithChips` with
  `commentContentExtensions` and the comment style (`CommentBody`, which takes the records as
  `chipContext`). They are:
  - the post page's cards and margin rail;
  - the edit history, whose versions come with one context for all of them;
  - the per-post queue, `/post/[id]/comments`;
  - the quote picker's comment view (`loadQuotableTarget`);
  - the rich editor's node views (`CommentEditor`, through `useChipInputs`).

  MCP's comment reads write each chip in its chip kind's Markdown (`commentMarkdownOf`). MCP
  writes no comments.
- **The post page stays static.**
  - `CommentSection` loads one chip context for every comment on the page
    (`commentChipContext`), the server render computes the labels, and the context rides in the
    payload beside the comments, through `CommentChipsProvider`. Nothing depends on the viewer
    (rule 2).
  - The context holds each mentioned person's name, initials and handle, which are on their
    public author page, and each cited work's record, which is on its public page.
  - A rename reaches the page at its next regeneration (`revalidate = 60`). The post's own text
    keeps the labels it had at its last publish.
- **The browser adds records the page didn't have.** A card's saved edit (`editComment`) and a
  switch from Markdown to rich text (`convertCommentBody`) return the records for the body they
  return, and the provider merges them in.
- **`/api/chip-context` takes a comment as its target** (`?comment=<id>`,
  `commentChipInputsFor`), under the comment's own read rule: a public comment for anyone,
  signed in or not, and the comments that editing and `/post/[id]/comments` already open to
  their commenter and moderators. Of the ids asked about beyond the body's own, it answers for
  the people the asker may mention on that post and for any work. An edit's rich editor asks it
  about a chip the page has no record of.
- **`body_text` holds labels.** The capture writes it with each chip's label in the comment
  style, so the labels reach `/comments`' filter, the spam check, excerpts and the comment
  search vector.
  - `refreshMentionLabels` and `refreshCitationLabels` find comments through the index tables
    and rewrite `body_text` (step 1, item 10), and relabel the chip records of the anchors into
    a comment.
  - Each write is a compare-and-set on the text it read, in raw SQL, so neither `edited_at` nor
    any revision moves.
  - `check-comment-revisions.ts` derives the text with current labels, so a lost refresh is
    reported there.

### Quoting a comment that holds a chip

A reply quotes a comment by typing its words, and those words include the chip's label.

- **The matcher reads each comment candidate with its labels** (`flattenForMatch(node,
  labels)`, as MCP's quotes do), so the typed label finds the chip. A quote that begins or ends
  inside a label takes the whole chip (`verifyWidened`, in the exact tier).
- **The rewrite copies the passage as nodes, not text** (`quotedContentIn`).
  - Writing the passage's text would put U+FFFC in the reply.
  - Its chips become chips in the reply, with new instance ids, so the quotation follows a rename
    as the comment it came from does. A block quotation and an inline one alike.
  - `quoted_text` keeps U+FFFC, and the anchor's selector records the chips with their labels
    (step 1, item 11). So `check-comment-quotes.ts`, which reads a copied chip in the body as its
    anchor text, still finds its three copies in agreement.
- **The body's own spans are read with their labels** (`extractQuoteCandidates(node, labels)`),
  so on an edit a quotation's copied chips read as what the commenter typed, and the span
  matches again.

A quotation of a post is unchanged, since a post holds linked text.

### Indexing and search

- **The `mention` and `citation` tables have a comment source** (migration
  `comment_chip_index`):
  - each has a `comment_id`, with its foreign key, a unique index and the CHECK's fourth
    column;
  - `mention_sync` and `citation_sync` take a fourth id, and the triggers that call them pass
    it.
- **Triggers on `comment` keep the rows from `body` and `status`.**
  - **Only an APPROVED comment has rows**, as a DRAFT note has none. A mention in a PENDING or
    SPAM comment has reached nobody, and approval is when it is first seen.
  - A deleted comment keeps its rows, as a deleted note does, and every reader filters through
    `publicCommentsWhere`.
  - There is no backfill, since no comment held a chip before the migration.
- **`mentions=` and `cites=` cover comments**, inside `publicCommentsWhere`, in MCP's `search`
  too.
- **"Mentions of you"** lists comments too, each linking to its permalink.
- `check-mentions.ts` checks both tables' comment rows.
- A reference's page doesn't list the comments that cite it.

### The menus

The rich editor (`CommentEditor`) has the `@` and `[@` menus and the citation popover, the same
components as a doc's (`MentionSuggestions`, `CiteSuggestions`, `CitePopover`), each handed a
search of the comment's own rather than a chip surface.

- **Both menus ask the server, keyed on the post, signed in or not:** `searchCommentMentionable`
  and `searchCommentCitable` (`src/app/actions/comment-chips.ts`), over
  `commentMentionCandidates` and `commentCiteCandidates` (`src/lib/comment-chips.ts`). A post
  that isn't published answers nothing.
  - **`@`** offers whom the commenter may mention (Who may insert, above): the post's byline
    first, in its order, then everyone else by name. Signed out, that is the byline and the
    contributor list.
  - **`[@`** offers the works the post cites first, then the rest of the library to anyone
    signed in. A signed-out commenter is offered only the post's works, which its bibliography
    already shows. `[@` alone lists them, under "Cited in this post".
  - **One server-side search for every commenter.** Sending a signed-out commenter the post's
    lists whole, for the browser to filter, is rejected: a filter in the browser would match
    works by other rules than the library's search (stemming, accent folding), so the same words
    could find a work for a stranger that they don't find for a member, or the reverse.
- **A menu seeds the record of what it inserts** into the editor's chip inputs, so a new
  comment's chips are labelled as they land.
- **The popover** edits a comment's citations as a doc's, with "Add a work" searching as the
  `[@` menu does. "In the sentence" is disabled, and a line under it says why: a comment has no
  narrative form (The Markdown box, above).
- **What a menu inserts passes the insertion check** on submit like any other chip, so the
  menus are a convenience, not the gate.

### Checks

- **Unit tests** (`src/lib/comment-body-chips.test.ts`):
  - the comment parse: the bracketed forms read, a bare `@word` kept as text, and an unresolved
    placeholder refused;
  - the writer's escapes, and a round trip over many comment shapes through both front doors;
  - the validator, the marks, the narrative form, instance ids and the 20-chip cap;
  - the insertion check's held chips;
  - `body_text` with labels;
  - capture finding a chip by its label, widening, copying chips, and matching again on an
    edit.
- **Integrity scripts:**
  - `check-mentions.ts`: the index tables against comment bodies;
  - `check-comment-revisions.ts`: `body_text` against the labels;
  - `check-comment-quotes.ts`: a quotation's copied chips.
- **e2e** (`e2e/comment-chips.spec.ts`), seeding comments wherever the form's per-IP budget
  would run out:
  - a member's Markdown comment mentioning the post's author and citing a work, labelled on the
    page and indexed;
  - an unknown key refused, and a mention a signed-out commenter may not make left a link;
  - quoting a comment that holds a mention, and a rename relabelling both and the page;
  - `mentions=` and the dashboard finding an approved comment, and not a pending one until it
    is approved;
  - a signed-out commenter's menus offering the post's byline and its works and not someone
    off the list or another work that matches, the popover's narrative form disabled, and the
    chips labelled on the page and indexed. It is the spec's one submission through the form.

## Later

- **The instance default style**, for every doc that hasn't set its own (Styling, above).
  Changing it is the one style change the refresh relabels (step 1, item 10), and that fan-out
  is untested (Risks, item 5).
- **The scrub bar showing each version in the style it had.** It shows the current one. The
  style is in the ydoc's settings map, so each version already holds its own.
- **Section styles** (Styling, above).
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
6. **Out-of-date tabs:** the gate, and the local database's name.
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
