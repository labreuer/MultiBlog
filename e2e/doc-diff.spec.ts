import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Page } from "@playwright/test";
import { COLLAB_PORT, DEV_HOST } from "../scripts/dev-ports";
import { withSchemaVersion } from "../src/lib/schema-version";
import { test, expect, bodyEditor, gotoOk, waitForDocCollabReady, QUOTED_BODY } from "./fixtures";
import {
  ADMIN_EMAIL,
  appendTestDocParagraph,
  countDocYdocUpdates,
  createTestDoc,
  deleteTestDoc,
  forkDocAs,
  getDocYdocUpdateIds,
  setTestDocBody,
  setTestUserRole,
  softDeleteTestDoc,
  type TestDoc,
} from "./db";

// docs/FORKS.md "Diffs" — /diff/<left>/<right>, a word diff from its left
// side to its right, each side a doc as it is now (`<id>`) or at one version
// (`<id>@<update id>`); and the two ways in that exist without forks, the
// scrub bar's links and side-by-side's.
//
// The rows are compared in the reader's browser, in a worker, after the page
// has loaded. **Every check of a row waits for the island to mark itself
// done** (`done`, below): before that the page holds its headers and
// "Comparing…", and a row that isn't there yet reads like one that never
// will be.
//
// What this can't see is in the unit tables: the parser's rejection surface
// (diff-side.test.ts), the folding, the deadline and the caps
// (doc-diff.test.ts).

const FIRST = "A second paragraph, appended as the doc's second version.";
const SECOND = "A third paragraph, appended as the doc's third version.";

/** Postgres's largest bigint, and the number after it. */
const MAX_UPDATE_ID = "9223372036854775807";
const PAST_THE_BOUND = "9223372036854775808";

const SLIDER = "Scrub through this doc's edit history";
const FROZEN = { name: /Switch to live view/ };

/** The rows, once the worker has answered. */
async function done(page: Page) {
  const island = page.locator('[data-state="done"]');
  await expect(island).toBeVisible({ timeout: 30_000 });
  return island;
}

/** The status a navigation answered with: a 404's is the page's own, where Forbidden is a 200 that says so. */
async function statusOf(page: Page, path: string): Promise<number | undefined> {
  return (await page.goto(path))?.status();
}

/** The two headers' "Earlier"/"Later" labels, left then right, with "" for a header that has none. */
async function orderLabels(page: Page): Promise<string[]> {
  const whens = page.locator("main").getByText(/when last read|as it was at/);
  await expect(whens).toHaveCount(2);
  return whens.evaluateAll((els) => els.map((el) => /^(Earlier|Later)/.exec(el.textContent ?? "")?.[1] ?? ""));
}

/** A range input ignores fill()/click, per docs/BROWSER_PANE.md's recipe. */
async function scrubTo(page: Page, value: number): Promise<void> {
  await page.getByLabel(SLIDER).evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/** Opens the doc's reading view and loads the scrub bar's history, which a touch does. */
async function openScrubBar(page: Page, doc: TestDoc, positions: number): Promise<void> {
  await page.goto(`/doc/${doc.slug}`);
  await expect(bodyEditor(page)).toBeVisible();
  await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
  await page.getByLabel(SLIDER).focus();
  await expect.poll(() => page.getByLabel(SLIDER).getAttribute("max"), { timeout: 15_000 }).toBe(String(positions - 1));
}

test.describe("the diff route's gate (docs/FORKS.md \"Who may see one\")", () => {
  test("one doc at two versions: the rows, Earlier and Later, and the later-on-left line when swapped", async ({
    page,
    sharedDoc,
  }) => {
    const [first] = await getDocYdocUpdateIds(sharedDoc.id);
    const second = await appendTestDocParagraph({ docId: sharedDoc.id, text: FIRST });

    await gotoOk(page, `/diff/${sharedDoc.id}@${first}/${sharedDoc.id}@${second}`);
    let island = await done(page);
    // The appended paragraph is the one change, on the right alone.
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText(FIRST);
    await expect(island.locator('[data-kind="added"] [data-side="old"]')).toHaveCount(0);
    await expect(island.locator('[data-kind="deleted"], [data-kind="changed"]')).toHaveCount(0);
    expect(await orderLabels(page)).toEqual(["Earlier", "Later"]);
    await expect(page.locator('[data-kind="later-on-left"]')).toHaveCount(0);

    // Swapped: the same row mirrored, and the page says which way round it is.
    await page.getByRole("link", { name: "Swap sides" }).click();
    await expect(page).toHaveURL(new RegExp(`/diff/${sharedDoc.id}@${second}/${sharedDoc.id}@${first}$`));
    island = await done(page);
    await expect(island.locator('[data-kind="deleted"] [data-side="old"]')).toHaveText(FIRST);
    expect(await orderLabels(page)).toEqual(["Later", "Earlier"]);
    const note = page.locator('[data-kind="later-on-left"]');
    await expect(note).toContainText("The later version is on the left");
    // Its own "Swap sides" leads back to the pair in order.
    await note.getByRole("link", { name: "Swap sides" }).click();
    await expect(page).toHaveURL(new RegExp(`/diff/${sharedDoc.id}@${first}/${sharedDoc.id}@${second}$`));
    await done(page);
    await expect(page.locator('[data-kind="later-on-left"]')).toHaveCount(0);

    // A side with no version is later than any version.
    await gotoOk(page, `/diff/${sharedDoc.id}/${sharedDoc.id}@${first}`);
    await done(page);
    expect(await orderLabels(page)).toEqual(["Later", "Earlier"]);
    await expect(page.locator('[data-kind="later-on-left"]')).toBeVisible();
  });

  test("the same doc on both sides is a 200 with no differences, and two unrelated docs have no order", async ({
    page,
    sharedDoc,
    draftDoc,
  }) => {
    // Side-by-side refuses one doc twice; a diff opens no Y.Doc in the browser, and doesn't.
    await gotoOk(page, `/diff/${sharedDoc.id}/${sharedDoc.id}`);
    let island = await done(page);
    await expect(island.locator('[data-kind="no-differences"]')).toBeVisible();
    expect(await orderLabels(page)).toEqual(["", ""]);
    await expect(page.locator('[data-kind="later-on-left"]')).toHaveCount(0);

    // Two docs, one of them empty: its one paragraph is paired with the
    // other's, and nothing says which side is later.
    await gotoOk(page, `/diff/${sharedDoc.id}/${draftDoc.id}`);
    island = await done(page);
    await expect(island.locator('[data-kind="changed"] [data-side="old"]')).toHaveText(QUOTED_BODY);
    await expect(island.locator('[data-kind="changed"] [data-side="new"]')).toHaveText("");
    expect(await orderLabels(page)).toEqual(["", ""]);
    await expect(page.locator('[data-kind="later-on-left"]')).toHaveCount(0);
  });

  test("a version that isn't in its doc's log is a 404: another doc's, one past the bound, and a side that is a slug", async ({
    page,
    sharedDoc,
    draftDoc,
  }) => {
    const [own] = await getDocYdocUpdateIds(sharedDoc.id);
    const [foreign] = await getDocYdocUpdateIds(draftDoc.id);
    expect(foreign).not.toBe(own);

    // Another doc's update: a real row, and never quietly the doc as it is now.
    expect(await statusOf(page, `/diff/${sharedDoc.id}@${foreign}/${sharedDoc.id}`)).toBe(404);
    // The largest id Postgres holds parses, and names nothing.
    expect(await statusOf(page, `/diff/${sharedDoc.id}@${MAX_UPDATE_ID}/${sharedDoc.id}`)).toBe(404);
    // One more is outside the grammar, and must not reach the database as a 500.
    expect(await statusOf(page, `/diff/${sharedDoc.id}@${PAST_THE_BOUND}/${sharedDoc.id}`)).toBe(404);
    // Sides are ids, never slugs.
    expect(await statusOf(page, `/diff/${sharedDoc.slug}/${sharedDoc.id}`)).toBe(404);
    // And the version it does have still answers.
    await gotoOk(page, `/diff/${sharedDoc.id}@${own}/${sharedDoc.id}`);
    await done(page);
  });

  test("a deleted side is a 404, to its own editor too", async ({ page, sharedDoc }) => {
    const other = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: FIRST });
    try {
      await gotoOk(page, `/diff/${sharedDoc.id}/${other.id}`);
      await done(page);
      await softDeleteTestDoc(other.id);
      expect(await statusOf(page, `/diff/${sharedDoc.id}/${other.id}`)).toBe(404);
      expect(await statusOf(page, `/diff/${other.id}/${sharedDoc.id}`)).toBe(404);
    } finally {
      await deleteTestDoc(other.id);
    }
  });

  test("a reader without the history sees two docs as they are now, and is Forbidden any version, whatever the id", async ({
    sharedDoc,
    draftDoc,
    secondUser,
  }) => {
    const [first] = await getDocYdocUpdateIds(sharedDoc.id);
    const [foreign] = await getDocYdocUpdateIds(draftDoc.id);
    const other = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: FIRST });
    try {
      // AUTHORIZED reads every SHARED doc and edits none, so has no doc's history.
      const { page: reader } = await secondUser({ role: "AUTHORIZED" });
      const forbidden = reader.getByRole("heading", { name: "Forbidden" });

      await gotoOk(reader, `/diff/${sharedDoc.id}/${other.id}`);
      const island = await done(reader);
      await expect(island.locator('[data-kind="changed"], [data-kind="deleted"], [data-kind="added"]').first()).toBeVisible();

      // A version in the log, one that is another doc's, and one that is
      // nobody's all answer alike: Forbidden against not-found would tell
      // this reader which ids are in the log.
      for (const version of [first, foreign, MAX_UPDATE_ID]) {
        expect(await statusOf(reader, `/diff/${sharedDoc.id}@${version}/${sharedDoc.id}`)).toBe(200);
        await expect(forbidden).toBeVisible();
        await expect(reader.locator("[data-state]")).toHaveCount(0);
      }
      // A side this reader can't read forbids the pair, and its title names neither doc.
      expect(await statusOf(reader, `/diff/${sharedDoc.id}/${draftDoc.id}`)).toBe(200);
      await expect(forbidden).toBeVisible();
      expect(await reader.title()).not.toContain(sharedDoc.title);
    } finally {
      await deleteTestDoc(other.id);
    }
  });

  test("the empty paragraph the editor appends to a doc that ends in a heading isn't a change", async ({ page }) => {
    const doc = await createTestDoc({
      authorEmail: ADMIN_EMAIL,
      body: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: QUOTED_BODY }] },
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "A heading the doc ends on" }] },
        ],
      },
    });
    try {
      const [first] = await getDocYdocUpdateIds(doc.id);
      // StarterKit's TrailingNode appends the paragraph when the editor opens
      // the doc, as an update of its own.
      await page.goto(`/doc/${doc.id}/edit`);
      await waitForDocCollabReady(page);
      await expect.poll(() => countDocYdocUpdates(doc.id), { timeout: 15_000 }).toBeGreaterThan(1);
      await page.goto("about:blank");

      await gotoOk(page, `/diff/${doc.id}@${first}/${doc.id}`);
      const island = await done(page);
      await expect(island.locator('[data-kind="no-differences"]')).toBeVisible();
    } finally {
      await deleteTestDoc(doc.id);
    }
  });
});

