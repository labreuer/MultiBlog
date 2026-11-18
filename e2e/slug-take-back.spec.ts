import { test, expect } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, createTestUser, deleteTestFile, deleteTestUser, takeBackOwnOldSlug } from "./db";
import { uniqueEmail } from "./naming";

// A slug an entity held before is its own to take back. Each kind's slug page
// (the manage page, for a file) offers one through "Use this url" when its
// standard slug, which passes over the entity's own history, comes out as a
// past slug; change*Slug then took it back out of the history rather than
// refusing it as in use, as revert*Slug and changeTagSlug already do. Called
// through the worker, since the rule is in each kind's src/lib/*-slug.ts.
//
// Each case moves the slug away and back: it ends where it started, and its
// history holds the slug it moved away to and not the one it took back.

test("a doc takes back its own old slug", async ({ draftDoc }) => {
  const { start, away, final, history } = await takeBackOwnOldSlug({ kind: "doc", id: draftDoc.id });
  expect(final).toBe(start);
  expect(history).toEqual([away]);
});

test("a post takes back its own old slug", async ({ draftPost }) => {
  const { start, away, final, history } = await takeBackOwnOldSlug({ kind: "post", id: draftPost.id });
  expect(final).toBe(start);
  expect(history).toEqual([away]);
});

test("a user takes back their own old slug", async () => {
  const email = uniqueEmail("slug-take-back");
  const user = await createTestUser({ email, name: `Slug Take Back ${email.split("@")[0]}`, role: "AUTHOR" });
  try {
    const { start, away, final, history } = await takeBackOwnOldSlug({ kind: "user", id: user.id });
    expect(final).toBe(start);
    expect(history).toEqual([away]);
  } finally {
    await deleteTestUser(email);
  }
});

test("a file takes back its own old slug", async () => {
  const file = await createTestFile({ ownerEmail: ADMIN_EMAIL });
  try {
    const { start, away, final, history } = await takeBackOwnOldSlug({ kind: "file", id: file.id });
    expect(final).toBe(start);
    expect(history).toEqual([away]);
  } finally {
    await deleteTestFile(file.id);
  }
});
