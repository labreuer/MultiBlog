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
  getDocYdocUpdateIds,
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
  const whens = page.locator("main").getByText(/when this page loaded|as it was at/);
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
