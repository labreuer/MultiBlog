# MultiBlog — Importing a claude.ai data export

`scripts/import-claude-chats.ts` turns each session in a claude.ai data export into a doc,
the way `/docs`' own Markdown import creates one ([DOC_IMPORT.md](DOC_IMPORT.md)), and keeps
those docs in step with later exports by updating them in place. With `--markdown` it does the
same for Markdown files written elsewhere, such as an analysis or a summary (§8). The script's
header documents its flags and environment; this file says what it does and why.

## 1. The export

A claude.ai data export is a manifest listing five zips: `conversations`, `projects`,
`memories`, `frames` and `light_metadata`. The importer reads two:

- **`conversations-000.zip`** holds `conversations.json`: every session, its messages, and
  each message's content blocks — text (with citations), thinking, tool calls and their
  results, attached documents, and machine-injected prompt blocks. Messages form a tree through
  `parent_message_uuid`, because editing a prompt starts a new branch.
- **`frames-000.zip`** holds `artifacts/<id>/`: a Claude Docs document as `page.md`, an HTML
  artifact as `versions/*.html`.

Things about the data that the importer is built around:

- **Each URL in the manifest works once**, and sits behind Cloudflare's browser check, so
  `curl` gets a challenge page instead of the zip. Download them in a signed-in browser.
- **Exports differ in what they cover** — the full history, or only a recent window. Check
  the date range before importing, and keep each export in a directory of its own rather than
  unpacking one over another.
- **Attachment files are not included**: only each attachment's name and the text claude.ai
  extracted from it.
- **Some sessions are empty**: their messages have no content at all.
- **A session's name can contain line breaks.**
- **Times are UTC.** A conversation's own `updated_at` moves without any message changing,
  so it is not a record of activity; the messages' and content blocks' timestamps are.

## 2. Running it

1. **Extract the export afresh for each run**, and compare the extracted files with the zips.
   An extraction left over from an earlier export is otherwise indistinguishable from the
   current one.
2. **Dry run** with `--dry-run --out <dir>`: every session's Markdown is written there and
   nothing is imported. Parse the files with `markdownToDocContent`
   (`src/lib/markdown-import.ts`) to check each one parses, takes its title from the leading
   heading, starts its body with the session's link, and stays under the import's size limit
   (DOC_IMPORT.md §6).
3. **Import** without `--dry-run`. This needs only the database; the web server can be down.
4. **Update** docs the run lists as differing: `--plan` reports what `--update` would change,
   `--update` changes it (§5). Take a `pg_dump` into `.db-backups/` first. Afterwards run
   `scripts/integrity/check-annotation-anchors.ts`, `check-doc-integrity.ts` and
   `check-ydoc-integrity.ts`.

`MB_EMAIL` names the importing account, which needs `canManageDocs`. `BYLINE_EMAILS` is the
byline to give every doc, in order; include the importing account, which the import has
already put on it. `HUMAN_NAME` is the heading over each prompt.

**On a deployed instance**, run the script in that instance's own checkout, on its server.
Everything comes from that checkout's `.env`: the database, the collab server `--update` writes
through, and the secret its token is signed with. The first import prints the database it is
writing to. On a server with more than one instance, check that it names the one you meant.
Copy the extracted export to the server; `conversations.json` is read into memory whole, which
costs about four times its size.

## 3. What happens to each session

