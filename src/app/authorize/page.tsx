import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  authorizationResponseUrl,
  authorizeParamsOf,
  clientIdHost,
  clientIdOf,
  isLoopbackRedirect,
  parseAuthorizeRequest,
  searchParamsOf,
} from "@/lib/oauth/authorize-request";
import { signOut } from "@/lib/auth";
import { findClient } from "@/lib/oauth/clients";
import LocalTime from "@/components/LocalTime";
import { AGENTS } from "@/lib/bot-rules";
import { botsFor, connectedBots, signedInPerson, type Bot, type Person, type RefusedBot } from "@/lib/oauth/consent";
import { consentOffer } from "@/lib/oauth/consent-offer";
import { issuer, mcpEndpointUrl } from "@/lib/oauth/discovery";
import { signInPath } from "@/lib/sign-in-redirect";
import { SITE_TITLE } from "@/lib/site-config";
import account from "@/styles/account.module.css";
import styles from "./page.module.css";

// docs/MCP.md §21, "The consent page" — OAuth's authorization endpoint, as a
// page rather than a route under /api/, because sign-in returns only to a
// page. It checks, in this order:
//
// 1. the client and its redirect URI, answered here and never redirected, or
//    this would be an open redirector;
// 2. the session: a signed-out visitor goes to sign in and comes back, before
//    any refusal that redirects (OAuth 2.1 §7.12.2), so a malformed request
//    can't send a visitor to a client's redirect URI unseen;
// 3. the rest of the request, each refusal redirected to the client.
//
// Then it asks. **For a client that is an AI agent's** ("Which agent a client
// is"), the person's bot for that agent is listed first, and so chosen; with
// none, an AUTHOR or above is offered a new one first, which Approve makes;
// and a bot that is another agent's has a line saying whose name it signs
// (`consentOffer`). A line per bot, not one that follows the select, which
// would need JavaScript.
//
// Every request asks: no consent is remembered, so a flow
// someone else started can't finish without the person seeing what it
// grants. The decision posts to /authorize/decide, which parses everything
// again. next.config.ts keeps the page from being framed, and SiteHeader
// renders nothing here, since every link off the page abandons the flow.
//
// Plain forms, so it works without JavaScript.

export const metadata: Metadata = { title: "Connect an app", robots: { index: false } };

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParamsOf(await searchParams);
  const clientId = clientIdOf(params);
  const client = clientId ? await findClient(clientId) : null;
  const parsed = parseAuthorizeRequest(params, client, mcpEndpointUrl());
  if (parsed.kind === "page-error") return <Refused message={parsed.message} />;

  const here = `/authorize?${params.toString()}`;
  const person = await signedInPerson();
  if (!person) redirect(signInPath(here));

  if (parsed.kind === "redirect-error") {
    redirect(
      authorizationResponseUrl(parsed.redirectUri, issuer(), {
        error: parsed.error,
        error_description: parsed.description,
        state: parsed.state,
      }),
    );
  }

  const { request } = parsed;
  const bots = await botsFor(person);
  const connected = await connectedBots(request.client, person.id, bots.offered.map((bot) => bot.id));
  const name = request.client.name;
  const host = new URL(request.redirectUri).host;
  const agent = request.client.agent;
  const offer = consentOffer(person, agent, bots.offered, bots.refused);
  // Nothing is offered to a person whose connections are turned off, whatever
  // bots they have: §3's check refuses every token they would issue.
  const canApprove = person.mcpAllowed && (offer.bots.length > 0 || offer.newBot !== null);
  const publisher = clientIdHost(request.client.clientId);

  // Signs out and back in, to this same request. A server action, so it
  // works without JavaScript; the request is closed over, which Next signs.
  async function switchAccount() {
    "use server";
    await signOut({ redirectTo: signInPath(here) });
  }

  return (
    <main className={styles.main}>
      <div className={account.card}>
        <h1>Connect {name}</h1>
        <p className={styles.lead}>
          {name} is asking to connect to {SITE_TITLE}.
          {publisher && (
            <>
              {" "}
              Its identity is published by <strong>{publisher}</strong>.
            </>
          )}{" "}
          If you approve, the connection goes to <strong>{host}</strong>.
        </p>
        {isLoopbackRedirect(request.redirectUri) && (
          <p className={styles.warning}>
            {host} is a program on your own computer, not a website, and any program running there could be the one
            asking. Approve only if you started this from {name} yourself.
          </p>
        )}
        <p className={styles.warning}>
          Approve only a connection you have just started yourself. If someone else sent you here, approving would
          connect their {name} to your account.
        </p>
        <form action={switchAccount} className={styles.who}>
          Signed in as <strong>{person.name ?? person.email}</strong>
          {person.name && <> ({person.email})</>}.{" "}
          <button type="submit" className={styles.linkButton}>
            Sign in as someone else
          </button>
        </form>
        <form method="post" action="/authorize/decide" className={account.form}>
          {authorizeParamsOf(params).map(([field, value], i) => (
            <input key={`${field}-${i}`} type="hidden" name={field} value={value} />
          ))}
          {canApprove ? (
            <>
              <RefusedBots refused={bots.refused} held={offer.held} client={name} />
              <label className={account.field}>
                Connect as
                {/* The first option is the one chosen: the new bot, or the person's bot for the client's agent. */}
                <select name="bot" className={styles.select}>
                  {offer.newBot !== null && <option value="new">{offer.newBot}, a new bot</option>}
                  {offer.bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {botName(bot)}
                    </option>
                  ))}
                </select>
              </label>
              {offer.newBot !== null && (
                <p className={styles.replaces}>
                  Approving as {offer.newBot}, a new bot, makes a bot called {offer.newBot}: an AUTHOR that works for
                  you. Like every AUTHOR it reads each SHARED doc and file from the start, and a PRIVATE one only once
                  it is put on that doc&rsquo;s or file&rsquo;s list.
                </p>
              )}
              {agent !== null &&
                offer.otherAgents.map((bot) => (
                  <p key={bot.id} className={styles.replaces}>
                    {botName(bot)} is a bot for {AGENTS[bot.agent!].name}, not {AGENTS[agent].name}: what{" "}
                    {AGENTS[agent].name} writes as it is signed {botName(bot)}.
                  </p>
                ))}
              {offer.bots
                .filter((bot) => connected.has(bot.id))
                .map((bot) => (
                  <p key={bot.id} className={styles.replaces}>
                    {botName(bot)} already has a connection to {host}, made <LocalTime value={connected.get(bot.id)} />.
                    Approving as {botName(bot)} replaces it, and that one stops working.
                  </p>
                ))}
              <fieldset className={styles.scopes}>
                <legend>It may</legend>
                <label>
                  <input type="checkbox" checked disabled /> read: search, read and download what that bot can read
                </label>
                {request.scopesAsked.includes("WRITE") && (
                  <label>
                    <input type="checkbox" name="write" value="1" /> write: create docs, upload files, edit the text of
                    docs, and add notes, links and tags
                  </label>
                )}
              </fieldset>
              <div className={styles.can}>
                <h2>What the connection can do</h2>
                <ul>
                  <li>
                    It acts as the bot, never as you. It reads only what the bot can read, not everything you can, and
                    whatever it writes carries the bot&rsquo;s name.
                  </li>
                  <li>It can&rsquo;t change who may read or edit anything, or delete a doc, file, note or link.</li>
                  <li>
                    It lasts until it goes 90 days unused, or until you revoke it under Connections on your dashboard.
                  </li>
                </ul>
              </div>
            </>
          ) : (
            <NoBot person={person} refused={bots.refused} held={offer.held} client={name} />
          )}
          <div className={styles.buttons}>
            {canApprove && (
              <button type="submit" name="decision" value="approve" className={account.button}>
                Approve
              </button>
            )}
            <button type="submit" name="decision" value="cancel" className={account.button}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

