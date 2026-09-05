// Fails if anything redirects to a bare "/sign-in" instead of going through
// `signInPath()` / `signInErrorPath()` (src/lib/sign-in-redirect.ts).
//
// WHAT THIS IS DEFENDING. Every gated surface sends anonymous visitors to
// /sign-in, and the destination they were heading for rides along as
// `?callbackUrl=`. That param is built at each gate, because the App Router
// gives a Server Component no way to learn its own pathname — see
// src/app/sign-in/NOTES.md for why a middleware matcher was not preferred here.
// The weakness of that arrangement is the obvious one: a *new* gated route can
// be written with a plain `redirect("/sign-in")` and be completely correct in
// every visible way. It compiles, it lints, it gates, its tests pass. The only
// symptom is that whoever followed the link lands on /dashboard instead of the
// thing they clicked — degradation, not breakage, on a path nobody signed-in
// ever exercises. This turns that into a failing check.
//
// The worked example, which is not hypothetical: /files/[slug]/download exists
// to be pasted into an email and clicked by someone who may not be signed in.
// Its own e2e spec runs from the shared admin storage state, so the anonymous
// path through it is untested. A missing callbackUrl there is invisible to
// every other check in this repo.
//
// WHY A GREP AND NOT A LINT RULE. `redirect()` is `next/navigation`'s, called
// with a plain string; there is no type to make illegal and no ESLint plugin
// already in the tree to hang a custom rule off. STYLE.md's colour-literal
// guard is the same shape and the same reasoning.
//
// WHAT IT DELIBERATELY DOES NOT MATCH:
//   - `<Link href="/sign-in">` on /sign-up, /invite, /forgot-password and
//     /reset-password. Those are "go and sign in" affordances, not gates
//     turning someone away from a destination.
//   - `pages: { signIn: "/sign-in" }` in src/lib/auth.ts — Auth.js config.
//   - `router.push("/sign-in")` in SessionRefresh.tsx, which fires when the
//     viewer's own row has just been deleted. They have been signed *out*;
//     there is no destination to come back to. Considered, not overlooked.
//
// Usage:
//   npm run check:sign-in
//
// Exits non-zero, listing file:line, when a bare literal is found.

import { globSync, readFileSync } from "node:fs";
import path from "node:path";

/** The one module allowed to write the path — it is what everything else calls. */
const OWNER = "src/lib/sign-in-redirect.ts";

/**
 * A `redirect(...)` or `redirectTo(...)` whose first argument is a literal
 * beginning with /sign-in, in any of the three quote styles. Anchored on the
 * call rather than on the string so the affordances and the Auth.js config
 * above stay silent.
 */
const BARE_REDIRECT = /\b(?:redirect|redirectTo)\(\s*[`'"]\/sign-in/;

const files = globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })
  .map((f) => f.split(path.sep).join("/"))
  .filter((f) => f !== OWNER)
  .sort();

const violations: string[] = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (BARE_REDIRECT.test(line)) violations.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error(
    `Found ${violations.length} redirect(s) to a bare "/sign-in":\n\n` +
      violations.map((v) => `  ${v}`).join("\n") +
      `\n\nUse signInPath(<where the viewer was heading>) instead, so signing in returns` +
      `\nthem there rather than dropping them on /dashboard. A gate with genuinely no` +
      `\ndestination — a mutation guard, say — calls signInPath() with no argument, which` +
      `\nsays so explicitly. See ${OWNER} and src/app/sign-in/NOTES.md.\n`,
  );
  process.exit(1);
}

console.log(`No bare "/sign-in" redirects in ${files.length} files.`);
