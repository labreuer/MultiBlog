/**
 * The doc reading view's scrub position, as a URL parameter.
 *
 * `/doc/[slug]?at=<ydoc_update id>` opens the page frozen at that point in the
 * doc's history (`DocScrubBar`, docs/DOCS.md "The reading view"). The id rather
 * than the slider's index, for the same reason an annotation stores one: an
 * index shifts under every new update, while the id is stable and is already
 * the currency everything else here trades in — `Annotation.ydocUpdateId`, the
 * "at this revision" control, `PostSnapshotScrubBar`'s `initialThroughUpdateId`.
 * The live end is the *absence* of the parameter, never `at=<head id>`, so a
 * shared URL that has since been edited past still means "the newest version"
 * rather than pinning a reader to whatever the head happened to be.
 *
 * **Written with `replaceState`, never `pushState`, and never per slider tick.**
 * A range input fires `change` for every pixel of a drag, so one drag across a
 * long history is a hundred-odd position changes. Pushing an entry per position
 * would bury the page the reader arrived from under a hundred entries — Back
 * would stop being a way to leave the page, which is the history-spam pattern
 * browsers have spent years fighting, and which no reader expects from a
 * slider. Pushing also needs a `popstate` listener to seek the slider back, or
 * the URL and the body disagree the moment Back is pressed; replacing needs
 * none, because the only way to arrive at a position is a real page load.
 *
 * Both calls are also *throttled by the browser*, which is why
 * `SCRUB_URL_DEBOUNCE_MS` is a correctness requirement and not a nicety: WebKit
 * throws `SecurityError` past roughly 100 history calls in 30 seconds, and an
 * uncaught throw inside the slider's change handler would break scrubbing
 * outright in Safari. Chromium drops calls past its own budget with a console
 * warning instead, which is quieter and worse — the URL silently stops matching
 * the view. Hence the debounce *and* the `try`/`catch` in `replaceScrubParam`.
 *
 * The pure half is here so `scrub-url.test.ts` can drive the rejection surface
 * without a DOM; `replaceScrubParam` is the only function that touches
 * `window`, and it is a no-op off the browser.
 */

/** The query parameter. Short because it appears in URLs people paste. */
export const SCRUB_PARAM = "at";

/**
 * Trailing debounce before the URL is rewritten. Trailing-only, with no
 * `pointerup` short-circuit of the kind `PdfAnnotationSurface` uses for a
 * selection: a range input is driven by arrow keys, Home/End and a screen
 * reader as well as a drag, so there is no one settle event to hang it on, and
 * nothing the reader can *see* is waiting on the write.
 */
export const SCRUB_URL_DEBOUNCE_MS = 400;

/**
 * `ydoc_update.id` is a bigint identity column, so a well-formed value is
 * digits, no sign, no leading zero, and 1 at the smallest. Anything else is
 * something a URL carried rather than something we wrote, and resolves to "no
 * position" — the same treatment an id that simply isn't in this doc's log
 * gets, since neither can be seeked to.
 */
const UPDATE_ID = /^[1-9][0-9]{0,18}$/;

export function parseScrubUpdateId(value: string | undefined | null): string | null {
  // Not merely a type guard: a repeated `?at=1&at=2` reaches a Next page as an
  // array at runtime, whatever the page's narrowed searchParams type says.
  if (typeof value !== "string") return null;
  return UPDATE_ID.test(value) ? value : null;
}

/**
 * `href` (a full URL, i.e. `window.location.href`) with `at` set to `updateId`,
 * or removed when that is null. Returns the path-relative form `replaceState`
 * wants. Every other parameter and the hash survive untouched — `?sel=` is an
 * anchored link's whole meaning on this route (docs/ANCHORED_LINKS.md), and the
 * fragment is which annotation the reader followed a link to.
 */
export function scrubUrl(href: string, updateId: string | null): string {
  const url = new URL(href);
  if (updateId === null) {
    url.searchParams.delete(SCRUB_PARAM);
  } else {
    url.searchParams.set(SCRUB_PARAM, updateId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Rewrite the current URL's scrub position in place.
 *
 * `window.history.replaceState` rather than `router.replace`: Next patches the
 * history methods so its own router state follows along, where `router.replace`
 * would refetch the whole page tree — the doc, its threads, its tags — on every
 * settled scrub position. The early return on an unchanged URL keeps a bar that
 * mounted at the live end, or a drag that returned to where it started, from
 * spending a call out of the browser's budget to write what is already there.
 */
export function replaceScrubParam(updateId: string | null): void {
  if (typeof window === "undefined") return;
  const next = scrubUrl(window.location.href, updateId);
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  try {
    window.history.replaceState(null, "", next);
  } catch {
    // Over the engine's history budget (see above). The view is still correct;
    // only the URL is stale, and the next settled position writes it again.
  }
}
