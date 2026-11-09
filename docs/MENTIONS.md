# Mentions (planned)

**Status: partly built.** What exists:

- the chip kind (`src/lib/entity-chips/kinds/mention.ts`): its fields, forms, labels and
  same-label rule;
- its context loader (`mention-context.ts`);
- the rule for who may be mentioned (`mention-rule.ts`), and the menu's search over it
  (`mention-search.ts`);
- the `@` menu (`MentionMenu.tsx`) in the doc editor and in a note's composer and edit session,
  on the suggestion menu it shares with `[[` (`SuggestionMenu.tsx`). A query is taken for a
  name only while it is at most 40 characters and four words and doesn't start with a space, so
  "meet @ 5pm" opens nothing. The menu isn't mounted for a viewer below AUTHOR, so a reader's
  "@" opens nothing rather than a list of nobody. A row says when the person couldn't read the
  doc, or the PDF a note is on.
- the `mention` index table and the label refresh after a rename (the kit's items 12 and 10).
- mentions in comments, written in the Markdown box (ENTITY_CHIPS.md, "Chips in comments").

- the Markdown, both ways: a read writes `[@Label](/authors/slug)`, with a deleted or unknown
  account struck through and a hand-written link of that shape escaped; an MCP edit, note or
  `create_doc`, and `/docs`' Markdown import, read it back as a mention, resolved by handle
  under the rule above (`resolveParsedChips`). The import leaves one it can't resolve as a
  link; MCP refuses it.

- search by who is mentioned, and the dashboard's "Mentions of you" card (below, "Search" and
  "The dashboard").

Still a plan: ordering beyond "participants first", and notifications.

A *mention* is an entity chip
([ENTITY_CHIPS.md](ENTITY_CHIPS.md)) that stands for a person: a MultiBlog account. It is shown as
`@Luke Breuer`, `LB` or `@luke-breuer`, depending on the doc's style, and it follows the
person's renames. This file fills in the kit's kind contract. The kit says how every chip is
stored, rendered, quoted and searched. Mentions are step 2 of the kit's order, built together with
step 1.

## The chip

- **Chip kind** `mention`. Its `data` holds `userId`, and an optional `form` that overrides the
  doc's.
