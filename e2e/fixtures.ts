// The extended `test` every spec imports instead of @playwright/test's.
//
// Each fixture owns its own throwaway rows and deletes them afterwards, so
// specs never share state and can run in any order across workers.
import { test as base, expect, type Page, type Browser } from "@playwright/test";
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

export async function signIn(page: Page, email: string, password = TEST_PASSWORD): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard");
}

async function signedInContext(browser: Browser, email: string): Promise<Page> {
  // storageState is explicitly empty rather than inherited — inheriting the
  // admin's would sign this "second user" in as the first one.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await signIn(page, email);
  return page;
}

export const test = base.extend<Fixtures>({
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
