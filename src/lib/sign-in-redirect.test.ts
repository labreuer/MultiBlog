import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SIGN_IN_DESTINATION,
  destinationAfterSignIn,
  pathWithQuery,
  safeCallbackUrl,
  signInErrorPath,
  signInPath,
} from "./sign-in-redirect";

// The rejection surface is the whole point here: this value arrives from the
// query string, so every case below is something an attacker can put there.
// See the module header for why Auth.js's own same-origin check doesn't run.

test("safeCallbackUrl accepts same-origin paths", () => {
  assert.equal(safeCallbackUrl("/dashboard"), "/dashboard");
  assert.equal(safeCallbackUrl("/doc/my-doc"), "/doc/my-doc");
  assert.equal(safeCallbackUrl("/posts?sort=title&page=3"), "/posts?sort=title&page=3");
  assert.equal(safeCallbackUrl("/doc/my-doc#comment-4"), "/doc/my-doc#comment-4");
  // Percent-encoding survives: params reach a page already encoded (CLAUDE.md),
  // so this is the shape a call site actually builds.
  assert.equal(safeCallbackUrl("/doc/a%20b"), "/doc/a%20b");
});

test("safeCallbackUrl rejects offsite destinations", () => {
  assert.equal(safeCallbackUrl("https://evil.example/phish"), null);
  assert.equal(safeCallbackUrl("http://evil.example"), null);
  // Protocol-relative, and the same attack spelled with a backslash — WHATWG
  // URL normalises `\` to `/` for special schemes, so a startsWith("//") test
  // alone would pass this one through.
  assert.equal(safeCallbackUrl("//evil.example"), null);
  assert.equal(safeCallbackUrl("/\\evil.example"), null);
  assert.equal(safeCallbackUrl("/\\/evil.example"), null);
  assert.equal(safeCallbackUrl("javascript:alert(1)"), null);
  assert.equal(safeCallbackUrl("data:text/html,<script>alert(1)</script>"), null);
});

test("safeCallbackUrl rejects anything that isn't a rooted path", () => {
  assert.equal(safeCallbackUrl(""), null);
  assert.equal(safeCallbackUrl("dashboard"), null);
  assert.equal(safeCallbackUrl("./dashboard"), null);
  assert.equal(safeCallbackUrl(undefined), null);
  assert.equal(safeCallbackUrl(null), null);
  assert.equal(safeCallbackUrl(42), null);
  // Next hands a repeated query param through as an array.
  assert.equal(safeCallbackUrl(["/dashboard"]), null);
});

test("safeCallbackUrl rejects pages that can't be a post-sign-in destination", () => {
  assert.equal(safeCallbackUrl("/sign-in"), null);
  assert.equal(safeCallbackUrl("/sign-in?callbackUrl=%2Fsign-in"), null);
  assert.equal(safeCallbackUrl("/sign-up"), null);
  assert.equal(safeCallbackUrl("/forgot-password"), null);
  assert.equal(safeCallbackUrl("/reset-password?token=abc"), null);
  assert.equal(safeCallbackUrl("/api/auth/signout"), null);
  // A longer sibling is a different page and stays allowed.
  assert.equal(safeCallbackUrl("/sign-in-help"), "/sign-in-help");
});

test("signInPath encodes the destination, and omits it when unusable", () => {
  assert.equal(signInPath("/doc/my-doc"), "/sign-in?callbackUrl=%2Fdoc%2Fmy-doc");
  assert.equal(
    signInPath("/posts?sort=title&page=3"),
    "/sign-in?callbackUrl=%2Fposts%3Fsort%3Dtitle%26page%3D3",
  );
  assert.equal(signInPath("https://evil.example"), "/sign-in");
  assert.equal(signInPath("/sign-in"), "/sign-in");
  assert.equal(signInPath(undefined), "/sign-in");
});

test("signInPath output round-trips back through safeCallbackUrl", () => {
  for (const target of ["/doc/my-doc", "/posts?sort=title&page=3", "/doc/a%20b#x"]) {
    const url = new URL(signInPath(target), "http://example.test");
    assert.equal(safeCallbackUrl(url.searchParams.get("callbackUrl")), target);
  }
});

test("destinationAfterSignIn falls back to the dashboard", () => {
  assert.equal(destinationAfterSignIn("/doc/my-doc"), "/doc/my-doc");
  assert.equal(destinationAfterSignIn("//evil.example"), DEFAULT_SIGN_IN_DESTINATION);
  assert.equal(destinationAfterSignIn(undefined), DEFAULT_SIGN_IN_DESTINATION);
});

test("pathWithQuery omits the ? when there is nothing to carry", () => {
  assert.equal(pathWithQuery("/posts", new URLSearchParams()), "/posts");
  assert.equal(pathWithQuery("/posts", new URLSearchParams({ page: "3" })), "/posts?page=3");
});

test("signInErrorPath keeps a usable destination and drops an unusable one", () => {
  // The retry has to land somewhere; losing the destination here is how a
  // mistyped password silently turns into "signed in, wrong page".
  assert.equal(signInErrorPath("/docs"), "/sign-in?error=1&callbackUrl=%2Fdocs");
  assert.equal(signInErrorPath("https://evil.example"), "/sign-in?error=1");
  assert.equal(signInErrorPath(null), "/sign-in?error=1");
  assert.equal(signInErrorPath(), "/sign-in?error=1");
});

test("signInErrorPath never echoes anything but the destination", () => {
  // The whole reason the no-JS action redirects with a flag rather than the
  // submitted form: a password in the query string is in history, the Referer
  // header, and every access log (src/app/actions/sign-in.ts).
  const params = new URL(signInErrorPath("/docs"), "http://example.test").searchParams;
  assert.deepEqual([...params.keys()].sort(), ["callbackUrl", "error"]);
});
