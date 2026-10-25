# MultiBlog — an MCP server for machine clients

**Status: built through §18's phase 5**: tokens and every read, doc writes and targeted edits,
annotations, anchored links, tags, uploads and `manage` (phases 1–4); and OAuth for claude.ai
on SDK v2 (phase 5, §21): bot accounts for a connection to act as, the consent page, refresh
tokens, so a connection lasts until it goes 90 days unused, descriptions and a skill that tell
claude.ai's model what the server holds, Claude Code's sign-in through its own identity, and
`/dashboard`'s Connections card. Not built: §21's read-only endpoint, which is designed, and
passage-level tags (phase 6). §1–§19 are the design the build followed, and §21 the plan for
OAuth and SDK v2; §20 lists where the build departs from either, and every such point is
decided there rather than here.

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
  set at issue: by the script's `--client`, which defaults to `other`, or by an OAuth
  connection, which is `claude-ai` for Claude's published identity or a client registered by
  hand as claude.ai's, and `other` for any other client (§21). Only a `claude-code` token lists
  the tools that force a prompt, since Claude Code is the one client documented to honor the
  flag (§15). The token decides rather than the request, because a stateless server sees the
  client's `clientInfo` only in `initialize`, never in the `tools/list` and `tools/call` that
  follow (§5).
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
  - §21 adds a step: a token's issuer must be its account's person,
    `works_for_user_id ?? the account's own id`, whichever way the token was issued; and a
    bot's token is refused while its person is a COMMENTER or the bot outranks them. §21 also
    lists `manage` to no bot's token, whatever its scopes.
