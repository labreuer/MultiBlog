"use client";

import { useSyncExternalStore } from "react";

// A timestamp rendered in the *viewer's* locale and timezone without tripping
// React's hydration check (TODO.md's "#418" entry, found in production
// 2026-08-11).
//
// The problem this exists to solve: `new Date(x).toLocaleString()` reads the
// **runtime's** default locale and timezone. In a client component — which the
// App Router renders on the server too — that line runs twice, once during SSR
// on the box (UTC, on any normal deployment) and once during hydration in the
// browser (the reader's own zone). The two strings differ, React reports a
// text mismatch, and it recovers by throwing away and re-rendering the whole
// subtree on the client. Locally it never fires, because the dev server and the
// browser are the same machine and therefore always agree — which is why this
// class of bug reaches production untouched by any check we run.
//
// Note the contrast worth not "fixing": the identical-looking call in
// app/doc/[slug]/page.tsx is in a *Server* Component, so it is formatted once
// and shipped as a finished string in the RSC payload. Only a client
// component's copy renders on both sides of the boundary. Grepping for
// `toLocaleString` and converting every hit is the wrong move.
//
// How this avoids the mismatch: SSR and the *first* client render both emit
// `utcFallback`, a string built by slicing the ISO text with no `Intl` involved
// at all — so the two are identical by construction. Only once hydration has
// finished does the localized form appear. That is deliberately not
// `suppressHydrationWarning`, which silences the warning but leaves the
// server's UTC text in the DOM until something else happens to re-render it.
//
// The "have we hydrated yet" flag is a `useSyncExternalStore` whose subscribe
// never fires, rather than the more familiar `useState(false)` +
// `useEffect(() => setMounted(true))`. Same result, but it says the thing
// directly: `getServerSnapshot` is *defined* as the value React must use while
// server-rendering and hydrating, so the two-render sequence is the hook's
// contract rather than a side effect arranged to imitate it. It also keeps the
// React Compiler's `set-state-in-effect` rule satisfied, which rejects the
// setState-in-effect form outright.
//
// There is a third reason, and it's the one that would be easy to destroy while
// "simplifying" this back to useState+useEffect: on a **client-side
// navigation** there is no SSR pass, so React calls `getSnapshot` and this
// renders the localized string on its very first render — no UTC flash at all.
// The effect form cannot do that; it always paints the fallback first and then
// corrects, on every mount, forever. This is the same pattern and the same
// rationale as tkdodo.eu/blog/avoiding-hydration-mismatches-with-use-sync-external-store,
// which a React team member confirmed is an intended use of the hook. (React
// once had a StrictMode bug where a differing getServerSnapshot warned anyway —
// facebook/react#26095, fixed in #26791, long before the version pinned here.)
//
// The one genuinely different architecture, considered and not taken: have the
// client write its IANA zone to a cookie, read it server-side with `cookies()`,
// and format with an explicit `timeZone` so the server emits the reader's local
// time and there is no second pass at all. It's what next-intl is built around.
// Rejected because it doesn't remove the problem so much as move it — the first
// visit has no cookie yet, so it still needs this exact fallback — and it buys a
// flash-free render at the price of a cookie, a client bootstrap script, and
// every such page becoming cookie-dependent. Worth revisiting only if the
// transient UTC text ever actually bothers anyone.
//
// `Intl` is avoided in the fallback on purpose rather than out of caution: even
// pinned to a fixed locale and `timeZone: "UTC"`, Node's and the browser's ICU
// builds can disagree on the output — most famously the U+202F narrow no-break
// space before AM/PM in newer ICU — which would reintroduce the very mismatch
// this is here to remove, in a form far harder to recognize.

type Precision = "datetime" | "date";

type DateLike = string | Date | null | undefined;

function toIso(value: DateLike): string | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The pre-hydration text. Pure string slicing on an ISO-8601 timestamp, so it
 * is byte-identical on the server and in the browser. Labeled UTC because that
 * is genuinely what it shows, for the frame or two before the effect runs.
 */
function utcFallback(iso: string, precision: Precision): string {
  return precision === "date" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// Module-level constants, not inline arrows: `subscribe` must keep the same
// identity across renders or React resubscribes on every one of them. Nothing
// ever calls the emit callback, because "we have hydrated" transitions exactly
// once and React itself drives that transition by switching from
// getServerSnapshot to getSnapshot.
const subscribeNever = () => () => {};
const getIsHydrated = () => true;
const getIsHydratedOnServer = () => false;

/**
 * The string form, for the two places an element can't be used: inside a
 * template literal (`PostPublisher`) and as the text of an `<option>`
 * (`YdocDebug`), where a nested `<time>` would be invalid HTML.
 *
 * Safe to call with a nullish value — returns `""` — so a call site whose
 * timestamp is conditional doesn't have to call a hook conditionally.
 * Being a hook, it still cannot be called inside a `.map()`; render a small
 * per-item component instead, the way `YdocDebug`'s option list does.
 */
export function useLocalTime(value: DateLike, precision: Precision = "datetime"): string {
  const hydrated = useSyncExternalStore(subscribeNever, getIsHydrated, getIsHydratedOnServer);

  const iso = toIso(value);
  if (iso === null) return "";
  if (!hydrated) return utcFallback(iso, precision);

  const date = new Date(iso);
  return precision === "date" ? date.toLocaleDateString() : date.toLocaleString();
}

/**
 * The element form, and the one to reach for by default. Renders a `<time>`
 * carrying the canonical ISO value in `dateTime` — identical on both sides of
 * hydration, and machine-readable besides.
 */
export default function LocalTime({
  value,
  precision = "datetime",
  className,
}: {
  value: DateLike;
  precision?: Precision;
  className?: string;
}) {
  const iso = toIso(value);
  const text = useLocalTime(value, precision);
  if (iso === null) return null;
  return (
    <time dateTime={iso} className={className}>
      {text}
    </time>
  );
}
