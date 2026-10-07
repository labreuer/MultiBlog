# MultiBlog — an MCP server for machine clients

**Status: planned; nothing here is built.** Like [ANCHORED_LINKS.md](ANCHORED_LINKS.md), this
file is the plan until the build and is then rewritten as built.

The purpose is narrow: to let Claude put research into MultiBlog over HTTPS with a token —
docs, PDFs, annotations, anchored links, tags, bylines — and to find and read it again as a
source for later research. Putting it in takes `scripts/import-claude-chats.ts` and
hand-written scripts run on the server itself today ([CLAUDE_IMPORT.md](CLAUDE_IMPORT.md)), and
reading it back has no path short of the database. **The web app is not routed through the MCP
server, and may never be.** That is why most of this file is about how the two share code rather
than duplicate it.

**The MCP server is one endpoint**, beside plain HTTP routes for what shouldn't pass through a
model: a file's bytes either way, a Markdown draft in, and docs out in bulk. There is no REST
API (§5).

## 1. Where the MCP server sits

Headless CMSs relate their API to their admin UI in one of three ways:

| Shape | Examples | What gets duplicated |
|---|---|---|
| **API-first**: the admin UI is itself a client of the public API | Directus's Data Studio, Sanity Studio, Ghost Admin, Strapi's admin | Nothing, by construction |
| **One operation layer, several front doors**, each handing the operation an explicit actor | Payload 3 (its Local API takes `user` and `overrideAccess`, with REST and GraphQL in front, and the whole CMS lives inside a Next.js App Router app); Keystone 6 (`context.withSession()`, `context.sudo()`); Directus's services (`accountability`) | Only each front door's glue |
| **A second front door with handlers of its own** | WordPress: wp-admin's form handlers and the REST controllers both call `wp_insert_post()`, each with its own permission glue | The glue, and every rule that lives in it |

**MultiBlog takes the middle row**, with two front doors: the web app's server actions and the
MCP endpoint. The alternatives, and why each is rejected:

- **API-first.** Ruled out by the premise. The UI is server components, server actions and a
  websocket, and routing it through an API would be a rewrite for no gain.
