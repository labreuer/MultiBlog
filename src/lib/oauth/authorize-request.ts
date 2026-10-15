import type { ApiScope } from "@/generated/prisma/enums";
import type { OauthClientInfo } from "./clients";
import { S256_CHALLENGE } from "./pkce";
import { namesEndpoint } from "./resource";

// docs/MCP.md §21, "The consent page" — the parse of an authorize request,
// which the page runs on its query and `/authorize/decide` runs again on the
// form the page posted, so the decision trusts nothing the form sends. Pure:
// the client is looked up by the caller (`clientIdOf`, then `findClient`),
// and the refusals are unit-tested (authorize-request.test.ts).
//
// **Two kinds of refusal, in the page's order.** A request whose client or
// redirect URI is wrong is answered on the page and never redirected, or the
// endpoint would be an open redirector. Anything else is redirected back to
// the client with `error` and `state` — but only once the visitor has signed
// in (OAuth 2.1 §7.12.2), which is the page's to check between the two.

/** The parameters an authorize request carries, which the page's form carries on to the decision. */
export const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
] as const;

export type AuthorizeRequest = {
  client: OauthClientInfo;
  /** The one sent, or the client's only registered one when none was. */
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  /** What the client asked for, and the most the page offers: `write` implies `read`. */
  scopesAsked: ApiScope[];
};

export type AuthorizeParse =
  | { kind: "page-error"; message: string }
  | { kind: "redirect-error"; redirectUri: string; state: string | null; error: string; description: string }
  | { kind: "ok"; request: AuthorizeRequest };

const DUPLICATE = Symbol("duplicate");

/**
 * A parameter's one value: null when absent or empty, which OAuth treats
 * alike (RFC 6749 §3.1), and DUPLICATE when sent more than once, which it
 * forbids.
 */
function single(params: URLSearchParams, name: string): string | null | typeof DUPLICATE {
  const values = params.getAll(name);
  if (values.length > 1) return DUPLICATE;
  return values[0] ? values[0] : null;
}

/** The client_id a request names, for the caller to look up; null when there isn't exactly one. */
export function clientIdOf(params: URLSearchParams): string | null {
  const clientId = single(params, "client_id");
  return typeof clientId === "string" ? clientId : null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The host of a client's `client_id` when that is an https URL, as a pinned
 * identity's is, and null for a client registered by hand, whose id is a
 * cuid. The consent page shows it: a host is the part of a client's identity
 * that its own document can't make up.
 */
export function clientIdHost(clientId: string): string | null {
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * Whether a redirect URI goes to a program on the person's own computer:
 * plain `http` to a loopback address, as a native app's does. The consent
 * page warns of one, since any program on the machine can answer it.
 */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Why a redirect URI can't be registered for a client, or null if it can
 * (§21, "Which clients"): one that isn't absolute, that has a fragment, or
 * that is plain `http` to any host but a loopback address, as OAuth 2.1 and
 * the MCP spec require. A code sent over plain `http` to another machine can
 * be read on the way.
 */
export function redirectUriRefusal(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `${uri} isn't an absolute URI.`;
  }
  if (uri.includes("#")) return `${uri} has a fragment, which a redirect URI may not.`;
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return `${uri} is plain http to a host that isn't a loopback address; use https.`;
  }
  return null;
}

/**
 * Whether `requested` is `registered`: exactly, or, for a registered loopback
 * URI, on any port with every other part the same (OAuth 2.1 §8.4.2). A
 * native client listens on whatever port it gets.
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let r: URL;
  let q: URL;
  try {
    r = new URL(registered);
    q = new URL(requested);
  } catch {
    return false;
  }
  if (r.protocol !== "http:" || !LOOPBACK_HOSTS.has(r.hostname)) return false;
  return (
    q.protocol === "http:" &&
    q.hostname === r.hostname &&
    q.pathname === r.pathname &&
    q.search === r.search &&
    q.username === "" &&
    q.password === "" &&
    !requested.includes("#")
  );
}

/**
 * The scopes a request asks for, by `scope`: `read` alone when it names
 * `read` without `write`, and both otherwise. `write` implies `read`, and a
 * request naming neither asks for both (§21, "Whose account"). Any other
 * word, `offline_access` among them, is ignored rather than refused.
 */
export function scopesAsked(scope: string | null): ApiScope[] {
  const words = new Set((scope ?? "").split(" ").filter(Boolean));
  return words.has("read") && !words.has("write") ? ["READ"] : ["READ", "WRITE"];
}

