import { test, expect, gotoOk } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  ADMIN_EMAIL,
  TEST_PASSWORD,
  createTestFile,
  deleteTestFile,
  getFileSlugFacts,
  getUploadFacts,
  renameTestFileSlug,
  setTestFileOwners,
  uniqueTitle,
} from "./db";
import { buildTestDocx } from "../scripts/make-test-docx";

// docs/PDF.md §14 — a file's manage page, /files/<id>/manage, without its
// versions: the gate and the address, the file's title, slug, visibility and
// owners, delete and restore, the refusals in their own words, /files' Manage
// column and the viewer's link here. The default `page` is the shared admin's.

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const manage = (fileId: string) => `/files/${fileId}/manage`;

/** Uploads a .docx through the real route from inside `page`, so it carries that page's session; answers its id. */
async function uploadDocx(page: Page, title: string): Promise<string> {
  const result = await page.evaluate(
    async ({ name, data }) => {
      const res = await fetch(`/api/files/upload?filename=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        body: new Uint8Array(data),
      });
      return { status: res.status, body: await res.text() };
    },
    { name: `${title}.docx`, data: Array.from(buildTestDocx([`${title}, the one paragraph.`])) },
  );
  expect(result.status, result.body).toBe(200);
  return (JSON.parse(result.body) as { id: string }).id;
}

/** On the owners section: adds `name` and takes the viewer off, without saving. */
async function handOver(page: Page, name: string): Promise<void> {
  const owners = region(page, "Owners");
  await owners.getByLabel("Add an owner").selectOption({ label: name });
  await owners.getByRole("button", { name: "Add", exact: true }).click();
  await owners.getByRole("listitem").filter({ hasText: "(you)" }).getByRole("button", { name: "Remove" }).click();
}

test.describe("a file's manage page", () => {
  test("an AUTHOR hands a file over in one save, and lands where they can still read it", async ({ secondUser }) => {
    const { user: author, page } = await secondUser({ role: "AUTHOR" });
    const { user: heir, page: heirPage } = await secondUser({ role: "AUTHOR" });
    const sharedPdf = await createTestFile({ ownerEmail: author.email, visibility: "SHARED" });
    const privatePdf = await createTestFile({ ownerEmail: author.email, visibility: "PRIVATE" });
    let docxId: string | null = null;
    try {
      await gotoOk(page, "/files");
      const docxTitle = uniqueTitle("handed docx");
      docxId = await uploadDocx(page, docxTitle);
      // A .docx's page: the format said, a download to read it by, and nothing about versions.
      await gotoOk(page, manage(docxId));
      await expect(region(page, "The file")).toContainText("Word (.docx)");
      await expect(region(page, "The file").getByRole("link", { name: "Download it" })).toHaveAttribute("href", /\/download$/);
      // Made SHARED from here, by its owner: nothing to confirm.
      await region(page, "Visibility").getByRole("radio", { name: /^SHARED/ }).check();
      await region(page, "Visibility").getByRole("button", { name: "Save" }).click();
      await expect.poll(async () => (await getUploadFacts(docxId!))?.visibility).toBe("SHARED");

      const cases = [
        { id: sharedPdf.id, landing: `/pdf/${sharedPdf.slug}` },
        { id: privatePdf.id, landing: "/files" },
        { id: docxId, landing: "/files" },
      ];
      for (const { id, landing } of cases) {
        await gotoOk(page, manage(id));
        await handOver(page, heir.name);
        const owners = region(page, "Owners");
        await expect(owners.getByText("You are taking yourself off, so you will lose this page")).toBeVisible();
        await owners.getByRole("button", { name: "Save owners" }).click();
        await owners.getByRole("button", { name: "Yes, save and leave" }).click();
        await page.waitForURL((url) => url.pathname === landing);
        expect((await getUploadFacts(id))!.owners).toEqual([heir.email]);
        // The one handed it can manage it now.
        await gotoOk(heirPage, manage(id));
        await expect(region(heirPage, "Owners")).toBeVisible();
      }
    } finally {
      await deleteTestFile(sharedPdf.id);
      await deleteTestFile(privatePdf.id);
      if (docxId) await deleteTestFile(docxId);
    }
  });

  test("an ADMIN taking themselves off a SHARED file's list loses nothing, and is asked nothing", async ({ page, secondUser }) => {
    const { user: other } = await secondUser({ role: "AUTHOR" });
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      await gotoOk(page, manage(file.id));
      await handOver(page, other.name);
      const owners = region(page, "Owners");
      await expect(owners.getByText("You are taking yourself off")).toHaveCount(0);
      await owners.getByRole("button", { name: "Save owners" }).click();
      await expect.poll(async () => (await getUploadFacts(file.id))?.owners).toEqual([other.email]);
      await expect(owners.getByRole("button", { name: "Yes, save and leave" })).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe(manage(file.id));
      await expect(owners.getByRole("list", { name: "Owners", exact: true })).toContainText(other.name);
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("a save over an owner list someone else changed is refused with the edit kept, after another section's save too", async ({
    page,
    secondUser,
  }) => {
    const { user: added } = await secondUser({ role: "AUTHOR" });
    const { user: meanwhile } = await secondUser({ role: "AUTHOR" });
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      await gotoOk(page, manage(file.id));
      const owners = region(page, "Owners");
      await owners.getByLabel("Add an owner").selectOption({ label: added.name });
      await owners.getByRole("button", { name: "Add", exact: true }).click();
      // Someone else's change, after this page loaded.
      await setTestFileOwners(file.id, [ADMIN_EMAIL, meanwhile.email]);

      await owners.getByRole("button", { name: "Save owners" }).click();
      await expect(owners.getByRole("alert")).toHaveText("This file's owner list changed since you started editing it.");
      await expect(owners.getByRole("list", { name: "Owners", exact: true })).toContainText(added.name);
      await expect(owners.getByRole("list", { name: "Owners as they are now" })).toContainText(meanwhile.name);

      // Another section's save refreshes the page; the edit and the list it started from stay.
      const title = region(page, "Title");
      await title.getByLabel("Title").fill(`${file.title} retitled`);
      await title.getByRole("button", { name: "Save" }).click();
      await expect(title.getByText("Saved.")).toBeVisible();
      await owners.getByRole("button", { name: "Save owners" }).click();
      await expect(owners.getByRole("alert")).toHaveText("This file's owner list changed since you started editing it.");
      expect((await getUploadFacts(file.id))!.owners).toEqual([ADMIN_EMAIL, meanwhile.email]);

      // Started again from the list as it is, the save goes through.
      await owners.getByRole("button", { name: "Start again from this list" }).click();
      await owners.getByLabel("Add an owner").selectOption({ label: added.name });
      await owners.getByRole("button", { name: "Add", exact: true }).click();
      await owners.getByRole("button", { name: "Save owners" }).click();
      await expect.poll(async () => (await getUploadFacts(file.id))?.owners).toEqual([ADMIN_EMAIL, meanwhile.email, added.email]);
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("each refusal is read on the page in its own words", async ({ page }) => {
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const other = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      await gotoOk(page, manage(file.id));
      const title = region(page, "Title");
      await title.getByLabel("Title").fill("   ");
      await title.getByRole("button", { name: "Save" }).click();
      await expect(title.getByRole("alert")).toHaveText("A file needs a title.");

      const address = region(page, "Address");
      await address.getByRole("button", { name: "Change…" }).click();
      await address.locator("input").fill(other.slug);
      await address.getByRole("button", { name: "Save" }).click();
      await expect(address.getByText(`Url "${other.slug}" is already in use.`)).toBeVisible();
    } finally {
      await deleteTestFile(file.id);
      await deleteTestFile(other.id);
    }
  });

  test("going PRIVATE says who loses access; an ADMIN who owns no part of it is asked, and then refused here", async ({
    page,
    secondUser,
  }) => {
    const { user: coOwner } = await secondUser({ role: "AUTHOR" });
    const { user: author } = await secondUser({ role: "AUTHOR" });
    const privateFile = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "PRIVATE" });
    const theirs = await createTestFile({ ownerEmail: author.email, visibility: "SHARED" });
    try {
      await setTestFileOwners(privateFile.id, [ADMIN_EMAIL, coOwner.email]);
      await gotoOk(page, manage(privateFile.id));
      const owners = region(page, "Owners");
      await owners.getByRole("listitem").filter({ hasText: coOwner.name }).getByRole("button", { name: "Remove" }).click();
      await expect(owners).toContainText(`The file is PRIVATE, so ${coOwner.name} will no longer be able to read it`);

      await gotoOk(page, manage(theirs.id));
      const visibility = region(page, "Visibility");
      await visibility.getByRole("radio", { name: /^PRIVATE/ }).check();
      await expect(visibility).toContainText("Everyone who is not one of its owners will stop being able to read this file");
      await expect(visibility).toContainText("You aren't one of its owners, so you will lose this page and the file too.");
      await visibility.getByRole("button", { name: "Save" }).click();
      await visibility.getByRole("button", { name: "Yes, make it private" }).click();
      await page.waitForURL((url) => url.pathname === "/files");
      expect((await getUploadFacts(theirs.id))!.visibility).toBe("PRIVATE");
      await gotoOk(page, manage(theirs.id));
      await expect(page.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    } finally {
      await deleteTestFile(privateFile.id);
      await deleteTestFile(theirs.id);
    }
  });

  test("a past url is offered for revert and never for deletion", async ({ page }) => {
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      const renamed = await renameTestFileSlug(file.id);
      await gotoOk(page, manage(file.id));
      const address = region(page, "Address");
      await expect(address).toContainText(`/pdf/${renamed}`);
      await expect(address.getByRole("row").filter({ hasText: `/pdf/${file.slug}` })).toBeVisible();
      await expect(address.getByRole("button", { name: "Delete" })).toHaveCount(0);
      await expect(address).toContainText("Revert inside an hour of a change undoes it outright");
      await address.getByRole("button", { name: "Revert" }).click();
      await expect.poll(async () => (await getFileSlugFacts(file.id))?.slug).toBe(file.slug);
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("an id is read before a slug, and a past slug followed by a reader who may not manage answers Forbidden in place", async ({
    page,
    secondUser,
  }) => {
    const first = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const second = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      // The second file given the first's id as its slug.
      await gotoOk(page, manage(second.id));
      const address = region(page, "Address");
      await address.getByRole("button", { name: "Change…" }).click();
      await address.locator("input").fill(first.id);
      await address.getByRole("button", { name: "Save" }).click();
      await expect.poll(async () => (await getFileSlugFacts(second.id))?.slug).toBe(first.id);
      await gotoOk(page, manage(first.id));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(first.title);

      // A slug, or a past one, redirects a manager to the id.
      await gotoOk(page, `/files/${second.slug}/manage`);
      expect(new URL(page.url()).pathname).toBe(manage(second.id));

      const { page: reader } = await secondUser({ role: "AUTHOR" });
      await reader.goto(`/files/${second.slug}/manage`);
      await expect(reader.getByRole("heading", { name: "Forbidden" })).toBeVisible();
      expect(new URL(reader.url()).pathname).toBe(`/files/${second.slug}/manage`);
    } finally {
      await deleteTestFile(first.id);
      await deleteTestFile(second.id);
    }
  });

  test("a deleted file's page is its facts and its restore, and a restore says the url it came back under", async ({ page }) => {
    const title = uniqueTitle("deleted and back");
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", title });
    let taker: string | null = null;
    try {
      await gotoOk(page, manage(file.id));
      await page.getByRole("button", { name: "Delete this file" }).click();
      await expect(page.getByText("This file is deleted. Restore it, below")).toBeVisible();
      await expect(region(page, "Title").getByLabel("Title")).toBeDisabled();
      await expect(region(page, "Owners").getByLabel("Add an owner")).toBeDisabled();
      await expect(region(page, "Address").getByRole("button", { name: "Change…" })).toBeDisabled();
      await expect(region(page, "Visibility").getByRole("radio", { name: /^PRIVATE/ })).toBeDisabled();
      await expect(page.locator(`a[href^="/pdf/"]`)).toHaveCount(0);
      await expect(page.locator(`a[href$="/download"]`)).toHaveCount(0);

      // Opened by its id, after a reload: a deleted file is what this page has to open.
      await gotoOk(page, manage(file.id));
      await expect(page.getByRole("button", { name: "Restore this file" })).toBeVisible();

      // A file uploaded meanwhile takes its slug, so the restore suffixes it.
      taker = (await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", title })).id;
      expect((await getFileSlugFacts(taker))!.slug).toBe(file.slug);
      await page.getByRole("button", { name: "Restore this file" }).click();
      await expect(page.getByText(`Its url “${file.slug}” was taken by another file while it was deleted, so it came back as “${file.slug}-2”.`)).toBeVisible();
      await expect(region(page, "Address")).toContainText(`/pdf/${file.slug}-2`);
      await expect(region(page, "Title").getByLabel("Title")).toBeEnabled();
    } finally {
      await deleteTestFile(file.id);
      if (taker) await deleteTestFile(taker);
    }
  });

  test("a restore drops a past url a new upload took, and that upload's own url then changes without a fault", async ({ page }) => {
    const title = uniqueTitle("past slug taken");
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", title });
    let taker: string | null = null;
    try {
      const original = file.slug;
      await renameTestFileSlug(file.id);
      await gotoOk(page, manage(file.id));
      await page.getByRole("button", { name: "Delete this file" }).click();
      await expect(page.getByRole("button", { name: "Restore this file" })).toBeVisible();

      const upload = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", title });
      taker = upload.id;
      expect(upload.slug).toBe(original);
      await page.getByRole("button", { name: "Restore this file" }).click();
      await expect(page.getByText("Restored.")).toBeVisible();
      await expect.poll(async () => (await getFileSlugFacts(file.id))?.deleted).toBe(false);
      expect((await getFileSlugFacts(file.id))!.past).not.toContain(original);
      // Recording its old slug as a past one collides with nothing now.
      await renameTestFileSlug(upload.id);
      expect((await getFileSlugFacts(upload.id))!.past).toEqual([original]);
    } finally {
      await deleteTestFile(file.id);
      if (taker) await deleteTestFile(taker);
    }
  });

  test("the viewer's Metadata pane links a manager here, and no other reader", async ({ page, secondUser }) => {
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      await gotoOk(page, `/pdf/${file.slug}`);
      await page.getByRole("tab", { name: "Metadata" }).click();
      await expect(page.getByRole("link", { name: "Manage this file" })).toHaveAttribute("href", manage(file.id));

      const { page: reader } = await secondUser({ role: "AUTHOR" });
      await gotoOk(reader, `/pdf/${file.slug}`);
      await reader.getByRole("tab", { name: "Metadata" }).click();
      await expect(reader.getByRole("tab", { name: "Metadata" })).toHaveAttribute("aria-selected", "true");
      await expect(reader.getByRole("link", { name: "Manage this file" })).toHaveCount(0);
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("/files' Manage column: hidden until chosen, then a link on each row this viewer may manage, a deleted one included", async ({
    page,
    secondUser,
  }) => {
    const { user: author } = await secondUser({ role: "AUTHOR" });
    const prefix = uniqueTitle("manage column");
    const mine = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", title: `${prefix} mine` });
    const gone = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", title: `${prefix} gone` });
    const hidden = await createTestFile({ ownerEmail: author.email, visibility: "PRIVATE", title: `${prefix} theirs` });
    try {
      await gotoOk(page, manage(gone.id));
      await page.getByRole("button", { name: "Delete this file" }).click();
      await expect(page.getByRole("button", { name: "Restore this file" })).toBeVisible();

      const query = `q=${encodeURIComponent(prefix)}&deleted=1&showAllFiles=1`;
      await gotoOk(page, `/files?${query}`);
      await expect(page.getByRole("link", { name: `${prefix} mine`, exact: true })).toBeVisible();
      await expect(page.getByRole("columnheader", { name: "Manage" })).toHaveCount(0);

      await gotoOk(page, `/files?${query}&cols=title,manage,visibility`);
      const row = (title: string) => page.getByRole("row").filter({ has: page.getByRole("link", { name: title, exact: true }) });
      await expect(row(`${prefix} mine`).getByRole("link", { name: "manage", exact: true })).toHaveAttribute("href", manage(mine.id));
      await expect(row(`${prefix} gone`).getByRole("link", { name: "manage", exact: true })).toHaveAttribute("href", manage(gone.id));
      // A PRIVATE file listed only by the "Show all files" override: no link, and refused here.
      await expect(row(`${prefix} theirs`)).toBeVisible();
      await expect(row(`${prefix} theirs`).getByRole("link", { name: "manage", exact: true })).toHaveCount(0);
      await gotoOk(page, manage(hidden.id));
      await expect(page.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    } finally {
      await deleteTestFile(mine.id);
      await deleteTestFile(gone.id);
      await deleteTestFile(hidden.id);
    }
  });
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a signed-out visit returns to the manage page after sign-in", async ({ page }) => {
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      await page.goto(manage(file.id));
      await page.waitForURL("**/sign-in?callbackUrl=*");
      expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe(manage(file.id));
      await page.getByLabel("Email").fill(ADMIN_EMAIL);
      await page.getByLabel("Password").fill(TEST_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((url) => url.pathname === manage(file.id));
      await expect(region(page, "Owners")).toBeVisible();
    } finally {
      await deleteTestFile(file.id);
    }
  });
});
