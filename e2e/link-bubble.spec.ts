// The link bubble (src/components/LinkBubble.tsx; docs/TIPTAP.md, "A link
// opens from its bubble, not from a click") and the link popover's two
// boxes (LinkControls.tsx; TIPTAP.md, "The link popover is a form"). Driven through the doc editor: the annotation editor
// builds its StarterKit from the same EDITOR_LINK_OPTIONS and mounts the
// same LinkControls, so what is pinned here is the shared behaviour.
//
// The favicon is fetched by the browser straight from the linked site —
// the design's whole point, no server-side fetch of a user-supplied URL —
// so the icon host is intercepted with page.route rather than let out to
// the network. But Playwright itself aborts every request whose URL ends
// in /favicon.ico, in every browser, before routes or request events see
// it (playwright-core's requestStarted, `_isFavicon`; e2e/README.md), so
// the third-party derivation, <origin>/favicon.ico, cannot be observed
// here at all: under Playwright every third-party site takes the globe
// fallback. What is covered instead is the own-site branch, which reads
// the document's <link rel="icon"> and so can be pointed at a routed URL,
// and the <img> path end to end behind it.
//
// Links are created the way an author would — caret in place, Ctrl/⌘-K,
// type, Enter — rather than seeded as marks, so the popover's own paths are
// under test too. With nothing selected and no title typed, LinkControls
// inserts the href as the link's text, which is what makes each link
// addressable by name below.
import type { Page } from "@playwright/test";
import { test as base, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestDoc,
  createTestUser,
  deleteTestDoc,
  deleteTestUser,
  uniqueEmail,
  uniqueTitle,
  type TestDoc,
} from "./db";

// Each link goes at the end of its own paragraph. Appending a second link
// straight after a first would extend the first: TipTap's Link is
// inclusive while autolink is on, so a space typed at a link's end carries
// its mark.
const PARAGRAPHS = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";