1. It is converted to Markdown (§4). A session with nothing to show is skipped.
2. If a doc already opens with the session's link, the two are compared: the session's
   Markdown is parsed and round-tripped through Yjs exactly as an import would store it, and
   compared with the stored body regardless of JSON key order (jsonb doesn't keep it). The same
   is up to date; a difference is listed, or with `--update` applied in place.
3. Otherwise the doc is created as `/docs`' Import Markdown creates one: the same parse, then
   the same `createDocWithContent` (`src/lib/doc-create.ts`) the import action calls, which
   seeds the ydoc, inserts the row and derives the slug from the title. Nothing about the
   doc's creation is reimplemented here. It is created as the importing account, and under the
   import's size limit (DOC_IMPORT.md §6). That limit exists for the web form's request body,
   which the script doesn't send; it still applies so the script creates no doc `/docs`
   couldn't. The new doc's ydoc row is written straight to the database, which is safe only
   because nobody can have the doc open yet. An existing doc goes through the collab server
   (§5).
4. It then sets the byline and the doc's dates directly in the database.

Docs are created `PRIVATE`, so the byline is who can read them (PERMISSIONS.md).

**Created and Updated** are the session's first and last activity: the earliest and latest
timestamps on its messages and their content blocks. They are stored as the export gives
them, in UTC, which is what the columns hold; the tables render local time
(`src/lib/format-date.ts`), so converting here would apply the conversion twice. For the same
reason, never set these columns with SQL's `now()`, which writes local wall-clock time into
them.

## 4. How a session becomes Markdown

- **Title**: the session's name, whitespace collapsed; an unnamed session takes its first
  prompt's opening line, up to 80 characters, and failing that "Untitled chat".
- **First block**: the session's link, `https://claude.ai/chat/<uuid>`. It is also how an
  existing doc is matched to its session, so it has to stay first.
- **Branches**: only the branch claude.ai shows — from the most recently created leaf back to
  the root.
- **Turns**: each prompt and reply sits under a `##` heading naming its author. Headings
  inside a turn drop two levels, so they nest under it.
- **Prompts and replies are both Markdown, as claude.ai shows them**: a single newline is a
  line break, where CommonMark would join the lines. The conversion writes CommonMark's
  two-space hard break — except where the next line starts a block of its own (a list item,
  a heading, a fence), the line can't end in one (a heading, a table row, a rule), or the next
  line opens a deeper blockquote. Stored as real hard breaks, the lines stay separate in every
  renderer: the editor would show a bare newline as a break, but the static renderer would
  join it. Fences are recognised at any indentation, since replies nest them in list items.
- **A tag-like `<`** is escaped. The import shows HTML as literal text anyway (DOC_IMPORT.md
  §3), but as an HTML token it also swallows the line breaks around it. Autolinks and code
  spans are left alone.
- **Attachments** become an italic "Attached:" line with the file name. A passage quoted from
  an earlier reply (an `excerpt_from_previous_claude_message` attachment) becomes a
  blockquote, escaped as plain text.
- **Replies** leave out thinking. Each run of web searches and fetches becomes one italic line
  naming the queries and pages; other tool calls are left out.
- **Citations** go right after the span they support, where claude.ai draws its source chips:
  a link named for the source's site, in parentheses — `claim. ([example.org](…))` — with
  every source for one span in the same parenthesis. They are offsets into the raw text, so
  they are placed before anything trims or rewrites it; an end offset that falls mid-word or
  between emphasis delimiters moves to the end of the word or the delimiters. A reply's are
  `text.citations`; a research report's are kept beside its text, as the artifact's
  `md_citations`.
- **Research reports** (Markdown artifacts created with the `artifacts` tool) go in whole,
  where they were created.
- **Claude Docs documents** a session built come from `frames-000.zip`, and go at the end of
  the reply whose tool calls name them. The export wraps each in an "Untitled" heading and a
  tab marker, and writes the byline's mention of the user as "@someone"; the wrapper is
  removed and the mention becomes `HUMAN_NAME`.

## 5. Updating a doc in place

**An imported doc is never deleted and imported again.** Other docs' anchored links point
into imported docs, deleting a doc cascades away every anchor into it, and a doc imported
again gets a new id. `--update` edits the doc instead:

1. The stored body and a fresh conversion are aligned block by block (longest common
   subsequence over the blocks' JSON). Blocks that match stay as they are in the ydoc, Yjs
   identity and all; each run of blocks that differs is replaced by the conversion's.
2. The result must equal the conversion exactly, or nothing is written.
3. The edit goes to the running collab server as one Yjs update
   (`/admin/doc-apply-update`, `server/ydoc-hooks.ts`), signed as the importing account. The
   server applies it to the live doc, so anyone with the doc open sees it arrive. It stores
   the doc and answers with the update's id. Updated is then set back to the session's last
   activity. The edit is one more entry in the doc's history, so the scrub bar shows it, and
   its new blocks are attributed to the importing account.
4. Every anchored-link anchor on the doc is re-captured through `captureAnchorInYdoc`
   (`src/lib/anchors/capture.ts`), against the new version, as minting a link would. An anchor
   in a matching block moves with it. An anchor in a replaced run moves only if the run's
   positions still line up one for one — its text the same, with at most a newline become a
   hard break, which is one position either way. Otherwise the doc is reported and left
   alone, rather than the anchor guessed.

The plan is made against the doc's stored state. The server applies the update only if the
live doc is still at that state, and otherwise refuses it and writes nothing. That happens when
someone edited the doc between the plan and the write; the run lists it as not updated, and
running again plans afresh. `e2e/doc-apply-update.spec.ts` covers the endpoint: an open page
receives the edit, and a stale or read-only request changes nothing. Writing the stored rows directly instead would be wrong while the
collab server runs: if anyone had the doc open, the server's copy in memory would overwrite
the edit at its next store, and their tab would never receive it.

## 6. Deleting an imported doc

Prefer `--update`. The app has no hard delete for docs — its delete is a soft delete, to the
trash. A hard delete removes the `doc` row, which cascades to its authors, slug history,
annotations and every anchored-link anchor into it, and its `ydoc:<id>` row, plus
`ydoc:annotation:<id>` for each annotation, which have no foreign key back to the doc and
don't cascade (`scripts/test-doc.ts` does the same). Check first that nothing has been edited,
annotated, tagged, linked, posted or anchored into since the import — an edited doc's ydoc has
more than its one seed update.

## 7. What is not imported

- **Attachment files.** The export has only their extracted text, and it is not imported.
- **HTML artifacts** in `frames-000.zip`. Only Claude Docs documents a session names are.
- **Tool calls** other than web searches and fetches, and **thinking**.
- **Branches** other than the one claude.ai shows.
- **Display widgets** in a reply's text (a `…_display_v0` block, such as a comparison card)
  are not rendered; they come through as their raw text.

## 8. Markdown files

`--markdown <file.md>...` imports files instead of sessions, through everything above: the
same account and environment (§2), the same creation path, the byline from `BYLINE_EMAILS`,
and on a later run the same comparison and in-place update (§3, §5). `--plan` and `--update`
work as they do for sessions; `--export`, `--frames`, `--out` and `--dry-run` don't apply. On
a deployed instance, copy the files to the server and run the script there.

What differs from a session:

- **A file is matched to its doc by title**, because it has no link to be matched by. The
  match is a doc carrying the title the import takes from the file (DOC_IMPORT.md §4), not in
  the trash, with the importing account on its byline. So a file whose title changes imports
  as a new doc beside the old one. A file the import would title from its file name — one
  without a leading heading — is refused, since no later run could find its doc. So is a title
  two such docs share, rather than one of them being guessed.
- **The dates are the import's.** Created is when the file was imported and Updated moves with
  each update, since a file has no activity of its own to date the doc by.

A revised file is best brought in with `--update`, like a grown session: anchored links into
its doc survive the edit, and would not survive the doc being deleted and imported again.

**Quoting a PDF.** A file's quotations link their passages as PDF fragment links
([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md)), written straight into the Markdown, so the
import is the only write: `[could not yet 'call his soul his own'](/pdf/<slug>#page=122&text=could+not+yet+call+his+soul+his+own)`.

- **The page is the 1-based sheet number**, never the printed page. A booktext extraction's
  header gives the mapping ("pdf page = printed page -1").
- **The words are the quote's letters and digits, joined by `+`**, from the corrected copy
  rather than the PDF's own text: the match ignores what extraction does to words ("bea tific",
  "o f").
- **A quote longer than eight words goes as its first three and last three**,
  `text=a+direction+in,a+beatific+consummation`, and so does a quote elided with "…": its two
  ends.
- **A quote across a page break is two `page`/`text` pairs**, split where the page breaks.
- **The import stores hrefs as written and checks none of them.** Afterwards, where the import
  ran, `npx tsx scripts/integrity/check-pdf-fragment-links.ts --doc <slug>` confirms the doc's
  links. Before writing, `npx tsx scripts/pdf-fragment-link.ts <file-slug> <page> "<quote>"`
  gives one quote's link, or says where it stops matching.
- **The href carries the PDF's slug and the passage's words** to everyone who can read the doc
  (PDF_FRAGMENT_LINKS.md §10).
