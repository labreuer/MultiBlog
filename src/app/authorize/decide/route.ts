import {
  authorizationResponseUrl,
  authorizeParamsOf,
  clientIdOf,
  grantedScopes,
  parseAuthorizeRequest,
} from "@/lib/oauth/authorize-request";
import { findClient } from "@/lib/oauth/clients";
import { mintAuthorizationCode, signedInPerson, worksFor } from "@/lib/oauth/consent";
import { issuer, mcpEndpointUrl } from "@/lib/oauth/discovery";

// docs/MCP.md §21, "The consent page" — where the page's Approve and Cancel
// post. A route handler rather than a server action, because an OAuth
// response is an HTTP redirect to another origin: a handler returns a 303 as
// it is, where a server action's redirect is an instruction the client router
// turns into one. It works without JavaScript.
//
// **It trusts nothing the form sends.** It refuses an Origin that isn't this
// site's, re-parses the request through the page's own parse, and re-checks
// that the bot works for whoever is signed in. A cross-site post carries no
// session to begin with: Auth.js's cookie is SameSite=Lax.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A refusal shown to the person, never redirected to the client. */
function refused(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== issuer()) return refused(403, "This form can only be sent from this site's own page.");

  const form = new URLSearchParams(await request.text());
  const params = new URLSearchParams(authorizeParamsOf(form));
  const clientId = clientIdOf(params);
  const client = clientId ? await findClient(clientId) : null;
  const parsed = parseAuthorizeRequest(params, client, mcpEndpointUrl());
  if (parsed.kind === "page-error") return refused(400, parsed.message);

  const person = await signedInPerson();
  if (!person) return refused(401, "You are not signed in. Sign in, then start the connection again.");

  if (parsed.kind === "redirect-error") {
    return seeOther(
      authorizationResponseUrl(parsed.redirectUri, issuer(), {
        error: parsed.error,
        error_description: parsed.description,
        state: parsed.state,
      }),
    );
  }
  const { request: approved } = parsed;

  // Anything but Approve is Cancel, a missing decision included.
  if (form.get("decision") !== "approve") {
    return seeOther(authorizationResponseUrl(approved.redirectUri, issuer(), { error: "access_denied", state: approved.state }));
  }

  const botId = form.get("bot");
  if (!botId || !(await worksFor(botId, person))) return refused(403, "That account doesn't work for you.");

  const code = await mintAuthorizationCode({
    clientId: approved.client.clientId,
    redirectUri: approved.redirectUri,
    codeChallenge: approved.codeChallenge,
    scopes: grantedScopes(approved.scopesAsked, form.get("write") === "1"),
    botId,
    issuerId: person.id,
  });
  return seeOther(authorizationResponseUrl(approved.redirectUri, issuer(), { code, state: approved.state }));
}
