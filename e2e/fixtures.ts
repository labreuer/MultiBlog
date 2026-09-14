// The extended `test` every spec imports instead of @playwright/test's.
//
// Each fixture owns its own throwaway rows and deletes them afterwards, so
// specs never share state and can run in any order across workers.
import { test as base, expect, type Page, type Browser, type BrowserContext } from "@playwright/test";
import {
  ADMIN_EMAIL,
  TEST_PASSWORD,
  createQuoteThread,
  createTestPost,
  createTestDoc,
  createTestUser,
  deleteTestPost,
  deleteTestDoc,
  deleteTestUser,
  uniqueEmail,
  type TestPost,
  type TestDoc,
  type TestUser,
} from "./db";

export { expect } from "@playwright/test";

/**
 * A second signed-in identity, in its own browser context.
 *
 * A separate context is the whole point: the browser pane's tabs share one
 * cookie jar (docs/BROWSER_PANE.md), which makes "two users at once" a manual balancing
 * act there. Here each context has its own jar and neither can clobber the
 * other.
 */
export type SecondUser = { user: TestUser; page: Page };

// Fixed body text for the quote-anchoring specs, so anchor positions can be
// worked out by hand and asserted as literal numbers. The doc is a single
// paragraph, which makes the position arithmetic below trivial: character
// index `i` of the text sits at ProseMirror position `i + 1` (0 is the start
// of the doc, 1 the start of the paragraph's content).
export const QUOTED_BODY = "The quick brown fox jumps over the lazy dog near the river bank.";
export const QUOTED_TEXT = "brown fox jumps";
export const QUOTE_FROM = QUOTED_BODY.indexOf(QUOTED_TEXT) + 1;
export const QUOTE_TO = QUOTE_FROM + QUOTED_TEXT.length;

/** A published post carrying one ACTIVE quote-anchored thread over QUOTED_TEXT. */
export type QuotedPost = TestPost & { threadId: string };

type Fixtures = {
  /** A draft post authored by the shared admin, with real body text. */
  draftPost: TestPost;
  /** Same, already published — so the public page and comments work. */
  publishedPost: TestPost;
  /**
   * Published with moderationPolicy ALWAYS, so an untrusted commenter's
   * submission is reliably PENDING. The default AUTO would approve it on the
   * spot and test nothing.
   */
  publishedModeratedPost: TestPost;
  /** Published, body `QUOTED_BODY`, with one ACTIVE thread over `QUOTED_TEXT`. */
  quotedPost: QuotedPost;
  /** A PRIVATE doc authored by the shared admin, empty. */
  draftDoc: TestDoc;
  /** A SHARED doc, body `QUOTED_BODY` — readable/annotatable by any AUTHORIZED+ reader. */
  sharedDoc: TestDoc;
  /** Creates additional signed-in users on demand, cleaned up at test end. */
  secondUser: (opts?: { role?: TestUser["role"] }) => Promise<SecondUser>;
  /**
   * Tracks a doc id created through the live UI (e.g. clicking "+ New doc")
   * rather than via createTestDoc, so it still gets deleted at test end.
   * Needed specifically because such a doc starts titleless (PLAN.md §12n)
   * — sweepTestData's fallback matches on the "E2E " title prefix, which a
   * doc nobody has typed a title into yet doesn't have.
   */
  trackCreatedDoc: (docId: string) => void;
  /**
   * Auto-fixture, dev-target only (E2E_TARGET !== "prod"): watches the main
   * page's responses for the two known dev-server 500 classes and names them
   * in the test's annotations, so a red test says "known next-dev bug" instead
   * of masquerading as an app regression. Both classes are compiled out of a
   * production build — docs/playwright-flakiness.html, classes 3 and 4.
   */
  devServer500Watch: void;
};

/**
 * Grant clipboard access where the browser has such a permission to grant.
 *
 * Only chromium does: `grantPermissions(["clipboard-write"])` throws
 * "Unknown permission" on WebKit and Firefox, which took out 6 tests in the
 * webkit project's first run before the call sites went through here. Those
 * two engines have no permission gate on the clipboard at all — a test that
 * needs one either works without the grant or fails on its own assertion,
 * which is the failure worth seeing.
 */
