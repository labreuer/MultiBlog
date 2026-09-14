import { test, expect, signIn, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, deleteTestFile, type TestFile } from "./db";

// PLAN.md §19d — pinch and ctrl-wheel zoom the document, not the page.
//
// The load-bearing assertion is the *negative* one: the browser's own zoom must
// not also fire. It is what the whole feature is for, it is invisible in a
// screenshot, and `preventDefault` on a listener registered `{ passive: true }`
// by mistake would leave everything else here passing.
//
// What a desktop browser cannot cover is the touch half on iOS, where Safari's
// own `gesture*` events are the path that suppresses page zoom. That needs a
// real device (`npx tsx scripts/remote-console.ts`) — docs/PDF.md §10.

/** The scale pdfjs is actually rendering at, read off the value it sets itself. */
async function currentScale(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const viewer = document.querySelector<HTMLElement>(".pdfViewer");
    return Number(getComputedStyle(viewer!).getPropertyValue("--scale-factor")) || 0;
  });
}

/** The browser's own page zoom, which must stay put. */
async function pageZoom(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => window.visualViewport?.scale ?? 1);
}

async function waitForViewer(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

test.describe("pdf zoom gestures", () => {
  let file: TestFile;

  test.beforeAll(async () => {
    file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
  });

  test.afterAll(async () => {
    await deleteTestFile(file.id);
  });

  test("ctrl-wheel zooms the document, and leaves the page alone", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);

    const before = await currentScale(page);
    expect(before).toBeGreaterThan(0);

    // Playwright applies the currently-held modifiers to mouse events, so this
    // is a real ctrl-wheel rather than a synthesised one — which matters,
    // because a dispatched event would be untrusted and its preventDefault
    // would not stop the browser's own zoom either way.
    await page.mouse.move(400, 400);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -240);
    await page.keyboard.up("Control");

    await expect.poll(() => currentScale(page)).toBeGreaterThan(before);
    expect(await pageZoom(page)).toBe(1);

    // One notch is one step of 10%, however many pixels the engine reported
    // it as (Playwright sends 240 here; Chrome on Linux sends 53, Windows 100,
    // Firefox three lines). pdfjs rounds the scale to a hundredth, hence the
    // band. src/lib/pdf-zoom.ts, `readWheel`.
    const zoomedIn = await currentScale(page);
    expect(zoomedIn / before).toBeGreaterThan(1.08);
    expect(zoomedIn / before).toBeLessThan(1.12);

    // And back out again.
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 240);
    await page.keyboard.up("Control");
    await expect.poll(() => currentScale(page)).toBeLessThan(zoomedIn);
    expect(await pageZoom(page)).toBe(1);
  });

  // The other modifier a Mac reader has. ⌘-wheel is Chrome's and Safari's own
  // page zoom on macOS, so a handler that only watched `ctrlKey` would leave
  // one of the two zoom gestures still resizing the whole site.
  test("⌘-wheel zooms the document too, by the same step", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    const before = await currentScale(page);

    await page.mouse.move(400, 400);
    await page.keyboard.down("Meta");
    await page.mouse.wheel(0, -240);
    await page.keyboard.up("Meta");

    await expect.poll(() => currentScale(page)).toBeGreaterThan(before);
    expect(await pageZoom(page)).toBe(1);
    const zoomedIn = await currentScale(page);
    expect(zoomedIn / before).toBeGreaterThan(1.08);
    expect(zoomedIn / before).toBeLessThan(1.12);
  });

  // Every shape a wheel event arrives in, and what each is worth. Playwright's
  // own `mouse.wheel` is pixel-mode in all three engines — its Firefox included,
  // so a real Gecko mouse's *line*-mode notch (measured 2026-09-14, docs/PDF.md
  // §10c) is only reachable by dispatching. These are untrusted events, so the
  // page-zoom half is not in question here; what is being checked is the
  // classification in `readWheel` and the carry in `createTickAccumulator`,
  // against the engine's real WheelEvent rather than a plain object.
  test("a notch is one step whatever unit it comes in, and small deltas add up", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);

    /** The fields our handler reads; narrower than WheelEventInit so it survives `evaluate`'s serialisation types. */
    type Wheel = { deltaY: number; deltaMode: number; ctrlKey?: boolean; metaKey?: boolean };
    /** Dispatches one ctrl-wheel and returns scale-after over scale-before, once the frame has run. */
    const ratio = async (init: Wheel) => {
      const before = await currentScale(page);
      await page.evaluate((init) => {
        document
          .querySelector("[data-pdf-container]")!
          .dispatchEvent(new WheelEvent("wheel", { ...init, bubbles: true, cancelable: true, clientX: 400, clientY: 400 }));
        // The handler coalesces into one requestAnimationFrame; two frames is
        // past it, whether or not it changed anything.
        return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }, init);
      return (await currentScale(page)) / before;
    };
    // pdfjs rounds the scale to a hundredth, hence bands rather than 1.1 and 1/1.1.
    const oneStepIn = (r: number) => {
      expect(r).toBeGreaterThan(1.08);
      expect(r).toBeLessThan(1.12);
    };
    const oneStepOut = (r: number) => {
      expect(r).toBeGreaterThan(0.89);
      expect(r).toBeLessThan(0.93);
    };

    // One notch, in every unit and at every magnitude an engine reports it:
    // Firefox's three lines, a page, Chrome on Linux (53), Windows at the
    // default setting (100), Windows at six lines per notch (200), and a
    // wheel that has been flicked (900).
    oneStepIn(await ratio({ deltaY: -3, deltaMode: 1, ctrlKey: true }));
    oneStepOut(await ratio({ deltaY: 3, deltaMode: 1, ctrlKey: true }));
    oneStepIn(await ratio({ deltaY: -1, deltaMode: 2, ctrlKey: true }));
    for (const px of [53, 100, 200, 900]) {
      oneStepIn(await ratio({ deltaY: -px, deltaMode: 0, ctrlKey: true }));
      oneStepOut(await ratio({ deltaY: px, deltaMode: 0, ctrlKey: true }));
    }

    // A trackpad pinch frame: a couple of pixels with no sideways component,
    // on the continuous curve rather than a tick.
    const pinch = await ratio({ deltaY: -2, deltaMode: 0, ctrlKey: true });
    expect(pinch).toBeGreaterThan(1.0);
    expect(pinch).toBeLessThan(1.03);

    // The band between: fractional ticks that carry until they make a whole
    // one. Three of 10px are a third each.
    expect(await ratio({ deltaY: -10, deltaMode: 0, ctrlKey: true })).toBe(1);
    expect(await ratio({ deltaY: -10, deltaMode: 0, ctrlKey: true })).toBe(1);
    oneStepIn(await ratio({ deltaY: -10, deltaMode: 0, ctrlKey: true }));

    // A reversal drops the carry: 0.7 of a tick in, then a whole notch out, is
    // exactly one step out — not 0.3 of one.
    expect(await ratio({ deltaY: -21, deltaMode: 0, ctrlKey: true })).toBe(1);
    oneStepOut(await ratio({ deltaY: 100, deltaMode: 0, ctrlKey: true }));

    // ⌘ counts the same as ctrl on the dispatched path too.
    oneStepIn(await ratio({ deltaY: -100, deltaMode: 0, metaKey: true }));
  });

  test("an ordinary wheel still scrolls and does not zoom", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);

    const before = await currentScale(page);
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 400);

    await expect
      .poll(() => page.evaluate(() => document.querySelector("[data-pdf-container]")?.scrollTop ?? 0))
      .toBeGreaterThan(0);
    expect(await currentScale(page)).toBe(before);
  });

  test("the zoom control stops claiming a preset once a gesture has moved the scale", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);

    // It opens fitted to the width, and says so.
    await expect(page.getByLabel("Zoom")).toHaveValue("page-width");

    await page.mouse.move(400, 400);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -240);
    await page.keyboard.up("Control");

    // A select whose value matches no option renders blank, so the gesture's
    // scale has to become an option of its own — the reader is owed a readout
    // that says what the viewer is doing.
    await expect
      .poll(async () => (await page.getByLabel("Zoom").inputValue()) !== "page-width")
      .toBe(true);
    await expect(page.getByLabel("Zoom")).toHaveValue(/^[\d.]+$/);
    const shown = await page.getByLabel("Zoom").evaluate((el) => (el as HTMLSelectElement).selectedOptions[0].textContent);
    expect(shown).toMatch(/^\d+%$/);
  });

  test("a two-finger pinch zooms the document", async ({ browser }) => {
    // A touch-capable context, since `ontouchstart` gates nothing here but the
    // events themselves have to be deliverable.
    const context = await browser.newContext({ hasTouch: true, isMobile: false });
    const page = await context.newPage();
    try {
      // WebKit has no `Touch` constructor, and skipping is the honest answer
      // rather than reaching for `document.createTouch`: on a real Safari the
      // touch path below never runs at all, because `gesture*` arrives first
      // and `onTouchMove` stands down the moment it does. The gesture test
      // that follows is the one that covers what a Safari reader gets.
      const constructible = await page.evaluate(() => {
        try {
          new Touch({ identifier: 0, target: document.body, clientX: 0, clientY: 0 });
          return true;
        } catch {
          return false;
        }
      });
      test.skip(!constructible, "no Touch constructor — see the gesture* test, which is Safari's path anyway");

      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      const before = await currentScale(page);

      // Dispatched rather than driven: Playwright's touchscreen can tap and
      // nothing more, so there is no way to describe two fingers moving apart.
      // This proves our handler and its arithmetic reach pdfjs; whether the
      // *engine* also suppresses its own pinch zoom is a real-device question
      // (see this file's header).
      const applied = await page.evaluate(() => {
        const container = document.querySelector<HTMLElement>("[data-pdf-container]");
        if (!container) return "no container";
        const at = (id: number, x: number, y: number) =>
          new Touch({ identifier: id, target: container, clientX: x, clientY: y });
        const fire = (type: string, touches: Touch[]) =>
          container.dispatchEvent(
            new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }),
          );
        fire("touchstart", [at(1, 300, 300), at(2, 400, 300)]);
        for (let gap = 120; gap <= 240; gap += 20) {
          fire("touchmove", [at(1, 350 - gap / 2, 300), at(2, 350 + gap / 2, 300)]);
        }
        fire("touchend", []);
        return "ok";
      });
      expect(applied).toBe("ok");

      await expect.poll(() => currentScale(page)).toBeGreaterThan(before);
    } finally {
      await context.close();
    }
  });

  // Safari's own pinch, and **the only path an iPad reader ever takes** — the
  // touch handler above explicitly stands down once a `gesture*` event has
  // arrived, so on that device it is the touch test that covers nothing.
  //
  // Runs on every engine rather than webkit-only, and for the same reason
  // e2e/pdf-webkit-gaps.spec.ts simulates WebKit's missing built-ins in
  // chromium: the listeners are bound by name and read `scale` structurally,
  // so what is being tested — our arithmetic against a cumulative scale — is
  // ours rather than the engine's, and a chromium-only run should not lose it.
  test("Safari's gesture events zoom the document, and the touch path stands down", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    const before = await currentScale(page);

    const prevented = await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>("[data-pdf-container]");
      if (!container) return null;
      const fire = (type: string, scale?: number) => {
        // GestureEvent is not constructible anywhere, so the shape is built by
        // hand — which is all the handler reads, since it types these
        // structurally rather than through the DOM lib.
        const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
          scale?: number;
          clientX?: number;
          clientY?: number;
        };
        if (scale !== undefined) event.scale = scale;
        event.clientX = 300;
        event.clientY = 300;
        container.dispatchEvent(event);
        return event.defaultPrevented;
      };
      fire("gesturestart", 1);
      // Cumulative from the gesture's start, the way Safari reports it.
      const steps = [1.2, 1.5, 1.8].map((scale) => fire("gesturechange", scale));
      fire("gestureend");
      return steps.every(Boolean);
    });
    // The negative assertion this file exists for: a gesture we acted on must
    // be one the browser will not also zoom the page with.
    expect(prevented).toBe(true);

    await expect.poll(() => currentScale(page)).toBeGreaterThan(before);
    expect(await pageZoom(page)).toBe(1);
  });

  test("the viewer keeps one-finger scrolling native while claiming the pinch", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);

    // `touch-action: none` here would take one-finger scrolling with it — the
    // whole document would stop moving on a phone, which is a far worse bug
    // than the one this feature fixes.
    const touchAction = await page.evaluate(
      () => getComputedStyle(document.querySelector("[data-pdf-container]")!).touchAction,
    );
    expect(touchAction).toBe("pan-x pan-y");
  });
});