test.describe("ways in (docs/FORKS.md \"Choosing two versions on the scrub bar\", \"From side-by-side\")", () => {
  test("the scrub bar's links carry the right sides, the older on the left whichever was pinned", async ({
    page,
    sharedDoc,
  }) => {
    const [first] = await getDocYdocUpdateIds(sharedDoc.id);
    const second = await appendTestDocParagraph({ docId: sharedDoc.id, text: FIRST });
    await appendTestDocParagraph({ docId: sharedDoc.id, text: SECOND });
    const id = sharedDoc.id;

    await openScrubBar(page, sharedDoc, 3);
    const withNow = page.getByRole("link", { name: "Diff with now" });
    const pinnedToHere = page.getByRole("link", { name: "Diff pinned → here" });
    const pin = page.getByRole("button", { name: "Pin this version" });
    const pinnedLine = page.locator('[data-kind="pinned"]');
    const tick = page.locator('[data-kind="pin-tick"]');

    // At the live end there is nothing to diff with now, and nothing pinned.
    await expect(pin).toBeVisible();
    await expect(withNow).toHaveCount(0);
    await expect(pinnedToHere).toHaveCount(0);
    await expect(tick).toHaveCount(0);
    // Nobody has edited since the history loaded: the tap's own handshake is not a change.
    await expect(page.locator('[data-kind="changes-came-in"]')).toHaveCount(0);

    // Off the live end: this version against the doc as it is, a side with no version.
    await scrubTo(page, 0);
    await expect(withNow).toHaveAttribute("href", `/diff/${id}@${first}/${id}`);

    // Pinned here: a line naming it and a tick, and no diff of a version with itself.
    await pin.click();
    await expect(pinnedLine).toContainText("Pinned: update 1 of 3");
    await expect(tick).toHaveCount(1);
    await expect(pin).toHaveCount(0);
    // The tick is on the track where the thumb is: at the first position,
    // within a thumb's width of the slider's left end, and across its height.
    const sliderBox = (await page.getByLabel(SLIDER).boundingBox())!;
    const tickBox = (await tick.boundingBox())!;
    expect(tickBox.x).toBeGreaterThanOrEqual(sliderBox.x);
    expect(tickBox.x + tickBox.width).toBeLessThanOrEqual(sliderBox.x + 20);
    expect(tickBox.y).toBeLessThanOrEqual(sliderBox.y + sliderBox.height / 2);
    expect(tickBox.y + tickBox.height).toBeGreaterThanOrEqual(sliderBox.y + sliderBox.height / 2);
    await expect(pinnedToHere).toHaveCount(0);

    // Scrubbed on, the pin stays, and is the older side.
    await scrubTo(page, 1);
    await expect(pinnedLine).toContainText("Pinned: update 1 of 3");
    await expect(pinnedToHere).toHaveAttribute("href", `/diff/${id}@${first}/${id}@${second}`);
    // The live end is a side with no version, here as in "Diff with now".
    await scrubTo(page, 2);
    await expect(pinnedToHere).toHaveAttribute("href", `/diff/${id}@${first}/${id}`);
    await expect(withNow).toHaveCount(0);

    // Pinned at the later of two, the pin is the right side: the older is on the left either way.
    await scrubTo(page, 1);
    await pin.click();
    await expect(pinnedLine).toContainText("Pinned: update 2 of 3");
    await scrubTo(page, 0);
    await expect(pinnedToHere).toHaveAttribute("href", `/diff/${id}@${first}/${id}@${second}`);

    // Unpinned, the line, the tick and the link go.
    await pinnedLine.getByRole("button", { name: "Unpin" }).click();
    await expect(pinnedLine).toHaveCount(0);
    await expect(tick).toHaveCount(0);
    await expect(pinnedToHere).toHaveCount(0);

    // Followed, the link is the diff it names…
    await pin.click();
    await scrubTo(page, 1);
    await pinnedToHere.click();
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${second}$`));
    const island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText(FIRST);
    expect(await orderLabels(page)).toEqual(["Earlier", "Later"]);

    // …and Back returns to the bar at the position it was left on, unpinned:
    // the pin is the tab's, and the URL holds one position.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/doc/${sharedDoc.slug}\\?at=${second}$`));
    await expect(page.getByRole("button", FROZEN)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel(SLIDER)).toHaveValue("1");
    await expect(pinnedLine).toHaveCount(0);
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await expect(page.locator('[data-kind="changes-came-in"]')).toHaveCount(0);
  });

  test("side-by-side's Diff link is the pair as the two docs are now, by id", async ({ page, sharedDoc }) => {
    const other = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: FIRST });
    try {
      // By slug, which side-by-side takes and a diff's side never is.
      await page.goto(`/side-by-side/${sharedDoc.slug}/${other.slug}`);
      const link = page.getByRole("link", { name: "Diff", exact: true });
      await expect(link).toHaveAttribute("href", `/diff/${sharedDoc.id}/${other.id}`);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/diff/${sharedDoc.id}/${other.id}$`));
      const island = await done(page);
      await expect(island.locator('[data-side="old"]').first()).toContainText("quick brown fox");
      await expect(island.locator('[data-side="new"]').first()).toContainText("appended as the doc's second version");
      expect(await orderLabels(page)).toEqual(["", ""]);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(other.id);
    }
  });
});

// docs/FORKS.md "Sliders on the diff page" — a slider for each side whose
// history the viewer may see. A slider names a pair; the page asks
// `/api/diff/<left>/<right>` for it, compares it and draws it, with no
// navigation, and writes its address once the sliders have rested.
//
// Driven by key: a press is one position, where a drag is as many as the
// pointer crosses. `done` is what says the rows are for the pair the sliders
// name; it is "comparing" from the keypress until the new rows are drawn.
test.describe("sliders (docs/FORKS.md \"Sliders on the diff page\")", () => {
  const THIRD = "A fourth paragraph, appended as the doc's fourth version.";
  const sliderOf = (page: Page, which: "left" | "right") => page.getByLabel(`Scrub the ${which} side through its doc's history`);
  const bar = (page: Page) => page.locator('[data-kind="diff-sliders"]');
  const loadedHalf = (page: Page, which: "left" | "right") => bar(page).locator(`[data-side="${which}"][data-loaded]`);
  const pairPath = (left: string, right: string) => `/api/diff/${left}/${right}`;

  /** The pathname of every request the page makes that `pattern` matches, as they are sent. */
  function requestsTo(page: Page, pattern: RegExp): string[] {
    const seen: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pattern.test(pathname)) seen.push(pathname);
    });
    return seen;
  }
  const indexRequests = (page: Page) => requestsTo(page, /^\/api\/doc\/[^/]+\/versions$/);
  const pairRequests = (page: Page) => requestsTo(page, /^\/api\/diff\//);
  /** A doc's log, which the worker that builds a version fetches. */
  const LOG = /\/api\/doc\/[^/]+\/replay$/;
  const logRequests = (page: Page) => requestsTo(page, /^\/api\/doc\/[^/]+\/replay$/);

  /**
   * Leaves this browser unable to build a version: its doc's log never
   * arrives. Every pair a slider names is then the server's, which is the
   * path a pair takes whenever the browser can't build a side of it, and the
   * one whose requests a spec can hold, fail and count.
   */
  const serverReadsEveryPair = (page: Page) => page.route(LOG, (route) => route.abort());

  /** What a pair's page says, apart from its sliders: the two headers, the order lines and the rows. */
  async function pairFacts(page: Page) {
    const island = await done(page);
    return {
      sides: await page.locator('[data-kind="sides"]').innerText(),
      notes: await page.locator('[data-kind="later-on-left"], [data-kind="both-changed"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-kind"))),
      rows: await island.innerText(),
    };
  }

  const paragraph = (...content: object[]) => ({ type: "paragraph", content });
  const words = (text: string) => ({ type: "text", text });
  const mention = (iid: string, userId: string) => ({ type: "entityChip", attrs: { kind: "mention", iid, data: { userId } } });

  /**
   * Counts history calls from here on, the page's own apart from the
   * router's: Next answers a native `replaceState` with one of its own, whose
   * state it marks.
   */
  async function watchHistory(page: Page): Promise<() => Promise<{ own: string[]; all: number }>> {
    await page.evaluate(() => {
      const seen = { own: [] as string[], all: 0 };
      (window as unknown as { __history: typeof seen }).__history = seen;
      for (const name of ["pushState", "replaceState"] as const) {
        const before = window.history[name];
        window.history[name] = function (this: History, ...args: Parameters<History["pushState"]>) {
          seen.all += 1;
          if (!(args[0] as { __NA?: boolean } | null)?.__NA) seen.own.push(String(args[2]));
          return before.apply(this, args);
        };
      }
    });
    return () => page.evaluate(() => (window as unknown as { __history: { own: string[]; all: number } }).__history);
  }

  test("a slid side's rows and the address it leaves, with no navigation and without losing the slider's focus", async ({
    page,
    sharedDoc,
  }) => {
    const id = sharedDoc.id;
    const [first] = await getDocYdocUpdateIds(id);
    const second = await appendTestDocParagraph({ docId: id, text: FIRST });
    await appendTestDocParagraph({ docId: id, text: SECOND });
    const indexes = indexRequests(page);
    const pairs = pairRequests(page);
    const logs = logRequests(page);
    // A navigation would ask the server for the page: a document, or the router's own fetch.
    const pages = requestsTo(page, /^\/diff\//);
    const left = sliderOf(page, "left");
    const right = sliderOf(page, "right");

    // Somewhere to come Back to.
    await page.goto(`/doc/${sharedDoc.slug}`);
    await expect(bodyEditor(page)).toBeVisible();
    await gotoOk(page, `/diff/${id}@${first}/${id}`);
    let island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([FIRST, SECOND]);

    // Untouched: two grayed-out inputs, and nothing fetched for them.
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();
    await expect(bar(page).locator("[data-loaded]")).toHaveCount(0);
    expect(indexes).toEqual([]);
    expect(pairs).toEqual([]);
    expect(logs).toEqual([]);
    expect(pages).toHaveLength(1);

    // A touch fetches the doc's index, once for the two sides it is on, and its log.
    await right.focus();
    await expect(bar(page).locator("[data-loaded]")).toHaveCount(2);
    await expect(left).toHaveValue("0");
    await expect(right).toHaveValue("2");
    await expect(right).toHaveAttribute("max", "2");
    await expect(bar(page).locator('[data-side="right"] [data-kind="position"]')).toContainText("update 3 of 3");
    expect(indexes).toHaveLength(1);
    await expect.poll(() => logs).toHaveLength(1);

    // One step back from the live end: the slider's line at once, then the
    // rows and the headers together, then the address. The side is built
    // here from the log, so the server isn't asked for the pair.
    await right.press("ArrowLeft");
    await expect(bar(page).locator('[data-side="right"] [data-kind="position"]')).toContainText("update 2 of 3");
    island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([FIRST]);
    expect(await orderLabels(page)).toEqual(["Earlier", "Later"]);
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${second}$`));
    expect(pairs).toEqual([]);

    // Nothing under the page was mounted anew, so the input still has the focus.
    await expect(right).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${first}$`));
    island = await done(page);
    await expect(island.locator('[data-kind="no-differences"]')).toBeVisible();
    expect(await orderLabels(page)).toEqual(["", ""]);

    // The last position is the live end: a side with no version, never
    // `@<the last id>`. It is the doc as it is when read, so the server reads it.
    await page.keyboard.press("End");
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}$`));
    island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([FIRST, SECOND]);
    expect(pairs).toEqual([pairPath(`${id}@${first}`, id)]);

    // The other side's slider. The side at the live end is kept as it was read.
    await left.press("ArrowRight");
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${second}/${id}$`));
    island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([SECOND]);
    await expect(left).toHaveValue("1");
    await expect(right).toHaveValue("2");

    // Crossed: the left past the right, and the page says which way round it is.
    await right.press("Home");
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${second}/${id}@${first}$`));
    island = await done(page);
    await expect(island.locator('[data-kind="deleted"] [data-side="old"]')).toHaveText([FIRST]);
    expect(await orderLabels(page)).toEqual(["Later", "Earlier"]);
    await expect(page.locator('[data-kind="later-on-left"]')).toBeVisible();
    // Five pairs drawn: one read by the server, four put together here from
    // one fetch of the log, and the page was never asked for again.
    expect(pairs).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(pages).toHaveLength(1);

    // Swapped by its link, which is a navigation: each slider follows its side, on the index already held.
    await page.getByRole("link", { name: "Swap sides" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${second}$`));
    await done(page);
    await expect(left).toHaveValue("0");
    await expect(right).toHaveValue("1");
    expect(indexes).toHaveLength(1);

    // Back undoes the swap, to the pair the sliders had left there and not
    // the one the page was first opened on…
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${second}/${id}@${first}$`));
    island = await done(page);
    await expect(island.locator('[data-kind="deleted"] [data-side="old"]')).toHaveText([FIRST]);
    expect(await orderLabels(page)).toEqual(["Later", "Earlier"]);
    // …and Back again leaves the diff: five slid pairs made no entry.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/doc/${sharedDoc.slug}$`));
  });

  test("the address is written once for a run of moves, on the entry the page already has", async ({ page, sharedDoc }) => {
    const id = sharedDoc.id;
    const [first] = await getDocYdocUpdateIds(id);
    const second = await appendTestDocParagraph({ docId: id, text: FIRST });
    await appendTestDocParagraph({ docId: id, text: SECOND });
    const right = sliderOf(page, "right");

    await page.goto(`/doc/${sharedDoc.slug}`);
    await expect(bodyEditor(page)).toBeVisible();
    await gotoOk(page, `/diff/${id}@${first}/${id}`);
    await done(page);
    await right.focus();
    await expect(loadedHalf(page, "right")).toHaveCount(1);
    const entries = await page.evaluate(() => window.history.length);
    const calls = await watchHistory(page);

    // Four moves, each sooner after the last than the address waits.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    const rested = `/diff/${id}@${first}/${id}@${second}`;
    await expect(page).toHaveURL(new RegExp(`${rested}$`));
    await done(page);
    // Longer than the wait: nothing more is written once the sliders rest.
    await page.waitForTimeout(1000);
    const seen = await calls();
    expect(seen.own).toEqual([rested]);
    // The page's write, and the router's answer to it.
    expect(seen.all).toBe(2);
    expect(await page.evaluate(() => window.history.length)).toBe(entries);

    // A slider brought back to where the address has it writes nothing.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await done(page);
    await page.waitForTimeout(1000);
    expect((await calls()).own).toEqual([rested]);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/doc/${sharedDoc.slug}$`));
  });

  test("Back to a diff from elsewhere shows the pair its address names, not the one it was opened on", async ({ page, sharedDoc }) => {
    const id = sharedDoc.id;
    const [first] = await getDocYdocUpdateIds(id);
    const second = await appendTestDocParagraph({ docId: id, text: FIRST });
    await appendTestDocParagraph({ docId: id, text: SECOND });
    const right = sliderOf(page, "right");

    await gotoOk(page, `/diff/${id}@${first}/${id}`);
    let island = await done(page);
    await right.focus();
    await expect(loadedHalf(page, "right")).toHaveCount(1);
    await page.keyboard.press("ArrowLeft");
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${second}$`));
    island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([FIRST]);

    // Away by a link, which the router follows without a document load.
    await page.locator("main").getByRole("link", { name: sharedDoc.title }).first().click();
    await expect(page).toHaveURL(new RegExp(`/doc/${sharedDoc.slug}\\?at=${first}$`));
    await expect(bodyEditor(page)).toBeVisible();

    // The router restores the page it rendered for that entry, which is the
    // first pair's. The view asks for the address's pair, and shows that.
    const pairs = pairRequests(page);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${second}$`));
    island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([FIRST]);
    await expect(page.locator("main").getByText(/when last read/)).toHaveCount(0);
    // One request for it: the view has no pair to keep a side from, so the server reads this one.
    expect(pairs).toEqual([pairPath(`${id}@${first}`, `${id}@${second}`)]);
    // Its sliders are where the address puts them.
    await sliderOf(page, "left").focus();
    await expect(right).toHaveValue("1");
    await expect(sliderOf(page, "left")).toHaveValue("0");
  });

  test("a link followed before the address is written: Back returns to the pair last slid to, and the page gone to keeps its address", async ({
    page,
    sharedDoc,
  }) => {
    const id = sharedDoc.id;
    const [first] = await getDocYdocUpdateIds(id);
    const second = await appendTestDocParagraph({ docId: id, text: FIRST });
    await appendTestDocParagraph({ docId: id, text: SECOND });

    await gotoOk(page, `/diff/${id}@${first}/${id}`);
    await done(page);
    await sliderOf(page, "right").focus();
    await expect(loadedHalf(page, "right")).toHaveCount(1);

    // The left header's link goes to the doc at the left side's version, which this move doesn't change.
    const away = page.locator("main").getByRole("link", { name: sharedDoc.title }).first();
    await page.keyboard.press("ArrowLeft");
    await away.click();
    await expect(page).toHaveURL(new RegExp(`/doc/${sharedDoc.slug}\\?at=${first}$`));
    await expect(bodyEditor(page)).toBeVisible();
    // Past the wait: the write that was pending was made before leaving, and none is made after.
    await page.waitForTimeout(1000);
    await expect(page).toHaveURL(new RegExp(`/doc/${sharedDoc.slug}\\?at=${first}$`));

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${second}$`));
    const island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([FIRST]);
  });

  test("one request at a time: positions passed while one is out are never asked for", async ({ page, sharedDoc }) => {
    const id = sharedDoc.id;
    const [first] = await getDocYdocUpdateIds(id);
    await appendTestDocParagraph({ docId: id, text: FIRST });
    const third = await appendTestDocParagraph({ docId: id, text: SECOND });
    await appendTestDocParagraph({ docId: id, text: THIRD });
    const right = sliderOf(page, "right");

    await serverReadsEveryPair(page);
    await gotoOk(page, `/diff/${id}@${first}/${id}`);
    await done(page);
    await right.focus();
    await expect(loadedHalf(page, "right")).toHaveCount(1);
    await expect(right).toHaveValue("3");

    // Every request for a pair is held until released.
    const asked: string[] = [];
    const release: (() => void)[] = [];
    await page.route(/\/api\/diff\//, async (route) => {
      asked.push(new URL(route.request().url()).pathname);
      await new Promise<void>((resolve) => release.push(resolve));
      await route.continue();
    });

    await page.keyboard.press("ArrowLeft");
    const firstAsked = pairPath(`${id}@${first}`, `${id}@${third}`);
    await expect.poll(() => asked).toEqual([firstAsked]);
    // Two more positions while that one is out.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(right).toHaveValue("0");
    // The address rests on the last position, though no rows have come for it…
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${first}$`));
    // …the rows are still the first pair's, and say they trail…
    await expect(page.locator('[data-state="comparing"] [data-kind="added"] [data-side="new"]')).toHaveText([FIRST, SECOND, THIRD]);
    // …and nothing else was asked for.
    expect(asked).toEqual([firstAsked]);

    // Its answer lands, and the next request is for where the slider is now. The one between was never sent.
    release.shift()!();
    const lastAsked = pairPath(`${id}@${first}`, `${id}@${first}`);
    await expect.poll(() => asked).toEqual([firstAsked, lastAsked]);
    release.shift()!();
    const island = await done(page);
    await expect(island.locator('[data-kind="no-differences"]')).toBeVisible();
    expect(asked).toEqual([firstAsked, lastAsked]);
  });

  test("a drag is followed while the pointer is down", async ({ page, sharedDoc }) => {
    const id = sharedDoc.id;
    const [first] = await getDocYdocUpdateIds(id);
    const second = await appendTestDocParagraph({ docId: id, text: FIRST });
    await appendTestDocParagraph({ docId: id, text: SECOND });
    const right = sliderOf(page, "right");

    await gotoOk(page, `/diff/${id}@${first}/${id}`);
    await done(page);
    await right.focus();
    await expect(loadedHalf(page, "right")).toHaveCount(1);

    // Three positions: the track's right end, its middle and its left end.
    const box = (await right.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 8, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, y, { steps: 5 });
    // The rows follow with the pointer still down…
    let island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([FIRST]);
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${second}$`));
    // …on the same input, which goes on following it.
    await page.mouse.move(box.x + 8, y, { steps: 5 });
    await expect(right).toHaveValue("0");
    island = await done(page);
    await expect(island.locator('[data-kind="no-differences"]')).toBeVisible();
    await page.mouse.up();
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${first}$`));
  });

  test("a slid side keeps the reader's place on a long page", async ({ page, sharedDoc }) => {
    const [first] = await getDocYdocUpdateIds(sharedDoc.id);
    await appendTestDocParagraph({ docId: sharedDoc.id, text: FIRST });
    // Sixty paragraphs the other side lacks: sixty rows, taller than the window.
    const long = await createTestDoc({
      authorEmail: ADMIN_EMAIL,
      visibility: "SHARED",
      body: {
        type: "doc",
        content: Array.from({ length: 60 }, (_, i) => ({
          type: "paragraph",
          content: [{ type: "text", text: `Paragraph ${i + 1} of a long doc, which the other side never had.` }],
        })),
      },
    });
    try {
      await gotoOk(page, `/diff/${long.id}/${sharedDoc.id}`);
      let island = await done(page);
      await expect(island.locator('[data-side="old"]')).toHaveCount(60);
      await page.evaluate(() => window.scrollTo(0, 700));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(700);

      // A key on an untouched slider moves nothing: its index has to be there first.
      await sliderOf(page, "right").focus();
      await expect(loadedHalf(page, "right")).toHaveCount(1);
      await page.keyboard.press("ArrowLeft");
      await expect(page).toHaveURL(new RegExp(`/diff/${long.id}/${sharedDoc.id}@${first}$`));
      island = await done(page);
      await expect(island.locator('[data-side="old"]')).toHaveCount(60);
      expect(await page.evaluate(() => window.scrollY)).toBe(700);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(long.id);
    }
  });

  test("an index and a log fetched before the doc's later updates are fetched again", async ({ page, sharedDoc }) => {
    const FOURTH = "A fifth paragraph, appended as the doc's fifth version.";
    const id = sharedDoc.id;
    const [first] = await getDocYdocUpdateIds(id);
    const second = await appendTestDocParagraph({ docId: id, text: FIRST });
    await appendTestDocParagraph({ docId: id, text: SECOND });
    const requests = indexRequests(page);
    const logs = logRequests(page);
    const pairs = pairRequests(page);
    const left = sliderOf(page, "left");
    const right = sliderOf(page, "right");

    await gotoOk(page, `/diff/${id}@${first}/${id}`);
    await done(page);
    // The log as it is now: answered, not only asked for, before the doc moves on.
    const logged = page.waitForResponse((res) => LOG.test(new URL(res.url()).pathname));
    await left.focus();
    await expect(right).toHaveAttribute("max", "2");
    expect(requests).toHaveLength(1);
    await (await logged).finished();
    expect(logs).toHaveLength(1);

    // The doc moves on twice, and nothing tells this page: it has no connection.
    const fourth = await appendTestDocParagraph({ docId: id, text: THIRD });
    await appendTestDocParagraph({ docId: id, text: FOURTH });
    await expect(right).toHaveAttribute("max", "2");

    // A move of the other side keeps the side with no version as it was read.
    await left.press("ArrowRight");
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${second}/${id}$`));
    let island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([SECOND]);
    await expect(right).toHaveAttribute("max", "2");
    expect(pairs).toEqual([]);

    // Away from the live end and back to it is a read by the server, as the
    // doc is then. That side is now at an update the index doesn't hold: the
    // index is fetched again, and has it.
    await right.press("ArrowLeft");
    await done(page);
    await right.press("End");
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${second}/${id}$`));
    island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([SECOND, THIRD, FOURTH]);
    await expect(right).toHaveAttribute("max", "4");
    await expect(right).toHaveValue("4");
    await expect(left).toHaveValue("1");
    expect(requests).toHaveLength(2);
    expect(pairs).toEqual([pairPath(`${id}@${second}`, id)]);

    // One step back is a version the log, fetched before it was written,
    // doesn't hold: the log is fetched again, and the side is built from it.
    await right.press("ArrowLeft");
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${second}/${id}@${fourth}$`));
    island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([SECOND, THIRD]);
    expect(logs).toHaveLength(2);
    expect(pairs).toHaveLength(1);
  });

  test("a pair put together in the browser is the pair its address gives on reload, chips and all", async ({
    page,
    secondUser,
    sharedDoc,
  }) => {
    // An AUTHOR: someone the suite's ADMIN may mention, so the chip-context
    // endpoint answers for them though the doc's body no longer names them.
    const { user: reviewer } = await secondUser({ role: "AUTHOR" });
    const id = sharedDoc.id;
    const quoted = paragraph(words(QUOTED_BODY));
    const [first] = await getDocYdocUpdateIds(id);
    const second = await setTestDocBody({
      docId: id,
      content: [quoted, paragraph(words("Reviewed by "), mention("m1", reviewer.id), words(", who signed it off."))],
    });
    const third = await appendTestDocParagraph({ docId: id, text: FIRST });
    await setTestDocBody({ docId: id, content: [quoted, paragraph(words("Not reviewed by anyone yet.")), paragraph(words(FIRST))] });
    const pairs = pairRequests(page);
    const contexts = requestsTo(page, /^\/api\/chip-context$/);
    const left = sliderOf(page, "left");
    const right = sliderOf(page, "right");

    await gotoOk(page, `/diff/${id}@${first}/${id}`);
    await done(page);
    await right.focus();
    await expect(loadedHalf(page, "right")).toHaveCount(1);

    // Each pair as slid to, then as its own address loads it.
    const slid: { path: string; facts: Awaited<ReturnType<typeof pairFacts>> }[] = [];
    const keep = async (leftAt: string, rightAt: string) => {
      const path = `/diff/${id}@${leftAt}/${id}@${rightAt}`;
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      slid.push({ path, facts: await pairFacts(page) });
    };

    // The right side at the version that mentions the reviewer, by name.
    await right.press("ArrowLeft");
    await keep(first, third);
    expect(slid[0].facts.rows).toContain(`Reviewed by @${reviewer.name}, who signed it off.`);
    expect(await orderLabels(page)).toEqual(["Earlier", "Later"]);
    await right.press("ArrowLeft");
    await keep(first, second);
    // Both sides moved, and crossed: the later on the left.
    await left.press("End");
    await left.press("ArrowLeft");
    await keep(third, second);
    expect(slid[2].facts.notes).toEqual(["later-on-left"]);
    await left.press("ArrowLeft");
    await keep(second, second);
    expect(slid[3].facts.rows).toContain("No differences.");

    // The server was asked for no pair but the one `End` named, and for the
    // reviewer's record once.
    expect(pairs).toEqual([pairPath(id, `${id}@${second}`)]);
    expect(contexts).toHaveLength(1);

    for (const { path, facts } of slid) {
      await gotoOk(page, path);
      expect(await pairFacts(page), path).toEqual(facts);
    }
  });

  test("a version that mentions someone this viewer can't be answered for is read by the server, whole", async ({
    page,
    secondUser,
    sharedDoc,
  }) => {
    // A COMMENTER is nobody the ADMIN may mention, and the doc's body no
    // longer names them: the endpoint answers nothing for them. The server,
    // which labels a version from every record, reads them by name.
    const { user: outsider } = await secondUser({ role: "COMMENTER" });
    const id = sharedDoc.id;
    const quoted = paragraph(words(QUOTED_BODY));
    const [first] = await getDocYdocUpdateIds(id);
    const second = await setTestDocBody({
      docId: id,
      content: [quoted, paragraph(words("Raised by "), mention("m1", outsider.id), words(" in a comment."))],
    });
    const third = await setTestDocBody({ docId: id, content: [quoted, paragraph(words("Raised in a comment."))] });
    await appendTestDocParagraph({ docId: id, text: FIRST });
    const pairs = pairRequests(page);
    const contexts = requestsTo(page, /^\/api\/chip-context$/);
    const right = sliderOf(page, "right");
    const named = `Raised by @${outsider.name} in a comment.`;

    await gotoOk(page, `/diff/${id}@${first}/${id}`);
    await done(page);
    await right.focus();
    await expect(loadedHalf(page, "right")).toHaveCount(1);

    // A version with no chip is built here.
    await right.press("ArrowLeft");
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${third}$`));
    await done(page);
    expect(pairs).toEqual([]);
    expect(contexts).toEqual([]);

    // The version with the mention: asked about once, not answered, and the
    // server reads the pair. Never "unknown person", which a reload wouldn't show.
    const asked = pairPath(`${id}@${first}`, `${id}@${second}`);
    await right.press("ArrowLeft");
    await expect(page).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${second}$`));
    let island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([named]);
    expect(pairs).toEqual([asked]);
    expect(contexts).toHaveLength(1);
    const facts = await pairFacts(page);

    // Away and back: the server again, and the endpoint isn't asked twice.
    await right.press("ArrowRight");
    await done(page);
    await right.press("ArrowLeft");
    island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([named]);
    expect(pairs).toEqual([asked, asked]);
    expect(contexts).toHaveLength(1);

    await gotoOk(page, `/diff/${id}@${first}/${id}@${second}`);
    expect(await pairFacts(page)).toEqual(facts);
  });

  test("a parent's side built in the browser is placed against the fork point as the server places it", async ({ page, sharedDoc }) => {
    const parent = sharedDoc.id;
    const [first] = await getDocYdocUpdateIds(parent);
    const forkPoint = await appendTestDocParagraph({ docId: parent, text: FIRST });
    const forked = await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: parent, revision: forkPoint, visibility: "SHARED" });
    if (!forked.ok) throw new Error(forked.message);
    try {
      const past = await appendTestDocParagraph({ docId: parent, text: SECOND });
      await appendTestDocParagraph({ docId: parent, text: THIRD });
      const pairs = pairRequests(page);
      const left = sliderOf(page, "left");

      // The parent at its first version against the fork: the parent is the earlier.
      await gotoOk(page, `/diff/${parent}@${first}/${forked.id}`);
      await done(page);
      expect(await orderLabels(page)).toEqual(["Earlier", "Later"]);
      await left.focus();
      await expect(loadedHalf(page, "left")).toHaveCount(1);

      const slid: { path: string; facts: Awaited<ReturnType<typeof pairFacts>> }[] = [];
      const keep = async (at: string) => {
        const path = `/diff/${parent}@${at}/${forked.id}`;
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        slid.push({ path, facts: await pairFacts(page) });
      };
      // At the fork point: still the earlier, and nothing differs.
      await left.press("ArrowRight");
      await keep(forkPoint);
      expect(await orderLabels(page)).toEqual(["Earlier", "Later"]);
      expect(slid[0].facts.notes).toEqual([]);
      // Past it: no order, and the line that says both have changed.
      await left.press("ArrowRight");
      await keep(past);
      expect(await orderLabels(page)).toEqual(["", ""]);
      expect(slid[1].facts.notes).toEqual(["both-changed"]);
      expect(pairs).toEqual([]);

      // The fork's side is the doc as it was read, whose time a reload moves: the rest is compared.
      const timeless = (facts: (typeof slid)[number]["facts"]) => ({ ...facts, sides: facts.sides.replace(/when last read, .*/, "") });
      for (const { path, facts } of slid) {
        await gotoOk(page, path);
        expect(timeless(await pairFacts(page)), path).toEqual(timeless(facts));
      }
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(forked.id);
    }
  });

  test("a request that fails leaves the rows under a line saying so, and Try again or the next move recovers", async ({
    page,
    sharedDoc,
  }) => {
    const id = sharedDoc.id;
    const [first] = await getDocYdocUpdateIds(id);
    await appendTestDocParagraph({ docId: id, text: FIRST });
    await appendTestDocParagraph({ docId: id, text: SECOND });
    const failure = page.locator('[data-kind="load-failed"]');

    await serverReadsEveryPair(page);
    await gotoOk(page, `/diff/${id}@${first}/${id}`);
    await done(page);
    await sliderOf(page, "right").focus();
    await expect(loadedHalf(page, "right")).toHaveCount(1);

    let failing = true;
    await page.route(/\/api\/diff\//, (route) => (failing ? route.abort() : route.continue()));

    await page.keyboard.press("ArrowLeft");
    await expect(failure).toBeVisible();
    // The rows of the pair before, not marked done.
    await expect(page.locator('[data-state="comparing"] [data-kind="added"] [data-side="new"]')).toHaveText([FIRST, SECOND]);
    await expect(page.locator('[data-state="done"]')).toHaveCount(0);

    failing = false;
    await failure.getByRole("button", { name: "Try again" }).click();
    let island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([FIRST]);
    await expect(failure).toHaveCount(0);

    // Failed again, and this time left alone: a move asks for the pair moved
    // to. The button took the focus when clicked, so the slider is pressed.
    failing = true;
    await sliderOf(page, "right").press("ArrowLeft");
    await expect(failure).toBeVisible();
    failing = false;
    await page.keyboard.press("End");
    island = await done(page);
    await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText([FIRST, SECOND]);
    await expect(failure).toHaveCount(0);
  });

  test("a refusal of a pair the server reads ends on the page that says it, at the address moved to", async ({ page, secondUser, sharedDoc }) => {
    const other = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: QUOTED_BODY });
    try {
      // The doc deleted under an open diff: the next move is its 404.
      const [first] = await getDocYdocUpdateIds(other.id);
      const second = await appendTestDocParagraph({ docId: other.id, text: FIRST });
      await appendTestDocParagraph({ docId: other.id, text: SECOND });
      await serverReadsEveryPair(page);
      await gotoOk(page, `/diff/${other.id}@${first}/${other.id}`);
      await done(page);
      await sliderOf(page, "right").focus();
      await expect(loadedHalf(page, "right")).toHaveCount(1);
      await page.keyboard.press("ArrowLeft");
      await expect(page).toHaveURL(new RegExp(`/diff/${other.id}@${first}/${other.id}@${second}$`));
      await done(page);

      await softDeleteTestDoc(other.id);
      const gone = `/diff/${other.id}@${first}/${other.id}@${first}`;
      const answered = page.waitForResponse((res) => res.request().isNavigationRequest() && new URL(res.url()).pathname === gone);
      await page.keyboard.press("ArrowLeft");
      expect((await answered).status()).toBe(404);
      await expect(page).toHaveURL(new RegExp(`${gone}$`));
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(other.id);
    }

    // The history taken away: an EDITOR sees a SHARED doc's, an AUTHORIZED reader doesn't.
    const id = sharedDoc.id;
    const [first] = await getDocYdocUpdateIds(id);
    const second = await appendTestDocParagraph({ docId: id, text: FIRST });
    await appendTestDocParagraph({ docId: id, text: SECOND });
    const { user, page: editor } = await secondUser({ role: "EDITOR" });
    const open = async (viewer: Page) => {
      await serverReadsEveryPair(viewer);
      await gotoOk(viewer, `/diff/${id}@${first}/${id}`);
      await done(viewer);
      await sliderOf(viewer, "right").focus();
      await expect(loadedHalf(viewer, "right")).toHaveCount(1);
    };
    await open(editor);
    await setTestUserRole(user.email, "AUTHORIZED");
    // A role reaches a session already issued when the session is refreshed,
    // which /dashboard does, here in another tab.
    const tab = await editor.context().newPage();
    const refreshed = tab.waitForResponse((res) => res.request().method() === "POST" && res.url().includes("/api/auth/session"));
    await tab.goto("/dashboard");
    await refreshed;
    await tab.close();
    await editor.keyboard.press("ArrowLeft");
    await expect(editor.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    await expect(editor).toHaveURL(new RegExp(`/diff/${id}@${first}/${id}@${second}$`));
    await expect(editor.locator("[data-state]")).toHaveCount(0);

    // Signed out: sign-in, with the pair moved to as its way back.
    const { page: leaver } = await secondUser({ role: "EDITOR" });
    await open(leaver);
    await leaver.context().clearCookies();
    await leaver.keyboard.press("ArrowLeft");
    await expect(leaver).toHaveURL(/\/sign-in\?/);
    expect(new URL(leaver.url()).searchParams.get("callbackUrl")).toBe(`/diff/${id}@${first}/${id}@${second}`);
  });

  test("the pair route answers as the page does, and says which update a side was read at only to a viewer with its history", async ({
    page,
    browser,
    sharedDoc,
    draftDoc,
    secondUser,
  }) => {
    const id = sharedDoc.id;
    const [first] = await getDocYdocUpdateIds(id);
    const second = await appendTestDocParagraph({ docId: id, text: FIRST });
    const [foreign] = await getDocYdocUpdateIds(draftDoc.id);
    type Side = { docId: string; updateId: string | null; history: boolean; nowVersion: string | null; blocks: { text: string }[] | null };
    type Body = { order: string | null; diverged: boolean; readAt: string; left: Side; right: Side };

    // An editor: both sides as the page reads them, and never cached.
    const res = await page.request.get(pairPath(`${id}@${first}`, id));
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("no-store");
    const body = (await res.json()) as Body;
    expect(body.order).toBe("left-earlier");
    expect(body.left).toMatchObject({ docId: id, updateId: first, history: true, nowVersion: null });
    expect(body.right).toMatchObject({ docId: id, updateId: null, history: true, nowVersion: second });
    expect(body.left.blocks!.map((block) => block.text)).toEqual([QUOTED_BODY]);
    expect(body.right.blocks!.map((block) => block.text)).toEqual([QUOTED_BODY, FIRST]);
    expect(Number.isNaN(Date.parse(body.readAt))).toBe(false);
    // The segment with its @ percent-encoded is the same pair.
    expect((await page.request.get(pairPath(`${id}%40${first}`, id))).status()).toBe(200);

    // The page's 404s: a version outside the doc's log, one past the bound, a slug, a deleted side.
    for (const left of [`${id}@${foreign}`, `${id}@${MAX_UPDATE_ID}`, `${id}@${PAST_THE_BOUND}`, sharedDoc.slug, "nosuchdoc0000"]) {
      expect((await page.request.get(pairPath(left, id))).status(), left).toBe(404);
    }
    const deleted = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: FIRST });
    try {
      await softDeleteTestDoc(deleted.id);
      expect((await page.request.get(pairPath(id, deleted.id))).status()).toBe(404);
      expect((await page.request.get(pairPath(deleted.id, id))).status()).toBe(404);
    } finally {
      await deleteTestDoc(deleted.id);
    }

    // AUTHORIZED reads every SHARED doc and has no doc's history: two docs as
    // they are now, and nothing about either log, its newest update included.
    const { page: reader } = await secondUser({ role: "AUTHORIZED" });
    const now = await reader.request.get(pairPath(id, id));
    expect(now.status()).toBe(200);
    const nowBody = (await now.json()) as Body;
    for (const side of [nowBody.left, nowBody.right]) {
      expect(side).toMatchObject({ docId: id, updateId: null, history: false, nowVersion: null });
      expect(side.blocks!.map((block) => block.text)).toEqual([QUOTED_BODY, FIRST]);
    }
    // Any version is Forbidden, whatever the id: in the log, another doc's, nobody's.
    for (const version of [first, foreign, MAX_UPDATE_ID]) {
      const refused = await reader.request.get(pairPath(`${id}@${version}`, id));
      expect(refused.status(), version).toBe(403);
      expect(await refused.json(), version).toEqual({ error: "Forbidden" });
    }
    // A doc that reader can't read refuses the pair, with a version or without.
    expect((await reader.request.get(pairPath(id, draftDoc.id))).status()).toBe(403);
    expect((await reader.request.get(pairPath(`${draftDoc.id}@${foreign}`, id))).status()).toBe(403);

    // Signed out: refused before either doc is looked at.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      expect((await context.request.get(pairPath(id, id))).status()).toBe(401);
      expect((await context.request.get(pairPath("nosuchdoc0000", id))).status()).toBe(401);
    } finally {
      await context.close();
    }
  });

  test("the index is for whoever may see the doc's history, and answers everyone else alike", async ({
    page,
    browser,
    sharedDoc,
    draftDoc,
    secondUser,
  }) => {
    const ids = await getDocYdocUpdateIds(sharedDoc.id);
    const path = (docId: string) => `/api/doc/${docId}/versions`;

    // An editor: the log's ids and times, oldest first, and none of its bytes.
    const res = await page.request.get(path(sharedDoc.id));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { updates: Record<string, unknown>[] };
    expect(body.updates.map((update) => update.id)).toEqual(ids);
    expect(Object.keys(body.updates[0]).sort()).toEqual(["createdAt", "id"]);
    expect(Number.isNaN(Date.parse(body.updates[0].createdAt as string))).toBe(false);

    // AUTHORIZED reads every SHARED doc and edits none. A doc it can read, one
    // it can't, a deleted one and an id that is nobody's all answer the same.
    const { page: reader } = await secondUser({ role: "AUTHORIZED" });
    const deleted = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: FIRST });
    try {
      await softDeleteTestDoc(deleted.id);
      for (const docId of [sharedDoc.id, draftDoc.id, deleted.id, "nosuchdoc0000"]) {
        const refused = await reader.request.get(path(docId));
        expect(refused.status(), docId).toBe(403);
        expect(await refused.json(), docId).toEqual({ error: "Forbidden" });
      }
      // A deleted doc has no history for its own editor either.
      expect((await page.request.get(path(deleted.id))).status()).toBe(403);

      // That reader's diff of two docs as they are has no bar, and makes no room for one.
      await gotoOk(reader, `/diff/${sharedDoc.id}/${sharedDoc.id}`);
      await done(reader);
      await expect(bar(reader)).toHaveCount(0);
    } finally {
      await deleteTestDoc(deleted.id);
    }

    // Signed out: refused before the doc is looked at.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      expect((await context.request.get(path(sharedDoc.id))).status()).toBe(401);
    } finally {
      await context.close();
    }
  });
});

