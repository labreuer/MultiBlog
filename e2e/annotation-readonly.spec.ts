import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { COLLAB_PORT, DEV_HOST } from "../scripts/dev-ports";
import { test, expect, QUOTED_BODY, QUOTED_TEXT, QUOTE_FROM, QUOTE_TO } from "./fixtures";
import { ADMIN_EMAIL, createTestAnnotation } from "./db";
import type { Page } from "@playwright/test";

// PLAN.md §22e PR 1 — a posted annotation's body is writable by its author or
// an ADMIN, and read-only for everyone else who can merely read the doc.
//
// **Why this can't be a UI test.** The hole being closed was never reachable
// from the UI: `AnnotationBodyReader` renders a posted body from the proseJson
// cache with no provider at all, so nothing in the app ever opened the
// writable connection every reader was being handed. What is being asserted is
// therefore the two things underneath — the flag `/api/annotation/[id]/token`
// puts in the token, and Hocuspocus actually refusing the write when it is set.
// A spec driving the Edit control would pass just as happily against a token
// route that handed every reader write access, because the control's absence is
// decided in the browser.
//
// The token is minted through the real route with the real cookie jar (that is
// the gate under test); the connection is then made from Node, which is the
// only place a spec can attempt a write the app itself declines to offer.

const COLLAB_URL = `ws://${DEV_HOST}:${COLLAB_PORT}`;

type TokenResponse = { token: string; documentName: string; readOnly?: boolean };

/** Mints an annotation ydoc token as whoever `page`'s context is signed in as. */
async function mintToken(page: Page, annotationId: string): Promise<TokenResponse> {
  const res = await page.request.post(`/api/annotation/${annotationId}/token`);
  expect(res.ok(), `token route answered ${res.status()}`).toBe(true);
  return (await res.json()) as TokenResponse;
}

async function connect(documentName: string, token: string) {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: COLLAB_URL,
    name: documentName,
    document: ydoc,
    token,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${documentName} never synced`)), 15_000);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve();
    });
    provider.on("authenticationFailed", (data: unknown) => {
      clearTimeout(timer);
      reject(new Error(`authentication failed: ${JSON.stringify(data)}`));
    });
  });
  return { ydoc, provider };
}

/**
 * Appends a paragraph carrying `marker`, then asks a *second*, independently
 * authenticated connection whether the server kept it.
 *
 * Reading back through the same connection would prove nothing: a Yjs client
 * applies its own update locally whatever the server thinks of it, so a
 * read-only connection's document shows the edit even as the server drops it
 * on the floor. Only a fresh sync answers the question.
 */
async function writeAndCheck(documentName: string, token: string, marker: string): Promise<boolean> {
  const mine = await connect(documentName, token);
  try {
    const fragment = mine.ydoc.getXmlFragment("default");
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(marker)]);
    fragment.insert(fragment.length, [paragraph]);
    // The write leaves as a websocket message; there is no ack to await, so
    // this is the one genuinely time-based wait in the file.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } finally {
    mine.provider.destroy();
  }

  const witness = await connect(documentName, token);
  try {
    return witness.ydoc.getXmlFragment("default").toString().includes(marker);
  } finally {
    witness.provider.destroy();
  }
}

test.describe("a posted annotation's body is not writable by every reader", () => {
  test("the author's token is writable and a plain reader's is not", async ({ page, sharedDoc, secondUser }) => {
    // The admin this context is signed in as is the annotation's author, so
    // `page` is the author's view and the AUTHORIZED reader below is the
    // interesting one — an identity with real read access to the doc (the
    // fixture is SHARED) and no claim on the annotation.
    const { id } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: "E2E readonly probe body",
      anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
    });
    expect(QUOTED_BODY).toContain(QUOTED_TEXT);

    const author = await mintToken(page, id);
    expect(author.readOnly).toBe(false);

    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });
    const reader = await mintToken(readerPage, id);
    expect(reader.readOnly).toBe(true);
    expect(reader.documentName).toBe(author.documentName);

    // The enforcement, in both directions. The read-only write goes first: if
    // it were accepted, the author's own marker arriving afterwards could
    // otherwise be mistaken for it.
    expect(await writeAndCheck(reader.documentName, reader.token, "E2E-READER-WRITE")).toBe(false);
    expect(await writeAndCheck(author.documentName, author.token, "E2E-AUTHOR-WRITE")).toBe(true);
  });

  test("an ADMIN who is not the author keeps write access", async ({ page, sharedDoc, secondUser }) => {
    const { user: other } = await secondUser({ role: "AUTHORIZED" });
    // Authored by the *other* user, so the admin driving `page` is a
    // non-author ADMIN — §22f's one deliberate override.
    const { id } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: other.email,
      bodyText: "E2E readonly admin-override body",
    });

    const admin = await mintToken(page, id);
    expect(admin.readOnly).toBe(false);
  });

  test("a reader with no access to the doc gets no token at all", async ({ page, draftDoc, secondUser }) => {
    // draftDoc is PRIVATE and bylined to the admin alone, so the reader fails
    // the *connection* gate rather than the write gate — 403, not readOnly.
    const { id } = await createTestAnnotation({
      docId: draftDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: "E2E readonly private-doc body",
    });
    expect((await page.request.post(`/api/annotation/${id}/token`)).ok()).toBe(true);

    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });
    const res = await readerPage.request.post(`/api/annotation/${id}/token`);
    expect(res.status()).toBe(403);
  });
});