// PLAN.md §19e — the zoom when the container changes shape.
//
// `PDFViewer` computes a named scale once and then holds the number, so without
// this a phone rotated to landscape keeps a page fitted to its portrait width,
// sitting in a column of empty space. Driven with `setViewportSize`, which is
// what a rotation is from the page's point of view: the two dimensions swap and
// the orientation media query flips.
test.describe("pdf zoom on a rotation", () => {
  let file: TestFile;

  test.beforeAll(async () => {
    file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
  });

  test.afterAll(async () => {
    await deleteTestFile(file.id);
  });

  /** The viewer's scroll container width — what a fit-to-width is computed against. */
  const containerWidth = (page: import("@playwright/test").Page) =>
    page.evaluate(() => document.querySelector("[data-pdf-container]")?.clientWidth ?? 0);

  test("fit-to-width re-fits when a phone is turned sideways", async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      const portraitScale = await currentScale(page);
      const portraitWidth = await containerWidth(page);
      expect(portraitScale).toBeGreaterThan(0);

      await page.setViewportSize({ width: 844, height: 390 });

      await expect.poll(() => currentScale(page)).toBeGreaterThan(portraitScale);

      // The assertion that means something: the page is *fitted* to the new
      // width — filling it, without overflowing it. A ratio against the
      // container widths would be the wrong test, because pdfjs's fit reserves
      // a fixed allowance for a scrollbar, which is a tenth of a phone's width
      // and a fortieth of a desktop's.
      const landscapeWidth = await containerWidth(page);
      expect(landscapeWidth).toBeGreaterThan(portraitWidth);
      const fit = await page.evaluate(() => {
        const container = document.querySelector<HTMLElement>("[data-pdf-container]");
        const page1 = container?.querySelector<HTMLElement>(".page");
        return { page: page1?.getBoundingClientRect().width ?? 0, container: container?.clientWidth ?? 0 };
      });
      expect(fit.page).toBeLessThanOrEqual(fit.container);
      expect(fit.page).toBeGreaterThan(fit.container - 60);

      // Still a standing instruction, not a number it happened to land on.
      await expect(page.getByLabel("Zoom")).toHaveValue("page-width");
    } finally {
      await context.close();
    }
  });

  test("a zoom the reader chose is scaled with the width, not thrown away", async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 844, height: 390 },
    });
    const page = await context.newPage();
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      // An explicit choice, the same kind a pinch leaves behind: a number.
      await page.getByLabel("Zoom").selectOption("1");
      await expect.poll(() => currentScale(page)).toBeGreaterThan(0);
      const chosenScale = await currentScale(page);
      const landscapeWidth = await containerWidth(page);

      // Landscape to portrait takes width away — the direction where holding
      // the number fixed would leave a line needing sideways panning to read.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => currentScale(page)).toBeLessThan(chosenScale);

      const portraitWidth = await containerWidth(page);
      // Within a tolerance rather than exactly: the width ratio stands in for
      // the ratio of the two fit-to-width scales, and differs from it by
      // pdfjs's fixed scrollbar allowance (`refitScaleFactor` says why that
      // trade is the right one for a zoom the reader chose by feel).
      const scaleRatio = (await currentScale(page)) / chosenScale;
      const widthRatio = portraitWidth / landscapeWidth;
      expect(Math.abs(scaleRatio - widthRatio) / widthRatio).toBeLessThan(0.15);
      // Scaled, not re-fitted: it is still the reader's own zoom.
      await expect(page.getByLabel("Zoom")).not.toHaveValue("page-width");
    } finally {
      await context.close();
    }
  });

  test("an ordinary resize leaves a chosen zoom alone", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);

    await page.getByLabel("Zoom").selectOption("1");
    await expect.poll(() => currentScale(page)).toBeGreaterThan(0);
    const chosen = await currentScale(page);

    // A window drag on a desktop, staying landscape: the container narrows and
    // the reader's number stays exactly where they put it.
    await page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(() => containerWidth(page)).toBeLessThan(1280);
    expect(await currentScale(page)).toBe(chosen);
  });

  test("but fit-to-width follows an ordinary resize, because that is what it means", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, `/pdf/${file.slug}`);
    await waitForViewer(page);
    const before = await currentScale(page);

    await page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(() => currentScale(page)).toBeLessThan(before);
    await expect(page.getByLabel("Zoom")).toHaveValue("page-width");
  });
});