/**
 * Make every page in `context` record what it puts on the clipboard.
 *
 * Reading it back is the problem this solves. `navigator.clipboard.readText()`
 * from `page.evaluate` throws `NotAllowedError` on WebKit — reads are gated on
 * a user gesture there, and unlike chromium there is no permission to grant
 * instead (6 tests, the webkit project's largest remaining class). Writes are
 * not gated, so the app's Copy really does copy on every engine; only the
 * test's read-back needed replacing.
 *
 * Hence a wrapper that **calls through** rather than a stub of the whole API:
 * what ships still goes through the real `writeText`, so a regression in how
 * it is called still surfaces, and no engine is asserting against a different
 * mechanism than the others. Installed on every context rather than at the
 * call sites, because `addInitScript` only reaches *later* navigations and
 * several specs grant the permission after the page they care about is
 * already open.
 */
async function recordClipboardWrites(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    const write = clipboard.writeText.bind(clipboard);
    const copied: string[] = [];
    Object.defineProperty(window, "__e2eCopied", { value: copied, configurable: true });
    clipboard.writeText = (text: string) => {
      copied.push(String(text));
      return write(text);
    };
  });
}

/**
 * The last string the page asked the clipboard to hold, per
 * {@link recordClipboardWrites}. Polls, because Copy is fired by a click whose
 * handler is async.
 */
export async function copiedText(page: Page): Promise<string> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __e2eCopied?: string[] }).__e2eCopied?.length ?? 0))
    .toBeGreaterThan(0);
  return page.evaluate(() => {
    const copied = (window as unknown as { __e2eCopied?: string[] }).__e2eCopied ?? [];
    return copied[copied.length - 1];
  });
}

export async function grantClipboard(context: BrowserContext): Promise<void> {
  if (context.browser()?.browserType().name() !== "chromium") return;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
}

export async function signIn(page: Page, email: string, password = TEST_PASSWORD): Promise<void> {
  // **Landing on /dashboard is not the end of signing in**, and everything
  // below is about the window after it. `SessionRefresh` mounts there and,
  // once per mount, POSTs /api/auth/session and then calls `router.refresh()`
  // — so for a few hundred milliseconds the page still has a navigation of
  // its own coming. A test that navigates inside that window races it, and in
  // WebKit the race is lost outright: `page.goto` dies with "interrupted by
  // another navigation", which accounted for 84 of the webkit project's first
  // 92 failures, across 21 specs. Chromium tolerates it, which is the only
  // reason it went unnoticed for as long as the suite has existed.
  //
  // A navigation in that window also *aborts* the POST, which used to read as
  // "this session just died" and bounce the page to /sign-in — real app
  // behaviour that webkit surfaced, fixed in SessionRefresh.tsx. What is left
  // for the suite to wait out is the refresh navigation itself.
  //
  // **A listener rather than two `waitForResponse` calls**, because both
  // events can land inside the round trip that tells Playwright about the
  // previous one — arming the second waiter after awaiting the first measured
  // fine single-worker and then failed 78 tests under the prod suite's eight.
  // Watching from before the click cannot miss either one. What identifies the
  // refresh among the half-dozen RSC fetches the dashboard's nav links fire is
  // the **absent `Next-Router-Prefetch` header**; a matcher without that check
  // returns on a prefetch, before the refresh exists.
  let sawSessionPost = false;
  let refreshSeen!: () => void;
  const refreshed = new Promise<void>((resolve) => (refreshSeen = resolve));
  const watch = (response: { url(): string; request(): { method(): string; headers(): Record<string, string> } }) => {
    const request = response.request();
    if (request.method() === "POST" && response.url().includes("/api/auth/session")) {
      sawSessionPost = true;
      return;
    }
    if (!sawSessionPost) return;
    const url = new URL(response.url());
    if (url.pathname === "/dashboard" && url.searchParams.has("_rsc") && !request.headers()["next-router-prefetch"]) {
      refreshSeen();
    }
  };

  page.on("response", watch);
  try {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/dashboard");
    // Bounded: on the `session === null` branch above there is no refresh to
    // wait for, and a dead session is a thing tests deliberately create
    // (e2e/session-refresh.spec.ts).
    await Promise.race([refreshed, page.waitForTimeout(5_000)]);
  } finally {
    page.off("response", watch);
  }

  // The refresh's *response* is not its *commit* — waiting only for the
  // response measured 0 of 3 on webkit. `networkidle` covers the gap and
  // measured 3 of 3, but on a second sign-in in the same page it can take 29 s
  // (it is what turned files.spec's 3 s into 41 s), so it is capped: by here
  // the refresh has already been answered, and the cap only bounds the tail.
  await Promise.race([page.waitForLoadState("networkidle"), page.waitForTimeout(1_500)]);
}

