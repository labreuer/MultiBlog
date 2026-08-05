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
plus (new) written by `acceptInvite`.

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
| `RESEND_API_KEY` or `MAIL_FROM` unset | log in the original format | `{ delivered: true }` |
| `to` matches `/@(example\.com\|sample\.invalid)$/i` | log, annotated `(not delivered: reserved domain)` | `{ delivered: true }` |
| otherwise | `POST https://api.resend.com/emails` via `fetch` | `{delivered:true}` / `{delivered:false, error}` |

The logged form degrades gracefully for a `template` call too — there's no `text` to print,
so the log line shows the template id and its variables as JSON instead. Every caller's
success branch is still exercised without a provider or a template ever being configured.

Three properties are load-bearing:

- **The reserved-domain refusal is unconditional, in every environment — not an env
  flag.** `e2e/naming.ts`'s `SAFE_EMAIL` guarantees the suite only ever creates
  `@example.com` addresses, and `scripts/seed-sample-data.ts` uses `@sample.invalid`.
  Without this check, the day a live key lands in a dev `.env`, `npm run e2e` becomes a
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

**One sender identity.** `MAIL_FROM` serves both the auth flows and the RAISED-annotation
notifier (`src/app/actions/annotations.ts`) — their subject lines already carry the
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
  into the session JWT** — it's set once at sign-in (`src/app/sign-in/NOTES.md`), so a
  user who verifies mid-session would keep seeing a stale "please verify" notice.
- `/verify-email` stamps via an idempotent `updateMany` (`emailVerified: null` in the
  `where`), the same idempotency shape `/invite`'s click-stamping already uses.
- A 60-second resend cooldown off the newest token's `createdAt`, the same shape as §3.
- **It will still gate nothing.** That decision was made deliberately for this pass and
  applies to the deferred one too: every existing `User` row has `emailVerified = NULL`,
  since nothing has ever written to it, so gating sign-in on it would lock out every
  account that already exists, including whichever admin is reading this. That needs an
  explicit backfill migration and explicit sign-off before it's even a live option — not
  something to arrive at by accretion.
- **One write path already exists going into this deferred work.** `acceptInvite`
  (built in this pass) stamps `emailVerified` on acceptance — clicking a link delivered to
  an inbox is exactly what the column claims to mean, so an accepted invite already makes
  it truthful for that user. The verification pass adds the remaining paths (sign-up,
  on-demand, `/verify-email` itself); it doesn't need to invent this one.

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
