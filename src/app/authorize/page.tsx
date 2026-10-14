import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  authorizationResponseUrl,
  authorizeParamsOf,
  clientIdOf,
  parseAuthorizeRequest,
  searchParamsOf,
} from "@/lib/oauth/authorize-request";
import { findClient } from "@/lib/oauth/clients";
import { botsFor, signedInPerson } from "@/lib/oauth/consent";
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
// again. next.config.ts keeps the page from being framed.
//
// A plain form, so it works without JavaScript.

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

  const person = await signedInPerson();
  if (!person) redirect(signInPath(`/authorize?${params.toString()}`));

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
  const bots = await botsFor(person.id);
  const name = request.client.name;
  return (
    <main className={styles.main}>
      <div className={account.card}>
        <h1>Connect {name}</h1>
        <p className={styles.lead}>
          {name} is asking to connect to {SITE_TITLE}. If you approve, the connection goes to{" "}
          <strong>{new URL(request.redirectUri).host}</strong>.
        </p>
        <p className={styles.warning}>
          Approve only a connection you have just started yourself. If someone else sent you here, approving would
          connect their {name} to your account.
        </p>
        <form method="post" action="/authorize/decide" className={account.form}>
          {authorizeParamsOf(params).map(([field, value], i) => (
            <input key={`${field}-${i}`} type="hidden" name={field} value={value} />
          ))}
          {bots.length > 0 ? (
            <>
              <label className={account.field}>
                Connect as
                <select name="bot" className={styles.select}>
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name ?? bot.slug}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className={styles.scopes}>
                <legend>It may</legend>
                <label>
                  <input type="checkbox" checked disabled /> read what that account can read
                </label>
                {request.scopesAsked.includes("WRITE") && (
                  <label>
                    <input type="checkbox" name="write" value="1" /> write: create docs and files, edit their text,
                    and add notes, links and tags
                  </label>
                )}
              </fieldset>
            </>
          ) : (
            <p>No account works for you yet, so there is nothing to connect {name} to. An ADMIN can set one up.</p>
          )}
          <div className={styles.buttons}>
            {bots.length > 0 && (
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