async function signedInContext(browser: Browser, email: string): Promise<Page> {
  // storageState is explicitly empty rather than inherited — inheriting the
  // admin's would sign this "second user" in as the first one.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await recordClipboardWrites(context);
  const page = await context.newPage();
  retryInterruptedNavigations(page);
  await signIn(page, email);
  return page;
}

/**
 * Playwright's own words for "the page navigated somewhere on its own while
 * your goto was in flight", per engine.
 */
const INTERRUPTED = ["interrupted by another navigation", "NS_BINDING_ABORTED"];

/**
 * Replaces `page.goto` and `page.reload` with the retrying versions described
 * on the fixture. Both, because a reload is interrupted by exactly the same
 * thing — firefox reported one as NS_BINDING_ABORTED with goto already
 * covered.
 */
function retryInterruptedNavigations(page: Page): void {
  const retry = <A extends unknown[], R>(navigate: (...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await navigate(...args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt === 4 || !INTERRUPTED.some((needle) => message.includes(needle))) throw error;
          // Let the navigation that won finish before asking again. Retrying
          // immediately lands back inside the same window — firefox lost a
          // reload three times running that way, under load, after an
          // in-place admin-table save (links.spec). Escalating, so a slow
          // refresh is given room rather than met with three quick misses.
          await page.waitForTimeout(250 * attempt);
        }
      }
    };
  };
  page.goto = retry(page.goto.bind(page));
  page.reload = retry(page.reload.bind(page));
}