- **A second front door.** The duplicated part is exactly where the rules hide (§2's list),
  and drift there is a security bug rather than a cosmetic one. WordPress 4.7's
  unauthenticated content-injection hole (2017) was in the REST API's own permission code, not
  in what it shared with wp-admin.
- **A bearer-aware `auth()`, with tools calling the server actions.** The actions are shaped
  for the UI: some take `FormData` or end in a `redirect()`, and errors come back as strings
  for a form. And a token-aware `auth()` would open every action, including the browser-only
  ones, to token callers.

The middle row is close to how the code is already factored:

- **Every permission predicate already takes identity explicitly**, as `(userId, role, …)`:
  - `canUserReadDoc` and `canUserEditDoc` (`src/lib/doc-authz.ts`)
  - `canUserReadFile` and `canUserManageFile` (`file-authz.ts`)
  - `canUserAccessAnnotationYdoc` and `canUserEditAnnotationBody` (`annotation-authz.ts`)
  - `canUserTagTarget` and `canUserRemoveAssignment` (`tag-authz.ts`)
  - the anchored-link predicates (`anchored-link-authz.ts`)
- **Every read rule has one exported `where` helper** beside its per-row check:
  `readableDocsWhere`, `readablePostWhere`, `readableFilesWhere`, `readableAnnotationsWhere`
  and `publicCommentsWhere`. The MCP server's lists filter through the same statement of each
  rule as the UI's.
- **One operation already has the target shape.** Full-text search's `search(actor, params,
  opts)` is a plain module taking an explicit actor, and the page, the quote picker and this
  MCP server all call it (§14).
- **Identity comes in three shapes**: `{ userId, role }` for `search`, `{ id, role }` for
  `anchoredLinkForViewer` and `canUserReadComment`, and positional arguments for the
  predicates above and `browseTag`. The actor is one type, with an adapter for each shape, so
  no call site reshapes it by hand.
- **Much of the machinery takes identity as an argument or needs none:**
  - `createDocWithContent` (`src/lib/doc-create.ts`)
  - `captureAnchorInYdoc` and `capturePdfTextAnchor` (`src/lib/anchors/capture.ts`)
  - `markdownToDocContent`
  - the annotation helpers that call the collab server (`src/lib/annotation-admin.ts`)
- **The collab server's trust model needs no change.** Its `/admin/*` endpoints trust a
  two-minute ydoc JWT (`src/lib/ydoc-token.ts`) that the Next process mints *after*
  authorizing. An operation authorizes the same way and mints the same token. The one
  addition is §6's targeted-edit endpoint, a sibling of `/admin/annotation-mark` that trusts
  the same token.

What is bound to the session is the server actions' *bodies*. Each calls `auth()` and then
does its work inline. Extracting those bodies into functions that take an actor is the whole
refactor.

**The extracted functions go in plain modules, never as exports of a `"use server"` file.**
Every export of an action module is callable from any browser with any arguments, and these
functions take a `userId`. `doc-create.ts`'s header states the same rule for the same reason.

**An operation builds each Prisma write's data from named fields, never from its input.** A
tool's arguments are whatever JSON the client sends, as a server action's are, and Prisma
follows relations, so input passed through can write another table: a doc-link update could
once make its owner an ADMIN that way (`src/lib/doc-link-edit.ts`). That holds after zod (§4)
too: whether a schema strips a key it doesn't name is a per-schema setting, and nothing checks
it. `npm run check:prisma-data`, part of `npm run check`, fails a write whose data is a
parameter, and covers `src/lib` as well as the actions, because an extracted body takes its
caller's input with it.

## 2. What is shared, what moves, what is new

These are estimates from reading the code, in lines of code excluding comments.

| Area | Shared unchanged | Moved once, out of an action or script | New, MCP-only |
|---|---|---|---|
| Search | `search()` and `parseSearchParams`; the five `where` helpers | — | A strict parse ahead of the page's lenient one; one handle on each hit, with a parent and status on an annotation's and a writer's slug only for a named account; a file restriction; a tag filter; page labels on page hits; ranking one doc's sections; saying what an author filter left out (~100); the projection a model reads, each doc hit with its size (~40) (§4, §6, §14) |
| Posts and comments (read only) | `readablePostWhere`, `publicCommentsWhere`, `canUserReadComment`, `canUserReadDoc`; `isCommentVisiblyEdited`, `edit-grace.ts`, `commentContentToMarkdown`, `loadCommentQuoteCitations` | `getCommentHistory`'s and `getCommentMarkdown`'s bodies (~50), with their gate over `canUserReadComment` | Reading a post (~40); a post's public threads (~50); reading a comment (~30) (§13) |
| Docs | The doc predicates; `search()` for finding and listing docs; `createDocWithContent`; `markdownToDocContent`; `changeDocSlug`; `diffText` | The bodies in `src/app/actions/docs.ts` (~100) | Doc → Markdown and → text; the outline, with its sizes, leads and depth, and ranged reads (~150); changes since a version, as word diffs naming their writers (~90); the export, with its catalog (~90); the targeted-edit collab endpoint, with its word-level diff, its annotation marks, its per-block write-back and passages named by their ends (~200); what an edit touched (~70); reverting an edit (~60); the author mark on what the MCP server writes (~30); the create in one transaction, with its byline and its seed's clients (~40); records (~20); the importer's guard and its match by key (~45) (§6) |
| Annotations | The predicates; both captures; the collab helpers; `seedAnnotationYdoc`; `edit-grace.ts`; the `annotation-data.ts` loaders | ~550–600 from `src/app/actions/annotations.ts`: the post and settle core, draft creation, edit begin/finish/cancel, delete/restore, history. The core's helpers (`settleAnnotationBody`, `writeSettledBody`, `parentSettledMark`, `postFileAnnotation`) are private but already take identity | Markdown → annotation body (~35); seeding a body from JSON, with its Yjs client registered (~15); an attributed `/admin/annotation-replace` that refuses a read-only token (~35); a container's threads, or every readable container's, filtered, ordered and paged (~80); what and where each annotation is, on a read, and a lost mark's passage at its version (~65) (§9) |
| Anchored links | `anchoredLinkForViewer`, `anchoredLinkLandingFor`, the delete and rename predicates, `normalizeLinkName` | ~190 from `src/app/actions/anchored-links.ts`: `canUserLinkTarget`, `resolveCaptureStamp`, the part capture inside `addAnchoredLinkPart`, the mint preconditions, rename, delete | Minting one or more links in one transaction (~50); reading a link, its doc parts resolved (~50); "links into this target" (~55), lifted out of `/links`' page |
| Tags | `canUserTagTarget`, `canUserRemoveAssignment`, the role floors, the `tag-data.ts` reads, `browseTag` | ~150 from `src/app/actions/tags.ts`: `writeWholeObjectTags`, the `createTag` core, the apply gate, untag | Search's tag filter, and tags on every read (~40); tag slug history (~30) (§11) |
| PDFs | The file predicates, `storeUploadStream`, `extractPdf`, `storedPageText`, `claimFileSlug`; `extractPageItems` and `quadsForRange` for server-side quads ([PDF_QUADS.md](PDF_QUADS.md)); `resolvePassage`, and `FragmentChecker` for fragment links ([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md)) | The upload route after its session check, role check included, into `ingestUpload` (§8); the byte route's body, out of `/api/files/[id]/[hash]` (§5); `setFileDeleted`'s restore-and-rename; `buildQuote`, with `normaliseNeedle` for its fallback, out of the `"use client"` `pdf-anchor-capture.ts` into an isomorphic module | Page labels, read as ranges; the outline, with its depth (~70); a fragment link read as its passage (~30); the quote locator, with `resolveAll` exported for every occurrence (§8); checking a page's items against its stored text before computing quads (~15); changing a file's owners, which nothing does today (~40) (§12) |
| Cross-cutting | — | — | Tokens and scopes (~200); the actor, with an adapter for each shape identity takes (~60); idempotency, with `api_write` (~80); byte grants, and an audience on the ydoc token (~65); the quote resolver, with the matcher's new entry points, passages named by their ends, and a capture over a built node (~230) (§7); the MCP layer: the tools, `read`'s URL resolution and the byte routes (~600) |

The totals:

- **About 1,200 lines move**, once. Afterwards each action is a three-to-five-line wrapper:
  `auth()`, build the actor, call the operation, then the UI's own `revalidatePath` and
  `redirect`.
- **About 2,450 lines are new capability** the UI has no counterpart for.
- **About 600 lines are the MCP layer** (§15): some seventeen tools, `read`'s URL
  resolution, and the byte routes.

What remains duplicated is only each front door's glue: where the identity comes from, how
input is parsed, and how an error is shaped.

Re-implementing instead of extracting would duplicate those 1,200 lines, and they are where
the rules are:

- A DRAFT annotation is its owner's alone, even from an ADMIN. The delete path misses this
  today (§17, item 4), and the extraction fixes it.
- An annotation's version stamp is chosen in a fixed order: the client's version, then its Yjs
  snapshot, then the parent's settled mark for a reply, then the log's tail.
- Version 1 of a body, `postedAt` and the anchor are written in one transaction.
- Each creator has at most one open anchored link, and a minted link never drops to zero parts
  (`FOR UPDATE`).
- Tag names are unique case-insensitively, and a soft-deleted term still holds its name.
- Restoring a file whose slug has since been taken renames it.
- A doc keeps at least one author.

**Cache invalidation barely enters into it.**

- `/doc/[slug]` and `/pdf/[slug]` render per request, and `anchored-links.ts` deliberately
  revalidates nothing.
- The one write in scope that touches a statically generated page is tagging a published
  post, which is `manage` (§11). The page has `revalidate = 60` with `generateStaticParams`,
  and `revalidatePath` works from a route handler, which is what the MCP endpoint is.
- An operation a script also calls, as the importer calls `createDocWithContent`, leaves
  revalidation to its callers, because revalidating needs a Next request to run in.

## 3. Tokens

- **A table, `api_token`.** Its columns: `user_id`, `name`, `token_hash` (SHA-256, unique), a
  display prefix, `scopes` (`read`, `write`, `manage`), `expires_at`, `revoked_at`,
  `last_used_at`, `created_by_user_id`, `client`. The secret is `mb_` followed by 32 random
  bytes, and it is shown once, at issue.
- **The issuer is part of the token.** `created_by_user_id` is who issued it: for a person's
  own token, that person; for a bot's, the person the bot works for. It decides who else
  `write` may give access to (below).
- **So is the client it was issued for.** `client` is `claude-code`, `claude-ai` or `other`,
  set at issue: by the script's `--client`, which defaults to `other`, or by the OAuth consent
  page, which sets `claude-ai` (§5). Only a `claude-code` token lists the tools that force a
  prompt, since Claude Code is the one client documented to honor the flag (§15). The token
  decides rather than the request, because a stateless server sees the client's `clientInfo`
  only in `initialize`, never in the `tools/list` and `tools/call` that follow (§5).
- **SHA-256, not bcrypt.** A 256-bit random secret gives key stretching nothing to protect,
  and a fast hash makes the lookup a single unique-index hit.
- **Bound to a user, narrowed by scope.** The binding follows WordPress's Application
  Passwords and Payload's and Directus's per-user keys. The narrowing follows GitHub's
  fine-grained tokens and Strapi's read-only tokens. A token's effective permission is its
  user's, intersected with its scopes, so it can never do what that user's session couldn't.
- **Three scopes**, one for each kind of harm:
  - `read`: every read and every search, and the export (§6).
  - `write`: creating a doc, a file, an annotation, a link or a tag; editing content — a
    doc's text and title, an annotation's body, a link's name and parts, a file's title;
    tagging and untagging. **A doc or file is created PRIVATE**, with no one on its byline or
    owner list but the actor and the token's issuer: the actor first by default, or the issuer
    alone when they ask (§12).
  - `manage`: changing a doc's or file's visibility, byline, owners or slug, or whether a doc
    is a record (§6); tagging a published or scheduled post (§11); and deleting or restoring
    a doc, file, annotation or link. **Creating something SHARED is `manage` too**, and so is
    naming anyone else on a new byline or owner list: a create always makes a PRIVATE object,
    and sharing it is a `manage` call afterwards (§15).
- **Claude's token has `read` and `write`, never `manage`.** Claude reads text that other
  people wrote, public commenters included (§13), so an instruction planted there must not be
  able to change who can see something.
  - **No doc or file that `write` creates is seen by anyone but the actor and the token's
    issuer.** What it adds to an existing object is seen by whoever sees that object: an
    annotation by its container's readers, a tag wherever its object is shown. That is why
    `write` tags no published or scheduled post, whose page is public (§11).
  - **Taking someone off a PRIVATE doc's byline would lock them out** with no way back through
    the app: changing a byline needs `canUserEditDoc`, which on a PRIVATE doc is the byline
    alone.
  - The MCP endpoint lists only the tools a token's scopes allow (§5).
- **One check authenticates every request**, to the MCP endpoint and to every byte route,
  whether the request carries the token or a grant made from it (§5):
  - the token, looked up by its hash, neither revoked nor expired;
  - then its user, in a query of its own through the filtered client,
    `prisma.user.findUnique({ where: { id } })`. The soft-delete `$extends` filter adds
    `deletedByUserId: null` there, so a deleted user isn't found and the request is refused.
    Never `include: { user: true }` on the token's query: the filter intercepts top-level
    queries only, and an include goes around it ([prisma.ts](../src/lib/prisma.ts)).
  - The role comes from that same row, read on every request. The usual lags don't apply: the
    session JWT bakes the role in at sign-in ([sign-in notes](../src/app/sign-in/NOTES.md)), and
    a live collab connection is checked only once ([PERMISSIONS.md](PERMISSIONS.md)). A
    deletion or a demotion therefore takes effect on the token's very next call.
- **Soft-deleting a user revokes their tokens**, in the same transaction. `deleteUser`
  (`src/app/actions/users.ts`) is a single update today, so it becomes a transaction;
  `bulkDeleteUsers` calls it once per user and needs nothing of its own. Restoring the account
  brings none of the tokens back, since a token may be why it was deleted; a new one is issued
  instead.
- **A spec holds both:** a call that works; the user soft-deleted, and the call refused, along
  with a byte grant minted before the deletion; the user restored, and the call still
  refused.
- **Bearer only.** The MCP server never accepts the session cookie, so it has no CSRF surface to
  defend. The byte routes take a grant or the bearer token, and never the cookie either.
- **No ydoc token ever leaves the server.** Each operation mints one per call for the actor,
  after the same predicate `/api/doc/[id]/token` checks, and calls `/admin/*` over loopback
  (`collabHttpOrigin`).
- **Tokens are issued by a script first**: `scripts/create-api-token.ts --email …
  --issued-by … --name … --scopes … --client …`. Later come a `/dashboard` panel for your
  own tokens and a `/users` action for an admin issuing one to a bot account.
- **Claude gets its own account, an AUTHOR, and never a person's token.** That keeps
  attribution honest: bylines, `userId` columns and Yjs `clients` entries all name Claude. It
  also keeps the anchored-link tray from colliding. A person's open link includes a minted
  link they have reopened for editing, and an agent writing as them would add parts to it.
  What that account can read, and how it comes to be on the lists that decide that, is §12.
  - **It has no password.** Sign-in is by password alone (`src/lib/auth.ts`), so nothing signs
    in as Claude. An ADMIN's invite is the one thing that would set one, and it needs no
    mailbox, since `/users` shows the invite's link.
  - **AUTHOR is enough for everything it does.** The importer, which runs as the same account,
    needs only `canManageDocs`, and an AUTHOR has it. Its role is also the only role limit its
    tokens have, since a token acts with its account's current role: promoting the account
    widens every token issued for it.
- **If OAuth comes, it is a way of issuing rows in this table**, not a second auth system
  (§5).

Ghost's design, in which the client signs a five-minute JWT from its key so the secret never
travels, buys nothing over an HTTPS bearer token here and is not adopted.

## 4. The envelope

- **One endpoint, and tools rather than paths.** `/api/mcp` serves every operation as a tool
  (§15). A client reads the tools' schemas afresh each session, so a tool can change shape
  without a version number. What has to stay in step with the tools is §5's server
  instructions, and they ship with the same code.
- **Objects are named by URL or by id**, in every tool. A URL may carry a past slug: every
  kind with slug history is followed through it, as its own reading route follows it (§15).
- **Errors** are tool results with `isError` set and a body of `{ code, message, … }`:
  - `invalid` for malformed input, and `unknown_author` for an author not on the picker
    (§14);
  - `not_found`;
  - `conflict` when a name is taken, as a soft-deleted tag's still is (§11);
  - `ambiguous` for a quote that occurs more than once, with up to five occurrences' context
    and how many there are, and `no_match` for one that occurs nowhere, with up to three near
    misses (§7), or for a fragment link whose passage isn't on its page (§8);
  - `read_only` for an edit to a record (§6);
  - `already_done` for a write that repeats one made within a day, with that one's time and
    result (below);
  - `too_large`.

  The byte routes answer with the HTTP status that fits instead (§5).
- **An object the actor may not read is `not_found`**, the same as one that does not exist.
  `canUserLinkTarget` likewise answers the two alike, and it stops a token from probing for
  PRIVATE titles.
- **Versions travel as decimal strings.** A `ydoc_update` id is a `BigInt`, and JSON numbers
  can't hold one.
- **A write that adds something is refused when it repeats within a day.** An agent that
  times out and retries would otherwise make a second doc, a second link or a second append,
  and through MCP it has no header to resend and no reason to keep a random key.
  - **It covers only the writes that add something**: `create_doc`, both upload routes,
    `annotate`, `create_link`, `add_link_parts`, and `edit_doc`, whose appends and insertions
    add text. Every other write changes nothing more when repeated (`tag`, `untag`,
    `edit_file`, `edit_link`, `edit_annotation`, `manage`), so a repeat of one simply runs:
    tag, untag and tag again leaves the tag on.
  - **Each covered write is a row in `api_write`**, under its token and a key (the schema
    below).
  - **The key is a hash of the operation and its canonical arguments**, unique under the
    token. An upload keys on its bytes' hash and its parameters.
  - **A repeat is refused, never replayed.** It answers `already_done` with the first call's
    time and result, and does nothing. A retry after a timeout learns from the result what it
    needed, and a write meant to happen twice is never swallowed as a success. A byte route
    answers 409, with the same body.
  - **To repeat on purpose, a write passes an `idempotencyKey` of its own**, any string not
    used before, which is hashed in place of the arguments. A retry of that repeat sends the
    same key and is refused in its turn, so the repeat is protected as the first call was. A
    flag would not be: a retry of `repeat: true` would run again.
  - **Inserting the row is the claim.** A covered write inserts its row as `RUNNING` before it
    does anything, and the unique `(token_id, key)` refuses a second. A repeat that collides
    reads the row:
    - `DONE`: it answers `already_done`, with the row's `result`;
    - `RUNNING`: it waits for the row to finish, then answers the same way. A `RUNNING` row
      older than the longest a write can take, five minutes, died with its process, and the
      repeat takes it over;
    - `FAILED`: the write runs again. The refusals in the error list above all come before
      anything is written, so a failed write did nothing.
  - **A key is good for a day.** A claim that collides with an older row nulls that row's key
    and claims again. Postgres lets any number of rows share a null in a unique index, so the
    row itself stays. Whether old rows are ever deleted is §19's audit question.

    ```prisma
    model ApiWrite {
      id         String        @id @default(cuid())
      tokenId    String        @map("token_id")
      key        String?
      operation  String
      state      ApiWriteState @default(RUNNING)
      result     Json?
      createdAt  DateTime      @default(now()) @map("created_at")
      finishedAt DateTime?     @map("finished_at")

      token ApiToken @relation(fields: [tokenId], references: [id])

      @@unique([tokenId, key])
      @@index([tokenId, createdAt])
      @@map("api_write")
    }

    enum ApiWriteState {
      RUNNING
      DONE
      FAILED

      @@map("api_write_state")
    }
    ```

    - `key` is a SHA-256 in hex, and null once its day is up.
    - `operation` is the tool's name, or the byte route's method and path.
    - `result` is what the write answered: its `structuredContent`, or a byte route's JSON
      body. A write answers with ids, URLs and a `version`, never a body, so it is kept whole.
    - `(token_id, created_at)` is the order of a token's writes, for anything that lists them.
- **Audit** has two parts:
  - `last_used_at`, written at most once a minute;
  - one structured log line per tool call or byte request: token prefix, user, tool or route,
    outcome, duration.
- **Each token has an in-memory rate limit** (one web process per instance). It is mostly
  there to stop a runaway loop, since decoding a long doc, rebuilding one to anchor in it, and
  parsing a PDF page are expensive. It allows a burst: Claude Code runs read-only tools
  concurrently (§15), so a sweep arrives as several reads at once.
- **Arguments are checked with zod**, one schema per operation, which becomes the tool's
  `inputSchema`; a second becomes its `outputSchema`. zod becomes a direct dependency; it is
  only transitive today, through `eslint-config-next`. zod checks only the envelope. The domain
  parsers stay the trust boundary for what they parse: `parseSelector`, `parsePdfTarget`,
  `parseCommentBody`. A parsed argument is still never a write's data (§1).
- **A result is its `structuredContent`**, which matches the `outputSchema` and is what tests
  assert on. The text block beside it is that object serialized, as the MCP spec asks of a
  tool with structured output.
  - **The structured form is what the model reads.** Claude Code hands its model
    `structuredContent` alone ([anthropics/claude-code#55677](https://github.com/anthropics/claude-code/issues/55677),
    closed as not planned), so a separate rendering for the model would never reach it.
  - **It arrives as compact JSON**, `JSON.stringify` with no indentation (Claude Code 2.1.292,
    measured with a probe server). So what a result costs beyond its text is its keys and
    identifiers. A Markdown body wrapped in JSON costs about 5% more than the body alone, where
    twenty search hits as one object each, with every field, spent two thirds of their tokens
    outside their snippets.
  - **So it is shaped for reading:** a body is one Markdown or text string, never a tree of
    nodes; a snippet is one string with its matches marked (§14); and a field stays flat
    wherever nesting would only add keys.
  - **And it is lean.** A result says each thing once, and only what the model uses:
    - an object has one handle: its URL, which every tool takes, or its id where no URL names
      it for good (§14);
    - what a group shares is said on the group: threads under the heading their passages sit
      in (§9), a PDF's page hits under the file (§14);
    - a byline is one string of names, and a date is a day, or a minute in a thread (§9, §14);
    - what only the search page needs, such as its author picker, is never returned (§14);
    - every list inside an answer is capped, the error lists above included, and a longer one
      pages (§6, §9, §10).

    A spec holds each kind of result to a size budget, so a field added later has to earn its
    place (§18).
- **Reads are bounded twice.** A read with no range returns a doc whole only up to 40,000
  characters, about 10,000 tokens, where Claude Code starts warning; a longer doc answers with
  its outline and its size (§6). `whole: true` lifts that to the bound itself, 200,000
  characters measured as the serialized `structuredContent`. A doc longer still answers with
  its outline, and a range that long with its first part and where to continue.
  - **Why a lower default.** A result stays in the conversation, and is read again on every
    later turn until the conversation is compacted, so a first read should cost no more than
    deciding how to read the doc. Of the 333 imported docs, 319 are under 40,000 characters;
    the other 14 hold 803,000 of the 3.3 million, and an outline names their parts.
  - **Claude Code takes up to 200,000 once the tool says so.** It saves a result longer than
    50,000 characters to a file, unless the tool declares `_meta["anthropic/maxResultSizeChars"]`,
    up to 500,000, which applies apart from `MAX_MCP_OUTPUT_TOKENS`' 25,000-token limit. `read`
    declares 200,000; every other tool stays under 50,000.
  - **A saved result can't be read in parts.** The file holds the result as one line of JSON,
    and the model gets its path and a 2 KB preview in its place. So no tool relies on the file:
    each bounds what it returns.
  - **The ceiling's cost.** 200,000 characters is about 50,000 tokens, a quarter of a
    200,000-token window in one call. It is room for a long doc a task needs whole: the longest
    imported chat is 88,000 characters.
  - **claude.ai's limit isn't documented**, so it is measured before phase 5 (§18).
- **Lists** take `limit`, 20 by default and at most 100, and an opaque `cursor`. Search pages
  by rank, at most 20 at a time (§14).

## 5. Front doors: MCP, and routes for bytes

- **MCP at `/api/mcp` is the contract**, in the same Next process.
  - Each tool calls its operation in-process.
  - It uses stateless Streamable HTTP: a fresh server and transport per request, the official
    SDK's stateless mode. The SDK, `@modelcontextprotocol/sdk`, is a new dependency. The
    server is built after the token is checked and lists only the tools that token's scopes
    allow, so Claude's token never sees `manage` (§3).
  - Each tool carries MCP's hints, and the few whose actions can't be undone force a prompt in
    Claude Code (§15).
  - Claude Code's configuration names the server, and a `headersHelper` supplies the header,
    so the token is in neither the configuration nor the environment (below):

    ```json
    {
      "mcpServers": {
        "multiblog": {
          "type": "http",
          "url": "https://<host>/api/mcp",
          "headersHelper": "~/.config/multiblog/headers.sh"
        }
      }
    }
    ```
- **Bytes travel over plain HTTP routes**, because a tool's arguments and results pass
  through the model. A PDF can't; a draft Claude has refined in a local file shouldn't have to
  be typed out again; and a whole corpus is too much for one context.
  - `POST /api/mcp/files?filename=…` uploads a raw request body
    (`curl --data-binary @paper.pdf`), with the `write` scope: a PDF or a .docx, as `/files`
    takes. It is `ingestUpload` (§8) behind the token, and takes the title, and whether the
    issuer is to be the only owner, in the same request. The file is PRIVATE (§3, §12).
  - `GET /api/mcp/files/<id or slug>` downloads, with the `read` scope. It is the body of
    `/api/files/[id]/[hash]`, which `/files/<slug>/download` only redirects to: its gate,
    which answers 404 for a file the reader can't see, and its streaming, Range and ETag, whose
    helpers are private to that route today. The route reads the session through `auth()`,
    so its body moves out to take an actor.
  - `POST /api/mcp/docs?title=…` creates a doc from a Markdown request body
    (`curl --data-binary @summary.md`), with the `write` scope. It is `create_doc`'s operation
    (§6), the byline's choice included, and the doc is PRIVATE.
  - `/api/mcp/export` answers with a tar of docs as files, or with `catalog`, each doc's id,
    slug, title, size and `version` (§6). It takes `search`'s filters as a `GET`, or a list of
    ids or URLs as a `POST`, with the `read` scope.
  - Each takes a grant from `upload_url` or `download_url` (§15), or the endpoint's bearer
    token from a program that holds one, such as a local script that refreshes an export.
    Nothing else under `/api/mcp` answers outside MCP.
  - **A grant stands in for the token on one route, for ten minutes.** The tool answers with
    the route's URL, the grant in its query string, and Claude adds the route's own
    parameters and body, as it would with the token.
    - It is a JWT signed as the collab server's ydoc token is (`jose`, HS256, `AUTH_SECRET`;
      `src/lib/ydoc-token.ts`), with an audience of its own. It carries the token's id, the
      route and the expiry, and nothing else.
    - **The ydoc token gains an audience too**, checked wherever it is verified, so neither
      passes for the other. It has none today, so a grant shown to the collab server would be
      stopped only by lacking a `documentName`. Both processes take the change in one deploy,
      and a ydoc token lives two minutes.
    - The route checks the signature and the expiry, then runs §3's one check on the token it
      names. So revoking the token, or deleting its user, ends its grants at once.
    - A grant in a URL lands in access logs. It opens one route for ten minutes, where a
      token in a URL would open everything until revoked: that difference is why one is
      acceptable and the other isn't (the claude.ai bullet below).
- **The token stays out of Claude's shell.** A forced prompt guards a tool, not the endpoint
  (§15). A shell that holds the token can post the same `tools/call` itself, and in auto mode
  that command goes to a classifier rather than to the person. So nothing Claude runs needs
  the token: the byte routes take grants, and the client keeps the token where only its own
  connection reads it.
  - **A file only the connection reads.** The token lives in
    `~/.config/multiblog/<server>.token`, readable by its owner alone, and the
    `headersHelper` prints the header from it:

    ```sh
    #!/bin/sh
    printf '{"Authorization":"Bearer %s"}' \
      "$(cat "$HOME/.config/multiblog/$CLAUDE_CODE_MCP_SERVER_NAME.token")"
    ```

    Claude Code runs the helper outside the Bash sandbox at each connection, and again after
    a 401 or 403 before retrying the call once, so a token replaced in its file is picked up
    without a restart. One helper serves every instance, since Claude Code passes the
    server's name in `CLAUDE_CODE_MCP_SERVER_NAME`.
  - **Settings that keep the file from the model**, in `~/.claude/settings.json`:

    ```json
    {
      "permissions": { "deny": ["Read(~/.config/multiblog/**)"] },
      "sandbox": {
        "enabled": true,
        "allowUnsandboxedCommands": false,
        "failIfUnavailable": true,
        "credentials": { "files": [{ "path": "~/.config/multiblog", "mode": "deny" }] },
        "network": { "allowedDomains": ["<host>"] }
      }
    }
    ```

    - `sandbox.credentials` denies the directory to every command Claude runs, enforced by
      the operating system. On Linux the sandbox needs `bubblewrap` and `socat`. Claude Code
      honors `credentials` only from user and managed settings, never a project's, which is
      why these live in `~/.claude/settings.json`.
    - `allowUnsandboxedCommands: false` stops a command from asking to run outside the
      sandbox.
    - `failIfUnavailable: true` makes Claude Code stop with an error when the sandbox can't
      start. Otherwise it runs every command unsandboxed, and the token's file is readable.
    - The Read deny rule covers Claude's own file tools, which run outside the sandbox.
      Claude Code applies it to Grep and Glob on a best-effort basis.
    - `allowedDomains` lets curl reach the host with a grant. Nothing in the shell holds the
      token.
- **There is no REST API.** Nothing would call one, and a contract nobody calls goes stale
  without anyone noticing. The operation layer keeps one cheap to add if a client that isn't
  an agent ever needs it: a route would be a parse and a call, as a tool is.
- **There is no sidecar process.** [DEPLOY.md](../DEPLOY.md)'s target is a 1 GB instance,
  where memory is what runs out, and a second Node process costs tens of MiB before it does
  anything.
- **claude.ai comes after Claude Code, and needs OAuth.** It is where the research
  conversations happen, so it is the client that makes the round trip seamless. Claude Code
  comes first only because a header is all it needs, and Claude Desktop reaches the server
  through a local bridge that adds the header.
  - **What it takes.** claude.ai's custom connectors authenticate with OAuth: PKCE, plus one
    of dynamic client registration, a client ID metadata document, or a client registered by
    hand. Supporting them makes MultiBlog an OAuth authorization server, consent page included.
  - **Neither shortcut is open.** Anthropic's connector documentation lists a static header
    only as a beta for a limited set of organizations. A secret in the connector's URL would
    put a credential where URLs get logged, which is why the MCP authorization spec forbids
    one in a query string.
  - **The consent page issues the token for Claude's account**, not for whoever is signed in.
    The natural grant would bind it to the person approving, and everything claude.ai wrote
    would then carry that person's name (§3). So the page offers the accounts its user may
    issue for, as the `/users` action does, and records the user as the issuer.
  - **What it issues is an `api_token` row** (§3), with the same scopes, expiry and
    revocation: OAuth is a way of issuing rows in that table, not a second auth system.
  - **Its tokens are issued for `claude-ai`**, so they list none of the tools that force a
    prompt (§15).
- **Server instructions carry the conventions.** An MCP server returns `instructions` when a
  client connects, and Claude Code loads them at session start, before any tool's definition,
  so they also tell Claude when to reach for these tools. Shipped that way they deploy with
  the code they describe and can't drift from it.
  - **They are the one part of the server every session reads.** Claude Code defers MCP tools
    behind its tool search by default, however few a server has: a session sees each tool's
    name and the instructions, and loads a tool's description and schema when it first needs
    it. `search` and `read` are the exception (§15, §16).
  - **Claude Code cuts them off at 2,048 characters**, and each tool's description at the
    same length. The cap is on the description string alone: a tool's input schema reaches the
    model whole, so the detail of `read`'s URL forms and options goes on its parameters.

  So the instructions are short and lead with what matters most:
  - whose account the session acts as, and who issued its token (below);
  - what the server holds, and when to use it;
  - the conventions for a summary doc: the prompt quoted at the top; Claude first on the
    byline and the human second, or the human alone when they ask; `/doc/<slug>` for whole
    docs, minted links for sections, and fragment links for PDF passages (§8);
  - anchoring a section on its heading's text, a claim on its sentence, and a long passage by
    its first and last words, quoting from a `text` read (§6, §7);
  - reusing an existing link before minting another;
  - searching before creating, with `exact=1` whenever the question is whether something
    exists (§14);
  - that `already_done` means the write happened already, and that doing it again on purpose
    takes an `idempotencyKey` of its own (§4);
  - the byte routes, through a URL from `upload_url` or `download_url` and then curl: a file up
    or down, a Markdown draft in, and an export, or its catalog, before a sweep that must read
    every doc.
- **They name the actor and the issuer.** The server is built after the token is checked
  (above), so its instructions can say whose account the session acts as and who issued the
  token, each by name, and by slug when it has a name (§14), read from those two rows. "My
  annotations" then needs no lookup. The names come from the token, not the code: a token
  issued by someone else names them.
- **A convention about one tool goes in that tool's description**, under the same cap.
  `annotate`'s and `edit_doc`'s say that acting on a note means replying to it: what was done,
  and a link to the passage or the doc it went into (§9). `search`'s says that a doc hit's
  passage is one `read` away, `around` a phrase from its snippet (§14).
- **No Claude Code skill is needed.** Everything one would have carried fits in the
  instructions; a skill earns a place only for steps that depend on the local machine.

## 6. Docs, through the collab interface

**Reading.** The doc is read from its `ydoc` row, the state the collab server stores, decoded
with `docContentExtensions`. Nothing is replayed from the update log: an agent needs the text,
not the text exactly as of one log entry, and anything it then changes goes through the collab
server, where Yjs merges it with whatever else has happened. A read of the whole doc or of its
outline carries the metadata, its id and slug among them, the byline, the doc's tags (§11), and
`version`. A ranged read
carries `version` and its range alone, since the rest came with the first read.

- **How current it is.** When nobody has the doc open, the row is the doc. When someone is
  typing, it trails their text by the store debounce: two seconds of quiet, or ten at most
  ([DOCS.md](DOCS.md)). A write through the MCP server stores the doc as its direct connection
  closes, so a read after one sees it.
- **`version` is the exact version of the bytes read**: the log entry whose state they are.
  `resolveUpdateIdForSnapshot` (`src/lib/ydoc-version.ts`) finds it from the decoded doc's Yjs
  snapshot, walking forward from the row's own checkpoint, its `last_update_id` and state
  vector. The stored bytes can be past that checkpoint, never behind it, so the walk is
  short: it reads the rows after the checkpoint, including any a typist has added since the
  bytes were stored. Anchored writes send `version` back as the version the agent was looking
  at (§7), and it is exactly that.
  - **It is called without `headDoc`.** That argument is the document at the log's tail, and
    its fast path answers with the tail. Handed the decoded row instead, it would answer with
    the tail even when the row trails it, as it does while someone is typing.
- **`last_update_id` is only where the walk starts.** A stale one makes the walk longer, and a
  null one starts it from the newest snapshot the bytes cover, or from the first update; the
  answer is the same. A row is null until a store after the column landed: `createIfAbsent`
  (`server/ydoc-store.ts`) writes a doc's first update without recording its id, and so do the
  Etherpad and legacy importers. A doc never edited walks its one update; the longest walk
  measured, 1,219 rows, took 15 ms.
- **Pieces of one doc** are read from the row as it is at each call. A `version` that differs
  between two reads says the doc changed in between, so block numbers from the first may have
  moved; a section named by its heading's text finds its place again.

The content comes in two forms:

- **Markdown**, from `@tiptap/markdown`'s `MarkdownManager.serialize` over
  `contentExtensions`, after the `annotation` and `authorHighlight` marks are stripped.
  `commentContentToMarkdown` already serializes comment bodies this way. Tables come out as
  GFM tables and parse back to the same nodes. A merged cell and a column's width have no
  Markdown form, so they are lost there; the export's JSON keeps them (below).
- **Text**: the doc's characters, a line break between blocks (each table cell is one), and
  none of Markdown's syntax.
  It is what §7's matcher searches, so a quote copied out of it matches as written.

**No tool reads or writes ProseMirror JSON.** It is the lossless form, but in the imported
docs it runs to twice the characters of their text on average, and up to 6.8 times, and it
tokenizes worse than prose. Nothing a model does with a doc needs it; a program that does
takes it from the export.

**Ranges.** A read can ask for part of a doc rather than all of it:

- **The outline**: one entry per heading, with its level, its text, the number of the
  top-level block it opens, and its section's size in characters; and the doc's block count.
  - **Flat, never a tree.** A level on each entry and its block number place it. A tree would
    say nothing more, and would spend tokens on keys and brackets for its children.
  - **A repeated heading carries its section's first words.** An imported chat puts every turn
    under its author's name ([CLAUDE_IMPORT.md](CLAUDE_IMPORT.md)), so its outline would
    otherwise be "Luke Breuer" and "Claude" over and over: the longest chat has 84 such
    headings among its 107. An entry whose text occurs more than once carries the first 70 or
    so characters of its section, which in a chat is the prompt or the opening of the reply.
  - **`depth`** keeps the top levels only, counted from the shallowest level the outline
    covers, and **a section** keeps the headings inside it, named as below. So Claude can take
    a chat's turns first, each with its lead and its size, and then open the long replies it
    wants. On the longest chat, every heading with its size and lead comes to about 3,700
    tokens, against 23,500 for the doc.
- **A section**: a heading, named by its text or by its block number, through to the next
  heading at its level or above. Imported chats put each turn under a heading, so there a
  section is a turn. A heading text that occurs more than once is refused, naming up to five
  of its blocks and how many there are; the outline numbers them all.
- **Blocks** `from` to `to`, numbered as the outline numbers them.
- **Around a quote**: every occurrence of the quote, each with the blocks it lies in,
  `context` blocks either side (one by default), their numbers, and the heading they sit
  under. This is §7's matcher run as a read, so it answers whether a quote is really there as
  well as where. Occurrences are returned rather than refused, up to five by default and ten at
  most, since nothing is being anchored; a miss is `no_match` with near misses, as it is for a
  write.
- **No range** returns the whole doc when it is under the default bound (§4). A longer one
  answers with its size, its outline to the first level, and how many headings lie deeper;
  `whole: true` returns it whole, up to the bound itself.

**Changes since a version.** A read can ask what has changed since a `version`: one an earlier
read returned, or an annotation's (§9).

- **What it answers.** The top-level blocks that differ, each with its number now, or none for
  a block deleted since, and the heading it sits under.
  - **A changed block is one string**: its words, with what was removed marked `[-…-]` and what
    was added `{+…+}`, git's word-diff markers. On a paragraph with two small edits that is 152
    tokens, where its text then and now took 259, and the gap grows with the paragraph. A block
    added or deleted whole is its text alone.
  - **Each block names who wrote what it gained**, from the `authorHighlight` marks the editor
    puts on typed text and the MCP server on its own (below): a name per `{+…+}`, in order, or
    one name when a single writer added it all. "What did Luke change in my draft?" is then
    one call. Text with no mark, such as an import's, names nobody, and a deletion carries no
    mark, so who removed something isn't said.
- **How.** It is the edit endpoint's alignment (below) run as a read: the doc rebuilt once at
  `version`, as anchoring rebuilds it (§7), its blocks aligned with the doc as read, and a
  word-level diff within each pair. The `version` is validated as an anchor's is.
- **What it is for.** A client catches up on a long doc without reading all of it again, and
  sees how a passage has changed since a note on it was made.

**Finding within a doc** is `search` with `within` set to the doc (§14). It ranks the doc's
sections, as searching within a PDF ranks its pages (§8).

- **The sections are computed per request** from the doc as read: a heading through to the
  next at its level or above, and a section longer than about 2,000 characters split into
  runs of whole top-level blocks. [FULLTEXT.md](FULLTEXT.md)'s option B (§A.1) would store
  passages of a similar size: runs of top-level blocks of about 1–2k characters, or one turn of
  an imported chat.
- **They are ranked with search's own pieces**: the `english_unaccent` configuration,
  `websearchQuery`, `ts_rank_cd`, `headlineTexts` for snippets, and the same typo correction,
  reported as `corrected`.
- **Each hit carries its heading, its block numbers and its snippet**, so the next call is a
  ranged read of exactly that passage.
- **Nothing is stored, and there is no trigger.** This is option B for one doc at a time,
  without waiting for option B. Once option B exists, it reads that table instead.

**Exporting.** A sweep that reads every doc for a concept, rather than searching for its
words, wants the docs as local files: Grep can narrow them before anything is read, and
subagents can read them whole, in parallel. Through `read` that is a call per doc, and more
for the long ones: on the imported chats, about 350 calls for 333 docs and 3.3 million
characters. The export (§5) is one request.

- **Which docs.** Those that `search`'s listing filters select (`tags`, `authors`, dates), or
  a list of ids or URLs sent in the body; with neither, every doc the actor can read. They go
  through `readableDocsWhere`, as every listing of readable rows does. Docs only: a PDF's text
  is read by page (§8).
- **What comes back.** A tar holding one `<id>.md` per doc, and a `manifest.json`.
  - Each file opens with a front-matter block (id, slug, title, `version`), then the body as
    `read` gives it: Markdown, or text with `format=text`. A file named by id survives a
    change of slug.
  - `format=json` gives each doc's ProseMirror JSON instead, as `<id>.json`, for a program
    that wants what Markdown loses. No tool offers it (above).
  - The manifest lists each doc's id, slug, title, size, `version`, byline and tags.
- **`catalog`** answers with JSON alone: each doc's id, slug, title and size, and the newest
  entry in its log, `max(ydoc_update.id)`, from one grouped query with the doc rows.
  - **It is an index Claude can grep.** Saved as a local file, it finds a doc by its title
    without paging `search` twenty hits at a time, and says how long each doc is before it is
    read. The size is `Doc.proseJsonLength`, which `/docs` already shows.
  - **It is how a local copy finds what changed.** A doc whose newest entry differs from the
    `version` beside its local copy is fetched again, by id, and a doc missing from the list
    has been deleted, or is no longer readable.
    - **The newest entry is right whoever wrote the doc.** Every writer of a doc's content
      appends to its log: the collab server, the importers, `createIfAbsent`, the maintenance
      scripts. None has to keep `last_update_id` current for this to hold.
    - **It agrees with `version` whenever the doc is quiet.** While someone is typing, the log
      runs ahead of the stored bytes, so a fetch can come back behind the newest entry, and
      the next poll fetches the doc again. That costs a fetch, never a missed change.
- **`version` is the one `read` returns**, so an export and a read of one doc agree. A quote
  taken from an exported file anchors at the version beside it (§7).
- **Each doc is read as `read` reads it**, from its `ydoc` row. The route streams one doc at
  a time and yields between docs, so a long export never holds the one web process.
- **A concept index stays local for now.** An abstract per doc, or any other note kept to
  steer a sweep, lives beside the export, keyed by id and `version`, and is redone when the
  catalog shows its doc changed. Nothing about it is stored in MultiBlog.

None of this is a websocket peer. A peer would need presence, a token refresher, and a
document held open. Reading the stored doc and writing through the collab server's HTTP
endpoints is live enough: anyone with the doc open sees an MCP write arrive, and the MCP server sees
theirs within a store debounce.

**Creating.** Parse the input, then call `createDocWithContent`, the path that `/docs`'
Markdown import and the importer already share. The same 768 KB limit (`MAX_MARKDOWN_BYTES`)
applies, and the operation enforces it: `createDocWithContent` doesn't, and each caller does
today.

- **It is one transaction.** `createDocWithContent` makes three writes today: the row with its
  byline, the `ydoc` row (`createIfAbsent`, a transaction of its own), and the `proseJson`
  cache. A failure after the first leaves a doc whose first open seeds an empty document, and
  a retry (§4) then makes a second one. So all three go in one transaction, `createIfAbsent`
  taking the one it runs in, and the UI's import and the importer share it.
- **Its seed's Yjs clients are registered** in the doc's `clients` map as the actor, as an
  annotation's seed is (§9), so the replay view names who wrote the first text.
- **The doc is PRIVATE.** Its byline is the actor first and the token's issuer second, or the
  issuer alone when they ask to be its only author (§3, §12). Sharing it is a `manage` call
  afterwards.
- **The byline is written in the creating transaction.** `createDocWithContent` takes the
  ordered list, and `insertDocRow` writes every `doc_author` in the same create that writes
  the creator alone today. A byline added afterwards could fail once the row had committed,
  leaving a PRIVATE doc that only the actor can read and that nothing short of `manage` could
  put right.
- **Its creator is the actor**, in `created_by_user_id`, which `createDocWithContent` sets for
  every caller and nothing edits afterwards ([DOCS.md](DOCS.md), "Who created a doc").
- **A Markdown file can be sent as the request body** instead of an argument (§5), so a draft
  Claude has refined locally is not typed out a second time. The title then comes from the
  request, or from the file's leading heading, as the importer takes it.
- **Its fragment links are checked** before anything is written (§8).

**Text the MCP server writes carries the actor's `authorHighlight` mark**: on create, and on
targeted edits and the title.

- **Author highlighting draws that mark**, character by character ([TIPTAP.md](TIPTAP.md)).
  The Yjs `clients` map is a different thing: it maps each Yjs client to the user whose session
  wrote with it (PLAN.md §11d), which the replay view and an annotation's co-authoring switch
  read, and it gives highlighting nothing to color.
- **`createDocWithContent` gains an optional author.** Given one, it marks every text node and
  seeds through `authorHighlightExtensions` and `titleAuthorHighlightExtensions`, since
  `contentExtensions` and `titleExtensions` have no such mark and would refuse it. The MCP
  server passes the actor. `/docs`' import and the importer pass nothing, and stay as they are.
- **So Claude's text shows in Claude's color**, and a person's later edits in theirs.

**Editing is targeted, never a whole-body replace.** An edit changes what it means to change,
and nothing else:

- replace this passage with that (`old`/`new`, with unique-match semantics, the shape of
  Claude's own file-editing tool), a long passage named by its ends (below);
- append;
- insert after a heading;
- set the title.

**A long passage is named by its ends.** `old` can be `{ start, end }` instead of the passage:
from the first word of `start` to the last word of the first `end` after it, as a fragment
link's `text=start,end` reads ([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md) §2). Rewriting a
section then costs its first and last few words rather than the section typed out again, and
output is the slow and expensive direction.

- **`start` must occur once**, as a whole `old` must, under the same matching (§7).
- **The middle is checked, since it isn't sent.** The request carries the `version` its text
  was read at. If the doc's log has moved past it, the span is found again in the doc rebuilt
  at that version (§7) and compared, and a span whose text differs is refused with its text
  now: a person typing in the passage since the read is never overwritten unseen. A log that
  hasn't moved needs no rebuild.
- **A span may not cross a heading** unless the request says it may, so an `end` mistyped into
  words that next occur sections later is refused rather than taking the sections with it.

One call can carry several edits, and any fragment link in what they write is checked before
any of them is applied (§8). They need **a new collab endpoint**, a sibling of
`/admin/doc-apply-update` and built on its guards, not on `/admin/annotation-mark`'s:

- it refuses a read-only token, a name that isn't a doc's, and a doc that loaded degraded;
- it opens its connection with the actor's context, so the store names the actor as the last
  editor;
- it waits a macrotask before closing, so its append is queued before the store drains;
- **it matches before it opens.** Closing a direct connection stores the doc, which moves its
  Updated date and names the actor as its last editor whether or not anything changed. So
  every `old` is found in the open document, or the stored one, before a connection is opened,
  and a request that would be refused is refused there. The match inside the transaction is
  the one that decides.

Then it makes the edit inside one `transact` on the live document:

1. Decode the live document with `docContentExtensions`, so it carries its `authorHighlight`
   and `annotation` marks. `contentExtensions` has neither mark, so the doc's own marks could
   not survive the round trip ([TIPTAP.md](TIPTAP.md)). Find each `old` in its text, and verify
   the range with `textBetween`.
2. Build the replacement into a ProseMirror `Transform`, as narrowly as its text allows. The
   replacement is Markdown parsed in Next, sent as JSON, and validated against
   `pmDocContentSchema`. Then:
   - the blocks of `old` and `new` are aligned by their text; blocks between two aligned ones
     are paired in order, and any left over are inserted or deleted whole. A container (a
     list, a quote, a table) is aligned the same way, child by child, down to its textblocks;
   - within each pair, only the words whose text differs are replaced, from a word-level diff
     (`diffText`, `src/lib/diff.ts`). A word whose text is the same but whose bold, italic,
     code or link changed gains or loses just that mark;
   - every other mark stays where it is, including the `authorHighlight` and `annotation`
     marks a Markdown read never shows;
   - the words that are new carry the actor's `authorHighlight`, and the `annotation` marks of
     the text they replace. A pure insertion carries only those on both sides of it.
3. Write the result back block by block, never as a whole fragment:
   - a block that didn't change is left alone;
   - a paired block that changed is written with `prosemirrorToYXmlFragment(newBlock, yBlock)`,
     which y-prosemirror accepts for a single element. Within a textblock it rewrites the span
     from its first changed character to its last, and the words in that span that didn't
     change are written again with the marks step 2 kept on them. A container recurses, so
     y-prosemirror is only ever handed one textblock;
   - a block left over is inserted or deleted whole, as the importer's planner does
     (`scripts/import-claude-chats.ts`).

   Writing the whole fragment back is rejected. y-prosemirror then pairs the fragment's blocks
   itself, greedily and in order, and ignores step 2's alignment:
   - it mis-pairs when an edit adds or removes a block between two changed ones, and writes one
     block's Yjs items into its neighbour;
   - a block whose text carries overlapping annotations never compares equal, because each
     annotation is a mark of its own and the comparison checks only the first of a name. An
     insertion before such a block rewrites every block in between, each with its neighbour's
     text.

   Marks would survive that, since they come from the ProseMirror tree. Yjs item identity and
   the span-only update would not, and someone typing in a rewritten block would find their
   characters among tombstones in another paragraph. A spec pins the block-by-block write
   before the endpoint ships: an insertion between two changed blocks, an insertion ahead of a
   block with overlapping annotations, and an open page typing in a block the edit doesn't
   touch.

So the words that survive an edit keep their marks: an annotation's highlight, a link, a
person's author color. The update holds only the edited spans, so a person's edits elsewhere
are never part of it. `diffText` builds a table of every pair of words, which is fine for a
paragraph or a section; an edit spanning more than a few thousand words takes a linear-space
diff instead.

**A note stays on a passage the edit rewrites**, as it does when a person rewrites it. The
`annotation` mark is inclusive, ProseMirror's default, and typed text takes the marks of what it
replaces (`insertText`'s `marksAcross`): retyping one word of an annotated passage in the
editor, or all of it, leaves the annotation on the new words. Giving them the actor's mark
alone would strip the annotation from every word an edit replaced. The commonest edit there is,
rewording the passage a note is about, would then leave the note with no passage and, since a
mark keeps no quote, no record of one (ANNOTATIONS.md, "Anchoring").

- **The one difference from typing is at an edge.** ProseMirror extends an inclusive mark over
  text typed at its end, and a sentence the agent adds after an annotated passage is no part of
  what the note was about.
- **Column anchors have no mark to keep.** One detaches when its quoted text changes, as it
  does after a person's edit.
- **A spec pins it**, in a passage annotated in the editor: one word replaced, the whole
  passage replaced, and a sentence added at its end.

**An edit answers with what it touched.** The endpoint resolves every annotation on the doc and
every anchored-link part into it before applying and again after: the marks from the document,
and the columns and parts from rows the operation passes in.

- **The answer lists each annotation and part an edit overlapped**, and whether it still
  resolves.
- **That is how a client knows which notes it addressed**, so it can reply to them (§9), and
  which links into a passage it broke.
- **It names only what the actor could read** through `read`'s `include` (§9, §10).
- **It also names the blocks the edit changed**, numbered as they are after it, beside the
  edit's `version`, so checking the result (§14) is a ranged read of those blocks rather than
  of the doc.

The request is all-or-nothing: if one `old` is missing or ambiguous, or one span has changed
since its read, no edit applies. Two
design choices are deliberate:

- **The change is built on a scratch `Y.Doc` copied from the live state.** It is then applied
  to the live document, with its new Yjs client mapped to the actor in `clients`, the
  attribution `/admin/doc-apply-update` already does. Writing through the direct connection
  itself would leave the update unattributed: the in-memory document's own client is shared
  by every server-side write, and `attributeUpdate` skips a direct connection.
- **The search is [COLLAB.md](COLLAB.md) §9's normalizing matcher, run against a live
  document**, under §7's rules for what counts as a match: `old` is matched as written and
  then as Markdown parsed to text, only an exact match applies, and a near miss is reported,
  never applied.
  - COLLAB.md §9 relies on an immutable target. Here the transaction makes it safe instead:
    each hit is re-verified inside it, and nothing else can interleave.
  - **CLAUDE.md says not to lift that search into a live *surface*, and this isn't one.** All
    three of COLLAB.md §9's reasons hold inside one `transact`: the search runs once,
    server-side, against a state nothing changes while it runs; every hit is verified with
    `textBetween` after mapping back; and the range replaced is the verified one. So a
    flattening mistake costs a refused edit, never a wrong one. When this is built, CLAUDE.md's
    rule says "a per-keystroke surface", so it isn't read as forbidding this.

A targeted edit is never stale: it finds its `old` in the live document, wherever that has
moved to. It behaves as a person's edit does: anchors into the doc resolve at read time, as
they do after any edit, and Yjs merges it with anyone typing elsewhere.

**There is no whole-body replace.** Replacing the body with a new version of all of it, as the
importer does with its planner, compares whole blocks, marks and all. In a doc a person has
typed in, every character carries their `authorHighlight` mark, so nearly every block would
differ from a Markdown-parsed one and be rebuilt:

- the update would be nearly as large as the doc;
- every mark in a rebuilt block would be lost: the author colors, and the anchors of
  annotations made in the editor;
- and its base, whose state vector `/admin/doc-apply-update` requires the live doc's still to
  equal, never does while someone is typing. (A state vector counts insertions only, so a
  deletion since the base doesn't fail that check.)

The planner stays the importer's, for re-imports. If whole-doc rewrites turn out to be needed
here, they come as a patch: the client sends the text it read and the text it wants, the
server splits the difference into hunks, and each applies as a targeted edit located by its
text. A hunk whose text has changed since is reported, never forced.

**Reverting an edit needs nothing stored.** An edit through the endpoint is one Yjs
transaction, so it is one row in the doc's log, and `edit_doc` answers with that row's id as its
`version`. That is the id its own update was appended as, never `drainAppends`' answer, which is
the doc's newest row and can be a keystroke that landed after it.

- **The hunks come from the log.** The doc rebuilt at the row before the edit's and at the
  edit's (§7) differs by exactly that edit, and the endpoint's alignment turns the difference
  into hunks, each a run of text then and now.
- **`edit_doc` with `revert`** and that `version` applies the hunks backwards, as targeted
  edits located by their text now: all of them, or the ones it names, since a later edit may
  have built on some and not others. With `dryRun`, it lists them and applies none, each hunk
  one word-diff string, as changes since a version are (above).
- **A hunk whose text has changed since is reported and skipped**, never forced.
- **What it puts back carries the marks it had**, author colors and annotations included,
  taken from the rebuilt doc rather than given the actor's.
- **In practice it reverts what the MCP server wrote.** A person's rows are a keystroke or a
  few.

**Once a doc is imported, MultiBlog is its source.** The planner can be trusted only on a doc
nobody has written since the importer last did. It replaces every block that differs from the
file, so a re-import would undo an edit made in MultiBlog in between, by the MCP server or by a
person, along with the marks in those blocks; and `--plan` would list the block without saying
where the difference came from.

- **The workflow.** A summary is revised where it lives, through `edit_doc` or the editor, not
  by editing its local file and importing that again. A local copy, when one is wanted, comes
  from the export (above), which is always current. It is for reading: importing it would
  rebuild every block that carries a mark.
- **The guard.** The importer records the version it leaves each doc at, in
  `Doc.importedUpdateId` (`imported_update_id`): the id of the update it wrote, on a create or
  an `--update`. `--update` then refuses a doc whose log has moved past that id, and `--plan`
  reports it as edited in MultiBlog since its import, and when.
  - **The log decides, not the author.** Where the importer runs as Claude's account, an MCP
    edit is written by the same account, so who wrote an update can't tell the two apart. A
    recorded id can.
  - **`--force` overrides the guard**, for a file that has taken in the doc's edits by hand.
  - **A doc imported before the column existed has none.** Its next `--update` applies as it
    does today, and records one.
- **The importer matches by a key it records**, beside that id, in `Doc.importKey`
  (`import_key`): the chat's id for a transcript, the source file's name for a summary.
  - **Why.** It matches a summary by its exact title today, and a transcript by the chat link
    in its first block. A title changed through `edit_doc` or the editor would make the next
    `--markdown` run import the summary again, as a new doc.
  - **A doc imported before the column has none**, is matched as it is today, and is given one.

**The title is a Yjs fragment.** That fragment is the canonical copy, which the `title`
column caches, so renaming is a targeted edit and never a column write. The edit validates it
against a schema from `titleAuthorHighlightExtensions`, which needs adding: `tiptap-schema.ts`
refers to a `pmTitleSchema` but defines none.

**A record is never edited through the MCP server.** An imported chat is evidence of what was
said, and on a PRIVATE doc the byline is also the edit list (§12), so a token that can read a
transcript could otherwise rewrite it.

- **The flag.** The importer marks each doc it makes from a chat as a record, in a boolean
  column, `Doc.record`. Its pass over earlier imports marks those too (§12). A summary
  imported with `--markdown` is not a record.
- **What it stops.** `edit_doc` refuses a record, text and title alike, with `read_only`.
  Annotating, linking and tagging one work as on any doc.
- **What it doesn't stop.**
  - The importer's own `--update` still applies, since a re-import is the record catching up
    with its source, unless the record has been edited in MultiBlog since (the guard above).
  - The editor doesn't consult the flag, so a person can still correct a record by hand, and
    the guard keeps a re-import from undoing the correction.
- **Reads carry it**, as `record: true`, so a client knows what it is reading.
- **Marking or unmarking a doc** is `manage` (§3).

**Visibility, slug and deletion** are the extracted `docs.ts` bodies, and the record flag is
new beside them, all behind the `manage` scope (§3). **Deletion is soft only**, because a
hard delete cascades away every anchor into the doc ([CLAUDE_IMPORT.md](CLAUDE_IMPORT.md) §6).

## 7. Anchoring by quote

Annotations, anchored-link parts and (later) tag parts all need a range, and **an agent knows
words, not ProseMirror positions.** So every anchored write takes a quote, in the shape of the
W3C TextQuoteSelector, whose `exact` is called `quote` here:

```json
{ "quote": "the exact words", "prefix": "a few words before", "suffix": "a few after", "version": "123456" }
```

**A long passage can be named by its ends** instead, `start` and `end` in place of `quote`:
from the first word of `start` to the last word of the first `end` after it. That is the range
form of Text Fragments, which the W3C selector lacks, and a fragment link's `text=start,end`
already uses it ([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md) §2). It spares Claude typing
out the whole passage. An anchor's stored quote is derived from the doc either way (step 3
below), so the words between the ends need no checking here; an edit's do (§6).

```json
{ "start": "the first words", "end": "the last words", "version": "123456" }
```

**On a doc**, the server does four things:

1. **Validates `version`.** It must be a row in this doc's own log, at or before its tail, and
   it defaults to the tail. A client that has done a read sends the read's `version`. That
   keeps "`Annotation.ydocUpdateId` is the version the annotator was looking at" true for an
   agent too.
2. **Rebuilds the doc at `version` once**, as a ProseMirror node, and searches it with
   `src/lib/comment-quote-match.ts`'s normalizing matcher. That matcher crosses block
   boundaries; `findQuoteOccurrences` does only when told the match's width in positions,
   which a quote doesn't carry.
3. **Captures the anchor from that same node**, through a variant of `captureAnchorInYdoc`
   that takes the built node in place of a ydoc and a stamp to rebuild it from. The
   `quotedText` it is handed is the node's own `textBetween(from, to, " ")`, never the agent's
   quote or the matcher's `quotedTextAt`: the capture checks it byte for byte, and either of
   those differs from it at a curly quote or a hard break.
4. **Refuses when the capture does.** In the UI, `captureAnchorInYdoc`'s `null` means "post it
   without an anchor", a state every surface renders. An MCP write answers `no_match` instead,
   since an agent that named a passage didn't ask for a note on the whole doc. One sent with
   no quote at all is a note on the whole doc, or a reply to the whole of its parent (§9).

That is COLLAB.md §9's matcher pointed at its §2b stamped state: the state is immutable, the
work is server-side, every hit is verified, and the stored text is derived rather than taken
from the request. It adds no new anchoring mechanism.

**The MCP server rebuilds a doc from its log only at a version, never to read it as it is.**
Anchoring rebuilds at the quote's `version`; so do a read of changes since a version, reverting
an edit, and an edit naming a passage by its ends once the log has moved past its read (§6).
Anchoring has to: `captureAnchorInYdoc` is the UI's own capture, and the stamp it stores has to
reproduce the quote when replayed, which `check-annotation-anchors` verifies. The capture as it
stands rebuilds the doc on every call, so anchoring through it would cost two replays an
anchor: one for the matcher, one for the capture. The variant shares the matcher's node, as
`check-annotation-anchors` already shares one node per ydoc and stamp. So **an anchored write
costs one replay per doc and version**, never one per read, and a link with five parts in one
doc rebuilds it once. A quote taken from a read anchors at that read's `version`, since the
version is exactly the state the read returned (§6).

**What counts as a match**, here and wherever the MCP server finds a quote:

- **The matcher's own folding**: typographic quotes and dashes made plain, whitespace runs
  collapsed, and NFKC one character at a time, so a combining accent isn't composed with its
  letter (`normalizeForMatch`). It folds neither case nor punctuation.
- **One retry, for Markdown.** A quote that misses as written is parsed as Markdown, with the
  `MarkdownManager` the reads use, and matched again as the text that parse yields. So
  `the **key** claim`, or `[the paper](/link/…)`, copied out of a Markdown read still lands. A
  quote taken from a `text` read (§6) needs no retry.
- **Only an exact match anchors.** The matcher's `ends` tier accepts a long quote whose first
  and last 32 characters match while its middle differs, and stores the real text in its
  place. For a write it never counts as a match. A miss answers `no_match`, with up to three
  near misses as suggestions, each with its actual text, its context and where it is, and the
  client re-sends the real words. A model quoting from memory is then corrected rather than
  anchored somewhere it didn't mean.
  - **The `ends` tier suggests only for a long quote**: 65 characters or more once normalized,
    matched within ±20% of its length. A shorter quote, or one that is wrong anywhere in either
    end, gets nothing from it, so near misses need a search of their own: the windows of the
    flattened text whose words best overlap the quote's.

**Ambiguity is refused, where COLLAB.md §9 resolves it.** If the quote occurs more than once,
the answer is `ambiguous`, with up to five occurrences' context and how many there are, and
the client retries with a `prefix` or `suffix`. A comment quoting a passage can afford to pick
one occurrence; an annotation's highlight cannot. A passage named by its ends is ambiguous when
its `start` is.

**The matcher gains entry points for this.** `findQuoteInTarget` and `matchQuoteAcross` answer
with one hit at most: the exact tier silently takes the first or the nearest of several
(`pickNearest`), and the `ends` tier returns one candidate. Nor is there a `prefix` or
`suffix` input, only `near`, a position, and no range. So the module adds four, built from its
exported pieces (`normalizeForMatch`, `flattenForMatch`, `quotedTextAt`):

- every exact occurrence, each verified, for `ambiguous` and for `read`'s `around` (§6);
- the occurrences whose neighbouring text matches a `prefix` or `suffix`;
- a passage named by its ends: each occurrence of `start`, run to the first `end` after it;
- near misses, for `no_match`.

**On a PDF**, the quote is searched for in the page text (§8), optionally restricted to a
`page` or `label`, by its **skeleton**: its letters and digits in order, with accents and case
folded, starting and ending on a word boundary. A PDF's extracted text splits and joins words,
which no folding of typography undoes (§8).
PDF fragment links match by the same rule, built as `skeletonOf` and `resolvePassage` in
`src/lib/pdf-fragment.ts` ([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md) §4).
The rest of this section holds: a long passage may be named by its ends, within one page; one
retry as Markdown; only a match anchors; ambiguity is refused; and near misses are reported,
never anchored.

**The same matching is a read.** `read` with `around` (§6, §8) runs it and writes nothing:
whether a quote is really in a doc or PDF, where (its blocks, or its page and label), and
what surrounds it. That is the question research asks most of a citation.

## 8. PDFs

A file's bytes never change, since its `sha256` is its identity. Writing a PDF therefore means
uploading one and editing its metadata.

**Upload.**

- Everything in `src/app/api/files/upload/route.ts` after its session check moves into
  `ingestUpload(actor, { body, filename, title, issuerOnly, duplicate })`, which both that
  route and the MCP server's upload route (§5) call. That covers the role check
  (`canManageFiles`), the streamed write and hash, the format's magic-number check, a PDF's
  parse, the cleanup of the bytes when a step fails, and the row with its owners and page text
  in one transaction. Taking the actor rather than a bare `userId` keeps the role check inside
  the operation, where a front door can't leave it out. The title, the issuer as the only
  owner (§12) and a duplicate (below) are what the MCP server's route passes; the UI's passes
  none of them. The ADMIN-only bandwidth probe (`?probe=1`) stays in the UI's route.
- **A .docx is accepted, as `/files` accepts one**, and kept as bytes: it is checked for being
  a zip and never parsed (`src/lib/file-format.ts`), so nothing in it can be searched, read by
  page or anchored. It is downloaded through `download_url`, and a `read` of it gives its
  title, filename, size and tags.
- **The file is PRIVATE**, with the actor and the token's issuer as its owners, the actor first,
  or the issuer alone when they ask (§3, §12). The owners are written in the upload's own
  transaction, as the uploader alone is today. Its creator (`created_by_user_id`) is the actor,
  as the upload route's is its session's user.
- **Bytes the actor can already read come back as that file** (`existing: true`) rather than
  as a new row, unless the upload asks for a duplicate. The store dedups bytes on disk, but
  every upload through the UI still makes a new row with a new slug, and an agent uploading a
  paper again wants the one it has already annotated. Bytes the actor *can't* read make a new
  row (§19).
- Downloads go through a byte route of their own (§5), behind the bytes route's gate.

**Page labels go on `file`, not `file_page_text`.**

- **Why.** Labels are a property of the bytes, while `file_page_text` is keyed by
  `text_version`. A label column there would be copied for every version and would need three
  writers outside the test fixtures: the upload, lazy extraction in `storedPageText`, and
  `scripts/upgrade-pdf-text-version.ts`.
- **Where they come from.** `extractPdf` calls `getPageLabels()`, which is the viewer's call
  and works in the legacy build the server parses with. The upload stores the result. pdfjs
  answers `null` for a PDF that defines none, which is stored as `[]`.
- **The column.** It is `page_labels Json?`:
  - NULL means "not computed";
  - `[]` means "the PDF defines none";
  - otherwise it holds one string per page.
- **Existing files** are filled lazily on first read, following `storedPageText`'s precedent,
  so there is no deploy-time backfill to forget.
- **The lazy fill writes with raw SQL**, as [FULLTEXT.md](FULLTEXT.md) §3's backfill does. A
  Prisma `update` stamps `@updatedAt`, and a file's `updatedAt` is search's "updated" date for a
  PDF and the date its hit shows (FULLTEXT.md §6). Through Prisma, the first reader of an old
  PDF would make it "updated today".
- **Reading.** `usablePageLabels` is applied at read time, as the viewer applies it.
  `src/lib/pdf-page-labels.ts` is pure.
- **A read returns labels as ranges**, never one string per page. A run of sheets whose labels
  count up by one, in one style and with one prefix, is one entry, such as
  `{ "sheets": "19-471", "labels": "1-453" }`; any other label stands alone. For a 471-page
  book with roman front matter that is 28 tokens, where one string per page is 948. The column
  keeps one string per page, which a lookup by label wants.
- **Labels are a lookup, never a coordinate.** A request may name pages by label, but every
  stored anchor keeps `pageIndex`, so [PDF.md](PDF.md)'s "a label never enters a computation"
  holds.
- **Labels are not unique.** Front matter and body can both have a page "1". A label therefore
  resolves to every page carrying it, where the viewer's page box takes the first.
- **Numbering.** A tool's `page` is the 1-based sheet number, as `#page=` and search's hits
  use it. The viewer's page box shows the label instead wherever the PDF has usable ones, with
  the sheet number in its tooltip. Responses carry both.
- **Search's page hits carry the label too.** `/search` can then show "p. xii" where it shows
  "p. 12" today. This is display only, so PDF.md's rule holds.

**The outline goes on `file` too**, as `outline Json?`, for the reasons labels do, and filled
the same way: lazily on first read, with raw SQL. A book is read by chapter.

- **What it is.** What the viewer's Contents pane shows: pdfjs's `getOutline()`, each
  destination resolved to a page with `getDestination` and `getPageIndex`, as
  `use-pdf-outline.ts` resolves them in the browser. The legacy build serves those calls as it
  serves `getPageLabels()`.
- **What is stored.** Each entry's title, depth and sheet number, or no number when its
  destination doesn't resolve. NULL is "not computed" and `[]` "the PDF has none", as for
  labels.
- **Reading.** A read of the file carries it to its first level, flat as a doc's outline is
  (§6): each entry with its depth, its title, its sheet number and label, and how many pages
  it spans, then how many entries lie deeper. `depth` opens more levels, and an entry named by
  its title keeps the entries inside it, as a doc's outline does for a section.
  A read can also name an entry to get its pages: from its page to the one before the next
  entry at its depth or above, as a doc's section runs to the next heading (§6). A title that
  occurs twice is refused, naming each.

**Reading text.** `read` serves page text at the current text version: one page by sheet
(`#page=`), several by range, or every page carrying a label. `around` a quote returns each
occurrence's page, label and about 300 characters either side. A read of the file itself
carries its title, page count, labels, outline and tags.

**A fragment link reads as its passage.** `read` of `/pdf/<slug>#page=<n>&text=…` resolves each
`text` as the viewer does (`resolvePassage`) and returns the passage with about 300 characters
either side, its page and its label, rather than the page. The books on the development
instance average 2,500 to 3,250 characters a page, so following a summary's citations page by
page would read mostly other text. A passage that isn't there answers `no_match` with what the
check below reports.

**Finding text is two questions, and only the first is search.**

- **Which pages are about this?** Stemmed words, ranked, with snippets: `search` with `within`
  set to the file (§14). The operation doesn't take a file yet. It needs a file-id option on
  `pdfsSearch`'s candidates, and every matching page, paged. Today a file's hit shows three
  pages (`PDF_PAGES_SHOWN`) and a count of the rest.
- **Where exactly is this quote?** This is the locator that §7's anchoring and `read`'s
  `around` call.
  - **The index can't answer it.** A `tsvector` holds lexemes and word positions, not
    characters, so it gives no offsets.
  - **The index can't narrow the pages either.** The stored text keeps line-end hyphens, so
    "inter- national" is indexed as `inter` and `nation`, and a quote of "international" would
    find no page.
  - **So the locator scans.** It selects the file's rows at the current version, restricted
    with `page_index = ANY(…)` when a page or label is named, and matches in JS.

The locator's details:

- **The normaliser.** The match normalises as the browser capture does: `normalisePageText`,
  already isomorphic in `src/lib/pdf-text.ts`. Of the capture's needle helpers, private to the
  `"use client"` `pdf-anchor-capture.ts`, only `buildQuote` moves out, with `normaliseNeedle`
  for its fallback; its exact `locateInNormalised` gives way to the skeleton (below). So a
  hit's offsets index the same normalised text a selection in the viewer is measured against,
  from the hit's first letter or digit to its last. Offsets are UTF-16 code units, as JS
  indexes strings, not Postgres's code points.
- **The skeleton** (§7). The stored text keeps line-end hyphens ("inter- national"), splits
  words apart ("bea tific", "imagin ation", and "o f" thousands of times in one book) and runs
  others together ("ofAge").
  - **How it matches.** The locator compares letters and digits only, after NFKD with combining
    marks dropped and case folded, and maps a hit back to offsets in the normalised text. That
    covers the hyphens along with the rest. It is `resolvePassage` (`pdf-fragment.ts`), already
    isomorphic, which answers with the first occurrence; `resolveAll` beside it finds every
    one, and is exported for `ambiguous` and `around`.
  - **The word boundary.** One is required at each end, so a short quote can't match the tail
    of a longer word.
  - **The evidence.** On 62 quotes written from a corrected copy of one book, exact matching
    after folding quotation marks, dashes and whitespace found 34, a hyphen-tolerant pass none
    more, and the skeleton all 62 (PDF_FRAGMENT_LINKS.md, Appendix A).
- **Older text versions.** The text version is the pdfjs version with `NORMALISER_VERSION`,
  so a pdfjs bump strands old page text as surely as a normaliser change. On its first miss at
  the current version, `storedPageText` parses the whole file once and stores every page.
  Running `upgrade-pdf-text-version.ts` after a bump keeps those parses off the MCP server's
  requests. Search, by contrast, matches each page at the current version where it has one,
  and otherwise at its greatest stored one (FULLTEXT.md §4), so it can find a page in a file
  the locator would then re-extract.

**Anchors need quads, and the server computes them** with functions that already exist
([PDF_QUADS.md](PDF_QUADS.md)).

- **The problem.** `parsePdfTarget` refuses a target without quads, and the viewer draws, jumps
  to and sorts annotations only by them. The upload keeps no geometry.
- **The fix.**
  1. Read the file's bytes, and take the page's text items with `extractPageItems(bytes,
     pageIndex)`. It copies them through the same `quadSourceItems`, under the same
     `getDocument` options, as the extraction that stored the page text.
  2. Check that `normalisePageText(items).text` equals the stored page text at the
     `textVersion` it returns, through `storedPageText`, before trusting anything. A mismatch
     refuses the anchor.
  3. Call `quadsForRange(items, offsets, start, end)`. It maps the range to items through
     `offsets`, and builds each line's box from the item's `transform`, its `width` and its
     font's ascent and descent.
- **Where an edge falls inside an item** is measured in the regular advances of Liberation
  Serif and Liberation Sans, `quadsForRange`'s default measurer. Those are the fonts Chrome on
  Windows and on Linux draws the text layer's `serif` and `sans-serif` in.
  - Against Chromium's text layer, an edge lands at a median of 0.02pt from a selection's, and
    1.11pt at worst.
  - On a reader whose fonts differ, the error is the difference between their fonts and those:
    within 1.43pt at p95 on Noto, and 1.74pt on Carlito (PDF_QUADS.md, Appendix A).
  - Even spacing, the alternative, is off by a median of 1.36pt and up to 18pt.
- **The check.** A spec selects text in the real viewer, in Chromium, and asserts that each
  edge of the server's quads is within 1pt of the selection's. Overlap alone would also pass
  even spacing. The e2e fixture's worst edge measured 0.82pt.
- **One function for both sides.** The viewer draws PDF fragment links with the same
  `quadsForRange` ([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md) §6), passing a canvas
  measurer in the reader's own fonts. The server takes the default.
- **The rest of the target.** The quote, its context and `position` come from the page text,
  and `capturePdfTextAnchor` re-verifies the quote as it does for the viewer.
  - **An empty quote back refuses the anchor.** For the viewer a mismatch is stored, silently,
    as an empty quote. Here the server computed both sides, so a mismatch means two
    normalisers disagree.
  - **The prefix and suffix are the server's own.** `capturePdfTextAnchor` passes a client's
    through unchecked.

The alternative is storing an anchor without quads and letting the browser fill them in. It
is rejected because it changes the viewer's drawing, jumping and sorting, and gives up the
property [PDF.md](PDF.md) §4 rests on: an anchor measured once is correct forever.

**Limits to accept:**

- **Page breaks.** A quote that crosses a page break needs two anchors, since a target has one
  `pageIndex`.
- **Scanned PDFs.** A scanned PDF has no text, so nothing in it can be found or anchored. OCR it
  before upload.
- **Predefined CMaps.** The server's parse passes no `cMapUrl`, where the browser's does. Text
  in fonts that need predefined CMaps (mostly CJK) may therefore extract differently on the two
  sides. The failure is a refused anchor rather than a wrong one, but it is worth checking
  before relying on such files.

**Fragment links in what the MCP server writes are checked.** A doc or annotation body may link
a PDF passage by URL alone, as a fragment link ([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md)):
`/pdf/<slug>#page=<n>&text=<words>`. Each one is checked before anything is written, by the
check the integrity script and the one-quote CLI already share: `FragmentChecker`, with
`linkHrefsIn` to find the links in a body (`src/lib/pdf-fragment-check.ts`).

- **It reads as the operator**, so the MCP server asks `canUserReadFile` first, as the module's
  header requires.
- **It never extracts.** It reads the stored text at the current version, or the newest the
  file has, since a skeleton barely depends on the version. The anchor locator above extracts
  on a miss instead, because quads need the text the current pdfjs yields.

That covers every text a call writes:

- `create_doc`'s body;
- `edit_doc`'s replacements and appends;
- the bodies that `annotate` and `edit_annotation` write.

The answers:

- **A miss refuses the call with `no_match`.** The answer names the link, says where its
  skeleton stops matching and what the page has there, and gives the page the passage is on
  when it occurs exactly once elsewhere in the file: the checker's `matchedUpTo`,
  `pageHasThere` and `foundOnPage`. That is §7's answer for an anchor. An agent
  can fix the quote in the same turn, where otherwise a broken link shows only when someone
  follows it.
- **A file the actor can't read is `not_found`**, the same as one that doesn't exist (§4), so the
  check can't be asked what a PRIVATE file contains.
- **A passage that repeats on its page is a warning in the result**, not an error. A fragment
  link points at the first occurrence by definition, and only its writer knows which was meant.
- **Nothing is rewritten.** The href stored is the one sent.
- **The importer checks none.** An integrity script checks every stored one
  (PDF_FRAGMENT_LINKS.md §9).

## 9. Annotations

**One call, `annotate`, creates a LIVE annotation**, root or reply. The UI spreads the same
work across a draft, the body's websocket, and Post:

1. **Create.** The extracted creation core makes the row and its body ydoc.
   - The body is seeded from the parsed input by a JSON variant of `seedAnnotationYdoc`, which
     takes only plain text today.
   - **The seed carries no `authorHighlight` mark**, unlike a doc's text (§6). A solo
     annotation in the UI carries none: `AnnotationBody` turns the mark on only once the
     body's `clients` map holds two distinct users, and TODO.md keeps the colors as they fall
     out from that. When a second writer joins, PLAN.md §13h's one-time backfill marks
     everything already there as the annotation's author's.
   - **The seed's Yjs client is registered in the body's `clients` map.** The UI's seed is
     empty, and its first writer arrives over the websocket, where `attributeUpdate` registers
     them. This seed is the whole body, written directly, which registers nobody. Without the
     entry, a person who later joins would be the body's first distinct user rather than its
     second, and the backfill would never run.
2. **Settle.** The post core settles the body.
   - `settleAnnotationBody` asks `/admin/annotation-flush` for the mark.
   - `writeSettledBody` then writes, in one transaction: snapshot v1, the cache columns, the
     status, `postedAt` and the anchor.

`scripts/test-annotated-doc.ts` also writes a LIVE row without a draft, but in three separate
writes and without the settle, so it shows only that the draft can be skipped. The same call
checks read access to the container. The UI checks that only when the draft is created.

- **Bodies in Markdown** need a `markdownToAnnotationContent`. It is a `MarkdownManager` over
  `annotationContentExtensions` (StarterKit and AuthorHighlight), with `decodeNodeEntities`,
  the soft-break collapse that comments use, and a schema check. That schema has no tables, so
  a Markdown table needs a fallback. The 5,000-character limit (`MAX_BODY_LENGTH`) stays;
  long-form writing belongs in a doc. Fragment links in a body are checked as a doc's are (§8).
- **Always the column mechanism.** The MCP server has no editor surface, so it never asks for a mark
  (see §17, item 1).
- **A quote is optional.** With none, a root is a note on the whole doc or PDF, as the
  composer below the article posts, and a reply answers its parent as a whole, as the plain
  Reply button does. The stamp is then the doc's log tail, as `postAnnotation` stamps an
  anchorless one, and a PDF's is null. Neither kind needs the quote resolver or quads (§18).
  With a quote, a miss is `no_match`, never a note on the whole (§7).
- **A root annotation with a quote** anchors (§7): either into the doc, stamped with
  `version`, or into a PDF page, with server quads (§8).
- **A reply with a quote** anchors into its parent's *body*, at the parent's newest settled
  version, through `captureAnchorInYdoc` with the annotation schema.
  - The same on a PDF, where `postFileAnnotation` already runs the capture with the doc path's
    arguments. A reply's quote is in a body, never on a page, so it needs no quads.
  - The parent must be readable, posted, and not deleted (§17, item 3).
- **The MCP server never raises an annotation, and never resolves one.** Raising emails the
  body to every other byline author, or every other owner of the file, whose account isn't
  deleted (`raiseRecipientWhere`), and an email leaves the instance and can't be unsent.
  Claude's own account is never a recipient, being the poster or at `.invalid`, which
  `sendMail` refuses; the person who issued its token is. What the MCP server writes is LIVE, never RAISED. Resolving a thread, once it
  exists, is a person's act (TODO.md).
- **Editing a posted body** is one call, `edit_annotation`. It begins an edit session, writes
  the new body through `/admin/annotation-replace`, and finishes the session. Finishing writes
  a new snapshot as the next version, or none if nothing changed. If a step fails, the call
  cancels, putting the last settled body back as the UI's Cancel does.
  - **The new text carries the actor's mark only where the UI's editor would give it one**:
    once the body has two distinct writers.
  - **`/admin/annotation-replace` gains `/admin/doc-apply-update`'s attribution.** The change
    is built on a scratch copy, and its Yjs client is mapped to the actor in `clients`. Today
    the endpoint writes through the direct connection, which leaves the update unattributed,
    the reason §6 builds a doc edit on a scratch copy. Cancel, its one caller today, writes as
    it does now.
  - **It also gains `/admin/doc-apply-update`'s refusal of a read-only token.** Today it checks
    only that the token names the document, so a reader's token for the body would pass (§17,
    item 6).
- **Deleting** is the extracted soft delete, behind the `manage` scope (§3).
- **Reads** go through the `annotation-data.ts` loaders, behind the container's read gate:
  `read` of a doc or PDF with `include: ["annotations"]` for its threads, of `/annotations` for
  the threads on every container the actor can read (below), or of an annotation's URL for one
  thread. History goes through `edit-grace.ts`, which the MCP server must apply exactly as the
  UI does, because the existence of a silent edit is the thing withheld (CLAUDE.md).
- **A container's threads are filtered, ordered and paged.** Unpaged, a heavily annotated doc
  would overflow the read bound (§4) or be cut off arbitrarily, and search's annotation kind
  takes no container (§14).
  - **The filters go under `threads`** in `read`'s arguments, with a `limit` and `cursor` of
    their own. On a doc, `since` already names a version (§6) and a body continues by block
    number, so the threads' date and paging have names of their own, and one read can page a
    body, its threads and the links into it without one argument meaning two things.
  - `by`: threads with an entry by any of the named writers.
  - `notBy`: threads with no entry by any of the named writers, so none of them has touched
    the thread. For one list of writers, a thread matches exactly one of `by` and `notBy`.
  - `activeSince`: threads with activity at or after a date: a post, or an edit readers are
    told about, never a silent one.
  - `status`: LIVE or RAISED.
  - `awaiting`: threads whose latest activity, by the same measure, is by none of the named
    writers. `true` names the actor alone. That is the queue for replies: a thread leaves it
    when one of the writers answers, and returns when someone else answers back. So it isn't
    `notBy`: a thread the writers answered once, and someone has since replied to, is awaiting
    without being untouched.
  - `resolved`, once resolving exists (TODO.md).
  - **Writers are named by slug**, as search's `authors` is (§14), and any account may be
    named, not only the actor. So Claude can ask which threads still wait on the issuer, and
    one AI which wait on another.
  - **A slug outside what the reader can already see is `unknown_author`**, so a typo isn't
    read as "no threads", or as all of them. What the reader can see is the actor, the issuer,
    the author picker's slugs (§14), and the writers in the readable threads being filtered,
    since a writer need not be byline-eligible to annotate. Refusing anything outside that set
    tells the reader nothing new.
  - **Nothing marks an account as an AI.** Threads waiting on any AI are `awaiting` with the AI
    accounts listed, and threads no AI has touched are `notBy` with the same list. The
    conversation supplies the list, as it supplies which notes are requests (below). Each such
    account needs a name, or its slug is never returned to name it by (§14).
  - **The order is the document's:** by where each passage resolves, then the threads with
    none, by date. A PDF's go by page.
  - **They page as a list does** (§4), twenty to a page by default, and a ranged read (§6)
    includes only the threads whose passage lies in its range.
- **Every container's threads at once.** `read` of `/annotations`, the admin table's own path,
  takes the same filters over every doc and PDF the actor can read, and groups the threads by
  container, the one with the newest activity first. "What is waiting on me since Monday?" is
  then one call, `awaiting: true` with `activeSince`, rather than a read per container.
  - **It goes through `readableAnnotationsWhere`**, as the admin table does, but without the
    table's `includeDeletedContainers`: a thread on a deleted doc or PDF isn't listed, since
    `/doc/<slug>` and `/pdf/<slug>` refuse the container itself. Nor does it take the table's
    `canManageDocs` gate: everything it lists is readable already, as in search's annotation
    kind (§14).
  - **Within a container the order is the document's**, as above.
- **Which notes are requests is the conversation's call.** Nothing in MultiBlog marks a note
  as addressed to Claude: the person says which, and the filters find them. A note kept
  private is a DRAFT, its writer's alone, and never among them.
- **Each annotation says what and where it is**: its id; its `version`, the stamp; and its
  passage. A root annotation on a doc carries its passage's text, its block numbers and the
  heading it sits under, resolved against the doc as read (§6).
  - **A list says once what its threads share.** Threads on a doc are grouped under the
    heading their passage sits in, a PDF's under their page; a date is to the minute; `status`
    appears only when it is RAISED; and a writer is a name. Twenty threads come to about 3,400
    tokens this way, against about 5,000 as one object per annotation with every field.
  - **Its card's link comes with a thread read alone**: the container's URL with the card's
    fragment (§15). In a list it would cost some 20 tokens a note, and the id is the durable
    handle, since the fragment changes when its writer renames themselves.
  - **One function answers for both mechanisms**, as CLAUDE.md asks of every rail and jump
    target. `resolveAnnotationRanges` takes an editor state, so it gains a sibling that takes
    the node, built from the same two halves: `collectAnnotationMarkRanges` for an annotation
    made in the editor, whose columns are null, and `resolveAnchorInDoc` for the columns, as
    the reading view's plugin calls it.
  - **One that no longer resolves says so**, and keeps its `quotedText` where it has one.
  - **A note made in the editor has none once its mark is gone**, since a mark keeps no quote.
    Read alone, by its URL or id, such a thread is rebuilt at its stamp, where its mark is by
    construction (`check-annotation-anchors`' `mark-at-stamp`), and carries the passage it had
    then. A list doesn't, to keep each read to one rebuild.
  - **On a PDF**, an annotation carries its page, label and quote. **A reply** carries its
    quote in its parent's body.
- **Each writer is a name, never an email.** The loaders name a writer through
  `displayNameOf` (`src/lib/display-name.ts`), which labels an account with no name
  "Anonymous", and select no email to fall back on. `getAnnotationHistory` still selects the
  email it never returns; its extraction selects none.

## 10. Anchored links

- **Links are minted in one transaction, without the tray**, by `create_link`, which takes one
  link or several.
  - That is legal: the partial unique index `anchored_link_one_open_per_user` covers only
    links that are unminted or reopened, and `scripts/integrity/check-tag-constraints.ts`
    already inserts minted rows directly.
  - Every part of every link is captured first, and one refusal refuses the call, as one
    `old` refuses an edit (§6). Then the links and their anchors are written in one
    `$transaction`, each with `partOrder` 0..n−1, `normalizeLinkName`, `mintedAt` set, and
    `reopenedAt` and `editedAt` null.
  - The response carries each link's `/link/<id>` URL, in the order sent. So the citations a
    summary needs are minted in one call before the summary is written.
- **Reading a link** is `read` of `/link/<id>`, or of a reading route's URL carrying
  `?sel=<id>`.
  - It answers what the landing route decides for each viewer, as data.
    `anchoredLinkLandingFor` says whether the link exists for this viewer, and
    `anchoredLinkForViewer` gives its parts, each group filtered by its own target's read rule
    and an unreadable group left out without a trace ([ANCHORED_LINKS.md](ANCHORED_LINKS.md)).
  - Each part carries its target's URL, kind and title, and its quote with prefix and suffix.
    A PDF part adds its page and label.
  - A doc part is resolved against the doc as read (§6) with `resolveAnchorInDoc`, and adds
    its block numbers, its heading and the read's `version`. A part that no longer resolves
    says so, and keeps its stored quote.
  - The link carries its name, its creator and its dates.
  - This is how a client follows a citation in a summary back to the passage it names.
- **Each target is read-checked** with the extracted `canUserLinkTarget`. It takes docs and
  files, and refuses posts, annotations and comments, as the actions do.
- **A PDF part whose quote does not verify is refused.**
  - The tray's `addAnchoredLinkPart` keeps such a part, with an empty quote.
  - The MCP server computes the quote and the quads from the same text, so a mismatch means the two
    normalisers disagree, which is worth surfacing.
- **A minted link can be added to**, with `add_link_parts`, **and edited**, with `edit_link`.
  - Renaming follows `canUserRenameAnchoredLink`: the creator, or ADMIN/EDITOR once the link is
    minted.
  - Adding, removing and reordering parts are the creator's alone. They work by link id and
    keep the last-part rule.
  - Any of these edits sets `editedAt`.
  - Adding parts is a tool of its own because it is the one change to a link that can be
    undone, so it never forces a prompt where renaming and removing do (§15).
  - Deleting a link needs `manage` (§3).
- **Reuse comes before minting.** The "links into this target" query moves out of the `/links`
  page into `src/lib/`, and `read` of a doc or PDF with `include: ["links"]` returns it, so a
  client can find a link that already anchors a passage before minting another. It is gated
  by the target's own read rule and each link's own filtering (`anchoredLinkForViewer`), not
  by `/links`' page gate, `canManageDocs`, which an AUTHORIZED user who can mint a link
  doesn't pass. Beyond the refusal of a repeat within a day (§4), every mint makes a new link,
  and nothing deduplicates them.
  - **It lists only the parts into this target**, each with its link's URL, name and number of
    parts: the question is which passages here are already linked, and a link's parts
    elsewhere are a `read` of the link away.
  - **It pages on its own**, under `links` with its own `limit` and `cursor`, as threads do
    under `threads` (§9).

## 11. Tags

- **Whole-object tags are built.** One gate covers docs, files, posts, annotations and
  comments: `canUserTagTarget`, which asks the object's own read gate. The UI offers only the
  first three. There is one live assignment per tag, object and user, which the action
  enforces by looking first; the database doesn't, so a lost race leaves a duplicate
  assignment, which shows as one chip with its tagger counted twice (`tagsForTarget`).
- **`tag` checks an annotation's container for deletion**, which `canUserTagTarget`'s
  annotation arm doesn't. No UI tags an annotation, so `tag` is its first caller there.
- **Minting a term and applying one are the same permission**, `canApplyTags` (AUTHORIZED and
  up). A case-insensitive match returns the existing term.
- **A soft-deleted term still holds its name.** Minting it again is refused, and an
  ADMIN/EDITOR restores it instead.
- **Curating** (rename, describe, re-slug, delete) is ADMIN/EDITOR only, whoever minted the
  term.
- **Removing a tag** is allowed on one's own tags, or on anyone's as ADMIN/EDITOR.
- **`tag` refuses a post that is published or scheduled.** Its chips are on a public,
  statically generated page, or will be at the scheduled time without anyone acting again.
  - **The gate would allow it.** `canUserTagTarget` asks only whether the post is readable,
    and a published post is readable by everyone, so a token could tag anyone's post.
  - **A term's name is free text.** Minting one is the same permission as applying it, so a
    planted instruction could carry words read in a PRIVATE doc onto the open web.
  - **Untagging fixes only the page.** Tagging revalidates the page at once, and from then on
    crawlers, caches and archives can keep a copy.
  - **So tagging one is `manage`** (§3), through the `manage` tool, which prompts (§15). A
    draft can be tagged under `write`, since it goes public only when a person publishes it.
- **Reading an object's tags runs that object's read gate first.** `tag-data.ts`'s reads check
  nothing themselves, and a chip is exactly as private as the thing it is on (CLAUDE.md).
- **Tags read back three ways**, each inside the read rules that already govern the objects
  tagged:
  - **On every read of an object**, as its tags (`tagsForTarget`), after the object's own
    gate.
  - **As search's `tags` filter** (§14), which narrows each kind's ids to those carrying any
    of the named terms, inside the ids its read rule chose. With no `q` it lists what carries
    a term, per kind and paged, annotations and comments included, which `/tag/[slug]`'s three
    capped sections leave out.
  - **As `read` of `/tag/<slug>`**: the term's name, slug and description, and the first page
    of that listing.
  - `find_tags` finds terms by name.
- **Tags get slug history.** They are the one kind without it, so a re-slugged term's old URL
  finds nothing. `tag_slug_history`, in the shape of the other four, closes the gap for the
  MCP server, and `/tag/[slug]` follows it as the other reading routes follow theirs.
- **Passage-level tags do not exist.** `tag_anchor`'s part columns have no writer (PLAN.md §20,
  PR 2). A tool that tags a claim rather than a whole doc would be their first writer. That
  means settling §20f's semantics first, after reading [multi-anchoring.md](research/multi-anchoring.md).

## 12. Bylines and owners

- **One function, `setDocByline(actor, docId, orderedUserIds)`**, which `manage` calls and
  the UI's two byline actions (`updateDocAuthor`, `updateDocAuthorOrder`) become wrappers over.
  Its rules:
  - the actor can edit the doc;
  - every user named is in `BYLINE_ELIGIBLE_ROLES`;
  - at least one author remains;
  - the change is one transaction and sets `updatedByUserId`.

  Only the first and third are the UI's today. Its actions take any user id, leaving
  eligibility to the edit page's picker (§17, item 5); a toggle is two actions, one adding and
  one reordering; and neither writes the doc row.
- **A create writes its byline in the creating transaction**, never through `setDocByline`
  afterwards (§6). The importer's `finishDoc`, which writes its byline after the create today,
  hands `BYLINE_EMAILS` to the create instead.
- **Under `write`, a create's list names the actor and the token's issuer, and no one else**
  (§3). On a PRIVATE doc the byline is the access list, so a name added at creation shares the
  doc as surely as SHARED would. Any other name, at creation or afterwards, is `manage`.
  - **By default the actor comes first and the issuer second.** The bulk of what Claude makes
    is its own writing. A post copies its doc's byline as it stands (`createPostFromDoc`), so
    a post made from such a doc credits Claude first until someone reorders it by hand.
  - **The issuer may be the only author**, when they ask to be. The actor then can't read what
    it made, which is the issuer's call to make; nobody else gains anything.
- **On a PRIVATE doc the byline is the access list.** Removing someone revokes their access,
  the actor's own included, so removals take an explicit flag.
- **Claude edits a doc only from its byline.** There is no collaborator without credit: on a
  PRIVATE doc the byline is the read list and the edit list, and on a SHARED one an AUTHOR
  edits only from the byline, where an ADMIN or EDITOR needn't be on it (`canUserEditDoc`).
  So letting Claude revise an article means putting Claude on its doc's byline.
  - **The published post's byline is separate** (CLAUDE.md), so the published credit doesn't
    change.
  - **Claude's edits reach readers when a person publishes again**, since a post's text is its
    publication's (§13).
- **Claude's account is on every list, beside the user's**, unless the user asked to be the
  only one.
  - **What it can read** is what any AUTHOR can: SHARED docs and files, and PRIVATE ones whose
    byline or owner list names it, with no ADMIN bypass to fall back on
    ([PERMISSIONS.md](PERMISSIONS.md)). Imported chats and uploads are PRIVATE by default.
  - **The importer** runs as `MB_EMAIL`, Claude's account by default, so Claude is the creator
    of what it imports ([DOCS.md](DOCS.md), "Who created a doc"). Docs imported before that
    column were backfilled with their first byline name, the human's, so a rule keyed on the
    creator (§19) doesn't reach them. Its byline is `BYLINE_EMAILS`, both accounts, whose
    default order becomes Claude first, to match; the importing account is on it whatever the
    list says, since `insertDocRow` seeds it.
  - **What Claude makes through the MCP server** names Claude first and the user who issued
    its token second, on a doc's byline and a file's owner list (§5's instructions).
  - **Every doc the importer has made names both accounts already**: its default
    `BYLINE_EMAILS` names both, and a source whose byline names a missing account fails before
    anything is created, while the run goes on to the next. Its pass over earlier imports only
    marks the chats among them as records (§6).
  - **On a PRIVATE doc the byline is also the edit list**, so Claude can edit whatever it can
    read there, records aside (§6). The token's scopes are what keep it from changing who has
    access (§3).
- **File owners** (`file_owner`) are a file's equivalent, gated by `canUserManageFile` and set
  at upload under the same rule, in the upload's own transaction (§8).
  - **Nothing changes them after upload today**, though [PERMISSIONS.md](PERMISSIONS.md)
    describes the list as editable. Changing them through `manage` is new, under
    `setDocByline`'s rules read for a file: the actor can manage it, every owner named is
    eligible, at least one remains, and the change is one transaction.
  - **Until then they are changed by hand, in the database.** For a PDF its uploader owns
    alone, that is the one way to let Claude read it, or the notes on it, short of making it
    SHARED. Nothing adds Claude as an owner by default.
- **A user lookup**, `find_users`, matches byline-eligible users by name or slug, or one user
  by exact email. It returns id, slug and name: enough to set a byline without exposing the
  user table. A nameless account's slug is made from its email, so it is returned only to the
  exact-email lookup, which already holds that email (§14).

## 13. Posts and comments, read only

The MCP server writes neither of these. It reads them because search returns them (§14), and without
a read a hit is a dead end: a title, a snippet and a URL. Each read is behind the same rule
search used to find the row, so a hit never leads to `not_found`, and `not_found` never
reveals a hit.

### A post

`read` of a post's public path, or of `/post/<id>/edit`, is `readablePostWhere` with the id
added; anything else is `not_found` (§4).

- **Who can read one.** Everyone can read a published post. The posts the actor may edit can
  also be read, drafts and scheduled ones included: every post for an ADMIN or EDITOR, and the
  byline's for an AUTHOR.
- **Its text is the publication's.** `Post.proseJson` is the body of the published or
  scheduled version, fixed until the next publish or schedule.
  - **So a read needs no rebuild and no `version`**, as a doc's does (§6).
  - **It carries the publication's id instead** (`publishEventId`). That id is the post's
    coordinate axis: comment threads and quote anchors already stamp it as
    `anchored_event_id`.
- **Formats.** Markdown or text, as for a doc: the same `MarkdownManager` over
  `contentExtensions`, with the `annotation` and `authorHighlight` marks stripped.
- **A post never published or scheduled has no text of its own** (FULLTEXT.md §1); its words
  are in its doc. One that was unpublished, or scheduled and then cancelled, keeps the text it
  had and has no `publishEventId`; a read gives that text beside its status.
- **Its doc is named only to someone who may read the doc.** A post's byline grants nothing
  over its doc (CLAUDE.md), and a published post doesn't tell its readers which doc it came
  from.
  - The response carries `doc: { id, slug }` only when `canUserReadDoc` passes.
  - This is the looser of the two questions `/post/[id]/edit` asks; the other is
    `canUserEditDoc`.
- **The rest.**
  - title and slug;
  - status (`derivePostStatus`) and `publishedAt`;
  - the public URL, when published;
  - the byline from `post_author`, as names, with a slug only for an account that has a name,
    and never an email. A nameless account's slug is made from its email (`user-slug.ts`), and
    `AuthorByline` leaves such entries out.

### A post's comments

`read` of a post with `include: ["comments"]` returns what the post page shows: the public
comments, in threads, in the page's order.

- **The rule.** The post goes through the gate above, and its comments through
  `publicCommentsWhere`, with the post's id added.
  - **The page's loader doesn't do this.** `getPostThreadsWithApprovedComments` filters on
    status alone, and relies on its caller being a published post's page.
  - **The MCP server's list goes through the helper**, as every listing of readable rows does
    (CLAUDE.md).
  - **An unpublished post therefore lists none.**
- **Each thread** carries its passage (`quotedText`) and the publication its anchor was last
  mapped to. Each publish re-maps every active quote thread, so that differs from the post's
  current publication only for a detached thread, and for the general thread, which is never
  re-mapped.
- **Each comment** has the comment read's fields below, and names its parent.
- **A deleted comment** that has public replies keeps its place, as the page's tombstone does:
  its id and parent, with no body and no name. `publicCommentsWhere` requires
  `deletedAt: null`, so these come from a second query: the deleted comments a listed one
  replies to.
- **Pending comments are left out**, even for a moderator. Moderation belongs to `/comments`,
  and is outside the MCP server.

### A comment

`read` of a comment's URL — its post's path and the fragment its card renders
(`commentAnchorName`) — reads through `canUserReadComment`. That allows three readers:

- anyone, for a public comment: approved, not deleted, on a published post;
- the actor, for their own comment;
- anyone who may moderate the post (`canUserEditPost`).

`getCommentHistory` and `getCommentMarkdown` gate on the same function.

The response:

- **The body.** `Comment.body`, the newest revision (CLAUDE.md), as Markdown through
  `commentContentToMarkdown`: `getCommentMarkdown`'s serialization. Like a doc's, it is never
  read as JSON (§6).
- **The commenter, as a display name only.** Never the commenter row's email, its user id, or
  the comment's IP.
  - **A display name is fixed when the commenter row is made.** A user id beside it would let
    anyone link an old name to a renamed account.
  - **That is why search takes no author filter for comments** (FULLTEXT.md §10, item 3).
- **Dates.** `createdAt`, and the edit readers are told about (`isCommentVisiblyEdited`).
  Never `editedAt`, which silent edits also stamp.
- **Its place.** The ids of its post, its thread and its parent comment.
- **Its citations.** What each quotation in the body cites, from `loadCommentQuoteCitations`,
  whose post arm names a post only while it is public (`isPostPublic`).
- **Its status**, only when the comment isn't public. Only its writer or a moderator can see
  such a comment.

**History.** `read` of a comment with `history: true` is `getCommentHistory`'s body,
extracted, behind the same gate.

- **What it returns.** The versions `edit-grace.ts` lets readers see, each as Markdown.
- **The rule runs on the server, exactly as the UI runs it.** As with annotations (§9), what is
  withheld is the existence of a silent edit.
- **Each version's author is a name, never an email**, through `displayNameOf`, as the UI's
  history already names them.

## 14. Search

**Search is built** ([FULLTEXT.md](FULLTEXT.md)), and its operation already has this plan's
shape:

- **The operation.** `search(actor, params, opts)` in `src/lib/search/` is a plain module. It
  takes an explicit `{ userId, role } | null` actor and a scope, and it is never exported from
  a `"use server"` file.
- **The read rules.** Each kind ranks only inside the ids its `where` helper chose.
- **The tool.** `search` is a parse and a call, with the token's user as the actor in the
  `viewer` scope. There is no second search and no second statement of any read rule.

**It also does the listing.** With no `q` and a filter, it lists the readable rows newest first.
So `kinds=docs&authors=<slug>` is "this person's docs", and with the `tags` filter below,
`tags=<slug>` is "what carries this term": no tool needs a listing of its own.

**What the MCP server adds in front of it:**

- **A strict parse first.** `parseSearchParams` is written for a page: anything malformed falls
  back to its default (FULLTEXT.md §6). Behind a tool, each such fallback silently changes the
  search:
  - `kinds=doc` names no known kind, which means every kind, or, with no `q`, no search at
    all;
  - a mistyped date drops its filter;
  - an unknown `tz` becomes UTC;
  - an author slug that doesn't fit the slug pattern is dropped in the parser, before
    `search()` could answer `unknown_author` for it;
  - `q` is cut to 200 characters;
  - a malformed `page` becomes 1;
  - `exact` with any value but `1` turns exact matching off.

  The zod schema (§4) refuses each as `invalid` before the parser sees it.
- **An unknown author is `unknown_author`.** `search()` keeps only the slugs on the viewer's
  author picker. When it drops every one, the search runs over everyone's.
  - **Naming the refused slugs leaks nothing**, because the picker's slugs are already visible
    to this viewer.
  - **The picker must be built** whenever `authors` is given.
  - **Claude's account needs a name.** A nameless user is never on the picker (FULLTEXT.md §6),
    so nobody could ask for their docs.
- **What an author filter leaves out is said.** `search()` drops PDFs and comments from any
  search with an author filter (`withoutAuthors`), since neither names an author it may
  disclose. The response names the kinds it dropped, so their absence isn't read as none.
- **`within` one doc or PDF.** Set to a doc, it ranks the doc's sections (§6); set to a PDF,
  every matching page (§8). The object's own read gate runs first.
- **A `tags` filter** (§11). Each kind's ids are narrowed to those carrying any of the named
  terms, as `authors` takes any of its slugs.
- **Correction is reported, never hidden.** The response carries `corrected` (FULLTEXT.md §5).
  - **Checking whether something exists needs `exact=1`.** Before creating a doc or minting a
    link, an agent asks whether one is already there. Without `exact=1`, typo correction
    answers with a near match. `e2e/search.spec.ts`'s absence checks use `exact=1` for the same
    reason.
  - **The server instructions say so** (§5).
- **Paging.**
  - **The overview** gives five hits per kind, with each kind's `total`. Then the client pages
    one kind at a time.
  - **The cursor** encodes the page and its size, since ranked results page by offset.
  - **At most 20 hits per page** (`PAGE_SIZE`), not §4's 100. Each hit on a page costs a
    `ts_headline`, about 3 ms for a long doc, and FULLTEXT.md §3 names snippets as the cost to
    manage.
- **One handle on every hit**: its `href`, which every tool takes, or an annotation's id (the
  table below).
- **Snippets as marked strings.** A snippet is one string with each match in `**…**`, not
  `HeadlineFragment[]`. The model reads `structuredContent` (§4), and an array of fragment
  objects costs several times the tokens of the string it spells. A quote copied out of a
  snippet still lands, through §7's Markdown retry.
- **A hit carries what the model uses, said once** (§4):
  - a byline is one string of names, where the two accounts on most of Claude's docs cost 28
    tokens a hit as objects; a date is a day;
  - each doc hit carries `chars`, its size, from the stored `Doc.proseJsonLength`, so whether
    to read it whole or by its outline is decided before reading (§6);
  - a PDF's page hits are page numbers and labels under the file's one `href`, not an `href`
    each;
  - an annotation hit's `quote`, the whole passage on the page, is cut to about 200
    characters; a read of its thread has the rest;
  - what only the page uses is left out: `authorOptions`, `readableKinds`, and `params` as
    applied, since a parameter the parse would change is refused (above).

  Twenty doc hits with every field come to 3,463 tokens, 1,062 of them snippets; shaped this
  way, with one handle each, to 2,210. An id costs about as much as a whole slug, some 16
  tokens.

**One handle per hit.** A hit carries both an `id` and an `href` today. The MCP server returns
one: the `href` wherever it names the object for good, and the id where no URL does. A model
never parses a URL; it passes one back, and every tool takes one (§4, §15).

| Kind | Handle | Gains |
|---|---|---|
| Doc | `href`, `/doc/<slug>` | `chars` (above) |
| Post | `href`: its public path once published, `/post/<id>/edit` before | Nothing. Never its doc's id (§13) |
| PDF | `href`, `/pdf/<slug>`; each page by its 1-based number | Each page's label (§8) |
| Annotation | `id`, since its card's fragment changes when its writer renames themselves (§15) | Its container's `href`; the writer's `slug`, when the writer has a name; `parentId`, so hits group into threads; `status`, when it is RAISED |
| Comment | `href`: its post's path and its card's fragment, which never changes (§15) | Nothing. Never the commenter's user id (§13) |

- **An `href` stays good after a rename.** A replaced slug is kept in its kind's slug history,
  where it stays reserved, so it never comes to name another object, and `read` follows it
  (§15). An id is surer in two cases only: a hard delete frees the slug with its history, and
  a slug reverted within an hour of being set is dropped rather than kept. A doc renamed during
  a conversation can appear under two hrefs, the old in earlier results; a `read` of either
  reads the same doc.
- **Ids stay where they are needed.** A read of an object carries its id (§6); the export names
  its files by id, and its catalog pairs each slug with one (§6); `find_users` returns the
  user ids a byline change takes (§12).
- **No writer's user id is returned.** The thread filters and search's `authors` take slugs
  (§9, above), and only `manage` takes user ids.
- **The rule in `src/lib/search/types.ts` changes.** It says a field is on a hit "only because
  the page shows it". It becomes: because a front door shows it, or needs it to reach the row
  or to decide how to read it, as a doc hit's `chars` (above). The hit types gain only what the
  table does, and the MCP layer leaves out what it doesn't use.
- **Ids are not permission data.** Every field on a hit has passed its kind's read rule, and the
  two "never" entries above are the cases where an id would say more than the rule allows.
- **A nameless account's slug is never returned.** It is made from the account's email
  (`user-slug.ts`), so `displayNameOf`'s rule covers it too. A byline is names alone (above),
  so only an annotation's writer could carry one, and a nameless writer's doesn't.
- **The page ignores the new fields.**

**A snippet may seed a quote, but never replaces §7.**

- **A doc's snippet** comes from `prose_text(Doc.proseJson)`, which is a store debounce behind
  and carries no version. An anchored write that quotes it is resolved at the tail and verified
  there, like any other (§7).
- **A PDF's snippet** comes from the stored page text that the locator searches (§8).
- **Either way**, the resolver decides the range, not the snippet.

**A write is searchable once its text column is written.**

- **At once:** `createDocWithContent` and an annotation's settle, which write the indexed
  columns themselves, and an MCP edit through the collab server, whose direct connection
  stores the doc as it closes.
- **After the store debounce:** a person's edit in the editor.
- **So verify a write by reading it (§6)**, never by searching for it.

**Post and comment hits lead to §13's reads**, which are behind the same rules or wider ones:
a post's is `readablePostWhere`, and a comment's is `canUserReadComment`, which also admits the
comment's writer and the post's moderators. So a hit never leads to `not_found`.

**A doc hit doesn't land on its passage** (FULLTEXT.md §7).

- **The cost.** Reading the whole doc around a hit means up to 88,000 characters, for the
  longest.
- **Through the MCP server it takes one more call.** `read` `around` a phrase from the hit's
  snippet returns the passage, its blocks and its heading (§6), and `search`'s description says
  so (§5). The phrase comes from inside a fragment, since `ts_headline` drops short words at a
  fragment's edges. `within` the doc is for when the snippet isn't the passage wanted: it ranks
  the doc's sections, and a ranged read returns the one chosen.
- **The fix.** FULLTEXT.md's option B (§A.1) would let the first search name the passage
  itself.
- **So the MCP server is a second reason to build option B**, after the imported chats. It is not a
  prerequisite.

## 15. Tools

| Tool | Scope | Does |
|---|---|---|
| `search` | read | Search, and filtered listing, across kinds; `within` one doc ranks its sections, within one PDF its pages; `tags`, `authors`, dates, `exact` (§14) |
| `read` | read | Any MultiBlog URL (below): whole, as its outline, as a range or `around` a quote; changes `since` a version; and `include` for what hangs off the object, each list paged on its own, threads filtered under `threads` (§6, §9, §10) |
| `find_users` | read | Byline-eligible users by name or slug, or one by exact email (§12) |
| `find_tags` | read | Tag terms by name (§11) |
| `download_url` | read | A URL for a file's bytes or for the export, carrying a grant good for ten minutes (§5) |
| `upload_url` | write | A URL for uploading a PDF or a .docx, or for creating a doc from a Markdown body, carrying a grant good for ten minutes (§5) |
| `create_doc` | write | Markdown and a title; the doc is PRIVATE, its byline the actor and then the token's issuer, or the issuer alone (§6, §12) |
| `edit_doc` | write | Targeted edits, applied word by word, each passage named by its words or by its ends, and the title; reverting one edit, whole or in part (§6) |
| `edit_file` | write | A file's title (§8) |
| `annotate` | write | A LIVE annotation, root or reply, anchored by quote or on the whole; never raised or resolved (§9) |
| `edit_annotation` | write | A posted annotation's body (§9) |
| `create_link` | write | One or more minted links, their parts anchored by quote (§10) |
| `add_link_parts` | write | More parts on a minted link, anchored by quote (§10) |
| `edit_link` | write | A link's name; removing and reordering its parts (§10) |
| `tag` · `untag` | write | Apply a term, minting it when it is new, to anything but a published or scheduled post; remove one's own assignment, or anyone's as ADMIN/EDITOR (§11) |
| `manage` | manage | A doc's or file's visibility, slug, byline or owners, and whether a doc is a record; tagging a published or scheduled post; deleting or restoring a doc, file, annotation or link |

Uploading, downloading and exporting are §5's byte routes, not tools, reached at the URLs
`upload_url` and `download_url` answer with.

**Hints.** Every tool carries MCP's annotations, which a client may use to decide how to
present a call:

- `readOnlyHint: true` on the four reads, and on `upload_url` and `download_url`, which
  change nothing themselves: an upload happens when its bytes arrive.
- `destructiveHint: false` on the writes that only add: `create_doc`, `annotate`,
  `create_link`, `add_link_parts`, `tag`.
- `destructiveHint: true` on the writes that overwrite or remove: `edit_doc`, `edit_file`,
  `edit_annotation`, `edit_link`, `untag`, `manage`.
- `idempotentHint: true` on every write, since a repeat with the same arguments changes
  nothing more: by the write's nature, or, for one that adds something, because a repeat
  within a day is refused (§4).
- `openWorldHint: false` on every tool, since each acts on this instance alone.

**`readOnlyHint` decides how Claude Code runs a call**, not only how it shows one: a read-only
tool is safe to run concurrently, so several `read`s asked for in one turn run in parallel
(2.1.292). That is why there is no batch read, and why the rate limit allows a burst (§4).

**Loading.** Claude Code defers MCP tools behind its tool search, loading a tool's description
and schema when a session first needs it (§5). Two `_meta` keys shape that:

- `_meta["anthropic/alwaysLoad"]: true` on `search` and `read`. Nearly every session that uses
  the server starts with them, so they are loaded up front and save the search. Their schemas
  are then in every session where the server is configured, which is one reason to configure
  it per project (§16).
- `_meta["anthropic/searchHint"]` on every tool: a few words a tool search matches besides the
  name, such as "outline section page quote thread link" for `read`.

**Forced prompts.** Claude Code doesn't decide its prompts by MCP's hints. What it honors is
`_meta["anthropic/requiresUserInteraction"]: true` on a tool: it then asks on every call, even
in auto and bypass modes and whatever the allow rules say, with no "don't ask again" (and in
`dontAsk` mode refuses instead). It is set on the tools whose actions can't be undone, and
only those:

- `edit_link`: a link's name and part order keep no history, and removing a part deletes its
  anchor row, captured quote and all.
- `edit_file`: a file's title keeps no history.
- `manage`: an audience that has been widened has already seen the doc, a chip on a public
  post may already be in someone's cache, and someone taken off a PRIVATE byline or owner list
  can't get back in. Its slug changes and soft deletes could be undone, but they share the
  tool, which only a person's `manage` token lists (§3).

The prompt has two limits, and the plan answers each:

- **Only Claude Code is documented to honor the flag**, from v2.1.199. Another client may
  treat these tools like any other, with an approval its user can set to always allow, so
  only a token issued for `claude-code` lists them (§3). From claude.ai, renaming a link,
  retitling a file and `manage` are done in the UI.
- **The prompt guards the tool, not the endpoint.** A shell holding the token could post the
  same call itself, which is why the token stays out of Claude's shell (§5).

Everything else can be undone, so it never forces a prompt: a new doc, link, annotation, part or
tag can be taken away again, in the UI or through `manage`; a doc's text keeps its whole
history in the update log, from which an MCP edit can be reverted (§6); an annotation keeps
every version of its body; and an untagged
assignment comes back by tagging again. That is why the two lists differ: `edit_doc` is
destructive in MCP's sense, since it overwrites text, but nothing it overwrites is lost. The
scrub bar shows any earlier state of a doc, though putting one back is done by hand until
restore-to-a-point exists ([DOCS.md](DOCS.md), "Deferred").

**Suggested allow rules**, for the `.claude/settings.json` beside the project's `.mcp.json`
(§16), or for `~/.claude/settings.json` when the server is configured for every project:

- Reads only, with every write asking:

  ```json
  {
    "permissions": {
      "allow": [
        "mcp__multiblog__search",
        "mcp__multiblog__read",
        "mcp__multiblog__find_*",
        "mcp__multiblog__download_url"
      ]
    }
  }
  ```

- Everything, for research that shouldn't stop at each new doc, annotation or link. The three
  forced tools still ask on every call:

  ```json
  { "permissions": { "allow": ["mcp__multiblog__*"] } }
  ```

**What `read` takes** is a URL on this instance, absolute or as a path:

| URL | Reads |
|---|---|
| `/doc/<slug>`, also by id and with `/edit` | The doc whole, its outline, or a range of it (§6); `include` its annotations, or the links into it |
| `/pdf/<slug>` | The file's title, page count, labels as ranges, outline and tags (§8); `include` as for a doc; an outline entry's pages |
| `/pdf/<slug>#page=<n>` | That page's text; `pages` or `label` for others (§8) |
| `/pdf/<slug>#page=<n>&text=…`, a fragment link | Its passage, with its context, page and label (§8) |
| `/annotations` | The threads on every doc and PDF the actor can read, filtered as a container's are, grouped by container (§9) |
| `/files/<slug>` | Any file, a .docx included: its title, filename, size and tags (§8); a PDF's text is read at `/pdf/<slug>` |
| either, with an annotation card's fragment | That annotation's thread (§9) |
| `/link/<id>`, or either with `?sel=<id>` | The link and its parts (§10) |
| `/<yyyy>/<mm>/<dd>/<slug>`, `/post/<id>/edit` | The post (§13); `include` its comment threads |
| a post's path, with a comment card's fragment | That comment, and with `history` its versions (§13) |
| `/tag/<slug>` | The term and what carries it (§11) |
| `/authors/<slug>` | The person's name and slug, and what search lists for them |

- **Slugs may be current or past.** Every kind that keeps slug history is followed through it,
  as its own reading route follows it: docs, files, posts, users, and tags once §11 gives them
  theirs. A link copied into a doc before a rename still reads, a card's fragment aside
  (below).
- **A card's fragment names no id.** An annotation's is its writer's display name and the
  second it was created (`annotationAnchorName`), so `read` finds it by container, time and
  name, and the link breaks when its writer renames themselves; the id, which every read hands
  out (§9), doesn't. A comment's fragment is the name its commenter row was made with, which
  never changes.
- **Every other tool names objects the same way**, by URL or by id.
- **Any other URL is `invalid`**, naming the tool that answers it where one does: `search`
  for `/search` and the date archives.

## 16. Usage

How a client is set up, and what a session spends on the server. The connection itself is §5's:
the `mcpServers` entry, the token's file, and the settings that keep the token from the model.

- **Configure the server per project, in a research directory, not for every project.**
  Claude Code puts a server's instructions in every session where it is configured, coding
  sessions included, and loads `search` and `read` there up front (§15). A project's
  `.mcp.json` keeps both to the sessions that use them, and the allow rules (§15) go in that
  project's `.claude/settings.json`.
- **What a session spends**, as Claude Code 2.1.292 does it, measured with a probe server:
  - **in every session**: the instructions, cut at 2,048 characters (§5), and the schemas of
    `search` and `read`;
  - **on a tool's first use**: its description and schema, which the tool search loads;
  - **on each call**: the result's `structuredContent`, as compact JSON (§4). It stays in the
    conversation and is read again on every later turn until the conversation is compacted,
    which is why results are lean, a read's default is small (§4), and the specs hold both to
    a budget (§18);
  - **never in pieces**: a result past its tool's limit is saved to a file as one line, which
    no tool relies on (§4).
- **What keeps a research session cheap**, which the tools' descriptions teach:
  - a long doc's outline first, then the sections wanted (§6);
  - a doc hit's passage by `around` a phrase from its snippet (§14);
  - changes since a version, rather than a second read of the whole (§6);
  - several reads in one turn, which run in parallel (§15);
  - the export or its catalog, and Grep, before a sweep that must read every doc (§6);
  - a long passage named by its ends, rather than typed out (§6, §7).
- **From claude.ai, the byte routes can't be counted on.** They need curl, and nothing
  documents whether its code execution can reach the instance. So there the export and its
  catalog can't stand in for reads, and the lean results (§4) are all that keeps a sweep
  affordable.

## 17. Existing gaps the MCP server must not inherit

Each of these is in the UI's own paths today, and the MCP server avoids every one by construction.

- **Items 1–3.** The MCP server uses only the column mechanism, validates stamps, and
  re-checks a reply's parent.
- **Items 4 and 5.** Its deletes and restores are the extracted ones, fixed as they are
  extracted, and its byline checks eligibility (§12).
- **Item 6.** Its replacement of an annotation's body refuses a read-only token (§9).

All of them should still be fixed on their own account.

1. **A reader can have the server write into a doc they cannot edit.**
   - `postAnnotation` takes `anchorMode` from the client for a root annotation. For
     `"mark"`, it applies a mark through the collab server.
   - Nothing in `src/app/actions/annotations.ts` calls `canUserEditDoc`.
   - `/admin/annotation-mark` does not check the token's `readOnly`.
   - So [ANNOTATIONS.md](ANNOTATIONS.md)'s "why the reading views stopped writing marks" holds
     only because the reading views send `"columns"`.
2. **The client's version stamp is parsed, not validated.** `postAnnotation` turns
   `ydocUpdateId` into a `BigInt` and uses it. Nothing checks that it is in this doc's log, or
   not past its tail. A stamp from the future breaks "replay to the stamp and `textBetween` is
   `quotedText`" as soon as the doc changes.
3. **A reply's parent is checked for its container only.** `createDraftAnnotation` selects the
   parent's `docId` and `fileId`, and nothing about its status or deletion. A reply can
   therefore hang off someone else's DRAFT, and an anchored reply then searches that private
   body for the quoted text.
4. **An ADMIN can delete or restore another user's DRAFT annotation.** `requireOwnOrAdmin`
   (`src/app/actions/annotations.ts`) checks no status, so `deleteAnnotation`,
   `restoreAnnotation` and their bulk forms take another user's DRAFT by id, against "a DRAFT
   is its owner's alone".
5. **A doc's byline takes any user.** `updateDocAuthor` checks that the actor can edit the
   doc, and nothing about the user added. Eligibility lives only in the edit page's picker,
   whose role list is written out rather than taken from `BYLINE_ELIGIBLE_ROLES`. The read and
   edit predicates check the role as well, so an ineligible name on a byline gains no access,
   though `/dashboard`'s Recent docs still lists such a doc to it, with its title, byline and
   an Edit link, checking no role.
6. **`/admin/annotation-replace` accepts a read-only token.** It checks that the token names the
   document, and not `readOnly`, where `/admin/doc-apply-update` refuses one. Any reader of a
   container can mint a read-only token for each annotation on it
   (`/api/annotation/[id]/token`), so the endpoint's only protection is that nothing off the
   box reaches it: nginx forwards `/collab/admin/…`, which the collab server doesn't match, and
   the port is closed.

## 18. Build order

1. **Tokens, the actor, the MCP endpoint, and reads.**
   - Tokens with all three scopes and the client each was issued for, the tool list filtered
     by both, each tool's hints, loading keys and forced prompt (§15), and the server
     instructions, naming the actor and the issuer (§5).
   - The actor, with an adapter for each shape identity takes today (§1).
   - `download_url` and its grants, for the export, and an audience on the ydoc token (§5).
   - Reads, each result lean, with `read` declaring its bound and keeping a smaller default
     (§4):
     - search, behind its strict parse, with one handle on each hit and each doc's size,
       `within` and `tags`, and what an author filter left out (§14);
     - `read`'s URL resolution, slug history included (§15);
     - docs: `version`, exact through `resolveUpdateIdForSnapshot`, Markdown and text, the
       outline with its sizes, leads and depth, ranges, `around`, changes since a version as
       word diffs naming their writers, finding within a doc, and the export, with its JSON
       and its `catalog` from the log's newest entry (§6);
     - annotations: threads, a container's or every readable one's at `/annotations`,
       filtered under `threads`, ordered and paged, each with its version and passage, and
       when read alone its card's link and a lost mark's passage (§9);
     - files: pages, labels as ranges (on search's page hits too), the outline with its depth,
       `around`, and a fragment link read as its passage (§8);
     - links, and the parts into a target (§10);
     - posts, a post's comments, a comment and its history (§13);
     - tags, on every read and as `/tag/<slug>` (§11);
     - users.
   - Migrations: `api_token`, `file.page_labels`, `file.outline`, `tag_slug_history` and
     `doc.record`.
2. **Doc writes, and notes that need no quote.**
   - Create, PRIVATE, in one transaction, with the author mark, the seed's clients and the
     byline, from an argument or a Markdown body sent to an `upload_url` (§5); and the
     fragment-link check on what it writes (§8).
   - The targeted-edit endpoint, on `/admin/doc-apply-update`'s guards and matching before it
     opens, with its word-level diff, annotation marks that follow the words they cover, its
     block-by-block write-back, passages named by their ends with their middle checked
     against the version read, what it touched and the blocks it changed, reverting, and its
     refusal of records (§6).
   - `setDocByline` and the doc half of `manage`; and the refusal of a repeated write, with
     `api_write` (§4).
   - Annotations with no quote, roots and replies, on docs and PDFs, since they need neither
     the quote resolver nor quads (§9).
   - The importer, before the first MCP edit can reach a doc it made: its guard against undoing
     edits made in MultiBlog, and its match by key, with `doc.imported_update_id` and
     `doc.import_key` (§6); its byline handed to the create, Claude first; and its pass over
     earlier imports, for records.
3. **Anchoring by quote.** The quote resolver, with §7's rules: the capture over a built node,
   the matcher's new entry points, and passages named by their ends. Annotations anchored by
   quote: roots on docs, and replies on docs and PDFs alike, a reply's quote being in its
   parent's body, never on a page (§9). Editing a body, through an attributed
   `/admin/annotation-replace` that refuses a read-only token; anchored links, several to a
   call; and whole-object tags.
4. **The PDF side.** `ingestUpload` and the file routes, a .docx included, reached through both
   URL tools; PDF roots anchored by quote, their quads from `extractPageItems` and
   `quadsForRange`, with the spec that holds each edge within 1pt of a selection (§8); and the
   file half of `manage`, owner changes included (§12).
5. **OAuth, for claude.ai** (§5).
6. **If wanted:** passage-level tags (§20 PR 2).

Each phase ships with four things:

- e2e specs against the production build, calling the MCP endpoint through Playwright's
  `request` fixture with a small JSON-RPC `callTool` helper, the way
  `e2e/doc-apply-update.spec.ts` already tests the collab endpoint from below the UI. §6's
  block-by-block write-back and an edit's annotation marks are pinned there too, since what
  they guard is a ydoc's behavior;
- unit tests for the pure parts (the resolver and the matcher's new entry points, label lookup
  and label ranges, `read`'s URL parse, the section split, the outline's sizes, leads and
  depth, an edit's block alignment and word diff, and the word-diff rendering) under
  `npm run test:unit`;
- a size budget: the serialized size of each kind of result the phase adds, on a fixture,
  asserted beside its other tests, so a field added later has to fit (§4);
- a clean run of the integrity checks that cover what the phase writes:
  `check-annotation-anchors`, `check-annotation-snapshots`, `check-pdf-anchors`,
  `check-tag-constraints`, `check-pdf-fragment-links` for any phase that writes a fragment
  link, and `check-search-index` for any phase that writes text or `file.page_labels`.

## 19. Open decisions

1. **The shape.** The shared operation layer, which means refactoring the actions the MCP
   server touches, rather than a parallel set of handlers. §1 recommends the shared layer.
2. **claude.ai.** When OAuth comes (§5). claude.ai is where the research conversations
   happen, so it is a target; what is open is the timing.
3. **Tag granularity.** Passage-level tags now, or whole-object tags only.
4. **The gaps.** Whether §17's gaps are fixed first, separately.
5. **Files Claude can't see.** A PDF the user uploaded alone is invisible to Claude's account
   until its owners are changed by hand (§12), which nothing does by default. Claude uploading
   the same paper meanwhile makes a second row, and annotations and links split between the
   two. Open: whether the upload says these bytes are already in a file the actor can't read,
   which tells only someone who already holds the bytes, or duplicates are left to merge by
   hand.
6. **Undoing one's own creations, and the audit.** Who made a doc or file is already on its
   row, as `created_by_user_id`, and the MCP server's creates record the actor there (§6, §8).
   What is left:
   - whether `write` may soft-delete what its own account created. Records would be
     excluded (§6), since an importer run as Claude's account makes Claude their creator;
   - what else the audit should be;
   - whether `api_write`'s rows are ever deleted (§4).
7. **Provenance beyond records.** Whether Claude's research docs carry a tag that search can
   filter on, beside the record flag that already marks transcripts (§6).