- **Soft-deleting a user revokes their tokens**, in the same transaction. `deleteUser`
  (`src/app/actions/users.ts`) calls `softDeleteUser` (`src/lib/user-delete.ts`), one
  transaction; `bulkDeleteUsers` calls it once per user and needs nothing of its own. Restoring the account
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
  --issued-by … --name … --scopes … --client …`. `/dashboard`'s Connections card is the panel
  for your own tokens, listing and revoking but never issuing (§21). The script stays the only
  way to issue a header token; everyone else connects through OAuth (§21).
- **Every token expires**: a year unless the script is told otherwise, with no way to ask for
  none, since SDK v2's bearer check refuses a token without an expiry (§21, "The bearer
  check"). A CHECK on `api_token` holds every header token to it. A header token is re-issued
  before its year is up, and Claude Code reads the new file at its next connection (§5).
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
  - **It works for one person** (`user.works_for_user_id`), who is the issuer of every token it
    holds, by whichever route it was issued: the header, Claude Code's own identity or
    claude.ai (§21).
- **OAuth is a way of issuing rows in this table**, not a second auth system. A connection's
  row is reached through an hour's access token and a rotating refresh token, rather than a
  secret of its own (§21).

Ghost's design, in which the client signs a five-minute JWT from its key so the secret never
travels, buys nothing over an HTTPS bearer token here and is not adopted.

## 4. The envelope

- **One endpoint, and tools rather than paths.** `/api/mcp` serves every operation as a tool
  (§15). A client reads the tools' schemas afresh each session, so a tool can change shape
  without a version number. What has to stay in step with the tools is §5's server
  instructions and §21's skill, and both ship with the same code.
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
  - `too_large`;
  - `forbidden` for an object the actor can read but not change, `rate_limited`,
    `unavailable` when the collab server can't take a write, and `internal`.

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
    `add_note`, `create_link`, `extend_link`, and `edit_doc`, whose appends and insertions
    add text. Every other write changes nothing more when repeated (`tag`, `untag`,
    `rename_file`, `edit_link`, `edit_note`, `manage`), so a repeat of one simply runs:
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
  - **claude.ai passes 100,000 characters to its model inline**, as measured in the header
    trial, and honors none of Claude Code's `_meta` keys. So a `claude-ai` token's `read`
    stops at 95,000, for `whole: true` and a range alike (§21).
- **Lists** take `limit`, 20 by default and at most 100, and an opaque `cursor`. Search pages
  by rank, at most 20 at a time (§14).

## 5. Front doors: MCP, and routes for bytes

- **MCP at `/api/mcp` is the contract**, in the same Next process.
  - Each tool calls its operation in-process.
  - It uses stateless Streamable HTTP: a fresh server per request, built by the official SDK's
    `createMcpHandler`. The SDK is v2, `@modelcontextprotocol/server`, which serves claude.ai's
    2026-07-28 revision and every 2025-era client from the one endpoint (§21, "Moving to SDK
    v2"). The server is built after the token is checked and lists only the tools that token's
    scopes allow, so Claude's token never sees `manage` (§3).
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
  - Each takes a grant from `upload` or `download` (§15), or the endpoint's bearer
    token from a program that holds one, such as a local script that refreshes an export.
    Nothing else under `/api/mcp` answers outside MCP.
  - **A grant stands in for the token on one route, for ten minutes.** The tool answers with
    the route's URL, the grant in its query string, and Claude adds the route's own
    parameters and body, as it would with the token.
    - It is a JWT signed as the collab server's ydoc token is (`jose`, HS256, `AUTH_SECRET`;
      `src/lib/ydoc-token.ts`), with an audience of its own. It carries the token's id, the
      route and the expiry, and nothing else.
    - **The ydoc token has an audience too**, `multiblog:ydoc`, checked wherever it is
      verified, so neither passes for the other. Without it, a grant shown to the collab
      server would be stopped only by lacking a `documentName`.
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
  - **Settings that keep the file from the model**, in the settings of the sessions that hold
    the token:

    ```json
    {
      "permissions": {
        "deny": ["Read(~/.config/multiblog/**)", "Read(~/.claude/.credentials.json)"]
      },
      "sandbox": {
        "enabled": true,
        "allowUnsandboxedCommands": false,
        "failIfUnavailable": true,
        "credentials": {
          "files": [
            { "path": "~/.config/multiblog", "mode": "deny" },
            { "path": "~/.claude/.credentials.json", "mode": "deny" }
          ]
        },
        "network": { "allowedDomains": ["<host>"] }
      }
    }
    ```

    - `sandbox.credentials` denies each path to every command Claude runs, enforced by the
      operating system. On Linux the sandbox needs `bubblewrap` and `socat`. A denied
      directory is hidden whole, so a command reading the token is told "No such file or
      directory"; a denied file answers "Permission denied".
    - `~/.claude/.credentials.json` holds the tokens of a `/mcp` sign-in (§21, "Which
      clients"). Claude Code reads it outside the sandbox, so denying it costs nothing.
    - **Any settings file can add a `deny` entry**, and none can take away one another added;
      only `mask` entries need user or managed settings. So the settings go wherever covers
      the sessions to protect: `~/.claude/settings.json` for every session, a project's
      `.claude/settings.local.json` for that project's, or `--settings` for one session.
    - **Every session is usually too wide.** A sandboxed command writes only in its working
      directory and the temp directory, and reaches the network only through an HTTP proxy,
      so plain `ssh`, `scp` and database drivers can't connect, even to an allowed host. A
      command let out of the sandbox (`excludedCommands`) can read the token's file again. So
      the settings suit a project whose commands are local files and HTTPS, as a research
      project's are.
    - `allowUnsandboxedCommands: false` stops a command from asking to run outside the
      sandbox.
    - `failIfUnavailable: true` makes Claude Code stop with an error when the sandbox can't
      start. Otherwise it runs every command unsandboxed, and the token's file is readable.
    - The Read deny rule covers Claude's own file tools, which run outside the sandbox.
      Claude Code applies it to Grep and Glob on a best-effort basis.
    - **Auto mode's classifier can refuse a command before the sandbox sees it**, so a check
      that the sandbox holds runs in another permission mode, as `--permission-mode default`
      (§21, "The full trial").
    - `allowedDomains` lets curl reach the host with a grant. Nothing in the shell holds the
      token.
- **There is no REST API.** Nothing would call one, and a contract nobody calls goes stale
  without anyone noticing. The operation layer keeps one cheap to add if a client that isn't
  an agent ever needs it: a route would be a parse and a call, as a tool is.
- **There is no sidecar process.** [DEPLOY.md](../DEPLOY.md)'s target is a 1 GB instance,
  where memory is what runs out, and a second Node process costs tens of MiB before it does
  anything.
- **claude.ai comes after Claude Code, and needs OAuth** (§21). It is where the research
  conversations happen, so it is the client that makes the round trip seamless. Claude Code
  comes first only because a header is all it needs, and Claude Desktop reaches the server
  through a local bridge that adds the header. Desktop and the mobile apps also share
  claude.ai's connectors.
  - **What it takes.** claude.ai's custom connectors authenticate with OAuth: PKCE, plus one
    of dynamic client registration, a client ID metadata document, or a client registered by
    hand. Supporting them makes MultiBlog an OAuth authorization server, consent page included.
    §21 takes the metadata document, Claude's published identity, with a client registered by
    hand as its fallback.
  - **Neither shortcut is a connection.** Anthropic's connector documentation lists a static
    header only as a beta for a limited set of organizations. Where an account has it, it
    serves §21's header trial, with a read-only token good for a week, and nothing more: as a
    connection, the secret would sit in claude.ai's settings and travel on every call for its
    whole life. A secret in the connector's URL would put a credential where URLs get logged,
    which is why the MCP authorization spec forbids one in a query string.
  - **The consent page issues the token for a bot account**, not for whoever is signed in.
    The natural grant would bind it to the person approving, and everything claude.ai wrote
    would then carry that person's name (§3). So the page offers the bots that work for its
    user, and records the user as the issuer (§21).
  - **What it issues is an `api_token` row** (§3), with the same scopes and revocation. The
    row is reached through an hour's access token and a rotating refresh token: OAuth is a way
    of issuing rows in that table, not a second auth system.
  - **Its tokens are issued for `claude-ai`**, which sets `read`'s bound for claude.ai (§21).
    They list neither `edit_link` nor `rename_file`, whose forced prompt only Claude Code honors
    (§15), and never `manage`, which is outside their scopes.
  - **Research gets no endpoint of its own.** §21 designs `/api/mcp/read`, listing only the
    reads, for a second connector a person would turn on there. It isn't built, since Research
    calls no connector at all (§21, "The slice trial" and "The read-only endpoint").
- **Server instructions say whose account, and when to reach for the server; each tool's
  description carries its own conventions.** An MCP server returns `instructions` when a client
  connects, and Claude Code loads them at session start, before any tool's definition. Shipped
  that way, they and the descriptions deploy with the code they describe and can't drift from
  it (`src/lib/mcp/instructions.ts`).
  - **The instructions are the one part of the server every Claude Code session reads.** Claude
    Code defers MCP tools behind its tool search by default, however few a server has: a
    session sees each tool's name and the instructions, and loads a tool's description and
    schema when it first needs it. `search` and `read` are the exception (§15, §16).
  - **claude.ai never passes them to its model** (§21), and shows it a tool's description only
    once the tool is loaded. So a convention about one tool goes in that tool's description,
    which every client shows when the tool is about to be used, and what belongs to no one
    tool goes in the instructions for Claude Code and in a skill the person installs for
    claude.ai (§21, "The skill"). Both are built from the same text.
  - **Claude Code cuts the instructions off at 2,048 characters**, and each tool's description
    at the same length. The cap is on the description string alone: a tool's input schema
    reaches the model whole, so the detail of `read`'s URL forms and options goes on its
    parameters. §21 holds each description to 1,200.

  So the instructions are four short lines, the same for every token but the first:
  - whose account the session acts as, and who issued its token (below);
  - what the server holds;
  - to search it before researching elsewhere or answering from memory;
  - that each tool's description carries its conventions, and that a session starts with
    `search` and `read`.
- **They name the actor and the issuer.** The server is built after the token is checked
  (above), so its instructions can say whose account the session acts as and who issued the
  token, each by name, and by slug when it has a name (§14), read from those two rows. "My
  annotations" then needs no lookup. The names come from the token, not the code: a token
  issued by someone else names them. `search`'s and `create_doc`'s descriptions name them too,
  for claude.ai.
- **A convention about one tool goes in that tool's description**, under the same cap:
  - `search`: a call needs `q` or a filter; `exact` whenever the question is whether something
    exists; a doc hit's passage is one `read` away, `around` a phrase from its snippet (§14);
    cite what you use by its URL;
  - `read`: a long doc's outline first, then the sections needed; several reads in one turn run
    in parallel; the links into a doc or PDF, to reuse before minting another;
  - `create_doc`: the byline's order, by name; the prompt quoted at the top of a summary;
    `/doc/<slug>` for whole docs, minted links for sections and claims, and fragment links for
    PDF passages (§8);
  - `add_note`, `create_link` and `extend_link`: a section anchored on its heading's text, a
    claim on its sentence, a long passage by its first and last words, quoted from a `text`
    read (§6, §7); `create_link`'s, reusing a link before minting one;
  - `add_note`'s and `edit_doc`'s: acting on a note means replying to it, saying what was done,
    with a link to the passage or the doc it went into (§9);
  - `download`'s and `upload`'s: the byte routes, through curl, and the export or its catalog
    before a sweep that must read every doc.

  What `already_done` means is in that refusal's message, which arrives when it is needed (§4).
- **A skill serves claude.ai, not Claude Code.** Claude Code reads the instructions, and a
  local skill would earn a place only for steps that depend on the local machine. claude.ai
  reads neither the instructions nor a description before a tool loads, so the skill is how
  "my research is in MultiBlog; look there first" reaches it (§21, "The skill").

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
- **Who may ask: the doc's editors.** It shows the doc's history, and history is
  `canUserEditDoc`'s, as the reading view's scrub bar is (`/api/doc/[id]/replay`;
  PERMISSIONS.md). A reader who can't edit the doc is refused with `forbidden`, whatever
  version they send.
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
- **`createDocWithContent` gains an optional author.** Given one, it marks the seed as an edit
  marks a block that is all new (`markNew`), and seeds through `authorHighlightExtensions` and
  `titleAuthorHighlightExtensions`, since `contentExtensions` and `titleExtensions` have no
  such mark and would refuse it. The MCP server passes the actor. `/docs`' import and the
  importer pass nothing, and stay as they are.
- **Inline code carries it too**, and keeps a link or bold beside it, because this app's
  code mark excludes only itself ([TIPTAP.md](TIPTAP.md), "Inline code takes other marks").
  A code block takes no marks, so its text carries none.
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
  page or anchored. It is downloaded through `download`, and a `read` of it gives its
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
- **Where they come from.** `extractPdfMetadata` calls `getPageLabels()`, which is the
  viewer's call and works in the legacy build the server parses with. The upload stores the
  result. pdfjs answers `null` for a PDF that defines none, which is stored as `[]`.
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
- **It reads only the pages the links name**, and a whole file only for a miss, so a body
  citing many books costs what it cites rather than what the books hold
  ([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md) §8).

That covers every text a call writes:

- `create_doc`'s body;
- `edit_doc`'s replacements and appends;
- the bodies that `add_note` and `edit_note` write.

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

**One call, `add_note`, creates a LIVE annotation**, root or reply. The UI spreads the same
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
  a Markdown table needs a fallback. A body has no length limit, as a doc has none; the
  Markdown a call sends is capped at a doc's 768 KB (`MAX_MARKDOWN_BYTES`). Fragment links in
  a body are checked as a doc's are (§8).
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
- **Editing a posted body** is one call, `edit_note`. It begins an edit session, writes
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
- **A minted link can be added to**, with `extend_link`, **and edited**, with `edit_link`.
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
  means settling PLAN.md §20f's semantics first, after reading [multi-anchoring.md](research/multi-anchoring.md).

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
    its token second, on a doc's byline and a file's owner list (`create_doc`'s description,
    §5).
  - **Every doc the importer has made names both accounts already**: its default
    `BYLINE_EMAILS` names both, and a source whose byline names a missing account fails before
    anything is created, while the run goes on to the next. Its pass over earlier imports only
    marks the chats among them as records (§6).
  - **On a PRIVATE doc the byline is also the edit list**, so Claude can edit whatever it can
    read there, records aside (§6). The token's scopes are what keep it from changing who has
    access (§3).
- **File owners** (`file_owner`) are a file's equivalent, gated by `canUserManageFile` and set
  at upload under the same rule, in the upload's own transaction (§8).
  - **`manage` changes them** (`setFileOwners`, `src/lib/file-manage.ts`), under
    `setDocByline`'s rules read for a file: the actor can manage it, everyone added is in
    `FILE_MANAGER_ROLES`, at least one owner remains, a removal takes `allowRemovals`, and the
    change is one transaction. Nothing in the UI changes them. For a PDF its uploader owns
    alone, that is the one way to let Claude read it, or the notes on it, short of making it
    SHARED; nothing adds Claude as an owner by default.
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
  - **`search`'s description says so** (§5).
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
| `read` | read | Any MultiBlog URL (below): whole, as its outline, as a range or `around` a quote; changes `since` a version, on a doc the actor can edit; and `include` for what hangs off the object, each list paged on its own, threads filtered under `threads` (§6, §9, §10) |
| `find_users` | read | Byline-eligible users by name or slug, or one by exact email (§12) |
| `find_tags` | read | Tag terms by name (§11) |
| `download` | read | A URL for a file's bytes or for the export, carrying a grant good for ten minutes (§5) |
| `upload` | write | A URL for uploading a PDF or a .docx, or for creating a doc from a Markdown body, carrying a grant good for ten minutes (§5) |
| `create_doc` | write | Markdown and a title; the doc is PRIVATE, its byline the actor and then the token's issuer, or the issuer alone (§6, §12) |
| `edit_doc` | write | Targeted edits, applied word by word, each passage named by its words or by its ends, and the title; reverting one edit, whole or in part (§6) |
| `rename_file` | write | A file's title (§8) |
| `add_note` | write | A LIVE annotation, root or reply, anchored by quote or on the whole; never raised or resolved (§9) |
| `edit_note` | write | A posted annotation's body (§9) |
| `create_link` | write | One or more minted links, their parts anchored by quote (§10) |
| `extend_link` | write | More parts on a minted link, anchored by quote (§10) |
| `edit_link` | write | A link's name; removing and reordering its parts (§10) |
| `tag` · `untag` | write | Apply a term, minting it when it is new, to anything but a published or scheduled post; remove one's own assignment, or anyone's as ADMIN/EDITOR (§11) |
| `manage` | manage | A doc's or file's visibility, slug, byline or owners, and whether a doc is a record; tagging a published or scheduled post; deleting or restoring a doc, file, annotation or link |

Uploading, downloading and exporting go through §5's byte routes, not through a tool's
arguments: `upload` and `download` answer only with a route's URL.

**Every tool is listed with a `multiblog_` prefix**, `multiblog_search` for `search`, since
claude.ai shows its model a tool's name and nothing of the server it comes from (§21, "What
the model is told"). This document names each tool as the code does, without it; any text a
model reads names the listed one.

**Hints.** Every tool carries MCP's annotations, which a client may use to decide how to
present a call:

- `readOnlyHint: true` on the four reads, and on `upload` and `download`, which
  change nothing themselves: an upload happens when its bytes arrive.
- `destructiveHint: false` on the writes that only add: `create_doc`, `add_note`,
  `create_link`, `extend_link`, `tag`.
- `destructiveHint: true` on the writes that overwrite or remove: `edit_doc`, `rename_file`,
  `edit_note`, `edit_link`, `untag`, `manage`.
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
  name, such as "outline section page quote thread link" for `read`. claude.ai's tool search
  doesn't read it, so each description holds the same words, leading with them (§21).

**Forced prompts.** Claude Code doesn't decide its prompts by MCP's hints. What it honors is
`_meta["anthropic/requiresUserInteraction"]: true` on a tool: it then asks on every call, even
in auto and bypass modes and whatever the allow rules say, with no "don't ask again" (and in
`dontAsk` mode refuses instead). It is set on the tools whose actions can't be undone, and
only those:

- `edit_link`: a link's name and part order keep no history, and removing a part deletes its
  anchor row, captured quote and all.
- `rename_file`: a file's title keeps no history.
- `manage`: an audience that has been widened has already seen the doc, a chip on a public
  post may already be in someone's cache, and someone taken off a PRIVATE byline or owner list
  can't get back in. Its slug changes and soft deletes could be undone, but they share the
  tool, which only a person's `manage` token lists (§3).

The prompt has two limits, and the plan answers each:

- **Only Claude Code is documented to honor the flag**, from v2.1.199. Another client may
  treat these tools like any other, with an approval its user can set to always allow, so
  only a token issued for `claude-code` lists them (§3). From claude.ai, renaming a link,
  retitling a file and `manage` are done in the UI. §21 keeps it so for claude.ai, whose
  Research is documented to call tools without asking at all, until the two are auditable and
  revertible (TODO.md).
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
        "mcp__multiblog__multiblog_search",
        "mcp__multiblog__multiblog_read",
        "mcp__multiblog__multiblog_find_*",
        "mcp__multiblog__multiblog_download"
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

How each client connects, and what a session spends on the server. Claude Code's header is
§5's: the `mcpServers` entry, the token's file, and the settings that keep the token from the
model. OAuth is §21's.

**Claude Code:**

- **Configure the server per project, in a research directory, not for every project.**
  Claude Code puts a server's instructions in every session where it is configured, coding
  sessions included, and loads `search` and `read` there up front (§15). A project's
  `.mcp.json` keeps both to the sessions that use them, and the allow rules (§15) go in that
  project's `.claude/settings.json`.
- **There are three ways in** (§21, "Which clients"). The project's entry decides between the
  first two:
  - **The header**: an entry whose `headersHelper` reads a token the operator issued for
    Claude Code (`create-api-token.ts --client=claude-code`, §3, §5). It is the only way in
    that lists `edit_link` and `rename_file`, and `manage` with a person's own token.
  - **A sign-in through Claude Code's own identity**, for anyone without a header token: an
    entry with the URL and no `headersHelper`, then `/mcp`, which opens the consent page in a
    browser. The page warns that the connection goes to a program on the person's own
    computer, and they approve it as one of their bots, as a claude.ai connection is approved
    (below). On Linux its tokens are kept in `~/.claude/.credentials.json`, which §5's settings
    deny to the sandbox.
  - **The claude.ai connection**, which follows the account into every Claude Code session as
    `claude.ai <connector name>`, through Anthropic's proxy, with no token on the machine. It
    lists what a claude.ai connection lists, has claude.ai's bound on `read`, and its allow
    rules are named `mcp__claude_ai_<Name>__*`.
- **A claude.ai connection would undo the per-project rule.** The project's own entry outranks
  it there, and `deniedMcpServers` in `~/.claude/settings.json`, naming the connector, keeps it
  out of every other session (§21, "What else changes for claude.ai").
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

**claude.ai:**

- **A connection acts as one of the person's bots**, never as the person (§21, "Whose
  account"), so they need a bot first. An ADMIN makes one on `/users`, and the consent page
  says so to a person with none.
- **The connector is added in claude.ai**: a custom connector at the URL the Connections card
  gives, `<APP_URL>/api/mcp` exactly, with Claude's published identity, which claude.ai's dialog
  recommends. Connect opens the consent page on the instance, where the person signs in,
  chooses the bot, leaves `write` unchecked for a connection that only reads, and approves. The
  web, Desktop and the mobile apps share the one connector.
- **It lasts until it goes 90 days unused**, refreshing on its own. Revoke, on the Connections
  card, ends it at its next request, and claude.ai then asks the person to connect again.
  Disconnecting or removing the connector in claude.ai ends nothing here.
- **Each tool's setting is claude.ai's**: Always allow, Needs approval or Blocked. In a chat, a
  call on Needs approval waits for the person, but claude.ai's auto mode approved such calls
  unasked (§21, "The header trial").
- **After a deploy that renames a tool or rewords its description**, the person presses
  "Refresh tool list" in the connector's settings. Until then a chat calls the old names and
  reads the old descriptions (§21, "The full trial"), and a tool on Always allow asks again
  once its name or description has changed.
- **The skill, or the paragraph for a Project**, both on the Connections card, tell claude.ai
  that the person's research is in MultiBlog, which nothing in the connector can (§21, "What
  the model is told"). The skill is uploaded under Customize > Skills and needs code
  execution; the paragraph goes in a Project's instructions.
- **The byte routes work only once the person allows the instance.** They need curl, and code
  execution's egress proxy refuses a host that isn't among the allowed domains in claude.ai's
  settings (§21, "The header trial"). Until it is, the export and its catalog can't stand in for
  reads there, and the lean results (§4) are all that keeps a sweep affordable.
- **Research has called no connector**, in any trial (§21, Open).

## 17. Existing gaps the MCP server must not inherit

The MCP server avoids every one by construction, and building it fixed three in the UI's paths
as well:

- **Items 1–3 remain in the UI's paths.** The MCP server uses only the column mechanism,
  validates stamps, and re-checks a reply's parent.
- **Item 4 is fixed for both**: the delete and restore are `setAnnotationDeleted`
  (`src/lib/annotation-manage.ts`), which the actions wrap.
- **Item 5's byline half is fixed for both**: the byline actions wrap `setDocByline` (§12).
  `/dashboard`'s Recent docs still lists a doc to an ineligible name already on its byline.
- **Item 6 is fixed**: `/admin/annotation-replace` refuses a read-only token.

Items 1–3 should still be fixed on their own account (TODO.md).

1. **A reader can have the server write into a doc they cannot edit.**
   - `postAnnotation` takes `anchorMode` from the client for a root annotation. For
     `"mark"`, it applies a mark through the collab server.
   - Nothing in `src/app/actions/annotations.ts` calls `canUserEditDoc`.
   - `/admin/annotation-mark` refuses a read-only token, but the token `annotation-admin.ts`
     mints for the poster is writable whatever the poster may do to the doc.
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
   - `download` and its grants, for the export, and an audience on the ydoc token (§5).
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
     byline, from an argument or a Markdown body sent to `upload`'s URL (§5); and the
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
5. **OAuth and SDK v2, for claude.ai**: planned in §21, with a build order of its own, and
   built but for the read-only endpoint, which is designed.
6. **If wanted:** passage-level tags (PLAN.md §20, PR 2). Not built.

Phases 1–5 are built, each with its specs (`e2e/mcp-*.spec.ts`), unit tests and integrity
checks.

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
2. **claude.ai.** Settled: §21's OAuth is built. What is open is the questions §21 leaves
   (§21, Open).
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

## 20. As built: where it departs from the plan

Each of these is a decision the build made where the plan was silent or turned out wrong. The
code beside each says why as well.

**Reads**

- **`read` declares no detailed output schema.** Its result's shape depends on the URL's kind,
  so its `outputSchema` is a loose object with an optional `kind`; the other tools declare
  theirs.
- **A doc's sections, for `search`'s `within`, end at the next heading of any level**, not the
  next of the same level or above, so a hit names the smallest section holding it.
- **A card's URL that two notes share is `ambiguous`.** A card's name is its writer and the
  second the note was opened, so one writer's two notes in one second share it; the page jumps
  to the first, and a reply or a delete could reach the wrong one. The answer lists both ids.
- **A schema refusal inside a union names the union's forms** and the issues of the branch that
  came closest (`src/lib/mcp/issues.ts`), since zod reports only "Invalid input" there.

**Tokens**

- **A token whose issuer has been deleted is refused**, as one whose user has been: the issuer
  decides who a `write` may name, and a deleted account decides nothing.

**Docs**

- **An insertion after a heading takes `atEnd`**, to put the new blocks at the end of that
  heading's section rather than just under it.
- **A revert works in block-level hunks**, and a reverted title carries the actor's mark, as
  any title the actor writes does.
- **The merge compares finer tokens than the diff shows.** An edit merges word by word with
  punctuation split off (so a comma after an annotated word doesn't inherit its note), while a
  `since` read's diff splits on whitespace only, which reads better.

**Annotations**

- **`edit_note` gives new words the actor's mark only once the body has two writers**,
  which is when the editor turns the author mark on (`AnnotationBody`). Nothing backfills the
  first writer's words with a mark when a second arrives, as the editor doesn't either.
- **A reply's result carries no `version`.** A reply quoting its parent is stamped in the
  parent's body log, so the number would read as the doc's version and isn't.

**Bylines and owners**

- **Eligibility applies to the people a byline or owner list adds**, not to everyone on it
  (§12 said "every user named"). Someone already on it — an account since demoted or deleted —
  stays eligible to stay, or a byline holding one could never be reordered again.

**Links**

- **`edit_link` names parts by number**, 1-based in the link's order, counted over all its
  parts. A read shows the numbers to the link's creator only: to anyone else a gap would say a
  part they can't read exists.
- **A part's `on` is a doc or PDF**, not a fragment link; a fragment link's passage is quoted
  with `page` instead.
- **The `/links` page's query is unchanged.** The links into a target come from
  `linkPartsInto` (`src/lib/anchored-link-data.ts`), a query of its own beside the page's.

**Tags**

- **`untag` removes the actor's own assignments**, and with `anyone` everyone's, for an ADMIN
  or EDITOR. Every term is found before anything is removed.
- **`tag` and `untag` take no idempotency key**: a term is found by name and an assignment by
  tagger, so a repeat changes nothing.

**Files**

- **A repeated upload of bytes the actor can read answers 200 with `existing: true`**, a new
  one 201. A byte route maps an upload's refusal to a code by its status: 400 and 415 are
  `invalid`, 403 `forbidden`, 413 `too_large`.

**The importer**

- **Earlier imports are marked as records by `--mark-records`**, a pass of its own rather than
  a side effect of every run, though any run that matches a session's doc marks it too.
- **A Markdown file's key is its name without its directory.** Two files of one name in
  different directories would be one doc's source; the match refuses a key two docs share.

**Names and descriptions** (§21, step 2)

- **`create_doc`'s description names the issuer only where a new doc's byline takes them.** For
  a token its actor issued, or an issuer who can't carry a byline, it names the actor alone and
  says nothing of `issuerOnly`, as `newObjectPeople` decides the byline.
- **A renamed tool's `api_write` operation is its new name** (`add_note`, `extend_link`), so a
  retry that straddles the deploy runs again rather than answering `already_done`.
- **The skill and the instructions have unit tests besides the spec**
  (`src/lib/mcp/skill.test.ts`): every `multiblog_…` name either mentions is one the server
  lists, and the skill's name and description pass claude.ai's rules, the description as a
  plain YAML scalar. The spec checks each description's mentions the same way, over
  `tools/list`.

**The bearer check** (§21, step 4)

- **The gate takes §3's check as an argument** (`src/lib/mcp/bearer.ts`), so the verifier and
  both of its answers are unit-tested without a database (`bearer.test.ts`), and the route
  passes `authenticateSecret`.
- **The scopes are reported by OAuth's names**, `read` rather than the enum's `READ`, as the
  challenge names them.
- **A check that fails rather than refuses**, such as a database error, is logged and answered
  500 by v2, never 401, so a client doesn't take an outage for a revoked token.
- **The e2e fixture's tokens expire in a day**, and a second fixture backdates one for the
  expired-token spec.

**The thin slice** (§21, step 5)

- **Nothing of the read-only endpoint's is built**, so there is no `api_token.oauth_resource`
  and a code's row holds no endpoint: `/api/mcp` is the only resource, and every `resource` a
  request sends is checked against it. The column comes with that endpoint, if it is built.
- **A connection's prefix is `oa_` and the end of its id**, not the start. A cuid starts with
  its timestamp, so two connections made in the same second would share a prefix, and the
  audit line names a token by its prefix alone. The id isn't known until the row is created,
  so the prefix is written in the same transaction, after it.
- **Where it lives.** `src/lib/oauth/`: `discovery.ts` (the issuer, the endpoint's URL and both
  documents), `clients.ts` (Claude's pinned document and the lookup), `authorize-request.ts`
  (the page's parse, which the decision runs again), `consent.ts`, `grant.ts` (`/token`),
  `access-token.ts`, `pkce.ts` and `resource.ts`. Every pure one has unit tests. The routes are
  `src/app/.well-known/…`, `src/app/authorize/` with `decide/`, and `src/app/token/`.
- **`authenticateBearer` is the bearer check's verifier** (`src/lib/api/tokens.ts`, beside §3's
  check). It tells an `mb_` secret from an access token by the prefix, and refuses an access
  token whose subject is a header token's row. `access-token.ts` signs and verifies without a
  database, so the three audiences signed with `AUTH_SECRET` are unit-tested against each
  other.
- **`@modelcontextprotocol/core` is a dev dependency.** Only the tests use its schemas; the
  server takes the types from `@modelcontextprotocol/server`.
- **`/token` ignores any client authentication** rather than refusing it, since every client is
  public and claude.ai's own-client option may send an empty secret. It answers an unknown
  client `invalid_client` with a 400, since no client authenticated and a 401 needs a
  `WWW-Authenticate`. It takes a form body alone, of at most 16 KiB, and refuses a repeated
  parameter but `resource`.
- **The page shows a refusal with a 200**, since a Next page can set no other status but 404.
- **An S256 challenge must be 43 base64url characters**, which is the only shape one can have,
  and a decision without Approve is Cancel. The write box appears only when the client asked
  for `write`.
- **The e2e fixture `createTestBot`** makes a bot with no password, working for a given
  person. `createAgent` (`e2e/mcp.ts`) is unchanged until step 8.

**Refresh tokens** (§21, step 7)

- **The rotation rule is a function of a token's state** (`src/lib/oauth/rotation.ts`,
  unit-tested): whether it has been rotated and when, whether a token issued from it has been
  used, and whether a sibling has. The token endpoint reads that state under a `FOR UPDATE`
  lock on the connection's `api_token` row, so two refreshes sent at once each see the other's
  rotation, and the second is answered as a retry rather than taken for a replay.
- **A refresh token's parent is a plain column**, `oauth_refresh_token.parent_id`, not a
  foreign key, so pruning a parent leaves its children able to find their siblings.
- **A new connection replaces the bot's last one for any `claude-ai` client**, including one
  registered by hand as claude.ai's fallback, not for Claude's published identity alone
  (`replacesConnections`): the reason, claude.ai reconnecting to recover, holds for both.
- **The consent page names each bot with a live connection** through the client from the
  person signed in, when that connection was made, and that approving as that bot ends it.
- **A refresh's bucket is its own**, keyed on the connection, apart from the one its calls
  take from, so a burst of calls can't make a refresh fail. An empty one is answered 429
  with `invalid_request`, since OAuth has no error code for it. The bucket has no unit test:
  it is taken between two database reads, and the unit tests touch no database.
- **A refresh needs `client_id`**, as a code's redemption does, since a public client names
  itself that way. A known client other than the connection's is `invalid_grant`.
- **A refresh's `scope` asks for more only by naming `write`** on a connection that can only
  read (`asksForMore`). Any other word is ignored, as on the consent page.
- **`create-api-token.ts --list` shows a lapsed connection as lapsed**, by the rule the
  Connections card applies (`tokenState`, step 10).
- **The migration revokes every connection with no refresh token**, which is every
  connection the slice made.
- **The e2e covers §21 Testing's refresh cases but one**, a connection to the read-only
  endpoint, which isn't built. A replay past the two minutes is set up by
  `backdateRefreshRotation`, and Revoke on `/dashboard` is step 10's.

**Bot accounts** (§21, step 8)

- **The rule is one pure function**, `tokenRefusal` (`src/lib/bot-rules.ts`, unit-tested):
  the issuer a token must have, then a bot's role against its person's. §3's check applies it
  on every call, and **`issueApiToken` applies it at issue**, rather than the script alone, so
  the script and the e2e fixture share the refusal.
- **Redeeming a code refuses a bot that has come to outrank its person**, as well as one that
  no longer works for them. The plan named only §3's check, which would refuse every call
  such a connection made.
- **The consent page leaves out a bot the check would refuse**: one ranked above the person
  signed in, and every bot of a COMMENTER. The decision refuses the same bots.
- **Only a promotion is refused.** A bot's role cell offers its own role and every one below
  it, and above that only what its person allows. Demoting a bot or a person never is, since a
  person demoted below their bot stops its tokens at the check.
- **Moving a bot takes an inline Yes/No**, as Send invite does, since the tokens it revokes
  don't come back. Unlike the table's other selects, choosing a person commits nothing.
- **The Works for column is hidden by default** (PLAN.md §16m), since it is blank on every
  person's row. It sorts by the name of the person a bot works for.
- **`+ New bot` is a panel below the table**, just above its help. It offers only the people a bot may work for,
  and only the roles a bot may have under the one chosen. A bot starts as an AUTHOR where its
  person allows, as Claude's account is (§3).
- **A bot's slug is made from its name, and its address from its slug.** The e2e fixtures pass
  an address of their own (`createBot`'s `email`), so a crashed run's bots are swept up with
  its other accounts.
- **A bot's token asking for `manage` is issued all the same**, and lists no `manage`
  (`toolsFor`); the script says so as it issues one.
- **The e2e holds /users' refusals beneath the UI** (`e2e/mcp-bots.spec.ts`), through the
  functions the actions wrap (`src/lib/bots.ts`). That includes a person with no password,
  which only a database read can see, so no unit test reaches it; a bot with a password is the
  CHECK's to refuse. `e2e/users-bots.spec.ts` drives the panel and the column once. A bot the
  panel makes there is named "E2E …", so its address, `e2e-…@multiblog.invalid`, is one the
  fixtures may touch and the sweep removes.

**The consent page in full, and the clients** (§21, step 9)

- **The pins are in `src/lib/oauth/pinned-clients.ts`**, a module with no database, beside the
  comparison the drift check runs (`client-drift.ts`, unit-tested). So
  `scripts/check-oauth-clients.ts` needs neither `.env` nor Postgres. `clients.ts` builds its
  lookup from the pins, and holds `registerClient` and `revokeClient`, which the script and
  the e2e fixtures both call.
- **The drift check compares the acted-on lists as sets**, since the server acts on none's
  order. It exits 1 on a warning, for a run by hand; `deploy.sh` ignores the status.
- **`oauth-client.ts --list` shows the two pins beside the rows**, and `--revoke` refuses a
  pin. A redirect URI with a private-use scheme (`com.example.app:/callback`) passes: it is
  absolute, and the rule names only plain `http`. A client's name is at most 100 characters,
  since the page shows it whole.
- **The page renders no site header** (`SiteHeader` returns nothing on `/authorize`). It is a
  step in another app's flow, and every link off it abandons that flow; the header's own Sign
  out lands on `/`. Its prefetches go with it, among them a sign-in link that drops the
  request's query.
- **The switch signs out**, through a server action, and sends the person to sign in with the
  whole request as the destination. Signing in over a live session would have worked too, but
  the first person's session would then outlive a switch they abandoned.
- **The client's identity is named by its `client_id`'s host only for an `https` URL**: "Its
  identity is published by claude.ai". A client registered by hand has a cuid for an id, and
  no host to name.
- **The loopback warning names the host and port** the connection goes to, and asks the person
  to approve only if they started it from the client themselves. It sits above the warning
  against a flow someone else started, which every page carries.
- **"What the connection can do"** says that it acts as the bot, reading only what the bot can
  read and writing in its name; what it can't do, which is `manage`'s work; and that it lasts
  until it goes 90 days unused, or until it is revoked under Connections on the dashboard. That
  is said in words, not a link, since every link off the page abandons the flow. The scope
  boxes name what each scope's tools do.
- **A person with nothing to connect as is told why**, in one of three sentences, with Cancel
  alone: a COMMENTER, who can't have a bot; a person whose bots all outrank them, named, with
  what an ADMIN can change; and a person with no bot, told that an ADMIN makes one, or, when
  they are an ADMIN, pointed to `/users`. `botsFor` returns the refused bots beside the
  offered ones for this.
- **Claude Code's connections don't replace each other**, as a claude.ai client's do
  (`replacesConnections`): its kind is `other`, and each `/mcp` sign-in is a connection of its
  own, which lapses with its refresh token.

**`read`'s bound for claude.ai, and the Connections card** (§21, step 10)

- **A `claude-ai` token's bound is 95,000 characters** (`readBoundFor`,
  `src/lib/mcp/read/args.ts`), 5,000 under claude.ai's 100,000. The margin is for what
  `include` adds to a ranged read, which is paged on its own rather than fitted with the
  blocks. Every bound is measured by the serialized result's JavaScript length, which never
  counts fewer characters than claude.ai does.
- **`read`'s description is built per token**, since it names the bound `whole: true` lifts a
  read to; a description function takes the token's client beside its people. The `whole`
  parameter's own description names no number, since the input schema is the same for every
  token. `_meta["anthropic/maxResultSizeChars"]` stays 200,000 on every token: only Claude
  Code reads it, and it is a ceiling, not a promise.
- **The card and `create-api-token.ts --list` read one rule**, `tokenState`
  (`src/lib/api/token-state.ts`, unit-tested).
- **Revoke takes an inline Yes/No**, as `/users`' Send invite does, since a revoked token
  never comes back. Revoking a connection logs the token endpoint's line, with the reason
  `dashboard`. The rule is `revokeToken` (`src/lib/api/token-card.ts`), taking an `Actor`, and
  the action wraps it.
- **The skill's ZIP is served at `/dashboard/multiblog-skill.zip`**, built per request from
  `skill.ts`, so it matches the tools that build serves. It asks for a session only because
  the card does: it names no account.
- **The paragraph for a Project** is `projectInstructions` (`skill.ts`): what MultiBlog holds,
  to search it first, and how its tools are named, from the text the skill and the
  instructions share. The steps of a research session stay the skill's, since each tool's
  description carries its own part of them. The card shows it in a box that one click selects
  whole.

## 21. OAuth, for claude.ai

**Status: built**, every step of the build order below, but for the read-only endpoint, which
is designed ("The read-only endpoint"). §20 says where the build departs from this plan (§18's
phase 5), and §16 how each client connects. Five trials tried claude.ai and Claude Code against
it as it was built, four on a trial instance and the last on explore ("The early trial" through
"The full trial"): claude.ai connects through OAuth on the web and on iOS, refreshes on its own
on both, and asks the person to connect again after a revoke from `/dashboard`; a reconnect
replaces the connection before it; a renamed or reworded tool reaches claude.ai only when the
person refreshes the connector's tool list; Claude Code signs in through its own identity; and
a sandboxed command is refused the token's file. Research calls no connector (Open).

claude.ai's custom connectors authenticate with OAuth, short of a request-header beta
that serves for a trial and not as a connection (§5), so this makes MultiBlog an OAuth
authorization server for its own MCP endpoint, as small a one as claude.ai needs and the MCP
authorization spec allows.
It is written to the spec's newest revision, 2026-07-28, and to what claude.ai does as a
client: Anthropic documents that under claude.com/docs/connectors/building, and server logs
posted to `anthropics/claude-ai-mcp` fill in the rest. Three trials check each point the plan
leans on (Build order), the first two on a trial instance and the last on explore:

- **the header trial**, right after the move to SDK v2 and the renamed tools, where claude.ai's
  connector dialog offers request headers: claude.ai against both, before any OAuth is built;
- **the slice trial**, as soon as claude.ai can connect through OAuth, before most of the plan
  is built, because an open claude.ai bug puts that in doubt (Open);
- **the full trial**, once everything is built.

An early trial on the same instance, against the move to SDK v2 alone, has answered the header
trial's questions about the protocol, and raised two of its own ("The early trial"). A refresh
trial there, against step 7's build before it merged, has answered the full trial's about
refreshing on the web and a reconnect replacing a connection ("The refresh trial").

Claude Code keeps §5's header and its token file, and gains two more ways in: signing in with
`/mcp` through its own identity, and the claude.ai connection, which follows its account there
("Which clients"). A `headersHelper` that supplies `Authorization` takes precedence over OAuth
in Claude Code, so a server entry with one never signs in.

The phase also moves the server to SDK v2, which comes first. claude.ai opens in a protocol
revision that v1 refuses, and it can't list the tools without the move (below). The tools are
renamed next, since claude.ai drops the server's instructions and shows its model nothing of
a tool but its name until it searches ("What the model is told"). An endpoint that lists only
the reads, for Research, is designed and not built ("The read-only endpoint").

### A connection

- **A connection is an `api_token` row** (§3). What the script's flags decide is decided here
  too: the account, the issuer and the scopes on the consent page, and the `client` column by
  the identity that asked (below). One thing is new: the endpoint the connection is for,
  `/api/mcp` or the read-only `/api/mcp/read`, from the request's `resource`, kept as its path
  in `api_token.oauth_resource`. Everything that keys on a token keys on the row, and none of
  it changes: §3's one check, the tool list, `api_write`'s claims (§4), the rate limit,
  `last_used_at`, the audit line, byte grants (§5) and revocation.
- **Only the credential differs.** A script's row has one secret for life. A connection's row
  has none of its own: `token_hash` becomes nullable, so an `mb_` lookup never reaches it, and
  its `prefix` is `oa_` and the start of its id. A CHECK keeps the two kinds apart: a row has a
  `token_hash` or an `oauth_client_id`, one and never both,
  `(token_hash IS NULL) <> (oauth_client_id IS NULL)`. A connection's row is reached through
  two credentials minted from it:
  - **An access token, good for an hour.** It is a JWT signed as a byte grant is (`jose`,
    HS256, `AUTH_SECRET`), with its endpoint's URL as its audience and the row's id as its
    subject. Nothing else in it decides anything. The endpoint's bearer check verifies it ("The
    bearer check", below), then runs §3's one check on the row it names, as a byte route does
    with a grant. So revoking the row, or deleting its account or its issuer, ends it on the
    next call, however much of its hour is left.
  - **A refresh token**: `mbr_` and 32 random bytes, kept as its SHA-256 in
    `oauth_refresh_token`. It is rotated on every use, as the spec requires for a public client,
    and is good for 90 days from its issue. A connection unused for 90 days ends; reconnecting
    is one click in claude.ai.
- **A rotated refresh token presented again revokes the connection.** Either the client or a
  thief holds a copy, and the row can't tell which (OAuth 2.1 §4.3.1).
  - **The exception is a retry.** A rotated token is answered again, with a new pair, only
    while none of the refresh tokens issued from it has been used, and for at most two
    minutes. claude.ai gives a refresh 30 seconds before abandoning it, and a client that
    retries after losing the answer, or sends two refreshes at once, is not a thief. This
    departs on purpose from OAuth 2.1 §4.3.1, under which a rotated token is simply invalid.
  - **An access token's use never closes the window.** When an hour runs out, every call in
    flight can get a 401 at once, and nothing documents claude.ai refreshing only once for
    them. Were the first new access token's use to count, a second refresh a few seconds later
    would be a replay, and would revoke a healthy connection.
  - **The window closes early the moment any of its children is spent**, that is, the moment
    one of the refresh tokens issued from it is used in turn. The old token presented after
    that is a copy, and is caught at once rather than when the split below comes to light.
  - **Using either new token retires the other, and a retired token counts as a replay.**
    Presented later, it revokes the connection rather than getting `invalid_grant`. Whoever
    lost the split presents theirs sooner or later, and that is how the split is found.
    Answered with `invalid_grant`, the loser would only reconnect, and the winner, perhaps a
    thief, would keep the connection unnoticed.
  - **What the window leaves open.** A thief who presents a just-rotated token inside the two
    minutes gets an access token good for an hour. If they never use the refresh token that
    came with it, the split never comes to light. That hour is the price of answering retries.
- **Rotating `AUTH_SECRET` ends every access token at once.** Each client then refreshes, since
  a refresh token is a hash in the database, not a signature.
- **`mb_` tokens stay valid, at both endpoints.** The spec's "MUST NOT accept or transit any
  other tokens" is about tokens issued for another audience. An `mb_` token is this server's own
  credential for its endpoints, from its own table.
- **Why a JWT and not a second hashed secret.** The row is read on every call anyway (§3), so a
  stored access token would buy nothing its signature doesn't, at a write an hour per
  connection. Its audience keeps it apart from the two tokens already signed with the same
  secret: a byte grant or a ydoc token is never an access token, and an access token is
  neither of them.
- **Why not an `mb_` secret.** claude.ai would keep one, and the spec's MUSTs hold when no
  refresh token is issued. But the secret would travel on every call, from a server we don't
  run, for the whole of its year ("The bearer check", below). The spec asks for short-lived
  access tokens for that reason, and honoring it costs one table.

### Whose account

- **A connection acts as a bot account, never as the person approving it.** §5 decided this for
  attribution: what claude.ai writes carries Claude's name, not its user's. It also keeps
  Claude's reading to what has been shared with Claude (§12).
  - **That holds even for a read-only connection.** §3's "never a person's token" is about what
    Claude can see as well as what it signs, so the page offers no connection as oneself.
- **A bot is an AI agent's account.** It works for one person, recorded as
  `user.works_for_user_id`: "the person the bot works for", in §3's words. The consent page
  offers only the bots that work for whoever is signed in, and that §3's check would accept.
  That person becomes the connection's issuer, as `--issued-by` makes them for a script's token.
- **Only an account with no password may work for someone, and only for an account with one.**
  Sign-in is by password alone (`src/lib/auth.ts`), so a password is what makes an account a
  person's.
  - **So a person can't be made to work for another.** If one could, the second could connect
    as the first and read their PRIVATE docs. That would get past CLAUDE.md's rule that a
    PRIVATE doc is its byline's alone, ADMINs included, and without even the email an invite
    sends to the account's owner. Nor can a bot work for a bot.
  - **A CHECK keeps a bot from gaining a password later:**
    `works_for_user_id IS NULL OR password_hash IS NULL`. An ADMIN's invite is how a bot would
    get one (§3): `sendMail` reports a `.invalid` address delivered, so `/users` shows the
    invite's link. `/users` refuses to invite a bot, and the CHECK refuses a password set any
    other way, `set-user-password.ts`'s included.
  - **The web interface never turns an existing account into a bot.** It sets a person only on
    a bot it is creating, and moves a bot that already has one. An account that was imported
    and never claimed has no password either, and it is still a person's.
- **A COMMENTER has no bot, and a bot never outranks its person.** Rank is the order `Role`
  is declared in, ADMIN down to COMMENTER, which is privilege order (`users-query.ts`). A bot's
  tokens act with its own role (§3), so a bot above its person would let the person do through
  it what their own role forbids: a COMMENTER's AUTHOR bot would create docs the COMMENTER
  can't.
  - **The web interface refuses either** when a bot is made, promoted, or given a person.
  - **§3's check refuses a bot's token while either holds**, so demoting a person takes effect
    on their bot's next call, as demoting the bot itself does. The check reads both rows
    already.
- **Why one person.** A bot reads whatever any list names it on (§12). Two people using one
  Claude, by any route, would each read through it what the other's Claude had written, since
  Claude is on both bylines. The issuer also decides who `write` may put on a byline (§12). A
  second person who wants Claude gets a second bot ("Claude (Alice)"), and nothing passes
  between the two unless someone shares it on purpose.
- **It holds for every token, the header's included**, because §3's one check enforces it:
  - **The check:** a token is accepted only if its issuer is its account's person,
    `works_for_user_id ?? the account's own id`: for a bot's token, the person the bot works
    for; for a person's own token, that person. It is one comparison, on a row the check reads
    anyway. A rule that looked only at a token whose account isn't its issuer would accept a
    bot's token issued by the bot itself.
  - **At issue:** the script refuses a token that wouldn't pass, so the operator gets an error
    rather than a token that never works.
  - **So each person needs their own bot, whatever the route.** A header token for Alice's
    Claude Code is issued for "Claude (Alice)", with Alice as its issuer, exactly as her OAuth
    connection would be.
