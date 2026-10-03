# MultiBlog — Importing a claude.ai data export

`scripts/import-claude-chats.ts` turns each session in a claude.ai data export into a doc,
through `/docs`' own Markdown import ([DOC_IMPORT.md](DOC_IMPORT.md)), and keeps those docs in
step with later exports by updating them in place. The script's header documents its flags
and environment; this file says what it does and why.

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
3. **Import** without `--dry-run`. New sessions go through the dev server, so it has to be up
   when there are any.
4. **Update** docs the run lists as differing: `--plan` reports what `--update` would change,
   `--update` changes it (§5). Take a `pg_dump` into `.db-backups/` first. Afterwards run
   `scripts/integrity/check-annotation-anchors.ts`, `check-doc-integrity.ts` and
   `check-ydoc-integrity.ts`.

`MB_EMAIL`/`MB_PASSWORD` name the importing account, which needs `canManageDocs`.
`BYLINE_EMAILS` is the byline to give every doc, in order; include the importing account,
which the import has already put on it. `HUMAN_NAME` is the heading over each prompt.

## 3. What happens to each session

1. It is converted to Markdown (§4). A session with nothing to show is skipped.
2. If a doc already opens with the session's link, the two are compared: the session's
   Markdown is parsed and round-tripped through Yjs exactly as an import would store it, and
   compared with the stored body regardless of JSON key order (jsonb doesn't keep it). The same
   is up to date; a difference is listed, or with `--update` applied in place.
3. Otherwise the importer signs in and posts the Markdown to `/docs`' Import Markdown form the
   way a browser without JavaScript does, replaying the form's hidden server-action fields. The
   app parses it, seeds the doc, and derives the slug from the title — nothing about the doc's
   creation is reimplemented here.
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
3. The write follows the collab server's own sequence: `ydocStore.appendUpdate`,
   `drainAppends`, `storeState`, then `updateDocCache` (`server/ydoc-store.ts`,
   `server/doc-cache.ts`), and Updated is set back to the session's last activity. The edit is
   one more entry in the doc's history, so the scrub bar shows it.
4. Every anchored-link anchor on the doc is re-captured through `captureAnchorInYdoc`
   (`src/lib/anchors/capture.ts`), against the new version, as minting a link would. An anchor
   in a matching block moves with it. An anchor in a replaced run moves only if the run's
   positions still line up one for one — its text the same, with at most a newline become a
   hard break, which is one position either way. Otherwise the doc is reported and left
   alone, rather than the anchor guessed.

It writes ydocs directly, so the collab server must be down: a running one could be holding
the doc in memory and write its own copy back over the edit. `--update` refuses to run while
the collab port answers. `npm run stop:all` stops it; check first that nobody else, an e2e run
included, is using the servers.

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