export const test = base.extend<Fixtures>({
  // Every page records its clipboard writes — see recordClipboardWrites.
  context: async ({ context }, use) => {
    // **Ask the server, not the browser's cache.** Next serves a prerendered
    // page as `s-maxage=60, stale-while-revalidate=31535940` with no
    // `max-age`, so it is stale on arrival and that year-long window then lets
    // a browser keep serving the stored copy while it revalidates behind the
    // reader. Firefox implements that in its HTTP cache and chromium does not,
    // which is the whole of why seven firefox tests read content one publish
    // behind — on a *hard* navigation, so Next's Router Cache was never the
    // layer holding it (CACHING.md, 2026-09-14). These tests assert on what
    // the server has; this header is how they get to ask it.
    await context.setExtraHTTPHeaders({ "Cache-Control": "no-cache" });
    await recordClipboardWrites(context);
    await use(context);
  },

  /**
   * `page.goto` retries when the page navigated out from under it.
   *
   * A server action that ends in `router.refresh()` — publishing a post, the
   * session refresh on /dashboard — leaves the page with a navigation of its
   * own still to make after the status text a test waits on has already
   * appeared. A `goto` issued in that window is aborted: WebKit says
   * "interrupted by another navigation", Gecko says NS_BINDING_ABORTED, and
   * chromium quietly tolerates it, which is why the suite only ever saw this
   * as an occasional flake.
   *
   * Retrying is the honest response — the navigation was not refused, it was
   * beaten to it, and the page we asked for is still the page we want. The
   * alternative, a wait at every call site after every refreshing action, is
   * the one that has already failed three times: the failure mode of
   * forgetting it is a red test that reads exactly like an app bug.
   *
   * Bounded at three attempts, so a page that really does keep navigating
   * elsewhere (a client-side redirect the test did not expect) still reports
   * it, just three times slower. Anything that is not an interruption throws
   * on the spot.
   */
  page: async ({ page }, use) => {
    retryInterruptedNavigations(page);
    await use(page);
  },

  // Depending on `page` is deliberate, and the reason for the about:blank:
  // fixtures tear down in reverse setup order, so taking `page` as a
  // dependency puts this teardown *before* the page closes, and lets us drop
  // the editor's live collab connection before the post it points at is
  // deleted. (server/collab.ts survives the other order now, but only by
  // logging and discarding the write.)
  draftPost: async ({ page }, use) => {
    const post = await createTestPost({ authorEmail: ADMIN_EMAIL });
    await use(post);
    await page.goto("about:blank").catch(() => {});
    await deleteTestPost(post.id);
  },

  publishedPost: async ({ page }, use) => {
    const post = await createTestPost({ authorEmail: ADMIN_EMAIL, publish: true });
    await use(post);
    await page.goto("about:blank").catch(() => {});
    await deleteTestPost(post.id);
  },

  publishedModeratedPost: async ({ page }, use) => {
    const post = await createTestPost({ authorEmail: ADMIN_EMAIL, publish: true, policy: "ALWAYS" });
    await use(post);
    await page.goto("about:blank").catch(() => {});
    await deleteTestPost(post.id);
  },

  quotedPost: async ({ page }, use) => {
    const post = await createTestPost({ authorEmail: ADMIN_EMAIL, bodyText: QUOTED_BODY, publish: true });
    const { threadId } = await createQuoteThread({
      postId: post.id,
      anchoredEventId: post.eventId!,
      anchorFrom: QUOTE_FROM,
      anchorTo: QUOTE_TO,
      quotedText: QUOTED_TEXT,
      email: uniqueEmail("quoter"),
      displayName: "Quoting Reader",
      body: "Why this bit specifically?",
    });

    await use({ ...post, threadId });

    await page.goto("about:blank").catch(() => {});
    await deleteTestPost(post.id);
  },

  draftDoc: async ({ page }, use) => {
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL });
    await use(doc);
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  },

  sharedDoc: async ({ page }, use) => {
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: QUOTED_BODY });
    await use(doc);
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  },

  secondUser: async ({ browser }, use) => {
    const created: { email: string; page: Page }[] = [];

    await use(async ({ role = "ADMIN" } = {}) => {
      const email = uniqueEmail("second");
      // Unique per call, like the email: `uniqueUserSlug` derives the slug from
      // the *name*, and does so with a check-then-create loop. A fixed name
      // therefore has two workers picking the same free slug at the same moment
      // and one of them losing on the unique index — a cross-file flake
      // ("Unique constraint failed on the fields: (`slug`)") that has nothing to
      // do with whatever either test was checking.
      const user = await createTestUser({ email, name: `Second Editor ${email.split("@")[0]}`, role });
      const page = await signedInContext(browser, email);
      created.push({ email, page });
      return { user, page };
    });

    for (const { email, page } of created) {
      await page.context().close();
      await deleteTestUser(email);
    }
  },

  trackCreatedDoc: async ({ page }, use) => {
    const ids: string[] = [];
    await use((docId) => ids.push(docId));
    await page.goto("about:blank").catch(() => {});
    for (const id of ids) {
      await deleteTestDoc(id);
    }
  },

  devServer500Watch: [
    async ({ page }, use, testInfo) => {
      if (process.env.E2E_TARGET === "prod") {
        await use();
        return;
      }
      page.on("response", (response) => {
        if (response.status() < 500) return;
        void response
          .text()
          .catch(() => "")
          .then((body) => {
            // The dev error page embeds the server-side error message
            // verbatim (data-next-error-message), so the body names the class.
            let kind: string | null = null;
            if (body.includes("useSession") && body.includes("must be wrapped in a")) {
              kind =
                "next-auth's dev-only SessionProvider invariant (playwright-flakiness class 4) — " +
                "a transient Turbopack SSR module miss, impossible in a prod build; rerun, or use `npm run e2e`'s prod target";
            } else if (body.includes("Unexpected end of JSON input") || body.includes("Failed to generate static paths")) {
              kind =
                "next dev's prerender-manifest tear (vercel/next.js#96664, playwright-flakiness class 3) — " +
                "not an app bug; rerun, or use `npm run e2e`'s prod target";
            }
            if (kind) {
              const line = `${response.request().method()} ${response.url()} → ${response.status()}: ${kind}`;
              testInfo.annotations.push({ type: "dev-server-500", description: line });
              console.warn(`[dev-server-500] ${line}`);
            }
          });
      });
      await use();
    },
    { auto: true },
  ],
});

/** The post body's contenteditable. Both editors expose an accessible name. */
export function bodyEditor(page: Page) {
  return page.getByRole("textbox", { name: "Post body" });
}