const ICON_HOST = "https://icon.example";
const SITE_ICON = `${ICON_HOST}/site-icon.png`;
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const test = base.extend<{ linkDoc: TestDoc }>({
  // A doc of the shared admin's, open in the editor and synced, with the
  // icon host already intercepted — a 1×1 PNG for anything under it.
  linkDoc: async ({ page }, use) => {
    await page.route(`${ICON_HOST}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_1X1, "base64") }),
    );
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: PARAGRAPHS });
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    await use(doc);
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  },
});

/** The bubble under the caret's link — a labelled group; the toolbar's own "Link" is a button. */
function bubble(page: Page) {
  return page.getByRole("group", { name: "Link", exact: true });
}

/** The link popover's title box: the link's text, and nothing else. */
function titleInput(page: Page) {
  return page.getByRole("textbox", { name: "Link title" });
}

/** The link popover's URL box — a URL, or the doc search. */
function urlInput(page: Page) {
  return page.getByRole("combobox", { name: "Link URL or doc search" });
}

/** A link in the body, by the text it carries — which appendLink makes its href. */
function bodyLink(page: Page, name: string) {
  return bodyEditor(page).getByRole("link", { name, exact: true });
}

/**
 * Puts the selection on the text node holding `needle` — collapsed to its
 * end, or covering the whole node — as a DOM Range plus a `selectionchange`
 * dispatch, collapseToBodyStart's recipe, rather than a click and keypresses
 * that the next keystroke could race (fixtures.ts on why). focus() rather
 * than a click to get the editor focused: a bubble hangs *under* its link's
 * line, over whatever paragraph comes next, and a click landing there would
 * hit the bubble instead.
 */
async function selectIn(page: Page, needle: string, how: "caret-at-end" | "whole-node"): Promise<void> {
  await bodyEditor(page).focus();
  await page.evaluate(
    ({ text, how }) => {
      const root = document.querySelector('[aria-label="Post body"]');
      if (!root) throw new Error("Body editor not found.");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.includes(text)) continue;
        const range = document.createRange();
        if (how === "whole-node") {
          range.setStart(node, 0);
          range.setEnd(node, node.textContent.length);
        } else {
          range.setStart(node, node.textContent.length);
          range.collapse(true);
        }
        const selection = window.getSelection();
        if (!selection) throw new Error("No selection available.");
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return;
      }
      throw new Error(`"${text}" not found in the body editor.`);
    },
    { text: needle, how },
  );
}

/** Collapses the caret to the end of the paragraph holding `needle`. */
function caretAtEndOf(page: Page, needle: string): Promise<void> {
  return selectIn(page, needle, "caret-at-end");
}

/**
 * Appends " " + a link whose text is `href` to the paragraph holding
 * `paragraph`, through the popover, which opens on the URL box. The title
 * left empty, the href is the text.
 */
async function appendLink(page: Page, paragraph: string, href: string): Promise<void> {
  await caretAtEndOf(page, paragraph);
  await page.keyboard.type(" ");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(urlInput(page)).toBeFocused();
  await page.keyboard.type(href);
  await page.keyboard.press("Enter");
  await expect(urlInput(page)).toHaveCount(0);
  await expect(bodyLink(page, href)).toBeVisible();
}

test.describe("the link bubble (LinkBubble.tsx)", () => {
  test("a click in a link places the caret and raises the bubble; nothing opens", async ({ page, linkDoc }) => {
    void linkDoc;
    const href = `${ICON_HOST}/some/page`;
    await appendLink(page, "Paragraph one.", href);

    // Park the caret in plain text first, so the bubble seen after the click
    // is the click's doing and not left over from the insertion.
    await caretAtEndOf(page, "Paragraph three.");
    await expect(bubble(page)).toHaveCount(0);

    let opened = 0;
    page.context().on("page", () => {
      opened += 1;
    });
    await bodyLink(page, href).click();

    // openOnClick off (EDITOR_LINK_OPTIONS): with it on, this click would
    // have window.open'd the target, and Playwright would report a second
    // page in the context.
    const b = bubble(page);
    await expect(b).toBeVisible();
    expect(opened).toBe(0);
    expect(page.context().pages()).toHaveLength(1);
    await expect(bodyEditor(page)).toBeFocused();

    // The one line: the href as a real link to the target, and three
    // controls.
    const out = b.getByRole("link", { name: href });
    await expect(out).toHaveAttribute("href", href);
    await expect(out).toHaveAttribute("target", "_blank");
    await expect(b.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(b.getByRole("button", { name: "Edit link" })).toBeVisible();
    await expect(b.getByRole("button", { name: "Remove link" })).toBeVisible();

    // The icon: this site's /favicon.ico is what the bubble asks for, and
    // Playwright aborts exactly that (header comment) — which is the
    // fallback's own trigger. The globe, and no broken <img> beside it.
    await expect(b.locator("svg.tabler-icon-world")).toBeVisible();
    await expect(b.locator("img")).toHaveCount(0);

    // Under the link's line, hanging from its start (placePopover: a gap
    // below, the anchor's own left edge nudged right by the same gap).
    const linkBox = await bodyLink(page, href).boundingBox();
    const bubbleBox = await b.boundingBox();
    expect(linkBox).not.toBeNull();
    expect(bubbleBox).not.toBeNull();
    expect(bubbleBox!.y).toBeGreaterThanOrEqual(linkBox!.y + linkBox!.height);
    expect(bubbleBox!.x).toBeGreaterThanOrEqual(linkBox!.x);
    expect(bubbleBox!.x - linkBox!.x).toBeLessThan(12);
  });

  test("the icon is the site's own, lazily loaded — the own-site branch, through <link rel=icon>", async ({
    page,
    linkDoc,
  }) => {
    void linkDoc;
    // For a link on this origin, faviconFor reads the document's first
    // <link rel~="icon"> rather than guessing /favicon.ico (docs/FAVICON.md:
    // the real one is content-hashed). Prepended, so it is the first whether
    // or not build-icons.ts has run in this checkout.
    await page.evaluate((href) => {
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = href;
      document.head.prepend(link);
    }, SITE_ICON);

    // Same origin but not a doc, so no preview fetch is involved.
    const href = "/docs";
    await appendLink(page, "Paragraph one.", href);
    await bodyLink(page, href).click();

    const b = bubble(page);
    const icon = b.locator("img");
    await expect(icon).toHaveAttribute("src", SITE_ICON);
    await expect(icon).toHaveAttribute("loading", "lazy");
    // Decoded, not merely an <img> with a src.
    await expect.poll(() => icon.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
    await expect(b.locator("svg.tabler-icon-world")).toHaveCount(0);
  });

  test("Copy puts the absolute href on the clipboard and leaves the editor focused", async ({ page, linkDoc }) => {
    void linkDoc;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const href = `${ICON_HOST}/copied`;
    await appendLink(page, "Paragraph one.", href);
    await bodyLink(page, href).click();

    const b = bubble(page);
    await b.getByRole("button", { name: "Copy link" }).click();
    await expect(b.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(href);

    // The click did not take focus from the editor (mousedown is
    // prevented), so the bubble is still up — and the check mark gives way
    // to the copy icon again after its moment.
    await expect(bodyEditor(page)).toBeFocused();
    await expect(b.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(b).toBeVisible();
  });

  test("Edit opens the popover on the URL box with the href selected, so typing replaces it", async ({
    page,
    linkDoc,
  }) => {
    void linkDoc;
    const oldHref = `${ICON_HOST}/before`;
    const newHref = `${ICON_HOST}/after`;
    await appendLink(page, "Paragraph one.", oldHref);
    await bodyLink(page, oldHref).click();

    await bubble(page).getByRole("button", { name: "Edit link" }).click();
    // The title box shows the link's text (here, the href); the URL box is
    // the one that opens focused.
    const input = urlInput(page);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(oldHref);
    await expect(titleInput(page)).toHaveValue(oldHref);
    // Selected in full — the whole point of select-on-open. (selectionStart/
    // End, not a toHaveValue, since the value is the same either way.)
    expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([
      0,
      oldHref.length,
    ]);
    // The popover supersedes the bubble while it is open.
    await expect(bubble(page)).toHaveCount(0);

    // No select-all keystroke, no Backspace: typing over the selection is
    // the replacement.
    await page.keyboard.type(newHref);
    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);

    // The link's text is untouched; its href is the new one; and the bubble
    // is back, saying so.
    await expect(bodyLink(page, oldHref)).toHaveAttribute("href", newHref);
    await expect(bubble(page).getByRole("link", { name: newHref })).toBeVisible();

    // Ctrl/⌘-K on the same link takes the same path: the popover opens on
    // the current href, selected.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(newHref);
    expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([
      0,
      newHref.length,
    ]);
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
  });

  test("Remove unlinks the text in place", async ({ page, linkDoc }) => {
    void linkDoc;
    const href = `${ICON_HOST}/removed`;
    await appendLink(page, "Paragraph one.", href);
    await bodyLink(page, href).click();

    await bubble(page).getByRole("button", { name: "Remove link" }).click();
    await expect(bodyLink(page, href)).toHaveCount(0);
    await expect(bodyEditor(page)).toContainText(href);
    await expect(bubble(page)).toHaveCount(0);
  });
});

test.describe("a link into this site's docs previews the doc", () => {
  test("title, byline and last edit, for a relative and an absolute href alike", async ({ page, linkDoc }) => {
    void linkDoc;
    const target = await createTestDoc({
      authorEmail: ADMIN_EMAIL,
      title: uniqueTitle("bubble target"),
      visibility: "SHARED",
    });
    try {
      const relative = `/doc/${target.slug}`;
      await appendLink(page, "Paragraph one.", relative);
      await bodyLink(page, relative).click();

      const b = bubble(page);
      await expect(b).toContainText(target.title);
      // E2E Admin is the shared admin's name (auth.setup.ts); "just now"
      // because the doc was created moments ago (relative-time.ts).
      await expect(b).toContainText("E2E Admin");
      await expect(b).toContainText("Edited just now");

      // Copy resolves a relative href against the page, so what lands on
      // the clipboard is a URL that works anywhere.
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await b.getByRole("button", { name: "Copy link" }).click();
      await expect(b.getByRole("button", { name: "Copied" })).toBeVisible();
      const origin = new URL(page.url()).origin;
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}${relative}`);

      // The same doc by id, as an absolute URL on this origin — resolved as
      // /doc/[slug] would resolve it (id first, then slug).
      const absolute = `${origin}/doc/${target.id}`;
      await appendLink(page, "Paragraph two.", absolute);
      await bodyLink(page, absolute).click();
      await expect(b.getByRole("link", { name: absolute })).toBeVisible();
      await expect(b).toContainText(target.title);
      await expect(b).toContainText("E2E Admin");
    } finally {
      await deleteTestDoc(target.id);
    }
  });

  test("a doc the editor may not read says so; a doc that doesn't exist adds nothing", async ({
    page,
    linkDoc,
  }) => {
    void linkDoc;
    // A PRIVATE doc of someone else's: the shared admin's role earns no
    // bypass (docs/PERMISSIONS.md), and the reading route would answer with
    // Forbidden — which is exactly the line the bubble repeats.
    const other = uniqueEmail("bubble-other");
    await createTestUser({ email: other, name: "Other Author", role: "AUTHOR" });
    const privateDoc = await createTestDoc({
      authorEmail: other,
      title: uniqueTitle("bubble private"),
      visibility: "PRIVATE",
    });
    try {
      const forbidden = `/doc/${privateDoc.slug}`;
      await appendLink(page, "Paragraph one.", forbidden);
      await bodyLink(page, forbidden).click();

      const b = bubble(page);
      await expect(b).toContainText("You don't have permission to read this doc.");
      await expect(b).not.toContainText(privateDoc.title);
      await expect(b).not.toContainText("Other Author");

      // No such doc: the bubble stays its one line. Absence can't be waited
      // for, so wait for the lookup itself: the bubble is aria-busy from its
      // first paint until the preview answers, "no such doc" included, and
      // only then assert nothing was added. This used to wait for the server
      // action's POST, told apart from the popover's own search by the slug
      // in its body — but Playwright only has a request's body if it read it
      // before the request completed, and at 6+ workers the lookup regularly
      // finished first, leaving postData() null and the wait to time out
      // while the screenshot showed the bubble sitting there correct.
      const missing = `/doc/no-such-doc-${Date.now()}`;
      await appendLink(page, "Paragraph two.", missing);
      await bodyLink(page, missing).click();
      await expect(b).toBeVisible();
      await expect(b).toHaveAttribute("aria-busy", "false");
      await expect(b.getByRole("link", { name: missing })).toBeVisible();
      await expect(b).not.toContainText("Edited");
      await expect(b).not.toContainText("permission");
    } finally {
      await deleteTestDoc(privateDoc.id);
      await deleteTestUser(other);
    }
  });
});

