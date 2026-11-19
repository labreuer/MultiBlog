# MultiBlog — Email: real delivery and invites

Real mail delivery behind `sendMail()`, and email invites: an admin creates a `User` row,
then sends a link that lets that person set a password and claim the account. Originally
designed as a candidate PLAN.md §18, moved here before it was ever written there — this
work has no landing-page/schema-diagram home the way PLAN.md's numbered sections do, the
same reasoning that put auth mechanics in
[src/app/sign-in/NOTES.md](../src/app/sign-in/NOTES.md) and site icons in
[FAVICON.md](FAVICON.md) instead of PLAN.md. PLAN.md carries only pointers to this file;
everything below assumes PLAN.md §6's abuse-prevention posture, §16i's column-visibility
rules, and sign-in's session/JWT mechanics, without repeating them.

Email verification (double opt-in) is **not built** — see §7. `emailVerified` gates
nothing today and still gates nothing after this work; it is display-only on `/users`,
written by `acceptInvite` and by a join card's confirmation. §10 is one-off join codes:
printed cards that make an account only once the email given is confirmed.

## 1. Why Resend, and what actually determines deliverability

Ranked by how much each one actually moves the needle, not by how much attention it gets:

1. **Don't self-host.** Linode blocks outbound ports 25/465/587 by default on every
   account created since November 2019 — sending SMTP directly from the app box needs a
   support ticket just to attempt it, and a fresh VPS IP has no sending reputation, so
   even an unblocked port starts in the least-trusted tier every major inbox provider has.
   This rules out a Postfix-on-the-box design outright, independent of which API provider
   gets picked.
2. **SPF, DKIM and DMARC on the sending domain.** As of November 2025, mail failing these
   gets a permanent rejection rather than a spam-folder placement — this applies to
   transactional mail too, not just bulk marketing (the 5,000/day bulk-sender threshold
   governs extra requirements like one-click unsubscribe, not authentication itself).
   Correctly configured, senders see roughly 89% inbox placement; misconfigured, 22–34%
   lands in spam regardless of provider. **This is genuinely new deployment surface** —
   see §9.
3. **The provider's own IP-pool hygiene.** In shared-IP testing with no warmup, Postmark
   placed 83.3% and SES 77.1% — Postmark's edge is refusing to carry marketing traffic on
   the same infrastructure as transactional mail, keeping its shared pool's reputation
   clean.

**Resend was chosen** for this build: a 3,000/month free tier, a plain HTTP API reachable
with `fetch` (no new npm dependency), and Next.js-native ergonomics. It runs on Amazon SES
underneath, so its deliverability ceiling is SES-grade rather than Postmark-grade — an
acceptable trade at this volume given correct domain authentication (§9). If invites start
landing in spam despite correct DNS, **Postmark is the upgrade path**, and it is a one-file
change: everything downstream of `sendMail()` is provider-agnostic by construction (§2).

## 2. The seam's contract

`src/lib/mail.ts` is the abstraction — not a provider registry. A plugin layer for one
provider (with a second, unconfigured one) would be speculative generality this codebase
doesn't otherwise carry.

```ts
type MailContent =
  | { subject: string; text: string; html?: string; template?: undefined }
  | { template: { id: string; variables: Record<string, string> }; subject?: undefined; text?: undefined; html?: undefined };

export type SendMailInput = {
  to: string;
  from?: string;   // overrides MAIL_FROM; nothing sets this today
} & MailContent;
export type SendMailResult = { delivered: boolean; error?: string };
```

`template` and `subject`/`text`/`html` are a union, not all-optional siblings — Resend's own
API refuses to combine `template` with `html`/`text`/`react` ("mutually exclusive"), so this
makes that a type error rather than a runtime 422. `sendUserInvite` is the one caller using
the `template` branch, when `RESEND_INVITE_TEMPLATE_ID` is set (§4); every other caller still
passes `subject`/`text` exactly as before.

Dispatch, in order:

| Condition | Behavior | Returns |
|---|---|---|
| `to` matches `/@(example\.com\|([^@]+\.)?invalid)$/i` | log, annotated `(not delivered: reserved domain)` | `{ delivered: true }` |
| `RESEND_API_KEY` or `MAIL_FROM` unset | log in the original format | `{ delivered: true }` |
| otherwise | `POST https://api.resend.com/emails` via `fetch` | `{delivered:true}` / `{delivered:false, error}` |

The logged form degrades gracefully for a `template` call too — there's no `text` to print,
so the log line shows the template id and its variables as JSON instead. Every caller's
success branch is still exercised without a provider or a template ever being configured.

Three properties are load-bearing:

- **The reserved-domain refusal is unconditional, in every environment — not an env
  flag.** `e2e/naming.ts`'s `SAFE_EMAIL` guarantees the suite only ever creates
  `@example.com` addresses, and every account given an address that can't receive mail
  sits under RFC 2606's `.invalid` TLD — `scripts/seed-sample-data.ts`'s `@sample.invalid`,
  `scripts/import-claude-chats.ts`'s `claude@multiblog.invalid`. The whole TLD is refused,
  so a new such account needs no edit here. `src/lib/mail.test.ts` pins it with a stubbed
  `fetch` and a key set. Without this check, the day a live key lands in a dev `.env`, `npm run e2e` becomes a
  burst of hard bounces against your own sending domain — the fastest way to get
  throttled by a provider. Three lines makes "the suite cannot send mail" structural
  rather than a matter of `.env` discipline.