export function titleEditor(page: Page) {
  return page.getByRole("textbox", { name: "Title" });
}

/** An annotation's own live editor (AnnotationBody, PLAN.md §13j Phase 2). */
export function annotationEditor(page: Page) {
  return page.getByRole("textbox", { name: "Annotation body" });
}

/**
 * Navigates and asserts a 200, surfacing the response body when it isn't one.
 *
 * A bare `expect(response.status()).toBe(200)` reports only the number, which
 * is useless for a server-rendered 500 — the reason is in the body, and when
 * Playwright reuses an already-running dev server its console output isn't
 * captured either.
 */
export async function gotoOk(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  const status = response?.status();
  if (status !== 200) {
    const body = (await response?.text().catch(() => ""))?.slice(0, 3000) ?? "";
    throw new Error(`GET ${path} returned ${status}, expected 200. Response body:\n${body}`);
  }
}

/**
 * Revalidates an ISR path, then navigates to it — for asserting on content a
 * fixture wrote *straight to the database*, on a page with `revalidate`.
 *
 * Against the prod target, such a write is invisible to the Full Route Cache
 * (the server actions that would have called revalidatePath were bypassed),
 * so a copy cached by an earlier test's visit gets served — up to the
 * revalidate window stale. The POST hits the E2E_REVALIDATE-guarded
 * /api/test/revalidate route (scripts/prod-web.ts sets the var); against the
 * dev target the route 404s and the plain goto is already fresh, so the
 * failure is deliberately swallowed. Content written through a real server
 * action doesn't need this — the action's own revalidatePath is the thing
 * being bypassed.
 */
/**
 * Expands one of /dashboard's <details> cards; reach inside a card only
 * after this (docs/DASHBOARD.md "e2e notes"). Checks `open` first —
 * clicking an already-open summary would collapse it.
 */
export async function openDashboardCard(page: Page, name: string): Promise<void> {
  const card = page.locator("details").filter({ has: page.getByRole("heading", { name, exact: true }) });
  if (!(await card.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await card.locator("summary").click();
  }
}

export async function freshGoto(page: Page, path: string): Promise<void> {
  await page.request
    .post("/api/test/revalidate", { data: { path }, failOnStatusCode: false })
    .catch(() => {});
  await page.goto(path);
}

/**
 * Text as a reader actually sees it on a public post page.
 *
 * AnnotatableArticle keeps two copies of the body in the DOM — a server-
 * rendered static one and the interactive one — and swaps which is
 * `display: none` once the client is ready. A bare getByText therefore
 * matches twice and trips strict mode, while `.first()` would land on
 * whichever copy is currently hidden.
 */
export function visibleText(page: Page, text: string) {
  return page.getByText(text).filter({ visible: true });
}

/** The editor's status line: connection state, diff counts, present authors. */
export function statusLine(page: Page) {
  return page.locator("p").filter({ hasText: /🟢 Live|🔵 Connected|🟡 Connecting|🔴 Disconnected/ });
}

/**
 * Deletes an exact substring from the body editor.
 *
 * Selects it with a DOM `Range` and issues a real `delete` command, per the
 * recipe in PERFORMANCE.md — that drives a genuine ProseMirror transaction through
 * the normal path (mark tagging, Yjs sync) rather than reaching past it. The
 * alternative, arrowing a cursor to the right offset and pressing Backspace N
 * times, is far more fragile and no more realistic.
 */
export async function deleteTextInBody(page: Page, needle: string): Promise<void> {
  await bodyEditor(page).click();
  await page.evaluate((text) => {
    const root = document.querySelector('[aria-label="Post body"]');
    if (!root) throw new Error("Body editor not found.");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = node.textContent?.indexOf(text) ?? -1;
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      const selection = window.getSelection();
      if (!selection) throw new Error("No selection available.");
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("delete", false);
      return;
    }
    throw new Error(`"${text}" not found in the body editor.`);
  }, needle);
}

/**
 * Selects an exact substring in the body editor without deleting it — the
 * doc reading view's annotation-capture trigger (DocReadingBody's
 * onSelectionUpdate, PLAN.md §12i). A native `document.execCommand("delete")`
 * doesn't apply here since nothing should be removed; dispatching
 * `selectionchange` by hand is what makes TipTap's selection plugin (and so
 * onSelectionUpdate) notice a Range built directly in the DOM, the same way
 * deleteTextInBody's real `delete` command is what makes a Range-only
 * approach insufficient there.
 */