- **The web interface makes bots.** An ADMIN, on `/users`, creates one: a name, its person,
  and a role no higher than theirs. It can later give the bot another person, and the person is
  a column of the table, the one thing about tokens that page touches.
  - **There is no script for it.** The interface does every bot task, and the one task that
    needs a shell, issuing a header token, already has `create-api-token.ts`.
  - **The rules live in `src/lib/`**, in a function taking an `Actor`, with the action as its
    wrapper (CLAUDE.md), so the e2e fixtures and the action hold bots to the same rules.
  - **A bot's address is `<slug>@multiblog.invalid`**, after `claude@multiblog.invalid`.
    Nothing is mailed to a `.invalid` address, and it shows nowhere but ADMIN surfaces.
  - **Moving a bot to another person revokes the tokens the previous person issued for it.**
    The check would refuse them anyway; revoking keeps a move back from reviving them.
- **The Claude accounts on the trial instance and explore get their person once, by hand.** One
  `UPDATE` on each sets its `works_for_user_id` to Luke's account: the trial instance's before
  the slice trial, which runs there, since the consent page offers only a bot that works for
  whoever is signed in; explore's as the works-for rule (step 8) reaches it, since the rule
  refuses the header tokens already issued for it.
  - **The update runs after the migration and before the new build serves.** The column comes
    with `oauth_slice`, so on an instance without it the update can't come first. `deploy.sh`
    migrates, then builds, then swaps the build in, so an update made while it builds leaves no
    moment when the new code refuses a header token.
  - Luke is the only person using Claude, so nothing needs checking first. **The CHECK above
    refuses the update while the account has a password, so the same statement clears it**
    (`SET password_hash = NULL, works_for_user_id = …`). Explore's had one; the trial
    instance's didn't.
  - **Its address stays `claude@multiblog.invalid`.** The importer's `MB_EMAIL` and
    `BYLINE_EMAILS` default to it, and a bot's address is an identifier, never a mailbox.
  - **A Claude account on another instance gets its person the same way**, by the same
    `UPDATE`, as a build with the works-for rule reaches it. The web interface can't do
    it, since it never turns an existing account into a bot. The other way is a new bot, made
    in the web interface beside the old account.
