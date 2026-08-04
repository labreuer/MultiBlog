// PLAN.md §16 — the shared admin-table kit: filters/sort/pagination in the
// URL, and the row-status left border that replaced the saved-row pulse.
//
// /users is the subject for both because it's the one table with inline-edit
// cells, so it exercises the full idle → edited → saving → saved path that
// §16f describes; the URL assertions hold for every table on the kit.
import { test, expect } from "./fixtures";
import {
  ADMIN_EMAIL,
  clearColumnOrder,
  createComment,
  createTestDoc,
  createTestPost,
  createTestUser,
  deleteTestDoc,
  deleteTestPost,
  deleteTestUser,
  uniqueEmail,
  uniqueTitle,
} from "./db";

// The four border colors from AdminTable.module.css, as the browser reports
// them. Asserting the computed color (rather than a class name) is what makes
// this a test of what an admin actually sees.
const IDLE = "rgba(0, 0, 0, 0)";
const EDITED = "rgb(153, 153, 153)";
const SAVED = "rgb(0, 170, 85)";

test.describe("admin table kit", () => {
  test("a row's left border tracks idle → edited → saved", async ({ page }) => {
    const email = uniqueEmail("rowstatus");
    await createTestUser({ email, name: "Row Status", role: "AUTHOR" });

    try {
      // ?q= narrows to this worker's own user, so parallel workers can't make
      // the row ambiguous (same reason moderation.spec.ts deep-links ?post=).
      await page.goto(`/users?q=${encodeURIComponent(email)}`);

      const row = page.getByRole("row").filter({ hasText: email });
      await expect(row).toBeVisible();
      // The border lives on the row's first cell, which is the selection
      // checkbox's — the leftmost edge of the row, whatever it contains. The
      // Name input it reports on is the cell after it.
      const firstCell = row.locator("td").first();
      const borderColor = () =>
        firstCell.evaluate((el) => getComputedStyle(el).borderLeftColor);

      // Every row reserves the 3px border, transparent, so nothing shifts
      // horizontally when a status appears.
      await expect(firstCell).toHaveCSS("border-left-width", "3px");
      expect(await borderColor()).toBe(IDLE);

      const nameInput = row.locator("td").nth(1).getByRole("textbox");
      await nameInput.fill("Row Status Edited");
      expect(await borderColor()).toBe(EDITED);

      // Blur commits. "saving" (amber) is real but too brief to assert
      // without racing the server action, so this polls for the settled state.
      await nameInput.blur();
      await expect.poll(borderColor).toBe(SAVED);

      // …and the edit actually landed, rather than the border merely claiming
      // so. Scoped to one cell: a user row carries three textboxes (name,
      // initials, color).
      await page.reload();
      const reloadedName = page
        .getByRole("row")
        .filter({ hasText: email })
        .locator("td")
        .nth(1)
        .getByRole("textbox");
      await expect(reloadedName).toHaveValue("Row Status Edited");
    } finally {
      await deleteTestUser(email);
    }
  });

  test("search, sort and page size are mirrored into the querystring", async ({ page }) => {
    const email = uniqueEmail("urlstate");
    await createTestUser({ email, name: "Url State", role: "AUTHOR" });

    try {
      await page.goto("/users");
      // No params at all on a default view: the sort matches the default and
      // the page size matches this admin's own stored preference (§16b), so
      // neither is worth spending a querystring on.
      await expect(page).toHaveURL(/\/users$/);

      // Debounced 400ms, so the URL lands a beat after the last keystroke.
      await page.getByRole("searchbox", { name: "Search users" }).fill(email);
      await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(email).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

      await page.getByRole("columnheader", { name: "Email" }).click();
      await expect(page).toHaveURL(/sort=email%3Aasc/);
      // Clicking the same lone column again flips it rather than adding a key.
      await page.getByRole("columnheader", { name: "Email" }).click();
      await expect(page).toHaveURL(/sort=email%3Adesc/);

      await page.getByLabel("Rows per page").selectOption("10");
      await expect(page).toHaveURL(/pageSize=10/);
      // Changing a filter resets to page 1, so `page` never appears here.
      await expect(page).not.toHaveURL(/[?&]page=/);

      // A page size equal to the stored preference drops back out of the URL
      // instead of being pinned as a redundant param.
      await page.getByLabel("Rows per page").selectOption("25");
      await expect(page).not.toHaveURL(/pageSize=/);
    } finally {
      await deleteTestUser(email);
    }
  });

  test("bulk actions apply to the selected rows, by button and by select", async ({ page }) => {
    // A prefix both users share, so one ?q= brings exactly this test's rows
    // into view regardless of what other workers created.
    const first = uniqueEmail("bulkops");
    const second = uniqueEmail("bulkops");
    await createTestUser({ email: first, name: "Bulk One", role: "AUTHOR" });
    await createTestUser({ email: second, name: "Bulk Two", role: "AUTHOR" });

    try {
      // ?deleted=1 so the rows stay on screen after being deleted, which is
      // what makes the assertion possible at all.
      await page.goto("/users?q=bulkops&deleted=1");
      const rowFor = (email: string) => page.getByRole("row").filter({ hasText: email });
      await expect(rowFor(first)).toBeVisible();
      await expect(rowFor(second)).toBeVisible();

      // §16f's border applies to bulk changes too, so both rows start idle and
      // have to end up green — the same standing record a single-cell edit
      // leaves, which is what tells an admin which rows an action touched once
      // the selection has been cleared out from under them.
      const borderOf = (email: string) =>
        rowFor(email)
          .locator("td")
          .first()
          .evaluate((el) => getComputedStyle(el).borderLeftColor);
      expect(await borderOf(first)).toBe(IDLE);
      expect(await borderOf(second)).toBe(IDLE);

      await rowFor(first).getByRole("checkbox").check();
      await rowFor(second).getByRole("checkbox").check();
      await expect(page.getByText("2 selected")).toBeVisible();

      // A select-kind action: every selected row's role at once.
      await page.getByLabel("Set role").selectOption("EDITOR");
      await expect(rowFor(first).getByRole("combobox").first()).toHaveValue("EDITOR");
      await expect(rowFor(second).getByRole("combobox").first()).toHaveValue("EDITOR");
      // Running an action clears the selection rather than leaving it armed.
      await expect(page.getByText("2 selected")).toHaveCount(0);

      // Both rows carry the saved border, and still do after the selection is
      // gone. ("saving" is real but too brief to assert without racing the
      // action, same as the single-row test above.)
      await expect.poll(() => borderOf(first)).toBe(SAVED);
      await expect.poll(() => borderOf(second)).toBe(SAVED);

      // A button-kind action, and the one whose applicableTo matters: both
      // rows are live, so both are deleted and each offers Restore afterwards.
      await rowFor(first).getByRole("checkbox").check();
      await rowFor(second).getByRole("checkbox").check();
      await page.getByRole("button", { name: "Delete selected users" }).click();
      await expect(rowFor(first).getByRole("button", { name: "Restore user" })).toBeVisible();
      await expect(rowFor(second).getByRole("button", { name: "Restore user" })).toBeVisible();
      await expect.poll(() => borderOf(first)).toBe(SAVED);
      await expect.poll(() => borderOf(second)).toBe(SAVED);

      // Rows an action skips are left alone rather than swept up with the rest,
      // so the border answers "which of the rows I selected did that actually
      // change?" — not just "did something run?".
      //
      // A reload clears the statuses (they are visit-local, §16f), leaving both
      // rows deleted and idle. Restoring only `first` makes the selection mixed
      // for Set role, whose applicableTo is `!row.deleted`: `first` applies,
      // `second` is dropped silently and must stay idle.
      await page.reload();
      expect(await borderOf(first)).toBe(IDLE);
      expect(await borderOf(second)).toBe(IDLE);

      await rowFor(first).getByRole("button", { name: "Restore user" }).click();
      await expect.poll(() => borderOf(first)).toBe(SAVED);

      await rowFor(first).getByRole("checkbox").check();
      await rowFor(second).getByRole("checkbox").check();
      await page.getByLabel("Set role").selectOption("AUTHOR");
      await expect(rowFor(first).getByRole("combobox").first()).toHaveValue("AUTHOR");
      expect(await borderOf(second)).toBe(IDLE);
    } finally {
      await deleteTestUser(first);
      await deleteTestUser(second);
    }
  });

  // PLAN.md §16e — these two columns are the reason the post_activity view
  // exists: both are properties of the *latest* row of a to-many relation,
  // which Prisma can only order by _count. Asserting the actual row order (not
  // just that the header is clickable) is the whole point — a sort through a
  // view fails by returning the wrong order, not by throwing.
  test("Last edit by/at sort through the post_activity view", async ({ page }) => {
    const token = `viewsort${Date.now()}`;
    const earlyAuthor = uniqueEmail("viewsort-early");
    const lateAuthor = uniqueEmail("viewsort-late");
    // Names, not emails, decide the "Last edit by" order: the view is
    // COALESCE(name, email), and these two bracket the alphabet.
    await createTestUser({ email: earlyAuthor, name: "Aaa Firstauthor", role: "ADMIN" });
    await createTestUser({ email: lateAuthor, name: "Zzz Lastauthor", role: "ADMIN" });

    // Published in this order, so `alpha`'s publication event is the older one.
    const alpha = await createTestPost({
      authorEmail: earlyAuthor,
      title: uniqueTitle(`${token} alpha`),
      publish: true,
    });
    const beta = await createTestPost({
      authorEmail: lateAuthor,
      title: uniqueTitle(`${token} beta`),
      publish: true,
    });

    try {
      const table = page.getByRole("table").first();
      const titlesInOrder = () => table.locator("tbody tr td:nth-child(2) a").allTextContents();

      // ?q= narrows to just this test's two posts, so other rows can't affect
      // the relative order being asserted.
      await page.goto(`/posts?q=${token}&sort=lastEdit:asc`);
      expect(await titlesInOrder()).toEqual([alpha.title, beta.title]);

      await page.goto(`/posts?q=${token}&sort=lastEdit:desc`);
      expect(await titlesInOrder()).toEqual([beta.title, alpha.title]);

      await page.goto(`/posts?q=${token}&sort=editor:asc`);
      expect(await titlesInOrder()).toEqual([alpha.title, beta.title]);

      await page.goto(`/posts?q=${token}&sort=editor:desc`);
      expect(await titlesInOrder()).toEqual([beta.title, alpha.title]);

      // The displayed names come from the same view the sort reads, so they
      // agree by construction rather than by coincidence.
      await expect(page.getByRole("row").filter({ hasText: alpha.title })).toContainText("Aaa Firstauthor");
      await expect(page.getByRole("row").filter({ hasText: beta.title })).toContainText("Zzz Lastauthor");

      // And the header is wired up, not just the URL.
      await page.goto(`/posts?q=${token}`);
      await page.getByRole("columnheader", { name: "Last edit at" }).click();
      await expect(page).toHaveURL(/sort=lastEdit%3Aasc/);
    } finally {
      await deleteTestPost(alpha.id);
      await deleteTestPost(beta.id);
      await deleteTestUser(earlyAuthor);
      await deleteTestUser(lateAuthor);
    }
  });

  // PLAN.md §16l — the last two /posts columns to get a sort, both through
  // post_metrics. Same reasoning as the post_activity test above: a sort
  // through a view fails by returning the wrong order, so only asserting the
  // actual row order proves anything.
  test("Author(s) and Comments sort through the post_metrics view", async ({ page }) => {
    const token = `pmetrics${Date.now()}`;
    const aaAuthor = uniqueEmail("pmetrics-aa");
    const zzAuthor = uniqueEmail("pmetrics-zz");
    // createTestUser derives adminInitials as name.slice(0, 2).toUpperCase(),
    // and the byline the view string_aggs is built from those — so these two
    // names bracket the alphabet as "AA" and "ZZ".
    await createTestUser({ email: aaAuthor, name: "Aaa Alpha", role: "ADMIN" });
    await createTestUser({ email: zzAuthor, name: "Zzz Omega", role: "ADMIN" });

    const alpha = await createTestPost({
      authorEmail: aaAuthor,
      title: uniqueTitle(`${token} alpha`),
      publish: true,
    });
    const beta = await createTestPost({
      authorEmail: zzAuthor,
      title: uniqueTitle(`${token} beta`),
      publish: true,
    });

    // beta gets everything the Comments column counts; alpha gets only a SPAM
    // comment, which the view must *not* count — so alpha reading 0 is a real
    // assertion about the status filter, not just an absence of data.
    for (const body of ["First approved", "Second approved"]) {
      await createComment({
        postId: beta.id,
        anchoredEventId: beta.eventId!,
        email: uniqueEmail("pmetrics-commenter"),
        displayName: "Beta Commenter",
        body,
        status: "APPROVED",
      });
    }
    await createComment({
      postId: beta.id,
      anchoredEventId: beta.eventId!,
      email: uniqueEmail("pmetrics-commenter"),
      displayName: "Beta Moderatee",
      body: "Awaiting moderation",
      status: "PENDING",
    });
    await createComment({
      postId: alpha.id,
      anchoredEventId: alpha.eventId!,
      email: uniqueEmail("pmetrics-commenter"),
      displayName: "Alpha Spammer",
      body: "Uncounted spam",
      status: "SPAM",
    });

    try {
      const table = page.getByRole("table").first();
      const titlesInOrder = () => table.locator("tbody tr td:nth-child(2) a").allTextContents();

      await page.goto(`/posts?q=${token}&sort=authors:asc`);
      expect(await titlesInOrder()).toEqual([alpha.title, beta.title]);

      await page.goto(`/posts?q=${token}&sort=authors:desc`);
      expect(await titlesInOrder()).toEqual([beta.title, alpha.title]);

      // The byline the view produced is also the byline the cell prints —
      // the property that makes sorting and display impossible to drift.
      await expect(page.getByRole("row").filter({ hasText: alpha.title })).toContainText("AA");
      await expect(page.getByRole("row").filter({ hasText: beta.title })).toContainText("ZZ");

      // beta has 2 approved, alpha 0, so descending puts beta first.
      await page.goto(`/posts?q=${token}&sort=comments:desc`);
      expect(await titlesInOrder()).toEqual([beta.title, alpha.title]);

      await page.goto(`/posts?q=${token}&sort=comments:asc`);
      expect(await titlesInOrder()).toEqual([alpha.title, beta.title]);

      // SPAM counts for neither number: alpha's only comment is spam, so its
      // cell offers no moderation link at all.
      const betaRow = page.getByRole("row").filter({ hasText: beta.title });
      const alphaRow = page.getByRole("row").filter({ hasText: alpha.title });
      await expect(betaRow).toContainText("in moderation 1");
      await expect(alphaRow).not.toContainText("in moderation");

      await page.goto(`/posts?q=${token}`);
      await page.getByRole("columnheader", { name: "Comments" }).click();
      await expect(page).toHaveURL(/sort=comments%3Aasc/);
    } finally {
      await deleteTestPost(alpha.id);
      await deleteTestPost(beta.id);
      await deleteTestUser(aaAuthor);
      await deleteTestUser(zzAuthor);
    }
  });

  // PLAN.md §16l — /docs' last two, through doc_metrics. Length is the one
  // that also retired a second round trip, so this covers both the ordering
  // and that the number still renders from the view.
  test("Author(s) and Length sort through the doc_metrics view", async ({ page }) => {
    const token = `dmetrics${Date.now()}`;
    const aaAuthor = uniqueEmail("dmetrics-aa");
    const zzAuthor = uniqueEmail("dmetrics-zz");
    await createTestUser({ email: aaAuthor, name: "Aaa Alpha", role: "ADMIN" });
    await createTestUser({ email: zzAuthor, name: "Zzz Omega", role: "ADMIN" });

    // `bodyText` is what makes this test possible: createTestDoc writes the
    // prose_json cache the collab server would have written, and Length is
    // measured from that column — so two docs given different bodies really do
    // differ here, with no collab server in the loop.
    const shortBody = "Tiny.";
    const longBody = "A considerably longer body, so the two docs cannot tie on length.";
    const shortDoc = await createTestDoc({
      authorEmail: aaAuthor,
      title: uniqueTitle(`${token} shorter`),
      bodyText: shortBody,
    });
    const longDoc = await createTestDoc({
      authorEmail: zzAuthor,
      title: uniqueTitle(`${token} longer`),
      bodyText: longBody,
    });

    try {
      const table = page.getByRole("table").first();
      const titlesInOrder = () => table.locator("tbody tr td:nth-child(2) a").allTextContents();

      await page.goto(`/docs?q=${token}&sort=length:asc`);
      expect(await titlesInOrder()).toEqual([shortDoc.title, longDoc.title]);

      await page.goto(`/docs?q=${token}&sort=length:desc`);
      expect(await titlesInOrder()).toEqual([longDoc.title, shortDoc.title]);

      // The rendered number is doc_length's own count of the body text, which
      // for a single paragraph of plain text is just its character count.
      await expect(page.getByRole("row").filter({ hasText: longDoc.title })).toContainText(String(longBody.length));

      // "Aaa Alpha" authors the short doc, "Zzz Omega" the long one, so the
      // byline order is the opposite of the length order — which is what
      // makes these two assertions independent of each other.
      await page.goto(`/docs?q=${token}&sort=authors:asc`);
      expect(await titlesInOrder()).toEqual([shortDoc.title, longDoc.title]);

      await page.goto(`/docs?q=${token}&sort=authors:desc`);
      expect(await titlesInOrder()).toEqual([longDoc.title, shortDoc.title]);

      await expect(page.getByRole("row").filter({ hasText: shortDoc.title })).toContainText("AA");
      await expect(page.getByRole("row").filter({ hasText: longDoc.title })).toContainText("ZZ");

      await page.goto(`/docs?q=${token}`);
      await page.getByRole("columnheader", { name: "Length" }).click();
      await expect(page).toHaveURL(/sort=length%3Aasc/);
    } finally {
      await deleteTestDoc(shortDoc.id);
      await deleteTestDoc(longDoc.id);
      await deleteTestUser(aaAuthor);
      await deleteTestUser(zzAuthor);
    }
  });

  // PLAN.md §16d — a just-deleted row keeps its place. With the show-deleted
  // toggle off it is gone from the refetch entirely, so useRevealedRows puts it
  // back from its overlay; appending it there sent it to the bottom of the
  // table, which reads as the list spontaneously re-sorting.
  test("a deleted row stays where it was, not at the bottom", async ({ page }) => {
    const token = `ordering${Date.now()}`;
    // Created oldest → newest. /users defaults to createdAt desc, so the
    // display order is the reverse of creation: third, second, first.
    const first = uniqueEmail(`${token}-first`);
    const second = uniqueEmail(`${token}-second`);
    const third = uniqueEmail(`${token}-third`);
    for (const email of [first, second, third]) {
      await createTestUser({ email, name: email.split("@")[0], role: "AUTHOR" });
    }

    try {
      // No ?deleted=1 here — the toggle being *off* is the whole point, since
      // that is what makes the server drop the row and the overlay supply it.
      await page.goto(`/users?q=${token}`);
      const positions = async () =>
        (await page.locator("table").first().locator("tbody tr").allTextContents()).map(
          (text) => text.match(/ordering\d+-(first|second|third)/)?.[1] ?? "?",
        );

      expect(await positions()).toEqual(["third", "second", "first"]);

      // Single-row delete, from the middle.
      await page
        .getByRole("row")
        .filter({ hasText: second })
        .getByRole("button", { name: "Delete user" })
        .click();
      await expect(page.getByRole("row").filter({ hasText: second }).getByRole("button", { name: "Restore user" })).toBeVisible();
      expect(await positions()).toEqual(["third", "second", "first"]);

      // A real navigation clears the overlay, at which point the row is simply
      // gone — the overlay is visit-local, not a second source of truth.
      await page.reload();
      expect(await positions()).toEqual(["third", "first"]);

      // And the bulk path, which reveals several rows at once: both deleted
      // rows have to land back in their own slots, not both at the end.
      await page.goto(`/users?q=${token}`);
      expect(await positions()).toEqual(["third", "first"]);
      await page.getByRole("row").filter({ hasText: third }).getByRole("checkbox").check();
      await page.getByRole("row").filter({ hasText: first }).getByRole("checkbox").check();
      await page.getByRole("button", { name: "Delete selected users" }).click();
      await expect(page.getByRole("row").filter({ hasText: third }).getByRole("button", { name: "Restore user" })).toBeVisible();
      expect(await positions()).toEqual(["third", "first"]);
    } finally {
      for (const email of [first, second, third]) await deleteTestUser(email);
    }
  });

  // PLAN.md §16i — column visibility and order. /docs is the subject because it
  // is the table converted to ColumnSpec; the behaviour is the kit's, not its.
  test("columns hide, reorder and persist, and the fixed ones can't be dropped", async ({ page }) => {
    const headers = async () =>
      (await page.locator("table").first().locator("thead th").allTextContents()).map((t) =>
        t.replace(/[▲▼\s]/g, ""),
      );

    try {
      await page.goto("/docs");
      // Two of the eight are alwaysVisible and render as icon-only headers, so
      // they read as "" here — position is what matters for them.
      expect(await headers()).toEqual(["", "Title", "Edit", "Author(s)", "Visibility", "Created", "Length", ""]);

      // Hiding: only the named movable columns survive, and the fixed pair
      // still brackets them.
      await page.goto("/docs?cols=title,length");
      expect(await headers()).toEqual(["", "Title", "Length", ""]);

      // Order is position in the list, so reversing the list reverses them.
      await page.goto("/docs?cols=length,title");
      expect(await headers()).toEqual(["", "Length", "Title", ""]);

      // An unknown key is dropped rather than throwing — a renamed column in a
      // bookmarked URL should degrade, not 500.
      await page.goto("/docs?cols=title,no-such-column,length");
      expect(await headers()).toEqual(["", "Title", "Length", ""]);

      // colSpan follows the visible count instead of the literal it used to be.
      await page.goto("/docs?cols=title&q=zzz-no-such-doc");
      await expect(page.locator("tbody td[colspan]")).toHaveAttribute("colspan", "3");

      // A sort naming a hidden column stays honoured — dropping it would
      // silently change the result set. Only reachable by hand-editing a URL,
      // which is exactly why it needs pinning.
      const titlesFor = async (qs: string) => {
        await page.goto(`/docs${qs}`);
        return (await page.locator("table").first().locator("tbody tr").allTextContents()).map((t) => t.slice(0, 20));
      };
      const ascVisible = await titlesFor("?sort=length:asc");
      expect(await titlesFor("?cols=title&sort=length:asc")).toEqual(ascVisible);
      expect(await titlesFor("?cols=title&sort=length:desc")).toEqual([...ascVisible].reverse());

      // The picker writes the URL, and the fixed columns are listed but locked.
      await page.goto("/docs");
      await page.getByText(/^Columns: \d+\/\d+$/).click();
      await expect(page.getByLabel("select (always shown)")).toBeDisabled();
      await expect(page.getByLabel("deleted (always shown)")).toBeDisabled();
      // click(), not uncheck(): the checkbox is driven by `filters.cols`, which
      // only changes once the navigation lands, so uncheck()'s immediate
      // did-the-state-flip assertion races the round trip.
      await page.locator("label").filter({ hasText: "Visibility" }).getByRole("checkbox").click();
      await expect(page).toHaveURL(/cols=/);
      expect(await headers()).toEqual(["", "Title", "Edit", "Author(s)", "Created", "Length", ""]);

      // Save as my default: the preference persists, and the URL stops
      // carrying the override it was authored with.
      await page.getByRole("button", { name: "Save as my default" }).click();
      await expect(page).not.toHaveURL(/cols=/);
      // The real proof — a fresh navigation with no ?cols= at all still hides it.
      await page.goto("/docs");
      expect(await headers()).toEqual(["", "Title", "Edit", "Author(s)", "Created", "Length", ""]);
    } finally {
      // The shared admin is reused by every other spec, so this has to go back.
      await clearColumnOrder(ADMIN_EMAIL);
    }
  });

  test("every admin table paginates and keeps its controls when nothing matches", async ({ page }) => {
    for (const path of ["/posts", "/docs", "/users", "/comments", "/annotations"]) {
      // A search no row can match: the table must still render its header and
      // an empty-state row rather than collapsing to a bare paragraph, or the
      // filter that produced the empty result would be unreachable (§16d).
      await page.goto(`${path}?q=zzz-no-such-row-zzz`);
      await expect(page.getByRole("table").first()).toBeVisible();
      await expect(page.getByText(/no .* matching the criteria/i)).toBeVisible();
      await expect(page.getByLabel("Rows per page")).toBeVisible();
      // Exact names: a bare "Next" also matches Next.js's dev-tools button.
      await expect(page.getByRole("button", { name: "◀ Prev", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Next ▶", exact: true })).toBeDisabled();
    }
  });
});