export async function selectTextInBody(page: Page, needle: string): Promise<void> {
  await selectTextIn(page, '[aria-label="Post body"]', needle);
}

/**
 * PLAN.md §13p — the same gesture inside a posted *annotation's* body, which
 * is a read-only ProseMirror surface of its own (AnnotationBodyReader) and
 * therefore selectable in exactly the same way. `nth` picks which annotation
 * on the page, in DOM order.
 */
export async function selectTextInAnnotation(page: Page, needle: string, nth = 0): Promise<void> {
  await selectTextIn(page, '[aria-label="Annotation"]', needle, nth);
}

async function selectTextIn(page: Page, rootSelector: string, needle: string, nth = 0): Promise<void> {
  await page.evaluate(
    ({ text, selector, index: rootIndex }) => {
      const root = document.querySelectorAll(selector)[rootIndex];
      if (!root) throw new Error(`No element matching ${selector} at index ${rootIndex}.`);
      // Focus first, then select — the order every real gesture has, and
      // one that matters on an *editable* editor: focus dispatches a
      // transaction (TipTap's FocusEvents), and if that re-renders any text
      // — the blurred-selection decoration coming off is one such change —
      // ProseMirror re-asserts its own state selection over whatever the DOM
      // held, so a range set *before* the focus is silently replaced by the
      // stale one and no selection change is ever seen. A read-only view
      // isn't focusable and is unaffected either way.
      if (root instanceof HTMLElement && root.isContentEditable) root.focus({ preventScroll: true });
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const index = node.textContent?.indexOf(text) ?? -1;
        if (index === -1) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        const selection = window.getSelection();
        if (!selection) throw new Error("No selection available.");
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return;
      }
      throw new Error(`"${text}" not found in ${selector}[${rootIndex}].`);
    },
    { text: needle, selector: rootSelector, index: nth },
  );
}

/**
 * DocEditor's counterpart — and since the badge gained "🔵 Connected",
 * "🟢 Live" genuinely means the provider has *synced* (initial content
 * applied), not merely that a websocket opened. That distinction is what
 * makes this gate safe to type after: quote-anchoring once failed at
 * workers=1 with the seeded body simply absent because the old
 * connected-only badge passed this wait before syncStep2 had delivered
 * anything (docs/playwright-flakiness.html, class 2). There's no Publish
 * button to also check readiness against: a doc has no save/publish step at
 * all (PLAN.md §12k), so synced is the only thing worth waiting for.
 */
export async function waitForDocCollabReady(page: Page): Promise<void> {
  await expect(page.getByText("🟢 Live")).toBeVisible({ timeout: 30_000 });
}

/**
 * Collapses the caret to the very start of the body editor, via a DOM Range
 * plus a `selectionchange` dispatch — the same mechanism selectTextInBody
 * uses, collapsed.
 *
 * Never do this with `Ctrl+A` + `ArrowLeft`: at synthetic keystroke speed
 * (~15ms gaps) ProseMirror's ingestion of the native arrow-key collapse races
 * the keystrokes that follow, and the next typed character can execute
 * against the still-standing select-all *state* — replacing the entire
 * document. That wiped quote-anchoring's first test in 20 of 30 measured
 * runs, at every worker count, ~50% even solo on an idle server; this recipe
 * went 12/12 in isolation and 6/6 on the real test
 * (docs/playwright-flakiness.html, class 1). A human typing at >50ms gaps
 * essentially can't hit the race, which is why the app itself is fine and
 * only synthetic input bleeds.
 */
export async function collapseToBodyStart(page: Page): Promise<void> {
  await bodyEditor(page).click();
  await page.evaluate(() => {
    const root = document.querySelector('[aria-label="Post body"]');
    if (!root) throw new Error("Body editor not found.");
    const node = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) throw new Error("Body editor has no text to collapse into.");
    const range = document.createRange();
    range.setStart(node, 0);
    range.collapse(true);
    const selection = window.getSelection();
    if (!selection) throw new Error("No selection available.");
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}
