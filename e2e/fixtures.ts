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
 * cookie jar (CLAUDE.md), which makes "two users at once" a manual balancing
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
      anchoredRevisionId: post.revisionId,
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
      const user = await createTestUser({ email, name: "Second Editor", role });
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
  return page.locator("p").filter({ hasText: /🟢 Live|🟡 Connecting|🔴 Disconnected/ });
}

/**
 * Deletes an exact substring from the body editor.
 *
 * Selects it with a DOM `Range` and issues a real `delete` command, per the
 * recipe in CLAUDE.md — that drives a genuine ProseMirror transaction through
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
 * doc reading view's annotation-capture trigger (LiveDocBody's
 * onSelectionUpdate, PLAN.md §12i). A native `document.execCommand("delete")`
 * doesn't apply here since nothing should be removed; dispatching
 * `selectionchange` by hand is what makes TipTap's selection plugin (and so
 * onSelectionUpdate) notice a Range built directly in the DOM, the same way
 * deleteTextInBody's real `delete` command is what makes a Range-only
 * approach insufficient there.
 */
export async function selectTextInBody(page: Page, needle: string): Promise<void> {
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
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`"${text}" not found in the body editor.`);
  }, needle);
}

/**
 * Waits for the collab handshake, not just for the editor to render.
 *
 * PostEditor gates Save/Publish/Schedule on the provider having synced —
 * before that the local Y.Doc is legitimately empty, and a save would persist
 * that emptiness over the real content. So "🟢 Live" is the earliest point at
 * which acting on the editor means anything.
 */
export async function waitForCollabReady(page: Page): Promise<void> {
  await expect(page.getByText("🟢 Live")).toBeVisible({ timeout: 30_000 });
  // `exact` matters: without it "Publish" also matches the Unpublish button.
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
}

/**
 * DocEditor's counterpart — "🟢 Live" is the same synced signal, but there's
 * no Publish button to also check readiness against: a doc has no
 * save/publish step at all (PLAN.md §12k), so the provider having synced is
 * the only thing worth waiting for.
 */
export async function waitForDocCollabReady(page: Page): Promise<void> {
  await expect(page.getByText("🟢 Live")).toBeVisible({ timeout: 30_000 });
}
