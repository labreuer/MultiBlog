// Per-doc access (PLAN.md §12p). A PRIVATE doc is readable and editable by
// its listed DocAuthors alone, whatever the role; a SHARED doc is readable by
// anyone with canViewDocs and editable by any ADMIN/EDITOR. Both rules live
// in the same two functions (src/lib/doc-authz.ts), so both are pinned here.
// /docs carries an ADMIN-only "Show all docs" checkbox that widens that one
// listing and reaches nothing else.
import { test, expect, visibleText } from "./fixtures";
import {
  ADMIN_EMAIL,
  addTestDocAuthor,
  clearColumnOrder,
  createTestAnnotation,
  createTestDoc,
  createTestUser,
  deleteTestDoc,
  deleteTestUser,
  uniqueEmail,
  uniqueTitle,
} from "./db";

test.describe("PRIVATE doc authorization (PLAN.md §12p)", () => {
  test("an ADMIN who isn't a listed author can't read or edit a PRIVATE doc", async ({ secondUser }) => {
    const privateDoc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "PRIVATE", bodyText: "Secret." });
    const { page: adminPage } = await secondUser({ role: "ADMIN" });

    try {
      await adminPage.goto(`/doc/${privateDoc.id}`);
      await expect(adminPage.getByRole("heading", { name: "Forbidden" })).toBeVisible();
      await expect(adminPage.getByText("You don't have permission to read this doc.")).toBeVisible();

      await adminPage.goto(`/doc/${privateDoc.id}/edit`);
      await expect(adminPage.getByRole("heading", { name: "Forbidden" })).toBeVisible();
      await expect(adminPage.getByText("You don't have permission to edit this doc.")).toBeVisible();
    } finally {
      await adminPage.goto("about:blank").catch(() => {});
      await deleteTestDoc(privateDoc.id);
    }
  });

  test("an EDITOR who isn't a listed author can't read or edit a PRIVATE doc", async ({ secondUser }) => {
    const privateDoc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "PRIVATE", bodyText: "Secret." });
    const { page: editorPage } = await secondUser({ role: "EDITOR" });

    try {
      await editorPage.goto(`/doc/${privateDoc.id}`);
      await expect(editorPage.getByRole("heading", { name: "Forbidden" })).toBeVisible();

      await editorPage.goto(`/doc/${privateDoc.id}/edit`);
      await expect(editorPage.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    } finally {
      await editorPage.goto("about:blank").catch(() => {});
      await deleteTestDoc(privateDoc.id);
    }
  });

  test("a listed author reads and edits their PRIVATE doc", async ({ secondUser }) => {
    const privateDoc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "PRIVATE", bodyText: "Secret." });
    const { user, page: authorPage } = await secondUser({ role: "AUTHOR" });
    await addTestDocAuthor(privateDoc.id, user.email);

    try {
      await authorPage.goto(`/doc/${privateDoc.id}`);
      await expect(authorPage.getByRole("heading", { name: "Forbidden" })).not.toBeVisible();
      await expect(visibleText(authorPage, "Secret.")).toBeVisible();

      await authorPage.goto(`/doc/${privateDoc.id}/edit`);
      await expect(authorPage.getByRole("heading", { name: "Forbidden" })).not.toBeVisible();
    } finally {
      await authorPage.goto("about:blank").catch(() => {});
      await deleteTestDoc(privateDoc.id);
    }
  });

  test("an ADMIN/EDITOR reads and edits a SHARED doc without a byline on it", async ({ secondUser }) => {
    const sharedDoc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Public." });
    const { page: editorPage } = await secondUser({ role: "EDITOR" });

    try {
      await editorPage.goto(`/doc/${sharedDoc.id}`);
      await expect(editorPage.getByRole("heading", { name: "Forbidden" })).not.toBeVisible();

      await editorPage.goto(`/doc/${sharedDoc.id}/edit`);
      await expect(editorPage.getByRole("heading", { name: "Forbidden" })).not.toBeVisible();
    } finally {
      await editorPage.goto("about:blank").catch(() => {});
      await deleteTestDoc(sharedDoc.id);
    }
  });
});

