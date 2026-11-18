// A browser context's session token, read and rewritten with the suite's own
// AUTH_SECRET (playwright.config.ts loads .env). The session is a JWT in a
// cookie (src/app/sign-in/NOTES.md), and the token says when its account was
// last read (`checkedAt`), so a spec makes a session due for its next read by
// moving that time back, as `backdateComment` produces an interval rather
// than waiting one out.
import type { BrowserContext } from "@playwright/test";
import { decode, encode } from "next-auth/jwt";

type Claims = Record<string, unknown>;
type Cookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET must reach the suite (playwright.config.ts loads .env).");
  return value;
}

/** The session cookie, or undefined when the context holds none: it is `__Secure-`-prefixed over https. */
async function sessionCookie(context: BrowserContext): Promise<Cookie | undefined> {
  return (await context.cookies()).find((cookie) => cookie.name.endsWith("authjs.session-token"));
}

/** What the context's session token holds, or null when it has no session cookie. The cookie's name is also the key's salt. */
export async function sessionClaims(context: BrowserContext): Promise<Claims | null> {
  const cookie = await sessionCookie(context);
  if (!cookie) return null;
  return (await decode({ token: cookie.value, secret: secret(), salt: cookie.name })) as Claims | null;
}

/** Puts back the context's session token with `change` applied to what it holds. */
export async function rewriteSessionClaims(context: BrowserContext, change: (claims: Claims) => void): Promise<void> {
  const cookie = await sessionCookie(context);
  if (!cookie) throw new Error("This context has no session cookie to rewrite.");
  const claims = { ...((await decode({ token: cookie.value, secret: secret(), salt: cookie.name })) as Claims) };
  change(claims);
  await context.addCookies([{ ...cookie, value: await encode({ token: claims, secret: secret(), salt: cookie.name }) }]);
}

/**
 * Makes the context's session one whose account was last read `seconds` ago,
 * an hour unless said: older than any interval a server runs with, so its
 * next read of the session reads the account again.
 */
export async function ageSession(context: BrowserContext, seconds = 3600): Promise<void> {
  await rewriteSessionClaims(context, (claims) => {
    claims.checkedAt = Math.floor(Date.now() / 1000) - seconds;
  });
}
