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
import { botsFor, connectedBots, signedInPerson, type Bot, type Person } from "@/lib/oauth/consent";
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
// Then it asks. Every request asks: no consent is remembered, so a flow
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
          {bots.offered.length > 0 ? (
            <>
              <label className={account.field}>
                Connect as
                <select name="bot" className={styles.select}>
                  {bots.offered.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {botName(bot)}
                    </option>
                  ))}
                </select>
              </label>
              {bots.offered
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
                  <li>It lasts until it goes 90 days unused.</li>
                </ul>
              </div>
            </>
          ) : (
            <NoBot person={person} refused={bots.refused} client={name} />
          )}
          <div className={styles.buttons}>
            {bots.offered.length > 0 && (
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

/** Why there is nothing to connect as: a COMMENTER, bots that outrank the person, or no bot at all. */
function NoBot({ person, refused, client }: { person: Person; refused: Bot[]; client: string }) {
  if (person.role === "COMMENTER") {
    return (
      <p className={styles.noBot}>
        A connection acts as a bot that works for you, and a COMMENTER can&rsquo;t have one, so there is nothing to
        connect {client} to.
      </p>
    );
  }
  if (refused.length > 0) {
    const one = refused.length === 1;
    return (
      <p className={styles.noBot}>
        {refused.map(botName).join(", ")} {one ? "works" : "work"}{" "}
        for you, but a bot can&rsquo;t outrank its person, and {one ? "its role is" : "their roles are"} above
        yours. An ADMIN can lower {one ? "its role" : "theirs"} or raise yours, after which you start the connection
        again from {client}.
      </p>
    );
  }
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