- **`sendMail` never throws.** If it did, `requestPasswordReset`
  (`src/app/actions/forgot-password.ts`) would throw for an address that exists and return
  its generic message for one that doesn't — a perfect enumeration oracle, defeating the
  exact property that action's own comment exists to protect. A failure is logged via
  `console.error` and reported back as `{ delivered: false }` for a caller that can act on
  it (`sendUserInvite` does; `requestPasswordReset` and the RAISED-annotation notifier
  don't need to).
- **The log path always reports `delivered: true`**, so local dev and the e2e suite
  exercise every caller's success branch without a provider ever being configured.

**One sender identity.** `MAIL_FROM` serves the auth flows, and would serve the
RAISED-annotation notifier (`src/app/actions/annotations.ts`), which is switched off
(docs/ANNOTATIONS.md, "Raising sends no mail") — their subject lines already carry the
distinction a second identity would otherwise buy. `from?` exists on the input purely as a
future seam; nothing sets it today.

**`src/lib/app-url.ts`** centralizes what used to be
`process.env.APP_URL ?? "http://localhost:3000"` duplicated at two call sites — a third
(invite links) made that worth factoring out. Subjects use `SITE_TITLE`
(`src/lib/site-config.ts`) rather than a hardcoded brand name, so a deployment that set
`NEXT_PUBLIC_SITE_TITLE` gets mail branded to match.

## 3. Rate limiting: what's needed vs. scope creep

**`requestPasswordReset` gets a 60-second per-address cooldown**, checked against the
newest `PasswordResetToken.createdAt` for that user. Before a real provider was wired,
an unauthenticated, unlimited reset-email trigger was harmless; it becomes a live abuse
channel the moment mail is real. The action already deletes prior tokens before creating
one, so the surviving row's `createdAt` is exactly "when the last mail went out" — no new
table.

**The cooldown must still return the same generic message regardless of whether it fired.**
A distinct "you already have one, try again in a minute" response would itself be an
enumeration oracle — same reasoning as the account-exists check the message already hides.

**Not needed:**

- **`sendUserInvite`** is behind `requireAdmin()`, and repeat sends to the same user are
  the explicitly requested feature (spam-filter re-sends) — limiting it fights the
  requirement.
- **Per-IP limits on forgot-password** would need `headers()`/`x-forwarded-for` plumbing
  into a server action for comparatively little gain; the per-address cooldown already
  bounds damage to any single victim.
- **A dedicated rate-limit table, bucket algorithm, or shared limiter abstraction.**
  `src/lib/rate-limit.ts`'s existing precedent — a rolling count over columns that already
  exist — is what a hobby-scale site needs; this reuses the same idiom rather than adding
  a fourth kind of counter to the schema.

**Deferred, not solved here:** a global hourly send budget, which is what actually
protects the provider bill against a determined abuser. It needs a counter table this
pass doesn't build — TODO.md.

## 4. `user_invite`: many rows per user on purpose

```prisma
model UserInvite {
  id          String    @id @default(cuid())
  userId      String    @map("user_id")
  invitedById String    @map("invited_by_id")
  token       String?   @map("token")
  tokenHash   String    @unique @map("token_hash")
  sentAt      DateTime  @default(now()) @map("sent_at")
  expiresAt   DateTime  @map("expires_at")
  clickedAt   DateTime? @map("clicked_at")
  acceptedAt  DateTime? @map("accepted_at")
  revokedAt   DateTime? @map("revoked_at")

  user      User @relation("UserInviteRecipient", fields: [userId], references: [id], onDelete: Cascade)
  invitedBy User @relation("UserInviteSender", fields: [invitedById], references: [id])

  @@index([userId, sentAt])
  @@map("user_invite")
}
```

**Unlike `PasswordResetToken`, sending a new invite never deletes the old ones.**
`PasswordResetToken`'s action deletes priors before creating, because a reset token is a
one-shot credential with no reporting value — nobody needs a history of forgotten
passwords. `UserInvite` is the opposite: the whole feature request was "let an admin
re-send when the first lands in spam," which only means something if "sent three times,
clicked once, never accepted" stays answerable. Nothing is ever deleted on send; only
`sendUserInvite`'s own expiry sweep and `acceptInvite`'s sibling-revocation touch existing
rows, and both null the *token* rather than the row.

**`clickedAt` and `acceptedAt` are two columns, not one.** A GET on `/invite?token=…`
stamps `clickedAt` — including a corporate mail-security scanner's link prefetch, which is
fine: that still proves the message reached an inbox and was clickable, which is all
"clicked" claims to mean. `acceptedAt` can only be set by the POST that actually sets a
password, which no automated scanner can fake. Collapsing these into one column would
conflate "the mail was deliverable" with "the person is onboarded," and the first is
specifically what an admin deciding whether to re-send needs to see.

**Validation is per-token, never per-user.** There is no delete-priors step on send, so
several invites can be live for one user at once — clicking invite #1 must not invalidate
#2. `src/lib/invite.ts`'s `findLiveInvite` looks up by `tokenHash`, then rejects on
`revokedAt`, `acceptedAt`, `expiresAt < now`, or a soft-deleted recipient. Only
`acceptInvite` revokes the other live invites for that user, once one is actually accepted.

**The soft-delete `include` trap.** `src/lib/prisma.ts`'s extension filters *operations
on* `post`/`user`/`doc` directly, but a nested `include: { user: true }` inside a
`userInvite.findUnique` is **not** filtered — a soft-deleted recipient's row still comes
back through the relation. `findLiveInvite` selects `user.deletedAt` explicitly and checks
it by hand rather than relying on the extension to catch it.

**The invite email is a Resend Template, when one is configured.**
`RESEND_INVITE_TEMPLATE_ID` names a Template (an id or alias) declaring exactly three
variables: `invitee`, `invited_by`, and `invite_url`. `sendUserInvite` populates
`invitee`/`invited_by` from `User.name`, falling back to `User.email` when a name isn't
set — the invited user's own name, and the inviting admin's, read fresh from the database
(not the session, whose JWT only ever carries `id`/`role`/`color` at sign-in — see
`src/app/sign-in/NOTES.md`). `invite_url` is the same link either branch sends. **Leaving
`RESEND_INVITE_TEMPLATE_ID` unset falls back to a plain subject/text send** built from the
same three values — the same "absent env var, simplest degraded behavior" shape as
`RESEND_API_KEY`/`MAIL_FROM` themselves, so invites work end-to-end against a from-scratch
deployment that has never created a Template in the Resend dashboard. Designing the
template itself (copy, branding, which variables it renders) is dashboard configuration,
not something this codebase owns.

**TTL: 14 days**, not the reset flow's 1 hour. An invite sits in an inbox waiting to be
acted on, unlike a reset link someone is actively mid-flow for; 1 hour would mean
constant re-sending for no reason.

## 5. The raw token is stored until consumed

`PasswordResetToken` stores only a SHA-256 hash, so a database read — or a `pg_dump` in
`.db-backups/` — cannot yield a working credential. `UserInvite.token` is the raw value,
kept alongside `tokenHash`, and this is a real, deliberate narrowing of that posture.

**Why this one is different.** The requested "Invite URL (last if any)" column needs to
show a real, working link across page loads — not just in the instant after the button is
pressed. Three ways to get there were weighed:

1. **Store the raw token until consumed** (chosen). The column reads straight off server
   data with no client-side state; the link disappears the moment it stops being useful.
2. **Show it once, never persist.** Keeps the hash-at-rest posture fully intact, but the
   column reads empty for every invite that wasn't sent in the current page load —
   "last if any" effectively becomes "last from this session," which doesn't match what
   was asked for.
3. **Store the raw token permanently.** Simplest, and rejected outright: every historical
   invite token stays readable in the database forever, including for accounts that later
   became admins.

**What bounds the exposure of option 1:** the raw token is nulled the instant the invite
is accepted or revoked (`acceptInvite`'s transaction), and `sendUserInvite` sweeps a
user's own expired-but-unconsumed tokens to null on their next invite. Only *live,
unaccepted* invites carry a usable secret, the credential only sets a password on an
account nobody has ever signed into, and `/users` is already wholly ADMIN-gated.

**The residual, stated plainly rather than buried:** a pending invite's link is readable
by anyone who can read the database or a backup, for as long as that invite stays
unconsumed. And an invite that expires for a user who is never re-invited keeps its raw
token indefinitely — unusable (`findLiveInvite` checks `expiresAt`) but untidy; there is
no scheduled sweep for this case today (§7). See DEPLOY.md §9 for the backup-content
consequence.

## 6. The two `/users` columns

**Neither column is sortable, and no view was built for them.** "Send invite" is a button
and "Invite URL" is a link that only exists while an invite is live — `ColumnSpec`'s own
documentation gives "an action button is not a sort key" as a reason to omit `sortKey`
outright, and the same reasoning applies to a value that isn't stably comparable across
rows. PLAN.md §16l's escape hatch (a Postgres view keyed 1:1 on the table's primary key,
turning a to-many into an orderable to-one) exists for values that are *awkward to reach
and someone needs sorted* — nobody sorts a user list by invite recency, and "who hasn't
accepted yet" is a filter, not a sort. A `user_invite_status` view would be a fourth
hand-managed DDL artifact Migrate doesn't track, evaluated with a `LEFT JOIN` on every
sorted page load, bought for an ordering nobody asked for.

**If sortability is ever wanted**, the cheap answer needs no DDL at all: a third,
`defaultHidden`, `sortKey: "invites"` column showing just the count, with
`case "invites": return { invites: { _count: dir } };` added to `buildOrderBy` — the exact
shape `/users`' existing `posts` column already uses. Not built in this pass; nobody asked
for it.

**The `cols`-membership caveat applies to both new columns.** Per
`src/components/table/column-spec.ts`, membership in the saved `cols` list *is*
visibility — a column shipped after an admin last saved a `columnOrder` for `/users` is
invisible to them, `defaultHidden` or not, until they reopen the ColumnPicker. Because
both columns are `defaultHidden` anyway the practical difference is small, but it means:
manual verification needs the picker opened explicitly (it won't "just appear"), and e2e
specs force visibility with `?cols=…` rather than relying on defaults.

**Bulk "send invites to selected users" was not built.** `settleBulk`
(`src/lib/bulk-result.ts`) starts every per-row promise eagerly, so N selected users would
mean N simultaneous provider calls with no backoff against per-second rate limits any
provider imposes. Separately, every existing bulk action on this table (role, moderation
policy, delete/restore) reverses; sending mail to a real person does not. Worth building
once the single-row path has seen real use — TODO.md.

## 7. Deferred, with reasons

**Email verification (double opt-in) is not built.** When it is:

- **A new app-owned `EmailVerificationToken`**, not the unused Auth.js
  `VerificationToken` already in the schema. Four independent reasons to leave that model
  alone: it belongs to `PrismaAdapter`'s contract (an `EmailProvider`, if one is ever
  added, would collide with rows this feature wrote into the same table); it stores
  tokens unhashed, contradicting the posture `src/lib/tokens.ts` already established; it
  carries no FK to `User`, so nothing cascades a deletion; and it's keyed by an email
  string rather than a user id, so an email change strands every outstanding token. Same
  shape as `PasswordResetToken` instead.
- Send at sign-up (`src/app/actions/sign-up.ts`, before its existing redirect) and on
  demand from `/dashboard`, which already does a scoped `findUnique` — adding
  `emailVerified: true` to its `select` costs nothing extra. **Never bake `emailVerified`
  into the session JWT** — the token reads its account only every five minutes
  (`src/app/sign-in/NOTES.md`), so a user who verifies mid-session would keep seeing a stale
  "please verify" notice until it did.
- `/verify-email` stamps via an idempotent `updateMany` (`emailVerified: null` in the
  `where`), the same idempotency shape `/invite`'s click-stamping already uses.
- A 60-second resend cooldown off the newest token's `createdAt`, the same shape as §3.
- **It will still gate nothing.** That decision was made deliberately for this pass and
  applies to the deferred one too: every existing `User` row has `emailVerified = NULL`,
  since nothing has ever written to it, so gating sign-in on it would lock out every
  account that already exists, including whichever admin is reading this. That needs an
  explicit backfill migration and explicit sign-off before it's even a live option — not
  something to arrive at by accretion.
- **Two write paths already exist going into this deferred work.** `acceptInvite` stamps
  `emailVerified` on acceptance — clicking a link delivered to an inbox is exactly what the
  column claims to mean, so an accepted invite already makes it truthful for that user. A
  join card's confirmation (§10) makes its account with the column set, since the account
  exists only once its email has been proven. The verification pass adds the remaining
  paths (sign-up, on-demand, `/verify-email` itself); it doesn't need to invent these.
- **`/sign-up` stores its email trimmed, as typed, and refuses one any account has in any
  case**, and sign-in and password reset find an account by its email in any case (§10,
  "Mistakes that fail no check"). Verification changes none of that.

**Also deferred:** bulk invites (§6); auto-sign-in immediately after accepting an invite
(sign-in here is client-side via `next-auth/react`, and calling `signIn` with the
Credentials provider from a server action is exactly the v5 minefield
`src/app/sign-in/NOTES.md` documents — rendering a plain "sign in" link avoided it rather
than working around it); richer HTML mail templates (`SendMailInput.html` exists but
nothing sets it yet); a global hourly send budget (§3); a scheduled sweep for an expired,
never-re-invited token's raw value (§5's residual).