function botName(bot: Bot): string {
  return bot.name ?? bot.slug;
}

/**
 * The bots that work for the person and can't be offered, each group with
 * its reason: above the list when their other bots are offered, and in the
 * list's place when none are. `held` is the one among them that is the
 * client's agent's, which is why the list offers no new bot: a person has one
 * live bot per agent, and a second would hide the first.
 */
function RefusedBots({ refused, held, client }: { refused: RefusedBot[]; held: RefusedBot | null; client: string }) {
  const outranking = refused.filter((bot) => bot.reason === "outranks");
  const off = refused.filter((bot) => bot.reason === "account-off");
  return (
    <>
      {outranking.length > 0 && (
        <p className={styles.noBot}>
          {outranking.map(botName).join(", ")} {outranking.length === 1 ? "works" : "work"}{" "}
          for you, but a bot can&rsquo;t outrank its person, and {outranking.length === 1 ? "its role is" : "their roles are"} above
          yours. An ADMIN can lower {outranking.length === 1 ? "its role" : "theirs"} or raise yours, after which you start the connection
          again from {client}.
        </p>
      )}
      {off.length > 0 && (
        <p className={styles.noBot}>
          {off.map(botName).join(", ")} {off.length === 1 ? "works" : "work"}{" "}
          for you, but an ADMIN has turned connections off for {off.length === 1 ? "it" : "them"}. An ADMIN can turn them on again, after
          which you start the connection again from {client}.
        </p>
      )}
      {held && held.agent && (
        <p className={styles.noBot}>
          {botName(held)} is your bot for {AGENTS[held.agent].name}, which is what {client} connects as, so no new
          one is offered in its place.
        </p>
      )}
    </>
  );
}

/**
 * Why there is nothing to connect as: connections turned off for the person,
 * a COMMENTER, bots §3's check refuses, or no bot at all.
 */
function NoBot({ person, refused, held, client }: { person: Person; refused: RefusedBot[]; held: RefusedBot | null; client: string }) {
  if (!person.mcpAllowed) {
    return (
      <p className={styles.noBot}>
        An ADMIN has turned connections off for your account, so {client} can&rsquo;t be connected to it or to a bot
        that works for you.
      </p>
    );
  }
  if (person.role === "COMMENTER") {
    return (
      <p className={styles.noBot}>
        A connection acts as a bot that works for you, and a COMMENTER can&rsquo;t have one, so there is nothing to
        connect {client} to.
      </p>
    );
  }
  if (refused.length > 0) return <RefusedBots refused={refused} held={held} client={client} />;
  return (
    <p className={styles.noBot}>
      A connection acts as a bot, an account of its own that works for you, so that what {client}{" "}
      writes carries the bot&rsquo;s name and not yours. No bot works for you yet.{" "}
      {person.role === "ADMIN" ? (
        <>
          You can make one on <Link href="/users">Users</Link>, then start the connection again from {client}.
        </>
      ) : (
        <>An ADMIN can make one, after which you start the connection again from {client}.</>
      )}
    </p>
  );
}

/** A request answered on the page: an unknown client, or a redirect URI it didn't register. */
function Refused({ message }: { message: string }) {
  return (
    <main className={styles.main}>
      <div className={account.card}>
        <h1>This connection can&rsquo;t be made</h1>
        <p className={account.error}>{message}</p>
        <p className={styles.lead}>Start it again from the app that asked for it.</p>
      </div>
    </main>
  );
}
