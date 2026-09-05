/**
 * Return-to-where-you-were after signing in.
 *
 * Every gated surface redirects anonymous visitors to `/sign-in`, and until this
 * existed that was the end of the trail: you signed in and landed on /dashboard,
 * with the doc/post/file you actually clicked nowhere in sight. The destination
 * rides along in a `callbackUrl` query param — the Auth.js convention, which
 * NextAuth's own middleware wrapper would supply automatically if the gates here
 * were a middleware matcher. They can't be: most of them are conditional on a
 * database read (`/doc/[slug]` gates on the doc's visibility, `/pdf/[slug]` and
 * `/side-by-side/...` likewise), so the decision is only reachable from inside
 * the page. Hence a param each call site builds by hand from the params it
 * already holds, via `signInPath` below.
 *
 * **The validation is not optional, and it is ours to do.** The sign-in form
 * calls `signIn(..., { redirect: false })` and navigates itself (see
 * ../app/sign-in/NOTES.md for why it must), which bypasses Auth.js's `redirect`
 * callback — the thing that would otherwise enforce same-origin. A bare
 * `router.push(callbackUrl)` would therefore make `/sign-in?callbackUrl=https://…`
 * an open redirect that bounces users offsite from a URL wearing our own login
 * page. Both halves of the round trip run everything through `safeCallbackUrl`:
 * the writing half so a malformed value never reaches a URL, the reading half
 * because the URL is attacker-supplied by definition.
 *
 * Browser-safe on purpose — `SiteHeader`'s "Log in" link imports it too.
 */

/** Where a sign-in with no stated destination lands. */
export const DEFAULT_SIGN_IN_DESTINATION = "/dashboard";

export const CALLBACK_URL_PARAM = "callbackUrl";

/**
 * Paths that must never become a callbackUrl, because arriving at them
 * *after* signing in is either a loop or nonsense. `/sign-in` is the loop;
 * `/sign-up`, `/forgot-password` and `/reset-password` are the pages someone
 * may have been on immediately before, which matters for `SiteHeader`'s link
 * (it builds its callbackUrl from wherever the reader currently is).
 */
const NON_DESTINATIONS = [
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/api/",
];

/**
 * Only used to give `new URL` a base to resolve against; never emitted. The
 * `startsWith("/")` check below runs first precisely so nothing can address
 * this origin on purpose.
 */
const PROBE_ORIGIN = "http://sign-in-redirect.invalid";

/**
 * Narrow an untrusted value to a same-origin path we're willing to navigate to,
 * or `null`.
 *
 * The leading-slash test kills scheme-absolute URLs (`https://evil.example`,
 * `javascript:…`) before parsing; parsing then catches the forms that *look*
 * relative and aren't. `//evil.example` is protocol-relative, and WHATWG URL
 * normalises a backslash to a forward slash for special schemes, so `/\evil.example`
 * is the same attack spelled to survive a naive `startsWith("//")` check —
 * both resolve to a foreign origin and are rejected by the origin comparison
 * rather than by a blocklist. The return value is the *parsed* path, so a
 * caller can't be handed anything the parser didn't agree with.
 */
export function safeCallbackUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (!value.startsWith("/")) return null;

  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;

  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!path.startsWith("/")) return null;
  if (NON_DESTINATIONS.some((prefix) => isUnder(path, prefix))) return null;
  return path;
}

/** `path` is `prefix` itself, or something below it — never a longer sibling. */
function isUnder(path: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return path.startsWith(prefix);
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
}

/**
 * The URL a gate should redirect an anonymous visitor to. Falls back to a bare
 * `/sign-in` when `returnTo` doesn't survive validation, so a call site can pass
 * a constructed path without pre-checking it.
 */
export function signInPath(returnTo?: string | null): string {
  const safe = safeCallbackUrl(returnTo);
  return safe ? `/sign-in?${CALLBACK_URL_PARAM}=${encodeURIComponent(safe)}` : "/sign-in";
}

/**
 * The URL a *failed* sign-in bounces back to. Carries the destination forward so
 * a mistyped password doesn't quietly drop the retry onto /dashboard, and never
 * the submitted email — that would be a smaller version of the query-string leak
 * `signInAction` exists to prevent.
 *
 * Lives here rather than in the action so that `/sign-in` is written in exactly
 * one module, which is what lets `scripts/check-sign-in-redirects.ts` ban the
 * bare literal everywhere else with no allowlist.
 */
export function signInErrorPath(callbackUrl?: string | null): string {
  const query = new URLSearchParams({ error: "1" });
  const safe = safeCallbackUrl(callbackUrl);
  if (safe) query.set(CALLBACK_URL_PARAM, safe);
  return `/sign-in?${query.toString()}`;
}

/**
 * Where /sign-up hands off after creating an account.
 *
 * Here only so that `/sign-in` is written in one module and the guard needs no
 * allowlist — this is a handoff, not a gate, and has no viewer destination to
 * carry. **`registered` is currently read by nobody**: the sign-in page never
 * renders a "your account was created" message, so the flag rides in the URL
 * and does nothing. Left as-is rather than quietly dropped, since the missing
 * half is the confirmation message, not the flag.
 */
export function signInAfterSignUpPath(): string {
  return "/sign-in?registered=1";
}

/**
 * Where to send someone who has just signed in: their stated destination if it
 * survives validation, /dashboard otherwise.
 */
export function destinationAfterSignIn(callbackUrl: unknown): string {
  return safeCallbackUrl(callbackUrl) ?? DEFAULT_SIGN_IN_DESTINATION;
}

/**
 * Append a querystring to a path for use as a callbackUrl. Used by the admin
 * tables, whose filters, sort and pagination all live in the querystring
 * (CLAUDE.md, "Admin tables are one kit") — dropping it would return a reader
 * to an unfiltered page 1 of the table they were actually looking at.
 */
export function pathWithQuery(
  pathname: string,
  query: URLSearchParams,
): string {
  const qs = query.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
