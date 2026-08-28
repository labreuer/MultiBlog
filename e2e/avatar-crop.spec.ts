// The avatar cropper (PLAN.md §17n): picking a photo opens a drag/zoom
// cropper, and what reaches the server is the cropped square rather than the
// user's original.
//
// The regression this exists for: the object URL must be created *and* revoked
// inside one effect. Creating it in a `useState` initializer and revoking it in
// an effect looks equivalent and is not — StrictMode (on by default for the App
// Router in dev) runs setup → cleanup → setup, so that first cleanup revokes a
// URL nothing recreates and every pick fails with "That file couldn't be read
// as an image." The `naturalWidth` assertion below is what catches it: a
// revoked blob: URL leaves it at 0.
import type { Browser, Locator, Page } from "@playwright/test";
import { test, expect, signIn, openDashboardCard } from "./fixtures";
import { createTestUser, deleteTestUser, getAvatarFacts, uniqueEmail } from "./db";

// Portrait, so the cover scale is set by the width and only the vertical offset
// has anywhere to travel — that asymmetry is what the geometry assertions read.
const SOURCE_W = 900;
const SOURCE_H = 1200;

/**
 * The source photo, drawn in-page rather than committed as a binary — the same
 * approach landing.spec.ts's makeTestPng takes, and for a sharper reason here:
 * every geometry assertion below is *derived* from SOURCE_W/SOURCE_H, so a
 * checked-in file could be replaced with one of different dimensions and break
 * this spec without a line of code changing. (That is not hypothetical — it is
 * how this spec came to be rewritten.) Generating it keeps the pixels and the
 * numbers that describe them in one place.
 */
async function makePortraitPng(page: Page, w: number, h: number): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ({ w, h }) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#2266ff";
      ctx.fillRect(0, 0, w, h);
      // Distinct top and bottom bands, so a failure screenshot shows at a
      // glance which part of the source the circle actually kept.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h / 4);
      ctx.fillStyle = "#ff6600";
      ctx.fillRect(0, (h * 3) / 4, w, h / 4);
      return canvas.toDataURL("image/png");
    },
    { w, h },
  );
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

/** The image's vertical offset from the frame's centre, in CSS px. */
async function offsetOf(img: Locator): Promise<number> {
  return img.evaluate((el: HTMLImageElement) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return m.f + el.getBoundingClientRect().height / 2;
  });
}

async function signedInAs(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await signIn(page, email);
  return page;
}

test("avatar cropper: previews the picked file, positions it, and uploads the crop", async ({ browser }) => {
  const email = uniqueEmail("cropper-contributor");
  await createTestUser({ email, name: `Cropper ${email.split("@")[0]}`, isListedContributor: true });
  let page: Page | null = null;

  try {
    page = await signedInAs(browser, email);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Contributor profile" })).toBeVisible();
    await openDashboardCard(page, "Contributor profile");

    const png = await makePortraitPng(page, SOURCE_W, SOURCE_H);
    await page.getByLabel("Photo").setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: png });

    const frame = page.getByRole("group", { name: /Photo position/ });
    await expect(frame).toBeVisible();
    await expect(page.getByText("That file couldn't be read as an image.")).toHaveCount(0);

    // The blob: URL actually decoded — 0 here is the StrictMode revocation bug.
    const img = frame.locator("img");
    await expect
      .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(SOURCE_W);
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(SOURCE_H);

    // At zoom 1 the shorter side (width) exactly covers the 220px frame, so the
    // taller portrait overflows vertically and only the vertical offset has
    // anywhere to travel. That asymmetry is the geometry under test.
    const shown = await img.evaluate((el: HTMLImageElement) => ({
      w: el.getBoundingClientRect().width,
      h: el.getBoundingClientRect().height,
    }));
    expect(Math.round(shown.w)).toBe(220);
    expect(Math.round(shown.h)).toBe(Math.round((220 * SOURCE_H) / SOURCE_W));

    // Drag upward: the offset should move and then clamp at the bound rather
    // than letting an edge inside the circle.
    const box = (await frame.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 400, { steps: 10 });
    await page.mouse.up();

    const maxOffsetY = (shown.h - 220) / 2;
    const offsetY = await offsetOf(img);
    expect(offsetY).toBeGreaterThan(-maxOffsetY - 1.5);
    expect(offsetY).toBeLessThan(-maxOffsetY + 1.5);

    // Arrow keys are the keyboard equivalent of that drag. Reads its own
    // "before" value rather than reusing the drag's, so reordering anything
    // above can't quietly make this vacuous.
    await frame.focus();
    const beforeKey = await offsetOf(img);
    await page.keyboard.press("ArrowDown");
    expect(await offsetOf(img)).toBeGreaterThan(beforeKey);

    // The zoom slider's thumb must be able to reach both ends of the control.
    // `.field input` in ContributorPanel.module.css was a *descendant*
    // selector, so it applied a text input's `padding: 0.4rem` and border to
    // this range input one level deeper — leaving the track 145.2px inside a
    // 160px box. The values stayed reachable programmatically (which is why a
    // fill()/keyboard test missed it entirely); what broke was the 7.4px of
    // dead, bordered margin at each end that still looked draggable.
    const track = await page.getByRole("slider").evaluate((el: HTMLInputElement) => {
      const cs = getComputedStyle(el);
      return {
        width: el.getBoundingClientRect().width,
        usable:
          el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      };
    });
    expect(track.usable).toBe(track.width);

    // And the extremes are reachable by dragging the thumb itself, not just by
    // fill() — the gesture a person actually uses.
    const slider = page.getByRole("slider");
    // Raw mouse gestures don't auto-scroll the way click() would, and the
    // slider can start below the fold (docs/DASHBOARD.md "e2e notes").
    await slider.scrollIntoViewIfNeeded();
    const sBox = (await slider.boundingBox())!;
    const sMidY = sBox.y + sBox.height / 2;
    await page.mouse.move(sBox.x + 4, sMidY);
    await page.mouse.down();
    await page.mouse.move(sBox.x + sBox.width - 1, sMidY, { steps: 12 });
    await page.mouse.up();
    expect(await slider.inputValue()).toBe("4");

    await page.mouse.move(sBox.x + sBox.width - 4, sMidY);
    await page.mouse.down();
    await page.mouse.move(sBox.x + 1, sMidY, { steps: 12 });
    await page.mouse.up();
    expect(await slider.inputValue()).toBe("1");

    await page.getByRole("button", { name: "Use this photo" }).click();

    // The upload landed, and it's the ingested square rather than the original.
    await expect
      .poll(async () => (await getAvatarFacts(email))?.hash ?? null, { timeout: 15_000 })
      .not.toBeNull();
    const facts = (await getAvatarFacts(email))!;
    expect(facts.width).toBe(160);
    expect(facts.height).toBe(160);
    expect(facts.contentType).toBe("image/webp");

    // The whole point of cropping client-side: what crossed the wire was tens
    // of KB, not the ~1MB original — comfortably under Next's 1MB Server
    // Action body limit and nginx's 1MB client_max_body_size.
    expect(facts.byteLength).toBeLessThan(100_000);

    await expect(page.getByRole("group", { name: /Photo position/ })).toHaveCount(0);
  } finally {
    await deleteTestUser(email);
  }
});