## 8. Verification

**`e2e/invite.spec.ts`** (three tests) — per `e2e/README.md`'s rule of driving the real UI
once and reaching past it for the rest:

1. *Admin sends, through the real UI.* Creates a throwaway user, forces the two
   `defaultHidden` columns visible with `?cols=`, clicks "Send invite" → "Yes", and asserts
   the resulting `readOnly` input matches the invite-URL shape. Confirms in the database:
   exactly one row, sent/unclicked/unaccepted, a live token.
2. *The invitee accepts, in a fresh browser context.* Mints the invite straight in the
   database (this test is about acceptance, not the send path test 1 already covers), opens
   it in a context with no inherited session — the same "each identity gets its own cookie
   jar" discipline the collab specs use — fills a new password, and then **signs in with
   that password**. The final sign-in is the assertion that actually proves the feature
   works end-to-end rather than merely wiring together without a functional check: a broken
   `acceptInvite` that silently no-ops on `passwordHash` would still show "Password set" if
   only the success-state render were checked.
3. *History survives; acceptance revokes only the others.* Mints two invites for the same
   user, accepts the second. Asserts the row count is still **two** — the property that
   distinguishes this table from `PasswordResetToken`'s delete-priors behavior — and that
   the first invite is now revoked with its token nulled.

**`sendMail` is never stubbed or spied on in the suite.** Every recipient the suite
creates is `@example.com`, which §2's reserved-domain check refuses to deliver to
unconditionally — nothing leaves the box by construction, whether or not a real key is
present in the test environment's `.env`.

**By hand, once, with a real key:** send exactly one invite to your own address and check
both the inbox and the Resend dashboard. This is the only check that actually proves §1's
deliverability argument; nothing automated can stand in for it.

## 9. Deploying

Three new env vars, all optional and all bare (**not** `NEXT_PUBLIC_`, so a change is a
service restart, not a rebuild — the same distinction DEPLOY.md already draws for
`SITE_BANNER*`):

```
RESEND_API_KEY="re_..."
MAIL_FROM="MultiBlog <noreply@your-domain>"
RESEND_INVITE_TEMPLATE_ID="tmpl_..."
```

Leaving the first two unset keeps every environment on the logging stub — nothing here is
required to run the app. `RESEND_INVITE_TEMPLATE_ID` is independent of them: it only
changes *how* the invite email is composed (a Resend Template's variables vs. plain
subject/text, §4), and needs a Template already created and published in the Resend
dashboard before it's set here.

**The DNS work is genuinely new deployment surface.** DEPLOY.md §7 has, until now,
specifically called out that path-based collab means "no DNS-API plumbing" — an HTTP-01
challenge over port 80 is all TLS ever needed. Sending real mail from a domain breaks that
streak: Resend's dashboard, once a sending domain is added, emits the exact SPF/DKIM/DMARC
TXT records that domain needs, and those have to be added at whatever DNS provider hosts
the domain — a step this deployment has never needed before. Do this before flipping on a
real `RESEND_API_KEY`, not after; an unauthenticated sending domain is the single biggest
determinant of whether the mail described in §1 actually reaches an inbox.

**Backup content changed.** `user_invite.token` holds live invite links in plaintext, so
the `pg_dump` output DEPLOY.md §9 already produces now carries usable credentials for
whatever invites are pending at backup time — see §5's residual for the full trade.

## 10. Accounts from one-off join codes

**Built, in the five PRs of the build order below.** An ADMIN
prints a batch of cards, each with a QR code and a code that works
once. Whoever scans one gives a name, an email and a password, confirms the email from a link,
and only then has an account: an AUTHOR, whose comments publish without waiting for
moderation, and whose first sign-in lands on a welcome page showing the commons wiki page
`New Account Welcome`. It is made for handing out at a conference, but nothing in it is
specific to one.

It builds §7's email verification for these accounts alone; `emailVerified` still gates nothing
anywhere else. The trust it grants is a column beside `forceModerate` (docs/COMMENTS.md,
"Identity, moderation and abuse"), and the welcome page is a held commons name, found as the
front page is (docs/WIKI.md, "Permissions" and "The front page").

**It stands on three changes that came first, and each deploys everywhere on its own**
("Build order"):