- **Otherwise a bot is as §3 describes Claude's account.** Its tokens act with its own role,
  which its person's only bounds.
- **Scopes: `read`, or `read` and `write`.** The person chooses on the page, never more than
  the client asked for.
  - **`read` alone is chosen until the person changes it**, so `write` is granted on purpose
    and never by default.
  - **`write` implies `read`**: the spec requires a server to treat a broader scope as
    including the narrower ones. So a request naming `write` alone asks for both, and so does a
    request naming neither.
  - **A connection to the read-only endpoint is offered `read` alone** ("The read-only
    endpoint", below).
  - **Never `manage`** (§3): the page doesn't offer it, and no metadata lists it.
- **The client is `claude-ai` for Claude's published identity**, and for a client registered by
  hand as claude.ai's fallback (`--kind=claude-ai`, "Which clients", below). It is `other` for
  anything else. OAuth never issues a `claude-code` token, since a client's claim to be Claude
  Code rests on a loopback redirect, which any program on the machine can answer. So no
  connection lists `edit_link` or `rename_file`, which stay a `claude-code` token's ("What else
  changes for claude.ai", below), and `manage` is outside every connection's scopes.
- **Deleting a person revokes the tokens they issued**, in the transaction that revokes their
  own (`softDeleteUser`). §3's check already refuses those tokens, but restoring the account
  would bring them back; this way a restore brings none back, as §3 says of the account's own.

### Which clients

A request names its client by `client_id`, and an unknown one is refused before anything else.
**Every client is public**: none has a secret. PKCE is the proof on the code, and rotation
guards the refresh token. The metadata lists `none` as the only authentication method at the
token endpoint, which is also what makes claude.ai choose its published identity (below). There
are three kinds:

- **Claude's published identity**, a client ID metadata document (CIMD), which the spec
  prefers. Its `client_id` is `https://claude.ai/oauth/mcp-oauth-client-metadata`: a public
  client named "Claude" whose one redirect URI is `https://claude.ai/api/mcp/auth_callback`.
  - **Every Claude app uses it**: claude.ai on the web, Desktop and mobile.
  - **claude.ai picks it** over registering itself when the server's metadata sets
    `client_id_metadata_document_supported` and lists `none` among the token endpoint's
    authentication methods. Its connector dialog calls this "Use Claude's published identity"
    and recommends it.
  - **Pinned, not fetched.** The document's fields are a constant in the code, and a request
    naming that URL is answered from the constant. The authorize path makes no outbound
    request, and nobody can make the server fetch anything, so CLAUDE.md's rule against
    fetching a user-supplied URL holds by construction.
    - The spec says an authorization server SHOULD fetch the document, and this departs from
      that on purpose. The client-metadata draft allows it: its newest revision lets an
      authorization server register a client's URL ahead of time instead of fetching the
      document on each request, and asks only that the document be fetched when that is done
      (draft -02, §7.2), as both pins were.
    - **The two pins are an allowlist.** `client_id_metadata_document_supported` tells every
      client that a URL may serve as its `client_id`, but any URL other than these two is an
      unknown client. The draft lets an authorization server keep a trust policy of its own,
      and this is one.
    - The cost is that Anthropic can change the document. `scripts/check-oauth-clients.ts`
      fetches each pinned document and compares it with the constant, and a change is then a
      one-line edit. The change that would matter most is Claude becoming a confidential
      client (Open, below).
    - **It compares only what the server acts on**: `client_id`, `redirect_uris`,
      `token_endpoint_auth_method`, `grant_types` and `response_types`, and a `jwks_uri` or
      `jwks` appearing, which would announce the switch to a confidential client. A difference
      there is a warning. A difference anywhere else, a reworded `client_name` or a new
      `logo_uri` or `tos_uri`, is a note. Compared whole, every cosmetic edit would raise the
      warning, and a warning that keeps proving false gets skimmed past.
    - **An answer that isn't the document is a warning too**, a 404 say, since the URL is the
      client's identity. A fetch that can't complete is a note: it says nothing about the
      document.
    - **It follows no redirect.** The draft forbids an authorization server to follow one
      when it fetches a document (-02, §5), so a redirect is an answer that isn't the
      document.
    - **A Cloudflare challenge is a fetch that can't complete.** Claude's documents sit behind
      Cloudflare, which has answered fetches from some datacenters with a 403 challenge page
      (`anthropics/claude-ai-mcp#650`), and Linode is a datacenter. So a 403 carrying
      `cf-mitigated: challenge` is a note.
    - **`deploy/deploy.sh` runs it on every deploy**, once the new build answers, and prints
      what it finds without failing the deploy. Nothing else would run it, there being no CI
      or cron, and drift would otherwise first show as claude.ai failing to connect.
- **Claude Code's published identity**, `https://claude.ai/oauth/claude-code-client-metadata`,
  pinned the same way and checked by the same script. It is a public client whose redirect
  URIs are `http://localhost/callback` and `http://127.0.0.1/callback`, on any port. Claude
  Code uses it when a person signs in to the server with `/mcp`, instead of configuring §5's
  header.
  - **Its connections are `other`, never `claude-code`.** Any program on the machine can answer
    a loopback redirect, so a claim to be Claude Code can't be checked, and such a connection
    lists neither `edit_link` nor `rename_file`. A session connected this way renames a link or
    a file in the UI, or through the header (§5).
  - **The consent page warns** that the connection goes to a program on the person's own
    computer, and to approve it only if they started it from Claude Code. The spec asks for a
    warning on a client whose redirect URIs are all loopback.
  - **Its token is stored on the machine**: in `~/.claude/.credentials.json`, mode 0600, on
    Linux, and in the Keychain on macOS.
    - A sandboxed command can read that file by default. So the settings that keep §5's token
      file from the model deny it too, in `sandbox.credentials` and a Read deny rule.
    - Whether a sandboxed command can read the macOS Keychain isn't documented.
- **Clients registered by hand**, with `scripts/oauth-client.ts --name=… --redirect-uri=…
  --kind=claude-ai|other`: a row in `oauth_client`, listed and revoked by the same script.
  - **The script refuses a redirect URI** that isn't absolute, that has a fragment, or that is
    plain `http` on any host but a loopback address, as OAuth 2.1 and the MCP spec require. A
    code sent over plain `http` to another machine can be read on the way.
  - **claude.ai's fallback.** Its "Use your own OAuth client" option takes such a client's id
    with the secret left blank. That keeps claude.ai connecting if its published identity
    stops matching the pin before the pin is fixed.
  - **Anything else a person wants to connect**, such as the MCP Inspector while testing.
  - **Revoking a client revokes its connections.**
- **No dynamic client registration.** claude.ai doesn't need it, and the 2026-07-28 revision
  deprecates it in favour of CIMD. An open endpoint that writes a row per request would need a
  rate limit, pruning and a policy on redirect URIs of its own, for nothing the three kinds
  above don't already cover; claude.ai registers anew on every connection. The metadata lists
  no `registration_endpoint`.
- **So Claude Code has three ways in, all allowed:**
  - **The header (§5)**, for a research project of one's own. Its token is one the operator
    issues, it can carry `manage` for a person's own token, and nothing in it depends on the
    proxy or on OAuth.
  - **Its own identity**, for anyone without shell access to the server. It gets the same
    `read` bound and the same scoping to one project, but neither `edit_link` nor `rename_file`,
    and it puts a token on the machine, which the sandbox must deny.
  - **The claude.ai connection**, through Anthropic's proxy ("What else changes for
    claude.ai", below). No token is stored on the machine. But it appears in every Claude Code
    session unless denied by name, it has claude.ai's `read` bound and neither `edit_link` nor
    `rename_file`, and its allow rules are named `mcp__claude_ai_<Name>__*`.
- **Nobody issues themselves a header token.** `/dashboard` mints no `mb_` secret ("Seeing and
  ending a connection", below), and nothing else in the app does either: a header token comes
  only from the operator's script (§3). What a person can start for themselves is an OAuth
  connection, by either of the two OAuth ways above, and it reaches them through the consent
  page, not as a secret to copy.

### Discovery

This is what claude.ai reads before it opens the consent page.

- **One issuer string**: `APP_URL`'s origin, exactly, with no trailing slash. A client compares
  issuers as strings, and refuses the metadata on any difference. So the resource's
  `authorization_servers`, the metadata's `issuer` and the `iss` on every authorization response
  all use that one value: `new URL(APP_URL).origin`, never `.href`, which adds a slash. No
  document is built from the request's `Host`.
- **A 401 from either endpoint says where to look.** It is SDK v2's challenge,
  `bearerAuthChallengeResponse` ("The bearer check", below). `/api/mcp`'s is:

  ```
  WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", scope="read write", resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp"
  ```

  The read-only endpoint's names its own document, and `scope="read"`.
  - **Every 401 carries `error="invalid_token"`**, a request with no token included. OAuth 2.1
    §5.3.2 says a request that sent no credential SHOULD get no error code, but v2 has no way
    to leave it out. Anthropic's connector documentation shows the 401 both ways: with the
    code in its example of lazy authentication, and without it on its authentication page. A
    token that was sent and refused gets the code too, and the client refreshes rather than
    starting over.
  - **Its body is OAuth's error object**, `{"error":"invalid_token","error_description":…}`, not
    §4's `{ code, message }`, which is for refusals inside a call.
  - **It names the scopes**, as the spec asks. Without a scope in the 401 or the resource's
    metadata, claude.ai has been seen asking for `openid profile email` instead
    (`anthropics/claude-ai-mcp#1077`).
  - **The byte routes' 401 is unchanged, and they take no access token.** A grant, not OAuth,
    is how a shell reaches them (§5), and no shell holds an access token.
- **v2 serves the three documents**, through `oauthMetadataResponse`, with CORS open as it sets
  it. Each path is a route handler of its own that hands its request to that one function.
  - **Each exports `OPTIONS` as well as `GET`.** Next answers a preflight to a route that
    exports no `OPTIONS` by itself, with an `Allow` header and no CORS headers. A browser
    client whose request needs a preflight, because it sends a header of its own, could then
    never read the document.
- **Each endpoint's metadata** (RFC 9728) is the one v2 builds
  (`buildOAuthProtectedResourceMetadata`): `resource` is that endpoint's URL,
  `authorization_servers` the issuer, and `scopes_supported` `read` and `write`, or `read`
  alone for the read-only endpoint. It has no `bearer_methods_supported`, which RFC 9728 makes
  optional. v2 serves each at the path its 401 names,
  `/.well-known/oauth-protected-resource/api/mcp` and
  `/.well-known/oauth-protected-resource/api/mcp/read`, and nowhere else, so not at the root.
  A document there would describe the origin rather than an endpoint, and every client reads
  the 401's pointer first.
  - **v2 refuses to build it for an `http:` issuer** other than `localhost` or `127.0.0.1`.
    Slot B's `http://b.localhost` is neither, so `dangerouslyAllowInsecureIssuerUrl` is set
    exactly when `APP_URL` is `http:`, which no instance's is.
- **The authorization server's metadata** (RFC 8414) is at
  `/.well-known/oauth-authorization-server`, passed through by v2 as written and typed as its
  `OAuthMetadata`. It lists:
  - the issuer, and the authorization and token endpoints (below);
  - `code` as the only response type, and `authorization_code` and `refresh_token` as the
    grants;
  - `S256` as the only PKCE method, and `none` as the only token-endpoint authentication;
  - `read`, `write` and `offline_access` as its scopes;
  - `client_id_metadata_document_supported: true` and
    `authorization_response_iss_parameter_supported: true`.

  `offline_access` is listed here and nowhere else, as the spec asks. A client that sees it may
  add it to its request, which changes nothing: a refresh token comes with every grant.

  There is no OpenID configuration: nothing here issues an ID token, and an authorization server
  needs only one of the two documents.
- **The endpoints are `/authorize` and `/token`**, the paths the spec's 2025-03-26 revision gave
  as defaults for a client that finds no metadata. claude.ai has fallen back to
  `<origin>/authorize` when a server's metadata named an authorization server on another origin
  (`anthropics/claude-ai-mcp#341`, #706). With the server on the endpoint's own origin, and
  its endpoints at the defaults, every path claude.ai might take leads to the same place. Both
  are static routes, so `/[year]` never sees them.
- **A connector's URL is `<APP_URL>/api/mcp`, or `<APP_URL>/api/mcp/read`, exactly.** The
  resource's metadata must name the URL the user typed, and claude.ai strips a trailing slash.
- **No nginx change.** Its `location /` forwards `/.well-known/` to Next, where route handlers
  under `src/app/.well-known/` answer.
- **claude.ai caches these documents for about five minutes**, so a change to one takes that
  long to show.

### The consent page

`/authorize` is a page, not a route under `/api/`, because sign-in returns only to a page
(`safeCallbackUrl` refuses `/api/`). It checks, in this order:

1. **The client and its redirect URI.** An unknown `client_id`, or a `redirect_uri` that isn't
   exactly one the client registered, is answered on the page itself and never redirected, or
   the endpoint would be an open redirector. A loopback redirect URI matches on any port, as
   OAuth 2.1 requires.
   - **A request with no `redirect_uri`** takes the client's one registered URI. It is
     refused on the page when the client has more than one, as Claude Code's identity does,
     since OAuth 2.1 then requires the parameter (§4.1.1).
2. **The session.** A signed-out visitor goes to `signInPath()` with the whole authorize URL as
   the destination, and comes back to it (`check:sign-in`).
   - **It comes before any refusal that redirects.** OAuth 2.1 requires the person to be
     authenticated before the server redirects them anywhere (§7.12.2), so that a malformed
     request can't send a visitor to a client's redirect URI unseen. With every redirect URI
     pinned or registered by hand the risk is small, and the order costs nothing.
3. **The rest of the request.** Each of these refusals is redirected back to the client with
   `error`, `state` and `iss` (RFC 9207):
   - a `response_type` other than `code`;
   - no `code_challenge`, or a method other than `S256`. A missing method is refused too,
     since it would mean `plain`;
   - a `resource` that isn't one of the two endpoints after canonicalization, or that has a
     fragment, which RFC 8707 forbids (`invalid_target`). A fragment is refused, never
     stripped. A request with no `resource` is taken as naming `/api/mcp`.

   A scope other than `read` and `write` is ignored rather than refused: `offline_access`, or
   whatever a client asks for by mistake.
4. **The page.** It shows:
   - the client's name; the host of its `client_id`, when that is a URL; and the host of its
     redirect URI, where the connection will go. The spec requires the redirect URI's host, and
     a host is the part of a client's identity that its own document can't make up;
   - the warning to approve only a connection they have just started themselves, since a link
     someone else sent would connect that someone's Claude to their account (below);
   - for a loopback redirect URI, the warning that the connection goes to a program on the
     person's own computer;
   - who is signed in, with a way to switch;
   - the bots that work for them, to choose from, or a sentence saying there are none and that
     an ADMIN makes one;
   - which endpoint the connection is for, the full one or the read-only one;
   - the scopes, with `read` alone chosen ("Whose account");
   - for Claude's identity, beside each bot that already has a connection through it to this
     endpoint, that approving replaces that connection ("The token endpoint", below);
   - what the connection will be able to do, and that `/dashboard` ends it;
   - Approve and Cancel.

- **The decision posts to `/authorize/decide`**, a route handler answering 303 to the redirect
  URI. An OAuth response is an HTTP redirect to another origin: a route handler returns one as
  it is, where a server action's redirect is an instruction the client router turns into one.
  It works without JavaScript.
- **It trusts nothing the form sends.**
  - It refuses an `Origin` that isn't `APP_URL`'s.
  - It re-parses every parameter through the page's own parse.
  - It re-checks that the bot works for the person signed in.
  - A cross-site post carries no session to begin with, since Auth.js's cookie is
    `SameSite=Lax`.
- **Approving mints a code**: 32 random bytes, kept as its SHA-256 in
  `oauth_authorization_code`. The row holds the client, the redirect URI, the challenge, the
  endpoint, the scopes, the bot and the issuer. A code is good for two minutes, and for one
  use. Cancel redirects with `access_denied`.
- **Every request asks.** No consent is remembered, for claude.ai or anyone else. A connection
  is made rarely, and a remembered one would let a flow someone else started finish without
  the person seeing what it grants.
- **The page warns against a flow someone else started.** Every claude.ai user presents
  Claude's one `client_id` and redirect URI, so an authorize URL begun from someone else's
  claude.ai account looks exactly like one's own. Approved, its code goes to claude.ai in this
  person's browser carrying the other account's `state`. Whether claude.ai then refuses it
  rests on claude.ai tying `state` to the browser session, which MultiBlog can't check. So the
  page tells everyone, whatever the client, to approve only a connection they have just
  started themselves.
- **The page can't be framed.** `next.config.ts`'s `headers()` sends
  `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` for it, since a
  framed Approve button is a clickjacking target. Nothing sets either today.
  - **`/sign-in` gets the same headers**, since a signed-out visitor passes through it on the
    way to the page, and OAuth 2.1 names the login page beside the authorization page
    (§7.10).
- **A content security policy added later must allow the clients' origins in `form-action`**
  on `/authorize`. Chrome applies `form-action` to a form's redirects as well as to its target.

### The token endpoint

`POST /token` takes a form-encoded body. It answers JSON with `Cache-Control: no-store`, and its
errors are RFC 6749 §5.2's.

- **`authorization_code`.** The code is claimed in the transaction that uses it, and must be
  unexpired. It must come with the same client, and `S256(code_verifier)` must equal the
  challenge. A `resource`, if sent, must be the endpoint the code was issued for, with no
  fragment, as at `/authorize`. The bot must still work for the issuer, and both accounts must
  still be live.
  - **A `redirect_uri` is checked only when it is sent**, and must then be the one the code
    was issued for. OAuth 2.1 drops the parameter from this request, since PKCE is what binds a
    code to its client, and a client that follows OAuth 2.1 alone doesn't send it (§10.2). A
    client that follows OAuth 2.0 does, and has it checked as RFC 6749 asks.
  - **It creates the connection's row**, with the account, issuer, scopes, client,
    `oauth_client_id`, endpoint, and a name made from the client and the day.
  - **A new claude.ai connection replaces the bot's last one.** For Claude's identity, the
    grant revokes the bot's other connections through it to the same endpoint, from the same
    issuer. Reconnecting is how claude.ai recovers from most failures, and each reconnect
    would otherwise leave the old refresh token good for up to 90 days, wherever claude.ai
    keeps it.
    - **The consent page says so** before the person approves.
    - **Claude Code's identity is left alone**, since one person may sign in from more than
      one machine.
    - **One bot connected from two claude.ai accounts keeps only the newer connection.** A
      person who wants both makes a second bot.
  - **It answers with both tokens**, `token_type: "Bearer"`, which OAuth 2.1 requires,
    `expires_in` and the granted `scope`.
  - **A code presented again revokes the row its first use made**, since someone else had it
    (RFC 6749 §4.1.2), but only when the request is otherwise valid: the same client, and a
    `code_verifier` that matches. A replay that fails either check is `invalid_grant`, and
    revokes nothing. Its sender has the code without the verifier, and revoking for that would
    let anyone who saw a code end the connection (OAuth 2.1 §7.5.3).
- **`refresh_token`.**
  - The token must be unexpired and of the same client.
  - A `resource`, if sent, must be the connection's endpoint, with no fragment, or the
    refresh is `invalid_target`. The new access token names that endpoint whatever is sent.
  - Then §3's one check runs on the row, so a refresh can't outlive what a call couldn't, and
    then the rotation above.
  - A `scope` asking for more than the row's is refused, and the answer always carries the
    row's.
  - A dead refresh token is `invalid_grant`, which is what claude.ai expects.
- **Any other grant is refused.** That includes the `jwt-bearer` grant Claude's document also
  lists, presumably for the spec's enterprise-managed authorization extension, which this
  server doesn't offer.
- **The rate limit is §4's token bucket, keyed on the connection**, and taken only once a
  refresh token has resolved to its row. A code needs no bucket: it is good once, and only a
  person approving on the consent page makes one.
  - **A code or refresh token that matches no row is refused for the cost of a hash and an
    index lookup**, as an unknown `mb_` token is at `/api/mcp`, and takes from no bucket.
  - **Not per client.** Claude's `client_id` is public and comes with no secret. Anyone could
    keep a bucket keyed on it empty with junk requests, and while they did, every claude.ai
    connection on the instance would fail to refresh or to connect.
  - **Not per address** either: all of claude.ai arrives from Anthropic's `160.79.104.0/21`.
- **Each grant, refresh and revocation logs one line**, beside §4's audit line: the client, the
  row's prefix, the account and the issuer. A revocation for a replayed token, or for a
  connection replaced, says so.
- **Spent rows are pruned as it goes**, at most once an hour: codes a day after they expire,
  and refresh tokens past their 90 days, except each connection's newest, which dates its lapse
  (below).
  - **The pruning runs after the answer is sent**, through Next's `after()`, never before it.
    claude.ai waits 10 seconds for `/token`'s answer, and a flow whose answer comes later
    fails even when the token was issued (Anthropic's connector troubleshooting).
- **CORS is open**, without credentials, on this endpoint and the metadata documents, for a
  browser client such as the MCP Inspector. Each exports `OPTIONS`, as Discovery says. CORS is
  never open on the consent page.
- **There is no revocation endpoint.** Nothing documents claude.ai calling one, and a person
  revokes on `/dashboard` (below).

### Seeing and ending a connection

- **A Connections card on `/dashboard`** lists the tokens a person issued or acts as: name,
  client, account, scopes, created, last used, and Revoke.
  - **The endpoint is named once, above the table**, as the URL to give claude.ai, while
    `/api/mcp` is the only one. It becomes a column with the read-only endpoint, if that is
    built.
  - **It offers what claude.ai needs besides a connection**: the skill, as a ZIP to upload, and
    the paragraph for a Project's instructions ("What the model is told", below).
  - It is §3's "panel for your own tokens", listing and revoking only. It issues no token:
    an `mb_` secret stays the script's, and an OAuth connection comes from the consent page.
  - Revoke re-derives from the session that the viewer is the token's issuer or its account,
    as every write on the page re-derives its permission.
  - **A lapsed connection shows as lapsed**, with the day it lapsed and no Revoke, since
    nothing it holds still works. A connection lapses when its newest refresh token passes its
    90 days. The lapse writes nothing: a connection's row has no `expires_at` ("The bearer
    check") and isn't revoked, so its state comes from that refresh token, which the pruner
    keeps for this. A header token past its `expires_at` shows as expired, as the script
    already lists one.
  - **A revoked token isn't listed.** Nothing it holds works, and each claude.ai reconnect
    revokes the connection before it, so they would pile up.
  - **A COMMENTER sees the card only for a token of their own.** They can have no bot, so the
    skill and the paragraph would serve them nothing.
  - It is a plain `<table>`, as Recent docs is ([DASHBOARD.md](DASHBOARD.md)).
- **The script lists and revokes connections** as it does any token (`create-api-token.ts
  --list`, `--revoke`), and lists a lapsed one as lapsed.
- **claude.ai notices a revocation on its next call.** A 401 pauses the call and offers its
  inline Connect card. It has also been seen reporting a revoked token as "server isn't
  responding" (#744).
- **Removing the connector in claude.ai ends nothing here**: the connection lapses with its
  refresh token.

### What else changes for claude.ai

OAuth gets claude.ai a token. What follows decides how a connection behaves once it has one,
and the first item decides whether it works at all.

- **claude.ai speaks the 2026-07-28 protocol first, and SDK v1 can't.** claude.ai opens with
  `server/discover` under `MCP-Protocol-Version: 2026-07-28`. SDK 1.32.1, the newest v1, refuses
  that header in its transport, before any method runs, with an HTTP 400 and code `-32000`.
  After that answer, claude.ai has been seen never to list the tools
  (`anthropics/claude-ai-mcp#1064`, #919). So the server moves to SDK v2 (below).
- **`read`'s bound depends on the client.**
  - **The limit is 100,000 characters**, measured in the header trial: claude.ai counts one
    copy of the result, not the text block and the structured content together, and counts
    characters, not tokens. Past it, the model gets the first 100,000 characters and a note,
    and the whole result is kept as a file its Read tool opens until the reply ends, with code
    execution on or off.
  - **So a `claude-ai` token's reads get a bound of their own**, 95,000, for `whole: true` and
    a range alike, where Claude Code's is 200,000. The 40,000 default doesn't
    change.
  - **claude.ai honors none of Claude Code's `_meta` keys**, `maxResultSizeChars` included
    (§4).
- **A call may take 240 seconds** on claude.ai. Nothing measured here comes near that.
- **`edit_link` and `rename_file` stay a `claude-code` token's**, as §3 and §15 have them, until
  both keep a history (TODO.md). Once they do, they need no forced prompt, and every client
  lists them.
  - **claude.ai's prompt doesn't stand in for Claude Code's.** claude.ai asks before a write or
    a delete by default, by the category its hints put a tool in. But it lets a person set any
    tool or category to "Always allow". Anthropic's help center says Research calls a
    connector's tools "without further approval", though in the trials Research called none
    ("The slice trial"). After an "Always allow", an instruction planted in text Claude reads
    could rename a link, reorder or remove its parts, or retitle a file. None of that keeps a
    history, and removing a part deletes its captured quote.
  - **Everything else a connection can write can be undone in MultiBlog**: a doc's text
    reverted, a note's earlier wording kept, a doc, a file, a note or a link deleted, a tag
    removed (§15).
  - **Undoing doesn't unsee.** A note on a shared doc, or a tag on a shared object, is visible
    until someone removes it. That is the case for an endpoint with no writes at all ("The
    read-only endpoint", below), rather than relying on undo. It isn't built while Research
    calls no connector, and an ordinary chat honors "Needs approval", which is where a person
    keeps a write they don't want run unasked.
- **A deploy that changes the tools reaches claude.ai late, and asks again.**
  - **A connector keeps its old tool list until the person refreshes it** (#1044). In the
    header trial it kept the list from before a deploy through two chats and a changed
    `server/discover`, and in the full trial a new chat read a reworded description from the
    old list without sending a request at all. "Refresh tool list", in the connector's
    settings, fetched the new one at once both times. Until then a renamed tool is called by
    its old name and refused, so a deploy that renames or rewords a tool tells its people to
    refresh.
  - **A person's "Always allow" is stored per tool**, under its name and a hash of its
    description and its parameters' descriptions (#1032). So renaming a tool, or rewording
    its description, asks again for it.
- **A claude.ai connection follows its account into Claude Code.**
  - It shows up as a server named `claude.ai <connector name>`, reached through Anthropic's
    proxy on the same grant, and no token is stored on the machine.
  - **A server configured at the same URL outranks it**, so §16's project keeps the header.
  - **Everywhere else, the connector would bring its instructions and tools into every
    session**, coding included. `deniedMcpServers` in `~/.claude/settings.json`, naming the
    connector, keeps it out. That is what §16 does for the server by configuring it per
    project.
    - **The deny is the one setting that fits.** `/mcp` switches a connector off for one
      project at a time, and `disableClaudeAiConnectors` switches off every connector at
      once. The deny names this one, for every project, new ones included, and §16's project
      entry still brings the server into the research project.
    - **It names the connector rather than its URL**, since a URL pattern would deny §16's
      entry too, which points at the same URL.
    - **It reaches only the sessions that fetch connectors themselves**: the terminal, the
      IDEs and the Agent SDK. The desktop app hands its local sessions their connectors
      in-process, and no setting reaches them there.

### What the model is told

claude.ai never passes a server's instructions to its model, on the 2026-07-28 path as on the
old one (`anthropics/claude-ai-mcp#93`, a wire test with SDK v2 on 2026-10-09). It defers every
tool of a custom connector, `alwaysLoad` notwithstanding, and shows its model each one as a bare
name with no description until a tool search loads it (#1105). In that report's three chats that
didn't name the connector, the model answered from its own knowledge and never called the
server. The name is `mcp__<connector's display name>__<tool>`, where #1105 reports a uuid: both
trials saw the display name, and the header trial a connector named at length ("The header
trial"). So nothing in §5's instructions reaches claude.ai: whose account a session acts as, the
byline's order, searching before creating. And `search` and `read`, by name alone, say nothing
of MultiBlog, under a display name a person chose.

The instructions aren't routed to the model by some other way. Instructions honored in every
chat where a connector is on would let any server write into those chats' system prompts, which
raises prompt-injection and context-budget questions, and that is a plausible reason claude.ai
drops them. So each kind of guidance goes in the narrowest place that still reaches the model
when it is needed:

- **Names are always present, and say only what a tool is.** About 100 tokens of names is all
  MultiBlog puts into a chat where its connector is on.
- **A description loads only when the model picks its tool**, so a chat that never touches
  MultiBlog sees none. It holds MultiBlog's own fixed text and the two names the token gives,
  never anything a reader wrote.
- **What belongs to no one tool is the person's to say**, such as "my research lives in
  MultiBlog; look there first". It goes in a skill they install, or in a Project's
  instructions.

**The names:**

- **Every tool's name starts with `multiblog_`.** claude.ai has shown its model a tool's
  connector four ways this year, as `<display name>:`, then `mcp__<uuid>__`, then
  `mcp_<hash>_`, and now `mcp__<display name>__` ("The header trial"). The display name is
  whatever the person typed, often the instance's own name, so only the tool's own name
  reliably says MultiBlog, which is what Anthropic's tool-use guide asks: "prefix names with
  the service … especially important when using tool search".
- **A plain verb and noun**, in the words a person would use.
- **At most 21 characters.** A uuid's prefix, `mcp__<connector id>__`, takes 43 characters, and
  a new chat has been reported to fail validation when one connector's built name passes 64,
  taking the whole session's tool list with it (`anthropics/claude-code` #76775 and #60429).
  claude.ai builds names from the display name instead, and in the header trial loaded and
  called a 66-character one without error, so the limit isn't binding there at that length.
  It stays for Claude Code, which has an open 64-character cutoff on names built the same way
  (`anthropics/claude-code#97616`), and where a claude.ai connector is
  `mcp__claude_ai_<Name>__<tool>`. No dots, and nothing starting with `mcp_`, which has broken
  requests elsewhere.

| Before §21 | Listed as | Why the verb changed |
|---|---|---|
| `search`, `read`, `find_users`, `find_tags`, `create_doc`, `edit_doc`, `create_link`, `edit_link`, `tag`, `untag`, `manage` | the same, after `multiblog_` | — |
| `download_url`, `upload_url` | `multiblog_download`, `multiblog_upload` | `multiblog_download_url` would take 22 characters, and the pair stays a pair; each description says it answers with a URL |
| `edit_file` | `multiblog_rename_file` | it only retitles, and "edit" suggests changing the file |
| `annotate`, `edit_annotation` | `multiblog_add_note`, `multiblog_edit_note` | `multiblog_edit_annotation` would take 25 characters, and "note" is the word the descriptions and a person use |
| `add_link_parts` | `multiblog_extend_link` | `multiblog_add_link_parts` would take 24 characters |

- **The prefix goes on in `server.ts`**: where the tools are listed (`definitionOf`) and where
  `tools/call` looks one up. Inside the code a tool keeps its short name, one of `TOOL_NAMES`
  (`src/lib/mcp/tool.ts`), in `api_write`'s `operation` and in the audit line too. Every name a
  model reads is the listed one: another tool's name in a description, in the instructions, in
  the skill or in an error's message, each written through `listedName`, which takes only a
  name in `TOOL_NAMES`.
- **`e2e/mcp.ts` adds the prefix too**, so the specs change only where a verb does.
- **Claude Code shows the prefix twice**, `mcp__multiblog__multiblog_search`, which is harmless.
  §15's suggested allow rules carry it.
- **This document names each tool by its short name**, the code's, §21 included (§15).

**The descriptions:**

- **Each leads with the words a person searches by.** claude.ai's tool search matches a
  description as well as a name, and doesn't read `searchHint` (§15). `multiblog_search`'s, for
  one, opens "Search MultiBlog, this person's research archive: docs, PDFs, their notes on
  passages, links, tags, posts, comments and imported Claude chats." A tool's `searchHint`
  words go into its description as well, and the key stays for Claude Code.
- **`multiblog_search`'s and `multiblog_create_doc`'s name the actor and the issuer**, in the
  sentence that opens the instructions today (§5), built per token as the instructions are.
  One is the tool a session starts with; the other puts names on a byline.
- **`multiblog_search`'s and `multiblog_read`'s say their dates are UTC.** Nothing tells
  claude.ai the person's zone, and a bare day read as a day ahead in the header trial;
  `search`'s adds that `tz` moves only its filters.
- **A convention moves to the tool it governs**, where today the instructions alone carry it:
  - citing by URL, to `multiblog_search` and `multiblog_read`;
  - `exact=1` whenever the question is whether something exists, to `multiblog_search`;
  - a summary doc's shape, the prompt quoted at the top, the byline's order and which kind of
    link for what, to `multiblog_create_doc`;
  - anchoring a section by its heading and a claim by its sentence, and reusing a link before
    minting one, to the tools that anchor.

  What `already_done` means is in that error's message already, which arrives when it's needed.
- **The instructions keep the rest**, for Claude Code, which still reads them: whose account,
  what the server holds, and to search it first. Claude Code has the server only where the
  person configured it, in a research project (§16), so there that last is theirs to say too.
- **Each description stays under 1,200 characters**, held there by a spec as results are held to
  a budget (§4), with long names for the actor and the issuer. Claude Code cuts one at 2,048.
- **They follow Anthropic's review criteria for directory connectors**, which a custom connector
  isn't held to. A description is refused there if it would "interfere with Claude calling
  other tools", or "direct Claude to pull behavioral instructions from external sources". "Look
  in MultiBlog first" is that kind of sentence, and it is the person's to say.

**The skill:**

- **A skill the person installs carries the cold start.** claude.ai keeps only a skill's
  description in context, up to 1,024 characters, and reads its `SKILL.md` once a request
  matches the description. Anthropic's guidance for connectors says as much: "A connector
  alone leaves Claude to work out your workflow from tool names. The skill is where you put the
  sequence, the defaults, and what good output looks like."
- **It is generated from the instructions' source**, so it moves with the tools. It holds what
  belongs to no one tool: that the person's research lives in MultiBlog and is searched first,
  and how a research session goes. Its description says when it applies, in the words a request
  would use: the person's own notes, docs, PDFs, earlier conversations.
- **It names no account.** The descriptions do that per token, so one skill serves every bot.
- **The Connections card offers it as a ZIP**, `multiblog/SKILL.md` inside, which the person
  uploads under Customize > Skills and turns on ("Seeing and ending a connection"). `npx tsx
  scripts/mcp-skill.ts <out.zip>` writes the same ZIP from a checkout, and `--print` shows its
  `SKILL.md`. The skill is `src/lib/mcp/skill.ts`, and its ZIP is
  written by `src/lib/zip.ts`, as `src/lib/tar.ts` writes the export.
- **Skills need code execution.** claude.ai runs them in its sandbox, so "Code execution and file
  creation" must be on, on a Pro, Max, Team or Enterprise plan. Without it, the card's paragraph
  for a Project's instructions does the same work in that Project's chats.
- **A skill added in claude.ai follows the account into Claude Code**, so its description sits
  in every session there too. It applies only when a request matches it, and the tools it names
  are the research project's.
- **In the header trial it changed no tool use** ("The header trial"). claude.ai's memory and
  past-chat search won a question about an earlier discussion, the descriptions alone sent a
  question about the person's writing to MultiBlog, and a general question went to neither.
  The skill made the model say when it had skipped MultiBlog, nothing more. Its description
  wants a reason to search past memory: MultiBlog holds what memory doesn't, other people's
  notes and the group's own summaries among them (TODO.md).

### The read-only endpoint

**Designed, and not built**, by Luke's decision (2026-10-14). In every trial Research called no
connector, neither this one nor a directory connector ("The slice trial"), so there is nothing
yet for it to guard there. In an ordinary chat claude.ai asks for each call on "Needs approval" and leaves out
a Blocked tool ("The header trial"), so a person who keeps the writes on "Needs approval"
already has a switch. It is the answer if Research starts calling connectors "without further
approval", as Anthropic's help center says it does. Where another section names
`/api/mcp/read` (a connection's endpoint, its metadata document and 401, the consent page's
`read`-only offer, the second audience, the tests), it describes what this endpoint would add,
and none of it is built without it.

The design, as planned: Research is where text from the open web meets a connector's tools, and
claude.ai's Research is said to call them "without further approval". Its help center's only
advice is "Disable any tools that can take write actions", unchanged since before per-tool
settings existed. Those settings apply to every chat, per connector, and a single chat can only
switch a whole connector on or off. Whether "Needs approval" or "Blocked" holds inside Research
isn't documented, and the trials couldn't see, since Research never called the connector. So
the endpoint is the one guard that doesn't depend on what Research honors.

Servers that write draw the line themselves: GitHub serves a `/readonly` URL, Linear a separate
`/mcp/readonly`, and Cloudflare offers read-only access at consent, chosen by default. MCP's
hints, `readOnlyHint` among them, are only hints, which the spec tells a client not to trust
from a server it doesn't. OpenAI draws the line in its client instead: ChatGPT's deep research
uses a connector "for read/fetch actions only". A connection with `read` alone already lists no
write, whatever claude.ai does about approvals. What is missing is a way to choose it per chat,
since a connection's scopes are fixed when it is made.

- **`/api/mcp/read` is the same server, listing only the `read` scope's tools**: `search`,
  `read`, `find_users`, `find_tags` and `download`, whatever the token allows. Its
  instructions and descriptions are a read-only token's. A call to any other tool there is
  refused as one the token doesn't list.
- **Added as a second claude.ai connector, it is the per-chat switch claude.ai lacks**: the
  read-only connector on in a Research chat, the full one in an ordinary chat. With both on in
  one chat, the model would see each read twice under one name, so the two are kept to
  separate chats, which §16 says once this is built.
- **It is a resource of its own**, with its own metadata document and 401 (Discovery), and its
  own connection, made through the same consent page and offered `read` alone. Its access
  tokens name it as their audience, so `/api/mcp` refuses them ("The bearer check").
- **A path, not a query string.** RFC 8707 asks that a resource carry no query, and claude.ai
  compares the resource with the connector's URL exactly.
- **An `mb_` header token is accepted there too**, listing the reads alone, so Claude Code can be
  pointed at it for a project that should never write.
- **The route is `src/app/api/mcp/read/route.ts`**, handing its request to the same handler with
  the endpoint named. `toolsFor` takes the endpoint beside the token.

### Moving to SDK v2

The server moves from `@modelcontextprotocol/sdk` 1.32.1 to `@modelcontextprotocol/server`
2.3.1, which exports the types it uses as well. `@modelcontextprotocol/core` supplies only the
three OAuth schemas (below). v2 serves claude.ai's 2026-07-28 and every 2025-era client from one
endpoint.

- **Why now.** v1 is the maintenance line. Its README says support for 2026-07-28 "is not
  planned for v1.x", and v1 gets bug and security fixes for at least six months after v2's
  release on 2026-07-27, so through about late January 2027.
- **The SDK is imported in two files, and the change to each is small.**
  - **`src/lib/mcp/server.ts`** keeps the low-level `Server` rather than `McpServer`, for the
    reason its header gives: every refusal is a `{ code, message, … }` body (§4). Its two
    handlers are registered by method name, `'tools/list'` and `'tools/call'`, rather than by
    zod schema, and take v2's `ctx` where v1 passed `extra`.
  - **`src/app/api/mcp/route.ts`** runs §3's check, as it does now and from the build's fourth
    step through v2's bearer check (below), then hands the request to one
    `createMcpHandler(factory, options)` for the process, passing the token as `authInfo`. Its
    options are `{ legacy: "stateless", responseMode: "json" }`. The factory builds each
    request's server from `ctx.authInfo`, whose `extra` carries the authenticated token, and
    later the endpoint ("The read-only endpoint").
  - **GET and DELETE keep the route's own handlers**, which answer 405 with `Allow: POST` before
    any bearer check, as they do now. v2's own 405 has a JSON-RPC body and no `Allow`.
  - **`responseMode: "json"` makes v2 log a warning** when the handler is created. The handler
    is made once, at module scope, so the warning prints in `next build` and at each start.
    It is expected, and the route's comment says so.
- **No `subscriptions/listen` stream stays open.** v2 holds one only for a notification the
  server can send, and this server declares no list-changed capability. So every listen gets
  its acknowledgement and its result and closes at once, and never counts against v2's
  `maxSubscriptions`, which keeps its default. Checked against 2.3.1: with the cap set to 16,
  seventeen listens all completed.
  - **Each listen still costs a bearer check and a server build**, for a client that opens
    one. Claude Code doesn't: on a 2026-07-28 connection to a server that declares no
    list-changed capability, 2.1.296 opens none. Nothing documents what claude.ai does; it opened
    none in the early trial, and the later trials watch for a loop.
- **The cache hints are set, not left to v2's default.** On the 2026-07-28 leg,
  `server/discover` and `tools/list` are cacheable results, each carrying a `ttlMs` and a
  `cacheScope`. Both answers here are per token: the instructions and two descriptions name the
  actor and the issuer (§5), and the tool list follows the token's client and scopes (§3). A
  shared cache holding either would hand one person's to another.
  - **v2 answers `ttlMs: 0` and `cacheScope: "private"` when nothing is set**, but a default
    can change in a minor release, and nothing here would notice.
  - **So `buildMcpServer` passes `cacheHints`**, beside the `instructions` that make it
    necessary: `{ ttlMs: 0, cacheScope: "private" }` for each of the two methods, with a
    comment saying both answers are per token.
- **What has been checked**, in a scratch project against 2.3.1 with this shape:
  - It typechecks under the repo's pinned TypeScript 5.9.3, library checks included. v2 needs
    Node 20 and zod 4.2 or later, which the repo has.
  - One endpoint served two clients, with the token reaching the handler both times:
    - a v2 client negotiating 2026-07-28, which listed the tools and called one;
    - a bare 2025-era `tools/call`, sent as `e2e/mcp.ts` sends one.
  - That client read the server's instructions from `server/discover` (`getInstructions()`).
    `server/discover` and `tools/list` answered `ttlMs: 0` and `cacheScope: "private"` with no
    `cacheHints`, and a hint changed both.
  - A route of this shape builds under Next 16.2.11 with Turbopack, and served both clients
    over HTTP.
  - **v2 refuses nothing `callTool` returns.** Its `Server` checks a `tools/call` result only
    against `CallToolResult`'s shape, never against the tool's `outputSchema`. So both of what
    `callTool` answers on purpose pass, on either leg (`src/lib/mcp/server.ts`): a result
    outside its schema, which is logged and answered anyway, and an error with no
    `structuredContent`. A client that has listed the tools refuses the first, v2's as v1's
    does, and accepts the second.
  - **The body cap doesn't change.** v2 refuses a body over 4 MiB with a 413 (`-32000`), before
    any tool runs, and so does v1 today, since the route sets no `maxRequestBodySize`.
    `create_doc`'s largest Markdown fits, unless its client escapes nearly every character as
    `\uXXXX`. `edit_doc`'s schema accepts far more than either version takes, which is a gap
    of its own (TODO.md).
- **A 2025-era answer is a stream.** `responseMode: "json"` governs the 2026-07-28 leg only.
  The stateless fallback builds its transport with nothing but `sessionIdGenerator: undefined`,
  so it answers with `text/event-stream`, one `message` event.
  - **Claude Code reads either.**
  - **`e2e/mcp.ts` reads a stream.** `mcpRequest` takes the JSON-RPC response from the event
    carrying its request's id when the content type is `text/event-stream`, and parses the body
    whole otherwise.
  - **Not routing 2025-era requests through a JSON transport of their own.** v2 documents that
    pattern (`isLegacyRequest`, in front of a strict handler), and it would keep the JSON, at
    the cost of a second path through the route.
- **Checked before it merges**, since the scratch project didn't cover them:
  - the existing `e2e/mcp-*.spec.ts`, changed only in their helper, and one new spec,
    `e2e/mcp-modern.spec.ts`, driving a 2026-07-28 client (`@modelcontextprotocol/client`, a
    dev dependency). It asserts that `server/discover` brings the same instructions as
    `initialize` does for the same token, which `e2e/mcp-read.spec.ts` already checks name the
    actor and the issuer. It also asserts that `server/discover` and `tools/list` both come
    back private with a TTL of 0;
    - **the client is pinned to 2026-07-28**, and the spec asserts the version it negotiated.
      Left to its default, v2's client negotiates the 2025 protocol (`versionNegotiation`),
      and the spec would pass while testing the old leg;
    - **it lists the tools before calling one**, so that the client checks each result
      against its tool's `outputSchema`, as a v2 client does once it has the list;
    - **a 2026-07-28 request built by hand carries `Mcp-Method`**, and `Mcp-Name` for a
      `tools/call`, or v2 refuses it (`-32020`);
  - Claude Code against the dev server. Since 2.1.274 it asks every HTTP server for
    2026-07-28 first (2.1.232 where it fetches feature flags), so it takes the new leg.
    Checked with 2.1.296 and a `headersHelper`: `server/discover`, `tools/list` and a
    `tools/call`, each under 2026-07-28 with a JSON answer, and no `subscriptions/listen`.
- **The OAuth work is written against v2.**
  - **The documents' zod schemas** come from `@modelcontextprotocol/core`:
    `OAuthMetadataSchema`, `OAuthProtectedResourceMetadataSchema` and `OAuthTokensSchema`.
    Their types, `OAuthMetadata` among them, come from `@modelcontextprotocol/server`.
  - **v2's resource-server helpers do the resource side**: `verifyBearerToken` and
    `bearerAuthChallengeResponse` the bearer check (below), and `oauthMetadataResponse` the
    documents (Discovery). Discovery is written to what they produce, and the token code
    already built changes to meet what they require (below).
  - **v2's authorization-server helpers** live in `@modelcontextprotocol/server-legacy`, which
    is deprecated and bound to Express, so the authorization server stays hand-written.

### The bearer check, on v2's terms

`/api/mcp` authenticates through v2's own helpers, and what is already built changes to meet
what they require. It is the fourth step of the build, and nothing after it starts until its
tests pass (Build order).

- **The gate is `verifyBearerToken`**, with §3's one check as its verifier. A refusal is
  answered by `bearerAuthChallengeResponse`, whose 401 is Discovery's.
- **The verifier** takes the bearer value and:
  - runs §3's one check by the hash, for an `mb_` token;
  - from the thin slice on, verifies anything else as an access token with `jose`: its
    signature, its expiry, and an audience that is one of the two endpoints' URLs, which no
    byte grant or ydoc token has ("A connection", above). Then it runs §3's one check on the
    row the token names;
  - throws v2's `OAuthError` with `invalid_token` when either refuses, which v2 answers with
    the 401;
  - otherwise reports the token's scopes; `resource`, which is an access token's own audience,
    or for an `mb_` token the endpoint it was sent to; `expiresAt` (below); `clientId`, a
    connection's `client_id` or a header token's prefix; and the authenticated token in
    `extra`, where the factory reads it ("Moving to SDK v2", above).
- **`expectedResource` is the endpoint's URL**, so v2 refuses an access token made for the
  other endpoint, as the spec requires. That is what keeps a read-only connection's token out
  of `/api/mcp`: the verifier accepts either audience, and the endpoint decides. Were the
  verifier to report the endpoint's URL as a constant, the check could never fail.
- **The scopes go to the challenge alone.** Given to the verification as `requiredScopes`,
  `["read", "write"]` would refuse a read-only token with a 403. The tool list is what narrows a
  token by scope (§3). `bearerAuthChallengeResponse` takes them only to name them in the 401:
  `read` and `write` at `/api/mcp`, `read` at the read-only endpoint. So the gate is these two
  calls rather than `requireBearerAuth`, which passes one set of options to both.
- **Every token has an expiry, because v2 requires one.** `verifyBearerToken` refuses a token
  whose verifier reports no `expiresAt`, as v1's helper did. An access token reports its JWT's
  `exp`. A header token reports its row's `expires_at`, and that is where what is built changes:
  - `issueApiToken` takes `expiresAt` as required, and `create-api-token.ts`'s
    `--expires-days` defaults to 365, with no way to ask for none;
  - a migration gives every row without an expiry one 365 days from the migration, so no token
    already issued is refused when the gate ships;
  - a CHECK keeps it so: `token_hash IS NULL OR expires_at IS NOT NULL`. A connection's row,
    with no hash of its own from the thin slice on, has no expiry either, since its access
    token carries one;
  - the e2e fixture `createTestApiToken` issues with an expiry;
  - a header token is re-issued with the script before its year is up, and Claude Code picks
    up the new file at its next connection (§5).
- **`/api/mcp`'s 401 is v2's challenge and OAuth's error object** (Discovery), where it was
  `Bearer realm="multiblog"` and §4's `{ code, message }`, and it names the endpoint's
  `resource_metadata`. The byte routes keep theirs, and `bearerSecret` with them; v2 parses
  `/api/mcp`'s header itself.
- **Tested before anything continues:**
  - unit tests for the verifier's pure half: the `AuthInfo` it reports for an authenticated
    token, `expiresAt` in seconds included, and a refusal thrown as `OAuthError` with
    `invalid_token`;
  - the whole of `e2e/mcp-*.spec.ts` through the new gate. It already refuses no token, an
    unknown one, and a deleted account's, which stays revoked once the account is restored;
  - a new spec: a token past its `expires_at`, backdated by a fixture, refused; and the 401's
    `WWW-Authenticate`, with and without a token sent;
  - `npx prisma migrate status` clean, and no `api_token` row left with a hash and no expiry;
  - Claude Code against the dev server, with a header token issued under the new default.

### What it costs

- **Schema:**
  - new tables `oauth_client`, `oauth_authorization_code` and `oauth_refresh_token`;
  - `api_token.token_hash` becomes nullable, and `api_token.oauth_client_id` holds the
    connection's `client_id`. It is no foreign key, since a pinned identity has no row;
  - `api_token.oauth_resource`, the path of the endpoint a connection is for;
  - a CHECK that a row is one kind or the other:
    `(token_hash IS NULL) <> (oauth_client_id IS NULL)`;
  - a CHECK that a row with a `token_hash` has an `expires_at`, after a migration gives every
    row without one a year;
  - `user.works_for_user_id`, with a CHECK that a bot has no password.
- **About 1,350 lines**, specs aside:
  - the tools' names and descriptions, the instructions' shared source, and the skill's
    generator and script (~150);
  - the read-only endpoint, its document and its tool list (~40, not built);
  - the discovery documents, which v2 serves (~40);
  - the consent page and its decision (~250);
  - the token endpoint with its rotation (~220);
  - the bearer check on v2's helpers, and the access token (~60);
  - header tokens' expiry, in the script, `issueApiToken` and the e2e fixture (~20);
  - bots in the web interface, with their rules in `src/lib/` and the check (~150);
  - the clients (~60);
  - the move to SDK v2, with the e2e helper reading a stream (~60);
  - the per-client bound on `read` (~10);
  - the Connections card, lapsed connections included (~130);
  - two scripts, `oauth-client.ts` and `check-oauth-clients.ts`, and the drift check's lines
    in `deploy.sh` (~140).
- **One dependency swapped, one added for tests.** `@modelcontextprotocol/sdk` gives way to
  `@modelcontextprotocol/server` and `@modelcontextprotocol/core`, and
  `@modelcontextprotocol/client` joins as a dev dependency. Otherwise `jose` signs and verifies,
  and `node:crypto` hashes.

### Alternatives rejected

- **Another authorization server**, whether a hosted one (Auth0, WorkOS, Stytch) or Keycloak.
  What a consent decides, which bot and issued by whom, is MultiBlog's, against its own users,
  and the result has to be an `api_token` row. A hosted one is an outside dependency for each of
  five instances. Keycloak is a JVM beside Next on a 1–2 GB box (§5's "no sidecar").
- **`oidc-provider`**, the certified Node provider, and what SDK v2's upgrade guide points an
  authorization server towards. It is right for a general OpenID provider. But it brings its own
  Koa stack, interaction flow, storage adapter and token formats, each of which would have to be
  bridged back to `api_token` and Auth.js, for a subset this small.
- **`mcp-handler`** covers the resource side only, which v2's own helpers already do.
- **Auth.js** signs people in to MultiBlog. It authorizes no other client, and stays what the
  consent page asks "who is this?".
- **Acting as the person approving.** It is the simplest choice, and the natural reading of
  OAuth. But everything claude.ai wrote would carry that person's name, and Claude would read
  with their access (§3, §5).
- **Step-up authorization**: a 403 with `insufficient_scope` that asks for `write` at the first
  write, which the spec recommends (SHOULD). Here a token never meets a tool its scopes don't
  allow, since the list leaves it out, so there is nothing to answer that way: a call naming an
  unlisted tool is a tool result saying the token has no tool by that name. And `write`
  granted at a step-up would last as long as the connection, so a later chat could write
  unasked anyway. claude.ai's per-tool settings do that job ("The header trial").
- **Writes held for a person to confirm in MultiBlog**, as Stripe holds a refund. It would hold
  even in Research, should Research call connectors, but it changes every write path, for what
  "Needs approval" already gives in a chat.
- **A read-only mode in the query string**, as Supabase has (`?read_only=true`), for the reason
  "The read-only endpoint" gives for a path.
- **A shim on v1** in place of the move: the route answering an `MCP-Protocol-Version` that
  v1 doesn't know with a 400 carrying `-32022`, after which claude.ai has been seen to fall
  back to `initialize` on 2025-11-25 (#1110). About 20 lines, but it rests on server logs, not
  on anything Anthropic has published; it may cost a probe before many calls; and it leaves the
  server on v1, the maintenance line.
- **A guide tool** the model calls for the conventions, as Claude Docs has (`guide`).
  Anthropic's review criteria refuse a description that directs Claude "to pull behavioral
  instructions from external sources", and Claude Docs is first-party and pairs its tool with
  a skill. The descriptions and a skill do that work here ("What the model is told").

### Testing

- **Unit tests** (`npm run test:unit`):
  - PKCE against RFC 7636's own example;
  - the authorize parse's refusals, each with whether it redirects, a `resource` with a
    fragment and a missing `redirect_uri` among them;
  - the canonical resource, for each endpoint;
  - the rotation, as a function of a row's state: fresh; rotated within two minutes with none
    of its children spent, answered; rotated within two minutes with a child spent, past the two
    minutes, or retired by its sibling, each revoking the connection;
  - the token endpoint's bucket: a refresh's keyed on its connection, and a code or token that
    matches no row taking from none;
  - the 401's header at each endpoint, with and without a token sent;
  - the scopes the page offers: `read` alone chosen, `write` implying `read`, and `read` alone
    for the read-only endpoint;
  - the bot rules, as a function of the account's row and its person's: the issuer a token
    must have, a bot with a password, a person who is a COMMENTER, and a bot that outranks its
    person;
  - the tool list at each endpoint for each kind of token: at `/api/mcp`, `edit_link` and
    `rename_file` for a `claude-code` token alone, and `manage` only for a person's
    `claude-code` token with the scope; at `/api/mcp/read`, the reads alone, whatever the
    token's scopes;
  - an access token refused at the other endpoint, a byte grant and a ydoc token refused as
    access tokens, and an access token refused as a byte grant and as a ydoc token.
- **An e2e spec** (`e2e/mcp-oauth.spec.ts`), using Claude's real identity. The spec redeems each
  code itself, from the `Location` of the decision's 303: claude.ai's callback with the code,
  read and never followed.
  - **Approving goes through the real page once.** The signed-in browser opens the authorize
    URL and clicks Approve. `page.route` holds the form's post to `/authorize/decide`, sends it
    on with `route.fetch({ maxRedirects: 0 })`, reads `Location` from the answer, and fulfills
    the page with a stub, so the browser never reaches claude.ai. That exercises the form's
    hidden fields, and its `Origin` and session cookie as the browser sends them. A route on
    claude.ai's URL would catch nothing, since Playwright calls a route's handler only for the
    first URL of a redirect.
  - **The other cases post the decision directly**, through the request API with the suite's
    cookie and `maxRedirects: 0`.
  - **The spec reads the issuer and the endpoint's URL from the documents**, as a client
    would, and sends them as `Origin` and `resource`; it never computes them. The e2e server's
    `APP_URL` is its own origin, which `scripts/prod-web.ts` sets, so the documents name the
    server the spec talks to. The Playwright worker's `appUrl()` reads `.env` instead, which
    names the dev server, so a value computed in the worker would be wrong.
    `e2e/invite.spec.ts` meets the same split.

  It covers:
  - the documents and the 401, at each endpoint;
  - a signed-out visitor through sign-in and back to the page, and a signed-out visitor's
    malformed request sent to sign in rather than redirected to the client;
  - approve, code, token with its `token_type`, then `tools/list` without `edit_link`,
    `rename_file` or `manage`;
  - a code redeemed with no `redirect_uri`, and one refused for a `redirect_uri` that isn't
    its own;
  - a connection to the read-only endpoint: offered `read` alone, listing the reads alone, and
    its access token refused at `/api/mcp`;
  - a second claude.ai connection of the same bot to the same endpoint, revoking the first,
    and one to the other endpoint, leaving it;
  - a refresh, and its rotation;
  - a refresh naming the other endpoint's `resource`, refused;
  - a replay within the two minutes, answered, even after the new access token has been used;
  - a replay within the two minutes after the new refresh token has been spent, revoking the
    connection;
  - a replay past them, revoking the connection. The rotation is backdated by a fixture rather
    than waited for;
  - a token retired by its sibling, presented after the sibling's use, revoking the
    connection;
  - Revoke on `/dashboard` refusing the next call;
  - a replayed code with its verifier, revoking the connection, and one with a wrong verifier,
    refused with the connection left alone;
  - an unknown client, and a wrong redirect URI, answered on the page;
  - Cancel;
  - a person with no bot;
  - the frame headers, on the page and on `/sign-in`;
  - a preflight to `/token` and to each document, answered with CORS headers;
  - the 2026-07-28 client calling with an access token, as well as the 2025-era helper.

  Claude Code's pinned identity, with its loopback redirect URI on an arbitrary port, covers
  that path and the page's warning. A client the fixture registers by hand covers that kind.
- **By hand, in three trials** (Build order): the header and slice trials on the trial
  instance, the full trial on explore.
  - **the header trial, after SDK v2 and the renamed tools** (run on 2026-10-14: "The header
    trial"), where claude.ai's connector
    dialog offers request headers, with a token that can only read:
    - claude.ai on the web and on iOS reaching the endpoint at the path it was given (#382
      reports `/api/mcp` saved as `/Api/mcp`), negotiating 2026-07-28, listing the tools and
      calling one;
    - whether its requests carry a `Content-Type`, without which v2 answers 415 (#1135);
    - what the model is given: whether the server's instructions reach it (#93), how the tools
      appear before a tool search (#1105), and whether a question that doesn't name MultiBlog
      finds them, with the skill turned on and with it off;
    - whether claude.ai reopens `subscriptions/listen` in a loop;
    - whether claude.ai builds each tool's name from the connector's display name;
    - `read` near its bound, to find where claude.ai stops passing a result inline, on a doc
      made for it (Build order, step 3);
    - Research, with one tool set to "Needs approval" and another to "Blocked", to see whether
      either setting holds there, if Research calls the connector at all. A token that
      can only read puts nothing at stake;
  - **the slice trial** (run on 2026-10-14: "The slice trial"): claude.ai on the web and on
    iOS connecting through OAuth, listing the tools and calling one, and showing the connector
    as connected (#1110, Open); whether it reopens `subscriptions/listen` in a loop; and
    whether Research calls the connector. Without a header trial before it, it also checks what
    that one would have;
  - **the full trial, with everything** (run on 2026-10-15: "The full trial"):
    - claude.ai on iOS refreshing after an hour without asking the person to reconnect, and a
      revoke. The web's refresh, and a reconnect replacing the connection before it, were seen
      in the refresh trial;
    - whether Research calls the connector by then (Open);
    - the read-only connector beside the full one, once it is built: a Research run with it
      alone turned on, calling only the reads;
    - after a deploy that changes a tool's description, how long claude.ai takes to show it
      (#1044);
    - Claude Code signing in through its own identity with `/mcp`, and a sandboxed command
      refused its token file.

### The early trial

On 2026-10-13 claude.ai was connected to the trial instance, running step 1's build, through
the request-header beta: a read-only `claude-ai` token acting as its Claude account and issued
by Luke (TODO.md, "The claude.ai trial: what to undo"). It came before step 2's names, so it
answers the header trial's questions about the protocol and leaves what the model is told to
step 3. nginx logged each request to `/api/mcp` with its `MCP-Protocol-Version` and the type of
its answer (`/etc/nginx/conf.d/mcp-log.conf` there).

- **SDK v2 serves claude.ai.** On the web and on iOS, every connection opened with
  `server/discover` under 2026-07-28 and was answered in JSON. It listed the tools and called
  each of them. Nothing was refused but twice by `search`'s own `invalid`, and once a probe
  from Anthropic's servers without the token, answered 401, after which they looked for OAuth's
  metadata (a 404, since there is none yet).
- **The path stayed `/api/mcp`, and every request carried a `Content-Type`** (#382, #1135).
- **No `subscriptions/listen` was opened**, so there was no loop to find.
- **The instructions don't reach the model (#93), and before a tool search it has only the
  names (#1105).** Asked, without calling a tool, whose account the connector acts as, Claude
  said it couldn't tell: it saw the connector with five tool names, and "their schemas and
  descriptions aren't loaded".
- **The connector's display name does reach the model**, which "What the model is told" says it
  doesn't. A chat knew the connector by its display name, and named its tools
  `mcp__<display name>__search` and so on in the request it passed to Research. Whether
  claude.ai builds the names from it, or the model only wrote them so, was step 3's to check;
  it builds them ("The header trial"). The server can't see it: a call names the bare tool.
- **claude.ai keeps the tool list per connector, not per chat.** A chat that calls no tool sends
  no request. One that does opens with `server/discover` and calls from the list it holds,
  whatever the TTL of 0 says: four of eight connections fetched `tools/list` again. That bears
  on how long a changed description takes to show (#1044, the full trial).
- **`download` was called twice, and nothing fetched the link it answered.**
- **Research never called the connector.** With `read` on "Needs approval" and `find_tags` on
  "Blocked", and again with every tool on "Always allow" in a chat that had just used the
  connector, Research reported it unavailable and sent no request, not even `server/discover`.
  The chat that launched it knew the tools' names, less the blocked one, and passed them on.
  So the question is no longer which setting holds in Research but whether Research calls a
  connector at all. It didn't in the later trials either ("The slice trial").
- **Its largest answer, a `read`, was 69,729 bytes**, far from the bound the header trial looks
  for. The instance had no doc that long, so the header trial reads one made for it (Build
  order, step 3).
- **Two findings went to TODO.md**: a Markdown read writes `&` as `&amp;` (and an entity in a
  body's text comes back changed), and `search`'s description should say that a call needs `q`
  or a filter.

### The header trial

On 2026-10-14 claude.ai was tried against the trial instance at step 2's build (0f63ec0),
through the early trial's request-header connector and a second one for the display name, each
with a read-only `claude-ai` token acting as its Claude account and issued by Luke (TODO.md,
"The claude.ai trial: what to undo"). nginx's `mcp.log` gave each request's method, tool and
size.

- **A renamed tool reaches claude.ai only when the person refreshes the list.** claude.ai fetched
  `tools/list` 25 seconds before the deploy's restart and kept that list for 12 minutes 50
  seconds, through two chats and a `server/discover` whose answer had changed, whatever the
  TTL of 0 said. A call by an old name would have been refused. "Refresh tool list", in the
  connector's settings, fetched the new list at once (#1044).
- **Before a tool search the model has the names alone, and never the instructions** (#93,
  #1105). Once a tool is loaded, its description arrives word for word: `search`'s named Claude
  and Luke, each with an author slug.
- **Names are built from the connector's display name**:
  `mcp__<display name>__multiblog_search`, and, for a second connector whose display name was
  39 characters long, `mcp__<that name>__multiblog_find_users`. That is 66 characters, and it
  loaded and was called without error, as was the 65-character `find_tags`. So claude.ai
  doesn't hold a built name to 64 characters at that length, or maps it to one the model never
  sees ("The names").
- **claude.ai allows one connector per URL in an organization.** The second connector's URL was
  `/api/mcp?probe=1`; the route ignores the query.
- **Adding a connector probes for OAuth first.** A `python-httpx` client with no token, under
  2025-11-25, got the 401 and asked for `/.well-known/oauth-protected-resource/api/mcp`, the same
  at the root, and `/.well-known/oauth-authorization-server`, each a 404, before claude.ai used
  the header. The first path drops the query string, as RFC 9728's derivation does.
- **A listing with no `q` worked first time**, where the early trial's first call was refused as
  `invalid`, so the description's "A call needs q or a filter" is read.
- **claude.ai cuts a tool result at 100,000 characters**, on the read-bound test doc (Build
  order, step 3):
  - **It counts one copy.** Of 357,416 bytes on the wire it measured 178,317, the length of the
    text block, which equals the structured content's.
  - **It counts characters**, though its marker says "exceeded 25000 token limit". Blocks 1–106
    of the doc, about 99,200 characters, arrived whole; blocks 1–108, 100,146, were cut at
    100,000.
  - **Past it, the model gets the first 100,000 characters and a note**, and the whole result is
    kept as a file its Read tool opens until the reply ends. Asked to, the model read the rest
    that way and found the body's end. A later turn can't.
  - **The same with code execution off.**
- **The byte routes are reachable from claude.ai once the instance is an allowed domain.** By
  default code execution's egress proxy refused the connection (`curl: (56) CONNECT tunnel
  failed, response 403`), and nothing reached the server. With the instance's host added to
  the allowed domains, a `download` and then a `GET` of the export's catalog, from Anthropic's
  sandbox, answered 200.
- **The skill changed no tool use** in three questions, each asked with it off and then on:
  - "What did we conclude about whether God is a control freak?" went to claude.ai's memory and
    past-chat search both times, never to MultiBlog, so it missed the group's discussion summary
    there. With the skill on, the model saw it and called skipping it "arguably a miss".
  - "What have I written about sloth?" searched and read MultiBlog both times: the descriptions
    alone were enough. With the skill on, the model said it chose the archive over its memory
    because the question was about what the person wrote.
  - "Is acedia the same thing as laziness?" was answered from general knowledge both times.
  - The skill, once added in claude.ai, appeared in a Claude Code session as
    `anthropic-skills:multiblog`.
- **A chat honors each tool's setting.** `search`, on Always allow, ran unasked; each of four
  `read`s, on Needs approval, waited for its own approval; `find_tags`, Blocked, was missing
  from its list. This was a chat with Research mode on, but claude.ai's data export shows the
  model calling the connector itself rather than launching Research, which Research mode
  allows; Research proper called nothing ("The slice trial"). A first run in claude.ai's auto
  mode approved the reads unasked.
- **iOS** sent the same `server/discover` and call, under 2026-07-28.
- **No `subscriptions/listen`** in any request from claude.ai.
- **Findings for TODO.md**: search's dates are UTC unless `tz` is passed, which read as a day
  ahead; results give site-relative URLs, which claude.ai can't make clickable; `download`'s
  description says the catalog gives a "size" where the field is `chars`; and four of
  the instance's docs had no `prose_json`, so their bodies were missing from search and the
  catalog counted them as 0, until each was opened in the editor the same day.

### The slice trial

On 2026-10-14 claude.ai was connected to the trial instance at step 5's build (9d91866) through
OAuth: a new connector at `/api/mcp` with Claude's published identity, approved by Luke on the
consent page for Claude's account, which works for him. nginx's `mcp.log`, its access log for
`/authorize` and `/token`, and the app's `{"at":"oauth"}` and `{"at":"mcp"}` lines gave each
request.

- **claude.ai connects through OAuth, on the web and on iOS, and shows as connected.** #1110's
  symptom didn't appear (Open): the tools loaded in a chat on both, and the connector's settings
  showed it connected while its token was good.
  - **Adding the connector probes, as in the header trial**: a `python-httpx` request with no
    token, under 2025-11-25, got the 401, then
    `/.well-known/oauth-protected-resource/api/mcp` and `/.well-known/oauth-authorization-server`
    answered 200. With the first found, it asked for no other path.
  - **Connect opened `/authorize`** with `client_id`
    `https://claude.ai/oauth/mcp-oauth-client-metadata`, `redirect_uri`
    `https://claude.ai/api/mcp/auth_callback`, S256, `scope=read write`, and `resource` the
    endpoint's URL exactly. The page offered `write` unchecked; approved as it stood, the
    connection got `read` alone. `/token` was redeemed from Anthropic's servers within a second
    of the decision.
  - **Then 2026-07-28 throughout**: `server/discover`, `tools/list` and each call, answered in
    JSON. iOS sent the same.
- **No `subscriptions/listen`** in any request.
- **A connection ends with its hour, and claude.ai finds out from a refusal.** With no refresh
  token until step 7, the connector's settings offer Connect again once the hour is up. The next
  chat sent the expired token and got 401 `invalid_token`, retried with no token and got a 401
  again, then read both documents and asked the person to connect. Approving made a new
  connection and the chat carried on. The old connection's row stayed unrevoked, since nothing
  revoked a connection then; step 7's migration revokes the slice's connections. It happened twice, the same way each time.
- **A chat that reconnects stays on 2025-11-25.** After each reconnect, claude.ai fetched
  `server/discover` and `tools/list` under 2026-07-28 and then made that chat's calls through
  the 2025-11-25 fallback: `initialize` answered as a stream, `notifications/initialized`, and
  each `tools/call` as a stream. The same chat's later calls stayed there, and a new chat went
  back to 2026-07-28. The server answers both, so nothing failed.
- **Research called no connector.** Ten Research runs sent the server nothing, not even a
  `server/discover`: in auto mode and in manual, with every tool on Always allow, after
  "Refresh tool list", and with a header connector beside the OAuth one.
  - **How a run goes**, from claude.ai's data export: the chat model calls
    `launch_extended_search_task` with the request as text, and a separate agent does the
    research. That agent listed its tools as web search, web fetch, a helper agent, a draft
    checker and the step that submits its report. No connector was among them, Dropbox's
    included, though it was on in those chats; a run asking for Dropbox alone, in either mode
    and in a second browser, found none either.
  - **The approval never appeared.** Anthropic's help center asks a person to review an
    approval request before Research calls a connector's tools; claude.ai shows it as a dialog
    that picks the connectors a run may use. Luke has seen it before, but not in the week these
    runs fell in.
  - **The same was reported in `anthropics/claude-ai-mcp#21`**, which Anthropic closed in May as
    fixed on the web and desktop.
  - **Research mode doesn't force a launch.** With it on, the model sometimes answers with the
    connector directly, which is what the header trial saw.

  Nothing in this server decides whether Research calls a connector (Open).
- **For TODO.md**: the consent page renders the site header, whose links were prefetched as the
  page loaded, about 20 requests, one of them `/sign-in?callbackUrl=%2Fauthorize` with the
  request's query dropped.

### The refresh trial

Step 7's build (59c86c2) was deployed to the trial instance from its branch on 2026-10-14, before
its PR, and the slice trial's connector was used across a day. Its migration revoked the
slice's three connections; the first chat afterwards sent the revoked connection's token, got
401 `invalid_token`, retried with no token and got a 401 again, and the person connected anew.
The same logs as the slice trial's gave each request. A script against a dev server checked the
retry, which claude.ai never needed.

- **claude.ai refreshes on its own, before the call that needs it.** 5 h 56 min after the
  connection was made, a chat's first request was a refresh at `/token`, not a call: claude.ai
  knew from `expires_in` that the access token had lapsed, so no 401 came first. Then
  `server/discover`, `tools/list` and the calls, under 2026-07-28, and no consent page. A second
  refresh 10.5 hours later went the same way. Each spent one refresh token and got one.
- **One refresh serves every chat.** Two chats opened at the same instant both used the
  connection, and claude.ai sent one refresh between them, so it never sent a token twice.
- **The connector stayed connected** in claude.ai's settings across both refreshes (Open).
- **claude.ai asks for `offline_access`** now that the metadata lists it:
  `scope=read write offline_access`. The page ignores it, as designed.
- **The reconnect's calls stayed on 2026-07-28**, where the slice trial's two reconnects had
  fallen back to 2025-11-25 for the rest of their chats ("The slice trial"). What decides it is
  unknown; the server answers both.
- **Disconnect sends nothing, and a reconnect replaces the connection.** Disconnecting in the
  connector's settings made no request. Connecting again showed the consent page's sentence:
  "Claude already has a connection to claude.ai, made 10/14/2026, 1:49:24 PM. Approving as
  Claude replaces it, and that one stops working." Approving revoked the old connection and made
  the new one in one transaction, logged as a `revoke` with reason `replaced`, then a `grant`.
- **The retry, checked by hand** against a dev server, with a throwaway bot:
  - five refreshes of one token sent at the same instant were all answered, with five distinct
    refresh tokens: one rotation and four retries, since the lock on the connection's row takes
    them one at a time;
  - using one of the five retired the other four, and one presented after that ended the
    connection;
  - on the real clock, a rotated token presented again 115 seconds after its rotation was
    answered, and at 125 seconds ended the connection;
  - the log lines read as designed: `refresh`, `refresh` with reason `retry`, and `revoke`
    with reason `refresh_replayed`.
- **Not tried**: iOS refreshing, which the full trial covers.

### The full trial

Main at step 10 (512214f) was deployed to explore on 2026-10-15, with `api_token_expiry`,
`oauth_slice` and `oauth_refresh_token`. Explore's Claude account got its person by the
one-time update while the build ran, its password cleared in the same statement ("Whose
account"), and its one live token, Claude Code's header token issued by Luke, passed §3's check
throughout. A new claude.ai connector was added at `/api/mcp`, and Claude Code signed in to a
second server entry with `/mcp`. nginx's MCP log, which on explore also takes `/authorize` and
`/token`, and the `{"at":"oauth"}` lines gave each request.

- **claude.ai connects and calls on the web**, under 2026-07-28: the consent page, `/token`,
  `server/discover`, `tools/list`, then a call. The connector showed connected (Open).
- **The web and iOS both refresh on their own, before the request that needs it.** A web chat
  an hour after the access token had lapsed opened with a refresh at `/token`, and so did an
  iOS chat later, one second before its first call: no 401 before either, and no consent page.
  Every request came from claude.ai's servers, the phone's as much as the browser's, so the
  refresh doesn't depend on the device.
- **A revoke from `/dashboard` brings the consent page back.** claude.ai's next request carried
  the revoked token and got 401 `invalid_token`. claude.ai refreshed at once and got 400, sent
  `initialize` with no token and got 401, fetched both discovery documents, and asked the person
  to connect. Approving made a new connection, and the chat went on.
  - So claude.ai refreshes on a 401 as well as ahead of the hour.
  - **The reconnect's calls fell back to 2025-11-25** for the rest of the chat, as the slice
    trial's two did and the refresh trial's didn't. What decides it is still unknown; the
    server answers both.
- **Claude Code signs in with `/mcp` through its pinned identity**, from a server entry with no
  `headersHelper`: discovery, the consent page with its warning about a program on the person's
  own computer, `/token` from Claude Code itself, then calls under 2026-07-28.
- **A revoke from `/dashboard` stops Claude Code at its next call.** The six calls it had in
  flight were answered 401, and the six refreshes it sent for them 400.
- **A sandboxed command is refused the token's file.** A session started in the research
  project with §5's settings, through `--settings` and `--permission-mode default`, ran `wc -c`
  on the header token's file and on `~/.claude/.credentials.json`: "No such file or directory"
  for the first, since the sandbox hides a denied directory whole, and "Permission denied" for
  the second. Its `search` through the header went through as before. The same command under
  auto mode was refused by the classifier before the sandbox ran, so it showed nothing about
  the sandbox.
- **Research** sent one `server/discover` and no call, in manual mode, as in the slice trial
  (Open).
- **A reworded description reaches claude.ai only through "Refresh tool list"** (#1044). A
  second deploy to explore, after the trial, added `search`'s and `read`'s sentence on UTC dates
  ("What the model is told"). A new chat afterwards quoted the old description, and claude.ai
  sent the server nothing: it answered from the list it held. "Refresh tool list", in the
  connector's settings, fetched the new list at once, and the next chat quoted the new
  sentence. How long claude.ai would have kept the old list on its own is unmeasured, since the
  refresh ended the test, five minutes after the deploy.
- **Not tried**: the read-only connector, which isn't built ("The read-only endpoint").

### Build order

What this server can't test locally is whether claude.ai connects to it at all, and an open
claude.ai bug puts that in doubt (Open). So a thin slice, just enough for claude.ai to connect,
is built and tried on the trial instance before the rest. Where claude.ai offers request
headers, a header token tries v2 and the renamed tools there before that, while no OAuth exists
yet.

Each step can deploy on its own. The client registry comes with the consent page, in the
slice, so the slice's metadata advertises CIMD only beside the one identity it pins, Claude's.
Claude Code's identity is an unknown client until step 9, which costs nothing while Claude Code
connects by its header. And an instance whose Claude account has no person offers no
connection at all.

1. **SDK v2**, before any of the OAuth work, and shipped on its own: the two files, `e2e/mcp.ts`
   reading a stream, the checks above, and the spec with a 2026-07-28 client. That spec checks
   the instructions and the cache hints here, since this is the first build that answers
   `server/discover`. The suite as it stands is its proof, and Claude Code keeps working
   throughout.
2. **The tools' names and descriptions** ("What the model is told"), shipped on their own:
   - the `multiblog_` names, added where the tools are listed and looked up, and the six new
     verbs;
   - descriptions that lead with what a person searches by and carry the conventions, with
     `search`'s and `create_doc`'s naming the actor and the issuer;
   - the instructions cut to what belongs to no one tool, from a source the skill shares;
   - the skill's generator, and a script that writes its ZIP, so the header trial can try the
     skill before the Connections card offers it (step 10).

   Its specs: `e2e/mcp.ts` adding the prefix, so the specs change only where a verb does;
   every listed name within 21 characters; every description within 1,200, with long names
   for the actor and the issuer; and the instructions within their cap still. The docs that
   name a tool take the new names in the same change, since they describe what is built:
   MCP.md, §15's suggested allow rules included, PERMISSIONS.md, PDF_FRAGMENT_LINKS.md and
   TODO.md.
3. **The header trial, on the trial instance**, if claude.ai's Add custom connector dialog
   offers Request headers, a beta only some accounts have (§5). It tries claude.ai against v2
   and the renamed tools before any OAuth is built, and checks what Testing lists for it. The
   early trial has answered its questions about the protocol, on step 1's build.
   - **The trial instance rather than explore**: it already tracks `mcp-oauth`, and has the
     early trial's Claude account, token and connector (TODO.md, "The claude.ai trial: what to
     undo"), while explore, which holds the research, stays on main.
   - **The token** acts as Claude's account and is issued by Luke, with `read` alone and the
     `claude-ai` client, good for a week: `create-api-token.ts --scopes=read --client=claude-ai
     --expires-days=7`, with the account, the issuer and a name. The connector is added with
     "No sign-in" and one request header, `Authorization`, whose value includes `Bearer `. The
     early trial's connector and token serve as they are. A second connector, with a display
     name long enough to pass 64 characters in a built name, needs a token of its own, since
     the first token's secret is kept only in its connector, and a URL of its own, since
     claude.ai allows one connector per URL: `/api/mcp?probe=1`.
   - **`read`'s bound is tried on a doc made for it**, "Read-bound test for the claude.ai
     trial", PRIVATE to Claude's account and Luke. `scripts/make-read-bound-doc.ts` writes it:
     about 178,000 characters in nine parts of about 20,000, every paragraph opening with the
     character of the body it begins at, so the last one Claude sees shows where a result was
     cut off or spilled to a file. A whole read is past claude.ai's 150,000, and a ranged read
     of the first N parts, by the block numbers its outline gives, tries a size in steps of
     20,000. It goes in through `import-claude-chats.ts --markdown`.
   - **The skill** is uploaded from step 2's ZIP (`npx tsx scripts/mcp-skill.ts <out.zip>`),
     with code execution on, for the question that doesn't name MultiBlog.
   - **It tests nothing of OAuth's**, #1110 included, so the slice and its trial stay.
   - **Afterwards the token is revoked and the connector removed.** claude.ai can't change a
     connector's authentication once it is added, so the slice trial adds it anew.

   Without Request headers, the build goes on to step 4, and the slice trial checks what this
   one would have.
4. **The bearer check, on v2's terms** ("The bearer check", above): every header token given an
   expiry, by the migration and the script, and `/api/mcp` authenticating through
   `verifyBearerToken` and refusing through `bearerAuthChallengeResponse`. Nothing after it
   starts until the tests listed there pass.
5. **A thin slice, enough for claude.ai to connect:**
   - the schema it uses: `oauth_authorization_code` and `oauth_client`; `api_token`'s nullable
     `token_hash` and its `oauth_client_id`, with the CHECK that a row is one kind or the
     other; and `user.works_for_user_id`, with the CHECK that a bot has no password. The trial
     instance's Claude account gets its person by the one-time update ("Whose account");
   - Discovery: both documents, and the 401's `resource_metadata`;
   - the consent page and its decision, bare in what they show (the client's name and the host
     of its redirect URI, which the spec requires on every consent page; the bot, the scopes,
     the warning against a flow someone else started, Approve and Cancel) but not in what they
     check: the client and its redirect URI, the session, the rest of the request, `Origin`,
     and the frame headers, on the page and on `/sign-in`;
   - `/token` for the `authorization_code` grant alone, so a connection lasts its access token's
     hour. Until step 7 the metadata lists neither `refresh_token` nor `offline_access`;
   - the access token, accepted by the bearer check;
   - Claude's published identity, pinned. A client registered by hand is a row put in by hand
     until step 9's script.

   Its e2e: the documents and the 401; approve, code, token, then `tools/list` from both eras'
   clients; the page naming the client and the host of its redirect URI; and the refusals,
   redirected and not. A connection needs a bot, so a fixture makes one: an account with no
   password, working for the suite's user. `createTestUser` always sets a password, which the
   CHECK refuses on a bot, and step 8's `createAgent` builds on the fixture.
6. **The slice trial, on the trial instance**, for step 3's reasons, through a new connector at
   `/api/mcp` exactly, since a resource carries no query. The header trial's two connectors are
   removed and their tokens revoked first: claude.ai can't change a connector's
   authentication, and allows one connector per URL. claude.ai on the web and on iOS connects
   through OAuth,
   lists the tools and calls one, under 2026-07-28, and shows the connector as connected.
   Nothing more is built until it does. If claude.ai shows #1110's symptom (Open), a client
   registered by hand is tried next. It also runs Research with the connector on, to see
   whether Research calls it.
7. **Refresh tokens**: `oauth_refresh_token`, the grant with its rotation and its check of
   `resource`, and `refresh_token` and `offline_access` in the metadata. With them:
   - a new claude.ai connection replacing the bot's last one, and the consent page saying so
     ("The token endpoint");
   - the slice's connections revoked, in the migration that adds the table. They have no
     refresh token, and a connection's lapse is dated by its newest one ("Seeing and ending a
     connection"), so they would otherwise show as live for good.

   Tried on the trial instance from its branch before it merged ("The refresh trial").
8. **The rest of bot accounts**:
   - the web interface that makes bots and moves them to another person, with their rules: no
     password, a person who has one and isn't a COMMENTER, a role no higher than theirs, and no
     invite to a bot;
   - `softDeleteUser` revoking what its user issued;
   - the works-for rule and the role rule, in §3's check and in `create-api-token.ts`;
   - no `manage` in a bot's tool list, whatever its token's scopes.

   Its e2e:
   - `createAgent` (`e2e/mcp.ts`) makes its bot with step 5's fixture, with no password and
     working for its issuer, or every MCP spec's token is refused. A spec that calls `manage`
     asks `createAgent` for a person's token instead, issued by the person themselves, since a
     bot's lists no `manage` (`e2e/mcp-manage.spec.ts`);
   - a token for a bot, issued by someone it doesn't work for, refused at issue and at a call;
   - a bot's token refused once its person is demoted below it, or to COMMENTER;
   - a bot's token with the `manage` scope, listing no `manage`;
   - the web interface refusing to make a person work for anyone, and to invite a bot.

   It deploys to an instance only after that instance's Claude account has its person, or the
   header tokens issued for it are refused: the trial instance's by step 5's one-time update,
   explore's by the same update, made in the deploy that brought this step there, after its
   migration and before the swap ("Whose account").
9. **The consent page in full** (the host of the client's `client_id`; who is signed in, with a
   way to switch; the loopback warning; what the connection can do; the sentence for a person
   with no bot); **Claude Code's pinned identity**; the drift check over both identities, run
   by `deploy/deploy.sh`; and `scripts/oauth-client.ts`, which checks each redirect URI.
10. **The per-client bound on `read`, and the Connections card** (the read-only endpoint is
    designed and not built: "The read-only endpoint"):
    - the per-client bound on `read`: a little under 100,000 characters for a `claude-ai`
      token, whole or ranged ("What else changes for claude.ai");
    - the Connections card, with the endpoint named above it, and the skill and the paragraph for
      a Project to take.
11. **The full trial, on explore**, then the other four instances. Three of them were on
    fb56178, from before the MCP server, so this was also their first deploy of §18's phases
    1–4 and every migration those carry. A Claude account there gets its person by the
    one-time update, run once the deploy's migration has added the column ("Whose account"),
    or a new bot is made there in the web interface.
12. **The docs**: PERMISSIONS.md's "API tokens" (who connects, as whom, the rules for bots, and
    the tools each kind of token lists), DASHBOARD.md (the card), DEPLOY.md (the drift check
    `deploy.sh` runs), §16 (Claude Code's three ways in, claude.ai's connector and the skill),
    and §20 here, for wherever the build departs from this.

Each step ships as §18's phases did: with specs, unit tests and `npm run check`.

### Open

1. **Whether claude.ai treats the connector as signed in at all**
   (`anthropics/claude-ai-mcp#1110`, open since 2026-10-05). It reports a server shaped much
   like this one: Claude's published identity, the authorization server on the same host,
   S256, rotating refresh tokens, stateless JSON responses, and `scope` in the 401. OAuth
   completes and claude.ai lists the tools with its new token. Yet the connector keeps showing
   Connect, and no tools load in a chat, under 2026-07-28 and after its fallback to
   2025-11-25 alike. #1067 shows the same Settings symptom with a client registered by hand,
   though there the tools did load. **It didn't happen in any trial**: the tools loaded and the
   connector showed connected, with rotating refresh tokens as well as without, on the web and
   on iOS ("The slice trial", "The refresh trial", "The full trial").
2. **Whether claude.ai's Research calls a connector at all.** In every trial it called neither
   this one nor a directory connector, and the approval its help center describes never
   appeared ("The slice trial", "The full trial"). Nothing in this server decides it. If it does start calling
   connectors, which of a tool's settings hold there decides whether the read-only endpoint is
   built ("The read-only endpoint").
3. **Claude as a confidential client**, should Anthropic make it one. Its documentation says
   that dynamic registration and a client document both register Claude as a public client. A
   confidential Claude's document would name a key, and the token endpoint would verify
   `private_key_jwt` against it (`jose`'s `createRemoteJWKSet`, from the pinned `jwks_uri`).
   The drift check is what announces the change.
4. **A revocation endpoint** (RFC 7009), if claude.ai turns out to call one when a connector
   is disconnected or removed. Disconnecting sent nothing in the refresh trial, but the metadata
   lists no revocation endpoint, so that says nothing about whether claude.ai would call one.