test.describe("the link popover: a title box over a URL box (LinkControls.tsx)", () => {
  test("the URL box searches docs; a pick fills it and an empty title, and Save links the doc", async ({
    page,
    linkDoc,
  }) => {
    void linkDoc;
    const title = uniqueTitle("picked target");
    const target = await createTestDoc({ authorEmail: ADMIN_EMAIL, title, visibility: "SHARED" });
    try {
      await caretAtEndOf(page, "Paragraph one.");
      await page.keyboard.type(" ");
      await page.keyboard.press("ControlOrMeta+k");
      const urlBox = urlInput(page);
      await expect(urlBox).toBeFocused();
      // Where the popover opened is where it stays: it is placed for the
      // tallest it can be, so the list arriving, changing and going below
      // never moves the boxes being typed into.
      const popover = page.getByTestId("link-popover");
      const opened = await popover.boundingBox();
      expect(opened).not.toBeNull();
      // An empty URL box offers the recent docs at once, beneath it.
      const list = page.getByRole("listbox");
      await expect(list).toBeVisible();
      await expect(list).toContainText("Recently edited");
      expect(await popover.boundingBox()).toMatchObject({ x: opened!.x, y: opened!.y });

      await page.keyboard.type(title);
      const option = page.getByRole("option", { name: title });
      await expect(option).toBeVisible();
      await expect(list).not.toContainText("Recently edited");
      await page.keyboard.press("ArrowDown");
      await expect(option).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      expect(await popover.boundingBox()).toMatchObject({ x: opened!.x, y: opened!.y });

      // A pick fills rather than saves: the URL box holds the doc's path,
      // the empty title box its title, the list is gone, the URL box keeps
      // focus, and nothing is in the body yet.
      await expect(urlBox).toHaveValue(`/doc/${target.slug}`);
      await expect(titleInput(page)).toHaveValue(title);
      await expect(urlBox).toBeFocused();
      await expect(list).toHaveCount(0);
      await expect(bodyLink(page, title)).toHaveCount(0);

      await page.keyboard.press("Enter");
      await expect(urlBox).toHaveCount(0);
      await expect(bodyLink(page, title)).toHaveAttribute("href", `/doc/${target.slug}`);
    } finally {
      await deleteTestDoc(target.id);
    }
  });

  test("flipped above the selection, it grows upward and keeps its bottom on the text", async ({ page }) => {
    // Its own, longer doc, so a paragraph can be scrolled to the bottom of
    // the viewport: with no room for the tallest popover below it, the
    // popover opens above — pinned by its bottom edge, the list at its top.
    const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, title: uniqueTitle("flip"), bodyText: body });
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/doc/${doc.id}/edit`);
      await waitForDocCollabReady(page);
      const target = bodyEditor(page).getByText("Paragraph 25.", { exact: true });
      await target.evaluate((el) => el.scrollIntoView({ block: "end" }));
      await selectIn(page, "Paragraph 25.", "whole-node");
      const textBox = await target.boundingBox();
      expect(textBox).not.toBeNull();

      await page.keyboard.press("ControlOrMeta+k");
      const popover = page.getByTestId("link-popover");
      await expect(urlInput(page)).toBeFocused();
      // The recent docs arrive above the form: the list is over the URL box,
      // and the whole box sits above the text. (Measured once the list is
      // there — on a fast build it lands before the popover can be read
      // without it, so the list-shown box is the baseline.)
      const list = page.getByRole("listbox");
      await expect(list).toBeVisible();
      const grown = await popover.boundingBox();
      expect(grown).not.toBeNull();
      const bottom = grown!.y + grown!.height;
      expect(bottom).toBeLessThanOrEqual(textBox!.y);
      const listBox = await list.boundingBox();
      const urlBox = await urlInput(page).boundingBox();
      expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(urlBox!.y);

      // A URL empties the list: the box collapses back down onto the text —
      // same bottom, higher top — and the URL box itself hasn't moved.
      await page.keyboard.type("https://example.test/flipped");
      await expect(list).toHaveCount(0);
      // Polled: the list leaving and floating-ui re-placing the box are two
      // steps (autoUpdate hears the shrink through a ResizeObserver), and
      // under load a boundingBox() read can land between them, seeing the
      // box shortened from the bottom before it has been moved back down.
      await expect
        .poll(async () => {
          const b = await popover.boundingBox();
          return b ? b.y + b.height : NaN;
        })
        .toBeCloseTo(bottom, 0);
      const collapsed = await popover.boundingBox();
      expect(collapsed!.y).toBeGreaterThan(grown!.y);
      expect(collapsed!.x).toBe(grown!.x);
      expect((await urlInput(page).boundingBox())!.y).toBeCloseTo(urlBox!.y, 0);

      // Emptied again, the list comes back up top and the box regrows upward
      // to exactly where it was.
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Backspace");
      await expect(list).toBeVisible();
      const regrown = await popover.boundingBox();
      expect(regrown!.y).toBeCloseTo(grown!.y, 0);
      expect(regrown!.y + regrown!.height).toBeCloseTo(bottom, 0);
      await page.keyboard.press("Escape");
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(doc.id);
    }
  });

  test("the toolbar button opens the same popover under itself, and toggles it", async ({ page, linkDoc }) => {
    void linkDoc;
    await caretAtEndOf(page, "Paragraph one.");
    const button = page.getByRole("button", { name: "Link", exact: true });
    await button.click();
    await expect(urlInput(page)).toBeFocused();
    await expect(titleInput(page)).toHaveValue("");
    const buttonBox = await button.boundingBox();
    const popover = await page.getByTestId("link-popover").boundingBox();
    expect(popover!.y).toBeGreaterThanOrEqual(buttonBox!.y + buttonBox!.height);
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await button.click();
    await expect(urlInput(page)).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-expanded", "false");
  });

  test("selected text is the title, and a pick leaves it alone", async ({ page, linkDoc }) => {
    void linkDoc;
    const title = uniqueTitle("kept-text target");
    const target = await createTestDoc({ authorEmail: ADMIN_EMAIL, title, visibility: "SHARED" });
    try {
      await selectIn(page, "Paragraph two.", "whole-node");
      await page.keyboard.press("ControlOrMeta+k");
      await expect(urlInput(page)).toBeFocused();
      await expect(titleInput(page)).toHaveValue("Paragraph two.");

      // The search is in the URL box, so it can run without touching the
      // selection's text — the whole reason the boxes are the way round
      // they are.
      await page.keyboard.type(title);
      await page.getByRole("option", { name: title }).click();
      await expect(urlInput(page)).toHaveValue(`/doc/${target.slug}`);
      await expect(titleInput(page)).toHaveValue("Paragraph two.");
      await expect(urlInput(page)).toBeFocused();

      await page.keyboard.press("Enter");
      await expect(urlInput(page)).toHaveCount(0);
      await expect(bodyLink(page, "Paragraph two.")).toHaveAttribute("href", `/doc/${target.slug}`);
      await expect(bodyEditor(page)).not.toContainText(title);
    } finally {
      await deleteTestDoc(target.id);
    }
  });

  test("the selection stays painted while the popover holds focus", async ({ page, linkDoc }) => {
    void linkDoc;
    // With the URL box focused the browser's own selection highlight is
    // gone from the editor; TipTap's Selection extension paints the range
    // instead (class "selection"), and lets go once focus returns.
    const painted = bodyEditor(page).locator(".selection");
    await selectIn(page, "Paragraph two.", "whole-node");
    await expect(painted).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(urlInput(page)).toBeFocused();
    await expect(painted).toHaveText("Paragraph two.");
    await page.keyboard.press("Escape");
    await expect(urlInput(page)).toHaveCount(0);
    // Escape closes without refocusing the editor, so the paint stays until
    // focus comes back — at which point the browser's own highlight takes
    // over again.
    await bodyEditor(page).focus();
    await expect(painted).toHaveCount(0);
  });

  test("editing the title rewrites the link's text in place", async ({ page, linkDoc }) => {
    void linkDoc;
    const href = `${ICON_HOST}/retitled`;
    await appendLink(page, "Paragraph one.", href);
    await bodyLink(page, href).click();
    await bubble(page).getByRole("button", { name: "Edit link" }).click();

    const titleBox = titleInput(page);
    await expect(titleBox).toHaveValue(href);
    await titleBox.fill("A better name");
    // Enter in the title box saves — the URL box is already filled.
    await page.keyboard.press("Enter");
    await expect(titleBox).toHaveCount(0);
    await expect(bodyLink(page, "A better name")).toHaveAttribute("href", href);
    await expect(bodyLink(page, href)).toHaveCount(0);
    await expect(bodyEditor(page)).not.toContainText(href);
    await expect(bodyEditor(page)).toContainText("Paragraph one. A better name");
  });

  test("Enter in the title box with no URL moves on to the URL box; Save waits for one", async ({
    page,
    linkDoc,
  }) => {
    void linkDoc;
    await caretAtEndOf(page, "Paragraph three.");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(urlInput(page)).toBeFocused();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    // The list stands down with the URL box's focus, and is back with it.
    await expect(page.getByRole("listbox")).toBeVisible();
    await titleInput(page).click();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await page.keyboard.type("Just a title");
    await page.keyboard.press("Enter");
    await expect(urlInput(page)).toBeFocused();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(titleInput(page)).toHaveValue("Just a title");
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(urlInput(page)).toHaveCount(0);
    await expect(bodyEditor(page)).not.toContainText("Just a title");
  });
});