// docs/FORKS.md "A doc as it is now" — the collab server appends a log row on
// every update and writes the `ydoc` row only at its store debounce, two
// seconds of quiet and ten at most while someone types. The scrub bar hands
// out log ids, so the stored row alone can be older than the version a reader
// has just scrubbed to, and a "now" read from it would put the *earlier* text
// on the right.
//
// Typed over a socket of this test's own, which never goes quiet: an edit
// through /admin/doc-edit stores as its connection closes and leaves no gap
// to test.
test.describe("a diff with now while someone is typing", () => {
  // With the schema version every socket states (docs/YDOC.md "A tab whose
  // schema is out of date is refused"), as the app's own `getCollabUrl` adds it.
  const COLLAB_URL = withSchemaVersion(`ws://${DEV_HOST}:${COLLAB_PORT}`);

  test("has the scrubbed-to version's text on the left and the later text on the right, and the bar says changes came in", async ({
    page,
    sharedDoc,
  }) => {
    const id = sharedDoc.id;
    // The route compiled before the clock starts, on the dev target.
    await gotoOk(page, `/diff/${id}/${id}`);
    await done(page);

    const res = await page.request.post(`/api/doc/${id}/token`);
    expect(res.ok(), `token route answered ${res.status()}`).toBe(true);
    const { token, documentName } = (await res.json()) as { token: string; documentName: string };

    const live = new Y.Doc();
    const provider = new HocuspocusProvider({ url: COLLAB_URL, name: documentName, document: live, token });
    let typing: ReturnType<typeof setInterval> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${documentName} never synced`)), 15_000);
        provider.on("synced", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      await page.goto(`/doc/${sharedDoc.slug}`);
      await expect(bodyEditor(page)).toBeVisible();
      await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });

      // A word every 100ms at the end of the doc's one paragraph, each an
      // update of its own, so the text only ever grows.
      const text = (live.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText;
      let word = 0;
      typing = setInterval(() => text.insert(text.length, ` word${++word}`), 100);

      // The reading view follows, and then the bar's history holds what was typed so far.
      await expect(bodyEditor(page)).toContainText("word3", { timeout: 15_000 });
      await page.getByLabel(SLIDER).focus();
      // The loaded bar's own control: the inert slider it replaces has a `max` too.
      await expect(page.getByRole("button", { name: "Pin this version" })).toBeVisible({ timeout: 15_000 });
      const max = Number(await page.getByLabel(SLIDER).getAttribute("max"));
      expect(max).toBeGreaterThan(3);

      // The one live thing the bar does: it says its history is behind.
      await expect(page.locator('[data-kind="changes-came-in"]')).toContainText("Changes have come in since this history loaded", {
        timeout: 15_000,
      });

      // One back from the head the bar loaded: a version typed moments ago.
      await scrubTo(page, max - 1);
      await expect(page.getByRole("button", FROZEN)).toBeVisible();
      await expect(bodyEditor(page)).toContainText("word1");
      const scrubbedText = (await bodyEditor(page).innerText()).trim();
      expect(scrubbedText.startsWith(QUOTED_BODY)).toBe(true);

      await page.getByRole("link", { name: "Diff with now" }).click();
      await expect(page).toHaveURL(new RegExp(`/diff/${id}@[0-9]+/${id}$`));
      const island = await done(page);
      const row = island.locator('[data-kind="changed"]');
      await expect(row).toHaveCount(1);
      const left = ((await row.locator('[data-side="old"]').textContent()) ?? "").trim();
      const right = ((await row.locator('[data-side="new"]').textContent()) ?? "").trim();
      // The left is the version the slider was on, and the right has all of
      // it and what was typed after: never less than a version the bar handed out.
      expect(left).toBe(scrubbedText);
      expect(right.startsWith(left)).toBe(true);
      expect(right.length).toBeGreaterThan(left.length);
      expect(await orderLabels(page)).toEqual(["Earlier", "Later"]);
    } finally {
      clearInterval(typing);
      provider.destroy();
      live.destroy();
    }
  });
});