test.describe("/docs 'Show all docs' admin override (PLAN.md §12p)", () => {
  test("a PRIVATE doc the admin has no byline on appears only once the box is ticked, and stays shut", async ({
    page,
  }) => {
    const token = `showall${Date.now()}`;
    const otherAdmin = uniqueEmail("showall-other");
    await createTestUser({ email: otherAdmin, name: "Other Admin", role: "ADMIN" });
    const notOwned = await createTestDoc({
      authorEmail: otherAdmin,
      title: uniqueTitle(`${token} not-owned`),
      visibility: "PRIVATE",
    });

    try {
      // The shared admin has no byline on this doc, so the ordinary listing
      // leaves it out.
      await page.goto(`/docs?q=${token}`);
      await expect(page.getByText("No docs matching the criteria.")).toBeVisible();
      await expect(page.getByRole("link", { name: notOwned.title })).toHaveCount(0);

      // The checkbox is an ADMIN's to tick, and ticking it brings the doc in.
      // click(), not check(): the checkbox is driven by filters.showAllDocs,
      // which only changes once the navigation lands, so check()'s own
      // did-the-state-flip assertion races the round trip (same reasoning as
      // admin-table.spec.ts's column-picker checkboxes).
      const checkbox = page.getByLabel(/Show all docs/);
      await expect(checkbox).toBeVisible();
      await checkbox.click();
      await expect(page).toHaveURL(/showAllDocs=1/);
      await expect(page.getByRole("link", { name: notOwned.title })).toBeVisible();

      // Listed, but with no Edit link: the override widens which rows appear,
      // not who may edit them, so the column matches what the editor route
      // would say rather than offering a link that leads to Forbidden.
      await expect(
        page.getByRole("row").filter({ hasText: notOwned.title }).getByRole("link", { name: "edit" }),
      ).toHaveCount(0);

      // The override governs the listing alone; the doc's own route refuses.
      await page.goto(`/doc/${notOwned.id}`);
      await expect(page.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(notOwned.id);
      await deleteTestUser(otherAdmin);
      await clearColumnOrder(ADMIN_EMAIL);
    }
  });

  test("a SHARED doc someone else authored is listed, and editable, with the box unticked", async ({ page }) => {
    // /docs scopes its own rows rather than calling into doc-authz.ts, so it
    // states the SHARED rule separately (PLAN.md §12p). This pins the two
    // together: a doc this admin can open and edit straight from a URL is
    // also in the table, whoever's byline it carries.
    const token = `sharedlist${Date.now()}`;
    const otherAdmin = uniqueEmail("sharedlist-other");
    await createTestUser({ email: otherAdmin, name: "Other Admin", role: "ADMIN" });
    const sharedDoc = await createTestDoc({
      authorEmail: otherAdmin,
      title: uniqueTitle(`${token} shared`),
      visibility: "SHARED",
    });

    try {
      await page.goto(`/docs?q=${token}`);
      await expect(page.getByRole("link", { name: sharedDoc.title })).toBeVisible();
      await expect(page.getByRole("row").filter({ hasText: sharedDoc.title }).getByRole("link", { name: "edit" }))
        .toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(sharedDoc.id);
      await deleteTestUser(otherAdmin);
    }
  });

  test("EDITOR gets no override checkbox on /docs", async ({ secondUser }) => {
    const { page: editorPage } = await secondUser({ role: "EDITOR" });
    try {
      await editorPage.goto("/docs");
      await expect(editorPage.getByLabel(/Show all docs/)).toHaveCount(0);
    } finally {
      await editorPage.goto("about:blank").catch(() => {});
    }
  });
});

test.describe("/annotations is scoped to readable docs (PLAN.md §12p)", () => {
  // /annotations selects doc.proseJson and renders an excerpt as its Quote
  // column, so its row scoping is a content-exposure boundary, not just a
  // convenience filter — an annotation listed here reveals its doc's title
  // and a piece of its body.
  test("an annotation on someone else's PRIVATE doc is absent, by listing and by deep link", async ({ page }) => {
    const otherAuthor = uniqueEmail("annscope-other");
    await createTestUser({ email: otherAuthor, name: "Other Author", role: "AUTHOR" });
    const privateDoc = await createTestDoc({
      authorEmail: otherAuthor,
      title: uniqueTitle("annscope private"),
      visibility: "PRIVATE",
    });
    const secret = `Secret annotation ${Date.now()}`;
    await createTestAnnotation({ docId: privateDoc.id, authorEmail: otherAuthor, bodyText: secret });

    try {
      // The shared admin has no byline on this doc, and PRIVATE grants
      // nothing by role — so neither the doc nor its annotation surfaces.
      await page.goto("/annotations");
      await expect(page.getByText(secret)).toHaveCount(0);
      await expect(page.getByText(privateDoc.title)).toHaveCount(0);

      // ?doc= names the doc outright; scoping is applied ahead of it rather
      // than being something the deep link can step around.
      await page.goto(`/annotations?doc=${privateDoc.id}`);
      await expect(page.getByText(secret)).toHaveCount(0);
      await expect(page.getByText(privateDoc.title)).toHaveCount(0);

      // And the doc itself is refused, which is the rule this table now tracks.
      await page.goto(`/doc/${privateDoc.id}`);
      await expect(page.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(privateDoc.id);
      await deleteTestUser(otherAuthor);
    }
  });

  test("an annotation on someone else's SHARED doc is listed", async ({ page }) => {
    const otherAuthor = uniqueEmail("annscope-shared");
    await createTestUser({ email: otherAuthor, name: "Other Author", role: "AUTHOR" });
    const sharedDoc = await createTestDoc({
      authorEmail: otherAuthor,
      title: uniqueTitle("annscope shared"),
      visibility: "SHARED",
    });
    const body = `Shared annotation ${Date.now()}`;
    await createTestAnnotation({ docId: sharedDoc.id, authorEmail: otherAuthor, bodyText: body });

    try {
      await page.goto(`/annotations?doc=${sharedDoc.id}`);
      await expect(page.getByText(body)).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(sharedDoc.id);
      await deleteTestUser(otherAuthor);
    }
  });
});