/**
 * Whether a refresh's `scope` asks for more than the connection holds, which
 * is refused (§21, "The token endpoint"). Only `write` can: every connection
 * holds `read`, and any other word is ignored, as at the consent page.
 */
export function asksForMore(scope: string | null, held: readonly ApiScope[]): boolean {
  return (scope ?? "").split(" ").includes("write") && !held.includes("WRITE");
}

/** What a connection is granted: `read`, and `write` only when the client asked and the person chose it. */
export function grantedScopes(asked: readonly ApiScope[], writeChosen: boolean): ApiScope[] {
  return asked.includes("WRITE") && writeChosen ? ["READ", "WRITE"] : ["READ"];
}

/**
 * The request, or why it is refused. `client` is what `findClient` made of
 * its client_id; `endpoint` is the MCP endpoint's URL, the only resource a
 * connection can be for.
 */
export function parseAuthorizeRequest(params: URLSearchParams, client: OauthClientInfo | null, endpoint: URL): AuthorizeParse {
  const page = (message: string): AuthorizeParse => ({ kind: "page-error", message });

  // 1. The client and its redirect URI, answered on the page.
  const clientId = single(params, "client_id");
  if (clientId === DUPLICATE) return page("The request names its client more than once.");
  if (clientId === null) return page("The request names no client.");
  if (!client || client.clientId !== clientId) return page("The request comes from a client this site doesn't know.");

  const sent = single(params, "redirect_uri");
  if (sent === DUPLICATE) return page("The request names its redirect URI more than once.");
  let redirectUri: string;
  if (sent === null) {
    // OAuth 2.1 §4.1.1 requires the parameter of a client with several.
    if (client.redirectUris.length !== 1) return page("The request names no redirect URI, and its client has more than one.");
    redirectUri = client.redirectUris[0];
  } else {
    if (!client.redirectUris.some((registered) => redirectUriMatches(registered, sent))) {
      return page("The request's redirect URI isn't one its client registered.");
    }
    redirectUri = sent;
  }

  // 2. The rest, redirected back to the client.
  const state = single(params, "state");
  const fail = (error: string, description: string): AuthorizeParse => ({
    kind: "redirect-error",
    redirectUri,
    state: typeof state === "string" ? state : null,
    error,
    description,
  });
  if (state === DUPLICATE) return fail("invalid_request", "state is sent more than once.");

  const responseType = single(params, "response_type");
  if (responseType === DUPLICATE || responseType === null) return fail("invalid_request", "response_type is required, once.");
  if (responseType !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");

  const challenge = single(params, "code_challenge");
  if (challenge === DUPLICATE || challenge === null) return fail("invalid_request", "code_challenge is required, once: PKCE.");
  // A missing method would mean `plain`, which is refused with the rest.
  if (single(params, "code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256.");
  if (!S256_CHALLENGE.test(challenge)) return fail("invalid_request", "code_challenge is not an S256 challenge.");

  // RFC 8707 lets a request name several; each must be the endpoint. None
  // at all is taken as naming it.
  if (params.getAll("resource").some((resource) => !namesEndpoint(resource, endpoint))) {
    return fail("invalid_target", "resource must be this server's MCP endpoint, with no query or fragment.");
  }

  const scope = single(params, "scope");
  if (scope === DUPLICATE) return fail("invalid_request", "scope is sent more than once.");

  return {
    kind: "ok",
    request: { client, redirectUri, state, codeChallenge: challenge, scopesAsked: scopesAsked(scope) },
  };
}

/**
 * The URL an authorization response goes to: the redirect URI, its own query
 * kept, with the response's parameters and `iss` (RFC 9207) added. A null
 * value is left out.
 */
export function authorizationResponseUrl(redirectUri: string, issuer: string, response: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(response)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  url.searchParams.set("iss", issuer);
  return url.href;
}

/** A Next page's `searchParams`, as the URLSearchParams the parse takes, repeated parameters kept. */
export function searchParamsOf(query: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(name, one);
  }
  return params;
}

/** The request's own parameters, and nothing else, for the page's form to carry on. */
export function authorizeParamsOf(params: URLSearchParams): [string, string][] {
  const names: readonly string[] = AUTHORIZE_PARAMS;
  return [...params].filter(([name]) => names.includes(name));
}