- **a session that reads its account again every five minutes**, so that deleting or demoting
  an account takes effect (`src/app/sign-in/NOTES.md`, "The session is a JWT, and reads its
  account again every five minutes"), with **making a wiki page `PUBLIC` an editor's**
  (docs/WIKI.md, "Permissions"). Both are built;
- **commenter identities kept apart**, with every place an email meets an identity it doesn't
  belong to logged for an ADMIN to review (docs/COMMENTS.md, "Identities kept apart, and a log
  of where they meet"). Built;
- **publishing a post made an EDITOR's**, with `RAISED` annotations sending no mail (PLAN.md
  §38). Built.

**A card never changes an existing account**: it neither raises one's role, nor adopts an
anonymous commenter identity with the same email.

### What an AUTHOR from a card can do

Read this before printing a batch for an instance. AUTHOR is a role, and these are strangers.

**What reaches readers who aren't signed in:**

- **Not posts.** Publishing is an EDITOR's (PLAN.md §38), so a post a card's account drafts
  stays off `/`, the archives and the RSS feed until an editor publishes it.
- **Not wiki pages.** Their name gives them a namespace of their own, `/wiki/@<slug>/`, but
  making a page `PUBLIC` is an editor's too (docs/WIKI.md, "Permissions"), so their pages go as
  far as `SHARED`.
- **References.** An AUTHOR adds works to the reference library (`canWriteReferences`), and a
  reference's page, `/references/<key>`, is public.
- **Their author page**, `/authors/<slug>`, with their name and any avatar they upload.

**What reaches other accounts:**

- **Every `SHARED` doc and file, to read** (`canViewDocs`, `canViewFiles`), with the docs'
  annotations. Whatever an instance keeps `SHARED` is theirs to read the moment they confirm.
  They can annotate and tag all of it too.
- **Not mail.** Raising an annotation sends none (docs/ANNOTATIONS.md, "Raising sends no
  mail"), so nothing a card's account does sends mail, except its own confirmation.
- **Their own docs and uploaded files**, each file up to `FILE_MAX_UPLOAD_BYTES` (50 MB unless
  set), with no per-account quota.
- **An AI client's connection.** Connecting one makes them a bot at Approve (docs/MCP.md §21),
  as for any AUTHOR. An ADMIN can turn it off for one account on `/users` (`mcp_allowed`).

**Not**: edit another's `SHARED` doc, curate tags, create a commons page, publish a post or a
wiki page, send mail, or reach `/users`.

**Stopping one:** deleting or demoting the account on `/users` reaches its session within five
minutes (`src/app/sign-in/NOTES.md`, "The session is a JWT, and reads its account again every
five minutes"). An editor tab it already has open keeps its live connection until that
reconnects.

### Mistakes that fail no check

- **Mail sent or a card spent on a GET.** QR readers, chat previews and link scanners fetch a
  URL before anyone taps it. `/join/<code>` only shows the form, and its POST sends the mail.
- **The account made by the confirmation link's GET.** A corporate mail scanner fetches every
  link in a message. A GET that confirmed would confirm an email someone else typed. The link
  shows a form, and the POST confirms: the same split as `/invite`'s `clickedAt` and
  `acceptedAt` (§4).
- **A confirmation that asks for nothing.** A POST behind a bare button still lets a person
  confirm an email they never typed. Say a card holder types someone else's email, by mistake
  or on purpose, and that person, puzzled by the mail, presses Confirm. The typist would then
  hold an AUTHOR account in that person's name, with a password the typist chose. So
  confirming asks again for the password chosen at the scan, which only the typist knows (step
  6).
- **A code matched by its hash alone.** The lookup is by the code's hash, which a rotated key
  doesn't change, so a card would outlive the key it was made with. Reprinting under the new
  key would then make cards that match no row. Every lookup re-derives the code from its row
  and compares ("The code").
- **Trust given through `User.moderationPolicy`.** Its `AUTO` reads like "approve this
  person's comments", but it is the policy for comments *on their posts* (`authorPolicies` in
  `src/lib/moderation.ts`). It would publish everyone else's comments on their posts and still
  queue their own. Raising `approvedCount` to the threshold is wrong too. It counts approvals,
  so an ADMIN raising the threshold later would silently withdraw the trust.
- **A role taken from the request.** A card makes an AUTHOR, a constant in
  `src/lib/join-codes/`. No field in the form names a role.
- **An email lowercased when stored, or compared with its case.** `authorize`
  (`src/lib/auth.ts`) matches the email exactly, so one stored other than as typed can't sign
  in. Store it trimmed, as typed. `User.email`'s unique index compares case, and `/sign-up`
  neither trims nor compares without case (`src/app/actions/sign-up.ts`). So, on its own, the
  index would let `Foo@x.com` beside `foo@x.com` through. `createPasswordAccount` (step 6) trims
  the email and refuses one any account has in any case, inside its transaction. A unique
  index on `lower(email)` backs it ("Build order"). `/sign-up` goes through the same function,
  which is a change to it too. Sign-in and password reset look the email up the same way, by
  `lower(email)`, which the index makes unambiguous ("Build order"). An anonymous identity is
  looked for by the email lowercased, which is how the comment form stores one.
- **A case-insensitive match through Prisma's `mode: "insensitive"`.** It compiles to an
  unescaped `ILIKE`, so `_` and `%` in an email are wildcards: `first_last@x.com` would match
  `firstXlast@x.com`, refuse the wrong person, and log the wrong account. Every comparison here
  that ignores case, of an email or a name, is raw SQL, `lower(email) = lower($1)`, which also
  uses the `lower(email)` index. Raw SQL skips the soft-delete extension (`src/lib/prisma.ts`),
  so a lookup of live accounts says `deleted_by_user_id IS NULL` itself.
- **An anonymous identity adopted.** With an email now proven, attaching the anonymous
  `commenter` row with that email to the new account looks right. Doing so would hand over
  someone's comments and approvals on the strength of an email alone, so the two are kept apart
  and the meeting is logged (step 6).
- **The welcome page shown past the wiki read rule.** Rendered without `readableWikiDocsWhere`
  for its viewer, a `SHARED` page's text goes to every account, a COMMENTER's included, which
  can read no `SHARED` doc. A commons page is never `PRIVATE` (docs/WIKI.md), so that is the
  line the rule draws here. Rendered without `docJsonForPostSide`, a page holding a mention or
  a citation 500s.
- **A card's code carried into a `callbackUrl`.** `SiteHeader`'s "Log in" link builds its
  `callbackUrl` from wherever the reader is, and a card's path holds its code. `/join` is one
  of `NON_DESTINATIONS` (`src/lib/sign-in-redirect.ts`), as `/reset-password` is.
- **`New Account Welcome` not held.** Without it in `HELD_COMMONS_NAMES`, an AUTHOR on any
  commons page's byline could rename that page to it while the name is free, and greet every
  new account with their own text. It is the hole the front page's held name closes.
- **A pending password hash left behind.** A claim's hash sits on its card's row until the
  claim is confirmed or replaced, its fifth wrong password at Confirm ends it, or the card or
  its batch is revoked. Each of those nulls it, in the same statement as the rest of its
  write.

### The code

**Each card's code is derived, not stored.** It is the first 80 bits of
`HMAC-SHA256(K, "<batch id>:<serial>")`, as 16 Crockford base32 characters printed in fours,
`K7Q4-M2XD-9PFA-3HTN`. `K` is derived from `AUTH_SECRET` by HKDF-SHA256, with an empty salt and
the label `multiblog join codes v1`. A unit test pins two derived codes, computed apart from
the code under test, so a change to the derivation fails a test rather than silently voiding
cards already printed. The row keeps the code's SHA-256 under a unique index, so the code can be looked up. **A lookup then
re-derives the code from the row's batch and serial under the current key**, and compares the
two in constant time. A mismatch answers as a card that can no longer be used. So:

- a card can be printed again, or its link sent to someone, from its row and the secret;
- a database dump or a backup holds no working code, unlike `user_invite.token` (§5). Making one
  needs `AUTH_SECRET` as well, and that secret already forges any session. nginx's access log
  is different: it holds the path of every card opened, `/join/<code>`, until it rotates. A
  card is spent at confirmation, so the codes it holds are those of cards opened and never
  confirmed;
- rotating `AUTH_SECRET` voids every unclaimed card, as it already ends every session and access
  token (docs/ENV.md). A claim pending at the rotation can't be confirmed after it either:
  the confirmation checks that the card's stored hash is still the one its batch and serial
  derive. Reprinting refuses a batch whose stored hashes don't match the current key, rather
  than print cards that match no row.

**A code can be typed as easily as scanned.** The card prints `<host>/join` and the code under
the QR, and `/join` takes it typed. Input is normalized as Crockford's alphabet intends: case
ignored, dashes and spaces dropped (the Unicode dashes U+2010 to U+2015 too, which a phone
keyboard may put in), `O` read as `0`, and `I` and `L` read as `1`. Anything that isn't 16
characters of the alphabet after that is refused before a query, `U` included, which Crockford
leaves out. The functions that hash, format or put a code in a URL throw on one that isn't
normalized, since a hash of a dashed code would match no row and fail no check.

**80 bits needs no guessing limit.** At a thousand guesses a second against a batch of a
thousand cards, the first hit is expected after about 4 × 10^10 years.

The code's pure functions are `src/lib/join-codes/code.ts`, and the key under this instance's
secret is `key.ts` beside it; everything that reads or writes a row is `cards.ts`.

**The QR holds `https://<host>/join/<code>`**, without the dashes, at error-correction level M,
always `https`. The encoder puts the host in a byte segment and the code in an alphanumeric
one, which makes it version 3 (29 modules) for a host of up to 16 characters, version 4 (33)
up to 36, and version 5 up to 58. Printed 1.4 inches square with its quiet zone, a module is
under 0.9 mm. The prototype's sheets decoded on every card, rendered by Chromium and rasterized
from the PDF at 150 and 300 dpi. It has not yet been scanned by a phone.

### The data

```prisma
model JoinBatch {
  id          String    @id @default(cuid())
  label       String                                  // the admin's; no card holder sees it
  expiresAt   DateTime  @map("expires_at")
  createdById String    @map("created_by_id")
  createdAt   DateTime  @default(now()) @map("created_at")
  revokedAt   DateTime? @map("revoked_at")

  createdBy User       @relation("JoinBatchCreator", fields: [createdById], references: [id])
  codes     JoinCode[]

  @@map("join_batch")
}

model JoinCode {
  id        String    @id @default(cuid())
  batchId   String    @map("batch_id")
  serial    Int                                       // printed small on the card
  codeHash  String    @unique @map("code_hash")
  revokedAt DateTime? @map("revoked_at")

  // The pending claim: one at a time, replaced by the next.
  pendingEmail        String?   @map("pending_email")
  pendingName         String?   @map("pending_name")
  pendingPasswordHash String?   @map("pending_password_hash")
  pendingIpAddress    String?   @map("pending_ip_address")   // the claim's IP address, for the collision log
  confirmTokenHash    String?   @unique @map("confirm_token_hash")
  confirmSentAt       DateTime? @map("confirm_sent_at")      // the last *delivered* send
  confirmSends        Int       @default(0) @map("confirm_sends")
  confirmFailures     Int       @default(0) @map("confirm_failures") // wrong passwords at Confirm

  claimedAt     DateTime? @map("claimed_at")
  claimedUserId String?   @unique @map("claimed_user_id")

  batch       JoinBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  claimedUser User?     @relation("JoinCodeClaimant", fields: [claimedUserId], references: [id], onDelete: SetNull)

  @@unique([batchId, serial])
  @@map("join_code")
}
```

`commenter` gains `trusted Boolean @default(false)`. A hand-written CHECK
(`join_code_pending_claim_whole`) keeps `pending_email`, `pending_name`,
`pending_password_hash` and `confirm_token_hash` all set or all null, and another
(`join_code_claimed_has_no_claim`) keeps them and `pending_ip_address` null on a claimed card.
`pending_ip_address` can be unknown while a claim is pending, and `confirm_sent_at` is null
until a send is delivered. `user` gains a hand-written unique index on `lower(email)`,
`user_email_lower_key`, in a migration of its own ("Deploying PR 4, everywhere").

**A batch has no role and no trust switch.** Every card makes a trusted AUTHOR. A column for
either comes with the first batch that needs something else.

**One row per card, made at minting.** The admin table lists cards that were never scanned, and
revoking a lost card means stamping its row.

**One pending claim per card, replaced by the next submit.** That is how a holder fixes a
mistyped email: they scan again. It is also how someone who photographed the card could replace
the holder's claim. The first to *confirm* wins, and the serial printed on the card is how an
ADMIN finds the row to revoke before handing over another card.

**Nothing on `user` records the card.** `join_code.claimed_user_id` does, and it is unique.

### The card holder's path

1. **`/join/<code>`** looks the code up and re-derives it ("The code"), and writes nothing. The
   page answers with one of:
   - the form, for a live card: not revoked or claimed, its batch neither revoked nor expired,
     and its sends not used up;
   - "This card has been used", with a sign-in link, for a claimed one;
   - "This card has sent all the email it can. Ask the organizer for another card.", once it
     has five delivered sends. Anyone who saw the card can use those up; the serial is how an
     ADMIN revokes it and hands over another;
   - "This card can no longer be used", for a revoked or expired one, and for a code that
     matches no card or fails re-derivation: its holder can do nothing different about any of
     them.

   A signed-in viewer is told whose session they have and that a card makes a new account, with
   a sign-out button and no form. A card never changes an existing account, so the claim's
   POST refuses a request with a session too, not only the page.

   `/join` takes a code typed. It normalizes it and goes to `/join/<code>`, which looks it up;
   input that isn't a code is refused there, before any query. The `/join` pages are not
   indexed.
2. **The form asks for a name, an email and a password.**
   - **The password** follows `/sign-up`'s rule (8 characters or more).
   - **The name is required**, unlike on `/sign-up`. An AUTHOR's name goes on every byline they
     are credited on. Without one, `uniqueUserSlug` makes their slug from the email's local
     part, which then appears in `/authors/<slug>` and in every mention of them. That slug also
     bars the account from a wiki namespace of its own (docs/WIKI.md, "A person's namespace
     needs a slug that isn't made from their email").
   - **The name is trimmed, 1 to 100 characters, and refused when a live account's name
     matches it** case-insensitively: "An account already goes by this name. Add something
     that tells you apart." A trusted account's comments publish at once under its name, so
     a card must not be able to take an author's name. Names are public on bylines and author
     pages already, so the refusal reveals nothing.
     - **What it protects is the comment card**, which shows `commenter.display_name`, copied
       from the name when the row is made and never after (`src/lib/comment-data.ts`). The
       account can rename itself later in its settings, as any account can; its comments keep
       the name the card was claimed with.
     - **It is a rule for cards alone.** `createPasswordAccount` makes it only when asked, and
       `/sign-up`, where a name is optional, doesn't ask.
     - **Two claims racing for one name can both pass**, since no index backs the rule, and that
       is accepted.
3. **The POST** (`claimJoinCode` in `src/lib/join-codes/`, wrapped by a server action) does
   this, in order:
   - checks the code again from scratch;
   - refuses an email any account has, in any case (raw `lower(email)`, "Mistakes that fail no
     check") and deleted or not: "An account with this
     email already exists, so this card can't make another. Sign in with it, or ask the
     organizer." `/sign-up` already tells anyone that an email is taken, so a card holder
     learns nothing new. The refusal is logged as a `CARD_CLAIM` collision, with the request's
     IP address and the card (docs/COMMENTS.md, "The log");
   - refuses a send within 60 seconds of the card's last delivered one (§3's shape);
   - writes the pending claim with the request's IP address and a fresh confirmation token,
     keeping only the token's hash (`generateToken`, `src/lib/tokens.ts`), and zeroes
     `confirm_failures`;
   - sends the mail.

   **The send is reserved before it is made.** The write that puts the claim on the card also
   stamps `confirm_sent_at` and counts the send, on condition that neither has moved since
   the card was read. So two submits at once can't both pass the 60-second rule or the
   five-send cap: the second matches no row and is told to try again in a minute. A failed
   send then takes the stamp and the count back, on condition that the claim is still this
   one.

   The page answers with the email the mail went to, so a typo shows, and says that scanning
   the card again replaces the claim. **A failed send is reported as failed.** On a provider
   error, a daily cap included ("Mail volume"), `sendMail` returns `{ delivered: false }`. The
   page then says the mail couldn't be sent and to try again shortly. It keeps the claim, and
   takes back the reserved stamp and count, so the retry isn't refused by the 60-second rule.
   A refusal gives the form back its name and email, never its password.
4. **The mail is plain text**, subject `Confirm your email for <SITE_TITLE>`. It holds the link,
   says the link works for seven days, and says that nothing is made if the mail is ignored. It
   carries no welcome text, because its job is the link ("Rejected").
5. **`/join/confirm?token=…`** shows the email, a password field ("the password you chose when
   you scanned the card") and a Confirm button. It changes nothing. A token that matches no
   live claim gets one message saying to scan the card again. That covers a replaced claim, a
   link older than seven days, a used or revoked card, and an expired or revoked batch.
6. **The POST** (`confirmJoinClaim`) first checks the password against the pending hash. A
   wrong one is counted in `confirm_failures` by a write of its own, one statement, and the
   fifth ends the claim, nulling all of it, so the holder scans again. The page says how many
   tries are left. The person who typed the email knows the
   password; a stranger who only received the mail doesn't. Then it does everything else in
   one transaction:
   - It takes the card with a conditional `updateMany` that sets `claimed_at`. The `where`
     matches `confirm_token_hash` to the token's hash, with `claimed_at` and `revoked_at` null,
     `confirm_sent_at` within seven days, and the batch live. A count of 0 is the refusal, and
     it is also what a second click meets.
   - It creates the `User` as an AUTHOR, with `emailVerified` set to now, and with slug, color
     and initials as `/sign-up` makes them. Both go through one function, `createPasswordAccount`
     in `src/lib/accounts.ts`. It makes step 3's email check again inside the transaction, and
     step 2's name check when asked to, as a card is. If an account with the email, in any case, was made after the
     claim, everything rolls back and the page says so. The `lower(email)` index is what holds
     against a concurrent `/sign-up`.
   - It gives the user a trusted `commenter` row of their own, its display name the card's
     name. The row is always new. An anonymous identity with this email keeps its comments
     and approvals.
   - It sets `claimed_user_id`, and nulls the pending claim, its IP address and its token.

   **After the commit, if an anonymous identity has the email, the meeting is logged** as a
   `CARD_CONFIRM` collision, in a try/catch. The claim's IP address and the anonymous identity
   are read inside the transaction. The log is written outside it, because a failed statement
   aborts a Postgres transaction, and the log must change no answer (docs/COMMENTS.md, "The
   log"). The logged row holds the claim's and the confirmation's IP addresses. Making the
   commenter row at confirmation, rather than at the first comment, is what lets the log carry
   the claim's IP address.

   Then the page says the account is ready, and links to sign in with
   `signInPath("/welcome")`.

**Until that POST, there is no account**, so "no access before the email is confirmed" needs no
gate: sign-in finds no row. The cost is that someone who signs in before confirming is told
their email or password is wrong. The page shown after step 3 therefore says plainly that the
account won't exist until the link is used.

### The welcome page

**`/welcome` renders the commons page `New Account Welcome` for any signed-in viewer**, and
gates a signed-out one with `signInPath("/welcome")`. The page sits under a "Welcome, <name>"
heading, with a link to `/dashboard`. It is found the way the front page is
(`src/lib/front-page.ts`): in the commons, with variant `''`, the name matched by its key, and
the body rendered through `docJsonForPostSide` inside `.prose`. The two lookups are one
function that takes a held name, `heldCommonsPageBody`.

**One difference from the front page: which reader the visibility is checked for.** The front
page requires `PUBLIC`, because anyone reads it. The welcome page asks the wiki read rule for
*this viewer* (`readableWikiDocsWhere(viewer)`), so it shows exactly when they could read the
page at its address. `SHARED` reaches every AUTHOR and AUTHORIZED account, and `PUBLIC` reaches
every account, a COMMENTER's included. A commons page is never `PRIVATE`.

- **If no page answers, it shows a sentence and the dashboard link**, not an error. That covers
  a page with no `prose_json` yet, which is skipped as the front page skips it, rather than
  decoded from its ydoc. The minting script and the batch form warn, before anything is
  printed, when no commons page of that name is readable by an AUTHOR.
- **`/dashboard` links to it**, as "Welcome", for every account. Someone who confirms on one
  device and signs in later on another lands on `/dashboard`, not `/welcome`.
- **`New Account Welcome` joins `HELD_COMMONS_NAMES`**, typed as `FRONT_PAGE_NAME` is.
- **It is dynamic**, since it reads the session. It sets no flag and remembers no visit. A first
  sign-in lands there because the confirmation page's link says to, and the page stays at its
  address for anyone to come back to.

### Trusted commenters

**`commenter.trusted`, beside `force_moderate`, publishes a comment the way reaching
`trust_threshold` does.** `resolveCommentStatus` is: an ADMIN publishes; otherwise
`forceModerate` queues; otherwise `trusted`, or `approvedCount >= trustThreshold`, publishes;
otherwise the cascade decides. So `force_moderate` still overrides it, and an ADMIN can rein in
one account without touching its batch. The spam check still runs. A signed-in commenter's row
is found by its user and never rewritten (`findOrCreateSignedInCommenter`), so a row made
trusted at confirmation stays trusted.

**Trust stands on the identity fix** (docs/COMMENTS.md, "Identities kept apart"): before it, a
signed-out comment that gave a trusted commenter's email was posted as that commenter, and
published at once.

No UI sets `trusted`, just as none sets `force_moderate`. A `/users` column for both is
deferred.

### Minting and printing

**`mintJoinBatch(actor, { label, count, expiresAt })`** in `src/lib/join-codes/cards.ts` takes
an ADMIN only, a label of 1 to 200 characters, at most 500 cards, and a required `expiresAt` in
the future. It writes the batch and its rows in one transaction. `liveCardsForPrinting`,
`revokeJoinCards` and `revokeJoinCard` (one card by its row's id) beside it take an ADMIN too.
**Each asks the actor's role and then its account row's**, since a session can be five minutes
behind its account (`src/app/sign-in/NOTES.md`): a demoted ADMIN's open tab mints, prints and
revokes nothing, as `requireCanMakePublic` refuses it a raise to `PUBLIC`. The rule is in the
library, so it binds the table, the print route and the script alike.

**The card sheet is one function returning a whole HTML document**, for plain paper cut by
hand. It lays out ten cards to a US Letter page, two by five, 3.5 inches wide, with no cut lines
drawn, set apart so every cut has room on both sides. Each card's text sits 0.18 inches inside
its edge, and a card is twice that, 0.36 inches, above the next. Across the page, the gap
between the two columns is twice the side margin, so the white space between them is twice
what is at either edge, measured from the cards' edges or from their ink alike: three eighths
of an inch each side and three quarters between. Top and bottom, a quarter inch. A card's
height is what the page has left, about 1.81 inches, which still holds the
1.4-inch QR. **The text beside the QR spans the symbol's height**: it is inset by the QR's quiet
zone (`qrQuietInsetIn`, one figure per sheet, since every card's QR is one version), and CSS
`text-box` trims its leading, so the welcome's tallest letters meet the symbol's top edge and the
code's baseline its bottom (a browser without `text-box`, Firefox as of this writing, prints
them a point or two inside). With an extra line of two lines or more, the text runs past the
bottom. Each card has:

- "Welcome to `<host>`!", the host whole on a line of its own, its subdomain included (as
  `APP_URL` names it, or the script's `--host`); a host too long for the column breaks after
  a dot;
- "Use this code to create an account and try it out." (`CARD_INVITATION`);
- an optional line of text given at printing;
- the QR, as inline SVG;
- `<host>/join`;
- the code;
- its serial, in small type, below the text at the card's right, 0.09 inches above the cut.

It prints a batch's live cards, and refuses a batch whose hashes don't match the current key
("The code"). Drawing the QR takes a new dependency, a QR encoder (`qrcode`, with about 25
packages under it, most of them its command-line tool's). The server and the script use it; no
client bundle does. The sheet lives in `src/`, under STYLE.md's guard against color literals.
`qrcode`'s own SVG writes a white fill and a stroke color, so the sheet draws one `<path>` from
the encoder's module grid instead. That path has SVG's default fill, black on the paper's white,
and the quiet zone sits inside the SVG's box, so no card padding can eat it. The code is printed
on one line, in 9.5-point bold monospace, which leaves a little room in its column; anything
larger splits it over two lines.

**Minting is a script, or the admin table:**

- `scripts/join-codes/mint.ts` mints a batch on behalf of a named ADMIN (`--admin <email>`),
  and writes the sheet to a directory outside the tree, `~/join-cards` unless `--out` says
  otherwise; it refuses one inside it, and writes the file readable by its owner alone. The
  sheet holds live codes, so it is deleted once the cards are printed. `--print <batch>`
  writes it again for the live cards, `--revoke <batch>[:<serial>]` revokes a batch or one
  card, and `--list` lists the batches. `--expires` takes a date, read as the end of that
  day, UTC, or a date-time; `--host` defaults to `APP_URL`'s. It warns before printing when
  no `New Account Welcome` page is `SHARED` or `PUBLIC`. Its header has the usage.
  `scripts/join-codes/demo-sheet.ts` draws a sheet of fake cards under a fake secret, with no
  database, for looking at the layout. `--expires` and the table's mint form read a date
  through one parser, `parseJoinExpiry` (`src/lib/join-codes/expiry.ts`).
- **`/join-codes`** is an admin table through the kit (`src/lib/join-codes-query.ts`), one
  row per card, ADMIN-only and gated with `signInPath`; `/dashboard` links to it
  (docs/DASHBOARD.md, "Join cards"). Its columns are the batch's label, the card's number,
  its status, a pending claim's email, and who claimed it and when; the sends, the last
  delivered send, the batch's expiry and when it was minted are hidden by default. The newest
  batch comes first, its cards in number order.
  - **Status** is the `join_code_listing` view, keyed 1:1 on `join_code.id` (CLAUDE.md,
    "Admin tables are one kit"): `unclaimed`, `pending`, `sends-used`, `claimed`, `expired`
    or `revoked`, in the order `stateOf` decides what `/join/<code>` shows, with a live card
    split by whether a claim waits on it. It sorts in that order, and filters by `?status=`.
    The view writes the five-sends limit as a number, beside `MAX_CONFIRM_SENDS`, and
    compares expiry with `now() AT TIME ZONE 'UTC'`, since the column holds UTC without a
    zone.
  - **`?batch=<id>`** narrows the table to one batch, picked from a list of every batch
    with its claimed count and "expired, not revoked" or "revoked" beside it. A batch picked
    shows its facts, its sheet and Revoke batch, which asks first. Minting from the form
    (label, number of cards, and a date, read as the end of that day, UTC) picks the new
    batch. The action answers with the batch's id and nothing else: no code reaches the
    browser but in the sheet.
  - **Revoke** is a row's button, or a selection's in bulk, on any card neither claimed nor
    revoked, an expired one included, since revoking it drops its claim.
  - **The sheet is at `/join-codes/print?batch=…`**, with `&line=…` for an extra line on every
    card, under its invitation (at most 120 characters), opened in a tab of its own. It is a
    Route Handler returning the document, its host `APP_URL`'s. A page's gate doesn't cover a
    Route Handler, so it asks for an ADMIN itself, through `liveCardsForPrinting`; signed out,
    it sends the viewer to sign in and back. It writes nothing, and sends `Cache-Control: no-store`,
    `Referrer-Policy: no-referrer` and a CSP that allows its own inline style and nothing
    else, since the document holds live codes.
  - There is no MCP tool for any of it.

**Revoking nulls any pending claim; expiry doesn't.** An expired batch's pending password hashes
stay until the batch is revoked, so revoking a batch once its event is over is the clean-up.
`--list` says "expired, not revoked" beside such a batch, as do the table's batch list, its
batch's facts and the dashboard's line. A claimed
card is left as it is by a revoke: its account is managed on `/users`.

### Mail volume

**Each account made from a card costs at least one mail.** Password resets go through the same
Resend account. Resend's free plan stops at
[100 a day](https://resend.com/docs/knowledge-base/account-quotas-and-limits). A day with more
claims than that, which a conference can be, needs a paid plan for the month. Otherwise the
claim page gets `{ delivered: false }` for the rest of that day. Instances that share one Resend
account share its cap.

**Resend also limits requests per second**, per team
([its rate limit](https://resend.com/docs/api-reference/rate-limit)), and `sendMail` doesn't
retry. So a room told to scan at once will see some sends fail. The claim page's "try again
shortly" is the answer, and a failed send costs the card nothing (step 3).

### Rejected

- **One code for the whole event**, on a slide or a poster. Whoever sees it can make AUTHOR
  accounts, as many as they like, for as long as it lives. A card each bounds that to what was
  printed, and a lost card is revoked alone.
- **A random code kept only as a hash**, as `password_reset_token` keeps one, reprinted from a
  file written at minting. That file is then a store of live codes that has to be kept, where a
  derived code's sheet can be deleted once printed and written again from the database. The
  print route needs the derivation too.
- **Recording when a card is first opened.** It would be a write on every GET, a reader app's
  prefetch included, for one column in the admin table.
- **A raw code at rest**, as `user_invite.token` keeps one (§5). A backup would then hold codes
  that make AUTHOR accounts.
- **Making the account at the submit, unconfirmed, and refusing its sign-in.** That is a gate in
  `authorize` to keep in step. Worse, a mistyped email would hold an unconfirmed account in a
  stranger's name, and the email's owner then couldn't sign up.
- **The password asked for only at Confirm**, with the scan taking a name and an email. That
  would keep no hash at rest. But the holder would leave the event with nothing chosen, and
  the password asked for again at Confirm closes the same hole.
- **The welcome text in the mail.** Rendering a doc for mail would need a renderer no mail has
  today, a longer message is more likely to be filtered, and the mail has one job: its link.
- **Signing in by the confirming click.** The confirmation form now holds the password, so the
  client `signIn` the sign-in form uses could do it. That would be a second copy of the sign-in
  form's stale-session handling (`src/app/sign-in/NOTES.md`), to save one step.
- **Adopting an anonymous identity with the confirmed email.** A proven email shows that the
  person reads that inbox, not that they wrote what was posted under it, so the identity's
  comments and approvals stay where they are. The collision log puts both sides' IP addresses
  in front of an ADMIN, who can merge them by hand.
- **A card that raises an existing account's role, or trusts it.** It would be a third action
  at `/join/<code>`, and it would meet the session's lag: a raised role reaches a session
  already signed in within five minutes, or at a visit to `/dashboard`
  (`src/app/sign-in/NOTES.md`). An ADMIN raises a role on `/users`.
- **A batch role or a trust switch**, before any batch needs one ("The data").

### Build order

**PR 1: a session that reads its account again every five minutes**
(`src/app/sign-in/NOTES.md`, "The session is a JWT, and reads its account again every five
minutes"), **and making a wiki page `PUBLIC` an editor's** (docs/WIKI.md, "Permissions"). Built
2026-11-18. It deploys to every instance on its own, with no migration and nothing to convert:
a session signed in before it is read again at its first request, and a page that is `PUBLIC`
stays `PUBLIC`.

**PR 2: commenter identities kept apart, and the collision log** (docs/COMMENTS.md,
"Identities kept apart, and a log of where they meet"), with `/email-collisions`. Built
2026-11-18. It deploys to every instance on its own, with a migration, a script to run once,
and a change to the web unit's `ExecStart` (that section's "Deploying").

**PR 3: publishing a post made an EDITOR's** (PLAN.md §38), with a Status filter on `/posts`.
`RAISED` annotations stop sending mail in the same PR (docs/ANNOTATIONS.md, "Raising sends no
mail"). Built 2026-11-18. It deploys everywhere on its own, with no migration, after listing
who has been publishing as an AUTHOR (PLAN.md §38, "Deploying").

**PR 4: everything a card holder meets, with minting by script.** Built 2026-11-18. Checking
its plan against the code found what the sections above now say: the send reserved before it
is made; the claim's POST refusing a session; a pending claim refused after a rotated secret;
`/join` kept out of a `callbackUrl`; the welcome page's read rule drawn between `SHARED` and a
COMMENTER, since a commons page is never `PRIVATE`; and the bots' email checks, which compared
case (below). It was:

1. The migrations:
   - `join_batch` and `join_code`, with their CHECKs, and `commenter.trusted`;
   - the unique index on `lower(user.email)`, in a migration of its own, so that a duplicate
     fails it alone ("Deploying PR 4, everywhere");
   - the collision log's card columns, `join_code_id` (with `onDelete: SetNull`, since deleting a
     batch deletes its cards) and `claim_ip_address`;
   - `CARD_CLAIM` and `CARD_CONFIRM`, added to the log's enum in a migration of their own.

   Then `npm run check:schema`.
2. `src/lib/join-codes/`: the code's pure functions and the sheet (`code.ts`, `sheet.ts`, as
   the prototype has them), and lookup with re-derivation, `mintJoinBatch`, `claimJoinCode`
   and `confirmJoinClaim` beside them. `src/lib/accounts.ts`'s
   `createPasswordAccount`, with `/sign-up` moved onto it, so `/sign-up` trims and refuses an
   email in another case. Sign-in (`authorize`, `src/lib/auth.ts`) and password reset
   (`requestPasswordReset`, `src/app/actions/forgot-password.ts`) find the account by raw
   `lower(email) = lower($1)` among live accounts, so an email typed in any case signs in and
   resets. Reset stays as enumeration-safe as it is. The other writers of `user.email` are the
   bots (`createBot`, and `ensureAgentBot` at Approve), whose address checks compare without
   case through `anyAccountIdWithEmail`, as the index does; no UI makes a person's account
   besides `/sign-up` and a card. `/sign-up` trims its name too.
3. `trusted` in `resolveCommentStatus`.
4. `/join`, `/join/[code]`, `/join/confirm`, and the mail.
5. `New Account Welcome` held, the lookup shared with the front page, `/welcome`, and its link
   on `/dashboard`.
6. The sheet and the QR dependency, and `scripts/join-codes/mint.ts`.
7. `/email-collisions` taught the card sources: Card (its batch's label and serial) and Claim IP
   columns. Both are the row's own or a to-one relation, so they sort through Prisma and the
   view is unchanged.
8. The tests below, and the docs:
   - this section rewritten as built;
   - docs/COMMENTS.md's resolution order and the log's card sources;
   - docs/WIKI.md's held names, and PERMISSIONS.md;
   - `src/app/sign-in/NOTES.md` and §7, for who writes `emailVerified`, for `/sign-up`'s new
     email handling, and for sign-in and reset ignoring case;
   - docs/ENV.md's `AUTH_SECRET` row, and docs/DASHBOARD.md for the Welcome link;
   - docs/TEST_DATA.md and e2e/README.md, for the mint script and the spec's fixture;
   - CLAUDE.md's row for this file, and PLAN.md §37.

**PR 5: `/join-codes`**, meaning the table, revoking, the mint form and the print route, with
their PERMISSIONS.md rows, the dashboard's line (docs/DASHBOARD.md), and the table and its view
in CLAUDE.md's admin-table invariant. Built 2026-11-18. A PR of its own so that PR 4 can be used
at an event without it. Checking its plan against the code found what "Minting and printing"
now says: the ADMIN gate asked of the account row as well as the session, in the library; the
view's clock in UTC; a revoke by the card's id, which the script never needed; one expiry
parser for the script and the form; and the way in, which is the dashboard's line beside Email
collisions, since the header has no admin menu. It deploys with one migration, the view, and
nothing to run.

### Testing

- **Unit tests** (`npm run test:unit`), where the point is what is refused:
  - the derivation: stable for one secret, batch and serial, and different when any of them
    changes; a code from one key fails re-derivation under another; two codes pinned to values
    computed apart (`src/lib/join-codes/code.test.ts`);
  - the normalization table: case, dashes (Unicode ones too), spaces, `O`/`I`/`L`, `U`, wrong
    lengths, and characters outside the alphabet;
  - the sheet: ten cards to a page, and no color property in what it writes (`sheet.test.ts`);
  - `resolveCommentStatus`'s table, with `trusted`, and `forceModerate` above it
    (`src/lib/moderation.test.ts`);
  - an email trimmed and its case kept (`src/lib/account-email.test.ts`).
- **`e2e/join-codes.spec.ts`**, run in fresh contexts with no session, and reading no mail:
  every address is `@example.com` (§2). The fixture mints a batch in the database through the
  derivation, so lookups re-derive as they will in use. It then sets a claim's token hash to one
  it knows, as `invite.spec.ts` mints its invite.
  1. **A card through to a comment.** Open `/join/<code>` and submit, then see the pending claim
     in the database. Open the confirmation link and assert that the GET made no account. Enter
     the password and click Confirm, then sign in with it. Land on `/welcome` and see the
     fixture's commons page. Comment on a post under an `ALWAYS` policy, and see the comment
     published.
  2. **The refusals:**
     - a used card, a revoked one, an expired batch, a link older than seven days, and a second
       Confirm;
     - an email an account already has, in another case, which logs one `CARD_CLAIM` row;
     - an email with a `_`, beside an account whose email differs at that character, which is
       *not* refused (the `ILIKE` trap);
     - a name an account already has;
     - a wrong password at Confirm, and the fifth wrong one ending the claim;
     - a sixth send, once five are delivered;
     - a signed-in viewer at `/join/<code>`, who gets no form.
  3. **A replaced claim:** submit twice, with two emails, and the first claim's link is refused.
     The fixture back-dates `confirm_sent_at` between the two, since a send to `@example.com`
     counts as delivered and the second submit would otherwise meet the 60-second rule.
  4. **An anonymous identity with the email.** Confirm a card whose email a fixture's anonymous
     comments hold. The account gets a commenter row of its own, the anonymous comments stay on
     the anonymous identity, and one `CARD_CONFIRM` row is logged holding the claim's IP
     address.
  5. **The welcome page's rules:** `/welcome` shows a `SHARED` page of the held name to an
     AUTHOR and withholds it from a COMMENTER, shows it to both once `PUBLIC`, and an AUTHOR on
     a commons page's byline can't rename it to the held name. The test is skipped on an
     instance with its own page, which it won't change.
  6. **`/join-codes`**, as an ADMIN: mint a batch from the form and see its cards listed;
     print its sheet and read each card's code from it; revoke one card from its row, see its
     `/join/<code>` refuse it and the sheet leave it out; revoke another by selection; revoke
     the batch, and see a pending claim's columns nulled and the sheet refused. The status
     column agrees with what `/join/<code>` shows for each state, and filters by it. An EDITOR
     is refused the page and the sheet, and a signed-out viewer is sent to sign in from both.
- **Emails ignore case**, in the same file: `/sign-up` stores an email trimmed and refuses it
  in another case, a reset requested in another case makes the account's token, and the
  account signs in with its email in another case. No spec covered `/sign-up` before.
- **The welcome fixture** (`ensureTestWelcomePage`) uses the instance's `New Account Welcome`
  page if there is one, and otherwise makes and deletes its own, since the name is unique.
- **By hand, once, with a real key:** run one card, with one real address, from a phone, before a
  batch is printed.

### Deploying PR 4, everywhere

PR 4's code and migrations reach every instance, cards or not. Before `prisma migrate deploy`,
check that no two accounts have one email in different cases, since the `lower(email)` index
would refuse to build:

```sql
SELECT lower(email), count(*) FROM "user" GROUP BY lower(email) HAVING count(*) > 1;
```

When it finds any, an ADMIN decides which account keeps the email, and gives the other a
different one, or deletes it outright if it is unused. A soft delete keeps the email. If the
migration has already failed, its row has to be marked rolled back before the next deploy
(docs/DATABASE.md).

### Before printing cards for an instance

1. PRs 1 to 3 are on the instance, with their own steps done: the `EXISTING` collisions logged
   (docs/COMMENTS.md, "Deploying"), and its publishing AUTHORs listed and decided on (PLAN.md
   §38).
2. The wiki is on the instance (docs/WIKI.md, "Before the wiki reaches an instance").
3. Mail is real there: `RESEND_API_KEY`, `MAIL_FROM` and §9's DNS records, on a plan with room
   for the event's busiest day.
4. The commons page `New Account Welcome` exists, made by an ADMIN or EDITOR, and is `SHARED` or
   `PUBLIC`.
5. Someone has looked over the docs and files the instance keeps `SHARED`, knowing that every
   card makes a reader of them ("What an AUTHOR from a card can do").
6. Mint with an expiry well past the event, since a claim confirmed after it is refused. Print
   one card and run it end to end, then print the rest, and delete the sheet.
7. Revoke the batch once the event is over.