- **Identity:** the user id. Two mentions are the same entity when their user ids are equal. A
  mention continues no other chip: a changed user id is a different mention, so an MCP edit that
  swaps the person reads as one chip deleted and one inserted (the kit's MCP, item 5).

## Labels

**Forms.** Each can be shown with or without its `@` prefix.

| Form | Label |
|---|---|
| `name` | `@Luke Breuer` |
| `initials` | `LB`, from `User.adminInitials` |
| `handle` | `@luke-breuer` |

A nickname form would need a new user field.

**Rules.**

- **A mention never shows an email address**, whatever the record holds. A user with no name
  shows their handle, never `User.name`'s email fallback (account-settings.ts).
- **A deleted account** shows the same label, struck through and unlinked, since its author page
  404s. The context loader reads deleted users through `prismaIncludingDeleted`, because the
  default client hides soft-deleted users. Restoring the account clears the strikethrough.
- **An unknown id** shows a struck-through "unknown person".
- **Same labels.** Two mentions in one doc may name different accounts with the same name. Each
  person's bot may be called "Claude", for example. The label then adds a bot's person, or a
  person's handle. The same rule tells apart two people with the same initials, since
  `adminInitials` isn't unique. It uses the kit's doc-order pass, the one that numbers citations.

**Context:** each user's name, initials and slug, deleted users included.

**Refresh** (the kit's step 1, item 10): a user's name, initials or slug changes, or a bot is
moved to another person. Built: each of those writes calls `scheduleMentionRefresh` once it has
committed, from `updateAccountSettings`, `updateUserName`, `updateUserAdminInitials`,
`changeUserSlug`, `revertUserSlug` and `moveBot`. A new way to change one of those fields has
to call it too, and `npm run check:label-refresh` fails for a Prisma write to one of them in a
function that doesn't. What that check can't read (raw SQL, a script) is what
`check-doc-integrity.ts`'s `chip-labels` finding reports. A person's refresh covers their bots,
whose labels can name them.

**Link:** the author page, `/authors/<slug>`, in docs and posts alike.

## Markdown

- A mention is written `[@<label>](/authors/<slug>)`, with the `@` written whatever the style:
  `[@Luke Breuer](/authors/luke-breuer)`, or `[@LB](/authors/luke-breuer)` in a doc that uses
  initials.
- The parse keys on that `@` and the author-page URL, never on the label. So
  `[his profile](/authors/luke-breuer)` stays an ordinary link.
- Hand-written linked text that starts with `@` is escaped on the way out, as
  `[\@Andrew](/authors/andrew)`, so it never reads back as a mention. Today's serializer writes it
  unescaped.
- A deleted account's mention is wrapped in `~~ ~~` and keeps its slug. An unknown one is written
  with its stored user id in place of the slug.

## Step 2: mentions

- **The menu.** A `MentionMenu`, opened by `@` after a space or at the start of a line
  (Suggestion's default `allowedPrefixes: [" "]`, so an email address never opens it).
  - It sits in the doc editor (`CollabEditorBody`) and the annotation composer (`AnnotationBody`).
    Notes are where mentions are most used ("@Andrew, see this").
  - `DocRefMenu`'s placement and keyboard handling move into a shared suggestion menu first, so
    the two can't drift.
  - Spaces are allowed in the query, for full names.
  - **Who is listed:**
    - every named ADMIN, EDITOR and AUTHOR who isn't a bot (`works_for_user_id` is null);
    - the viewer's own bots;
    - another person's bot only when it already takes part in this doc: it is on the doc's byline,
      or it wrote a note on it. Replying to a note that a colleague's bot wrote therefore offers
      that bot, and no other doc does.

    For a bot acting through MCP, "the viewer's own bots" means its person's, so an agent can
    mention itself and its person's other bots.

    AUTHORIZED and COMMENTER accounts aren't listed. For now only AUTHOR and above insert
    mentions, so an AUTHORIZED reader's note gets no menu yet.
  - This doc's byline and annotators come first.
  - **One rule everywhere.** It binds the menu, MCP's mention lookup, the merge's `unknown_chip`
    check, and the people the chip-context endpoint answers for beyond the object's own chips. So
    a slug typed into Markdown can't get round it. `find_users` itself lists every named ADMIN,
    EDITOR and AUTHOR, bots included, and keeps doing so for bylines.
  - A row says "can't read this doc" (or "this PDF", in a note on one) for someone who wouldn't
    see the mention.
- **Search.** Built.
  - `mentions=<slug>` keeps a search to the docs, posts, notes and comments that mention that
    person, by the `mention` table, inside each kind's readable ids (`mentionedWhere`,
    `src/lib/search/context.ts`). Several handles mean any of them. PDFs hold no mention and are
    left out, and the page says so.
  - `me` is the searcher, and no account may have that handle (`RESERVED_USER_SLUGS`,
    `user-slug.ts`).
  - Typing `@me` or `@<slug>` in the search box applies it: every `@handle` that is a word of
    its own is a filter, and the rest is the text (`splitMentionTokens`). Every well-formed
    one, whether or not anyone has the handle, so the box can't be used to ask who exists. A
    `mentions=` in the URL is shown in the box as those words.
  - **A handle nobody has narrows to nothing**, exactly as a real person with no mention the
    searcher can read does, and the page names handles, never people. So the filter discloses
    no account and no private doc.
  - MCP's `search` and the export take `mentions`.
- **The dashboard** has a "Mentions of you" card (`src/lib/mentions-of.ts`): one query per
  kind through its read rule, newest first by when the mention was first seen, one line per
  doc, note, post or comment, a comment's linking to its permalink. Its heading is
  `/search?mentions=me`. Built.
- **The notification stub** is the `mention` table's first-seen time, an outbox nothing reads
  yet. When notifications are built:
  - only new mentions count, at most once per person per item;
  - the sender comes from the `clients` map;
  - delivery re-checks the recipient's read access.

## Later

- **The comment menu**, planned in [ENTITY_CHIPS.md](ENTITY_CHIPS.md), "Chips in comments".
  A comment's mentions are built from its Markdown box, under their own rule for who may be
  mentioned (that section, "Who may insert").
- **Notifications**, as described under the stub (TODO.md).
- **A control for a mention's `form`**, the per-chip override. Every label honours the field,
  and nothing sets it.

## Checks

- **Unit tests:**
  - each form, with and without `@`, and the fallbacks;
  - the same-label rule, for names and for initials;
  - the menu's rule: AUTHOR and above, the viewer's bots, and bots taking part in the doc;
  - the Markdown round trip, including an escaped hand-written `@` link and an initials label.
- **e2e:**
  - inserting a mention from the menu, in the editor and in the composer;
  - a rename relabelling a doc without detaching its anchors.
