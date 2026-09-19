import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { Page } from "@playwright/test";
import { COLLAB_PORT, DEV_HOST } from "../scripts/dev-ports";
import {
  test,
  expect,
  QUOTED_TEXT,
  annotationEditor,
  bodyEditor,
  gotoOk,
  selectTextInBody,
  signIn,
  waitForDocCollabReady,
} from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestAnnotation,
  createTestFile,
  deleteTestFile,
  getAnnotationStates,
  getFileAnnotationFacts,
} from "./db";

// docs/YDOC.md "One socket per page" — a surface's own document and every
// annotation opened on it are separate Hocuspocus documents multiplexed over
// one websocket, each authorized on its own.
//
// The first two tests are driven from Node, like annotation-readonly.spec.ts,
// because what they assert lives below the UI: that the server keeps a
// read-only doc connection and a writable annotation connection apart on the
// same socket, and that attribution (server/ydoc-hooks.ts, PLAN.md §11d) keys
// on the *document*, not the socket. That second one is the regression this
// file exists for. The attribution cache used to be keyed on Hocuspocus's
// `socketId`, which was one document per socket until sharing; with two
// documents on a socket it held whichever document's awareness arrived last,
// and a write to the other one was attributed under the wrong Y.Doc clientID.
// The user was right, the key was wrong, and nothing in the UI shows it — the
// author highlight just never finds the entry. So each Node test sends the
// *other* document's awareness last, on purpose, before writing.
//
// The last test is the browser proof that the surfaces actually share: one
// websocket to the collab port per page, an annotation composer or two
// notwithstanding.

const COLLAB_URL = `ws://${DEV_HOST}:${COLLAB_PORT}`;

type TokenResponse = { token: string; documentName: string; readOnly?: boolean };

async function mintToken(page: Page, path: string): Promise<TokenResponse> {
  const res = await page.request.post(path);
  expect(res.ok(), `${path} answered ${res.status()}`).toBe(true);
  return (await res.json()) as TokenResponse;
}

/** The id the server will attribute this context's writes to. */
async function sessionUserId(page: Page): Promise<string> {
  const res = await page.request.get("/api/auth/session");
  expect(res.ok()).toBe(true);
  const { user } = (await res.json()) as { user?: { id?: string } };
  expect(user?.id, "signed-in session").toBeTruthy();
  return user!.id!;
}

type Attached = { ydoc: Y.Doc; provider: HocuspocusProvider };

/**
 * Attaches one document to a shared socket and waits for its own sync — the
 * same thing `attachProvider` (src/lib/collab-socket.ts) does in the app,
 * spelled out here so the spec depends on Hocuspocus's API rather than on the
 * helper it is meant to check.
 */
async function attach(socket: HocuspocusProviderWebsocket, { documentName, token }: TokenResponse): Promise<Attached> {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: documentName, document: ydoc, token });
  const synced = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${documentName} never synced`)), 15_000);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve();
    });
    provider.on("authenticationFailed", (data: unknown) => {
      clearTimeout(timer);
      reject(new Error(`${documentName}: authentication failed: ${JSON.stringify(data)}`));
    });
  });
  provider.attach();
  await synced;
  return { ydoc, provider };
}

function appendParagraph(ydoc: Y.Doc, marker: string): void {
  const fragment = ydoc.getXmlFragment("default");
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(marker)]);
  fragment.insert(fragment.length, [paragraph]);
}

/**
 * The server's attribution write (`clients` map, clientID → user id) comes
 * back to this very connection as an ordinary update, so it can be read off
 * the local Y.Doc — and it only ever lands for an update the server
 * *accepted*, which is what makes it double as proof the write got through.
 */
async function attributedClients(ydoc: Y.Doc): Promise<Map<string, string>> {
  await expect.poll(() => ydoc.getMap<string>("clients").size, { timeout: 15_000 }).toBeGreaterThan(0);
  return new Map(ydoc.getMap<string>("clients").entries());
}

/** Reads the document through a socket of its own, so the answer is the server's and not this client's. */
async function readBack(tokenResponse: TokenResponse): Promise<string> {
  const socket = new HocuspocusProviderWebsocket({ url: COLLAB_URL });
  const witness = await attach(socket, tokenResponse);
  try {
    return witness.ydoc.getXmlFragment("default").toString();
  } finally {
    witness.provider.destroy();
    socket.destroy();
  }
}

test.describe("one socket per page", () => {
  test("a read-only doc tap and a writable annotation share a socket, and the write is attributed to the annotation's own client", async ({
    sharedDoc,
    secondUser,
  }) => {
    // An AUTHORIZED reader: may read the SHARED doc but not edit it, and is
    // the annotation's author — so the two tokens on the one socket carry
    // opposite flags, which is the configuration worth proving.
    const { page: readerPage, user } = await secondUser({ role: "AUTHORIZED" });
    const { id } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: user.email,
      bodyText: "E2E shared-socket probe body",
    });
    const docToken = await mintToken(readerPage, `/api/doc/${sharedDoc.id}/token`);
    const annotationToken = await mintToken(readerPage, `/api/annotation/${id}/token`);
    expect(docToken.readOnly).toBe(true);
    expect(annotationToken.readOnly).toBe(false);

    const socket = new HocuspocusProviderWebsocket({ url: COLLAB_URL });
    const doc = await attach(socket, docToken);
    const annotation = await attach(socket, annotationToken);
    try {
      // Per-document authorization, as the server reported it back.
      expect(doc.provider.authorizedScope).toBe("readonly");
      expect(annotation.provider.authorizedScope).toBe("read-write");

      // The mismatch setup: the *doc's* awareness is the last thing this
      // socket carries before the annotation write. Messages on one socket
      // are ordered, so a cache keyed on the socket alone now holds the doc
      // tap's clientID.
      annotation.provider.setAwarenessField("probe", "annotation");
      doc.provider.setAwarenessField("probe", "doc");

      const marker = `E2E-SHARED-SOCKET-${Date.now()}`;
      appendParagraph(annotation.ydoc, marker);

      const clients = await attributedClients(annotation.ydoc);
      expect(clients.get(String(annotation.ydoc.clientID))).toBe(user.id);
      expect(clients.has(String(doc.ydoc.clientID))).toBe(false);

      // And the read-only doc connection beside it constrained nothing: the
      // server kept the write.
      expect(await readBack(annotationToken)).toContain(marker);
    } finally {
      annotation.provider.destroy();
      doc.provider.destroy();
      socket.destroy();
    }
  });

  test("writes to both documents on one socket are attributed under each document's own client", async ({
    page,
    sharedDoc,
  }) => {
    // The admin driving `page` is the doc's author and the annotation's, so
    // both connections are writable and the mismatch can be provoked in both
    // directions on one socket.
    const userId = await sessionUserId(page);
    const { id } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: "E2E shared-socket both-ways body",
    });
    const docToken = await mintToken(page, `/api/doc/${sharedDoc.id}/token`);
    const annotationToken = await mintToken(page, `/api/annotation/${id}/token`);
    expect(docToken.readOnly).toBe(false);
    expect(annotationToken.readOnly).toBe(false);

    const socket = new HocuspocusProviderWebsocket({ url: COLLAB_URL });
    const doc = await attach(socket, docToken);
    const annotation = await attach(socket, annotationToken);
    try {
      // Annotation's awareness last, then write the doc.
      doc.provider.setAwarenessField("probe", "doc");
      annotation.provider.setAwarenessField("probe", "annotation");
      appendParagraph(doc.ydoc, `E2E-SHARED-DOC-${Date.now()}`);
      const docClients = await attributedClients(doc.ydoc);
      expect(docClients.get(String(doc.ydoc.clientID))).toBe(userId);
      expect(docClients.has(String(annotation.ydoc.clientID))).toBe(false);

      // Doc's awareness last, then write the annotation.
      doc.provider.setAwarenessField("probe", "doc again");
      appendParagraph(annotation.ydoc, `E2E-SHARED-ANNOTATION-${Date.now()}`);
      const annotationClients = await attributedClients(annotation.ydoc);
      expect(annotationClients.get(String(annotation.ydoc.clientID))).toBe(userId);
      expect(annotationClients.has(String(doc.ydoc.clientID))).toBe(false);
    } finally {
      annotation.provider.destroy();
      doc.provider.destroy();
      socket.destroy();
    }
  });

  test.describe("the surfaces open one websocket each", () => {
    /** Counts websockets the page opens to the collab port; registered before navigation. */
    function countCollabSockets(page: Page): () => number {
      let count = 0;
      page.on("websocket", (ws) => {
        if (new URL(ws.url()).port === String(COLLAB_PORT)) count += 1;
      });
      return () => count;
    }

    test("/doc/[slug]: the live tap plus a posted annotation", async ({ sharedDoc, secondUser }) => {
      const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });
      const sockets = countCollabSockets(readerPage);

      await readerPage.goto(`/doc/${sharedDoc.slug}`);
      await expect(bodyEditor(readerPage)).toBeVisible();
      await expect(readerPage.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
      await selectTextInBody(readerPage, QUOTED_TEXT);
      const popup = readerPage.getByTestId("annotation-popup");
      await popup.getByRole("button", { name: "Annotate" }).click();
      await annotationEditor(readerPage).click();
      const annotationText = `Shared socket, reading view ${Date.now()}`;
      await readerPage.keyboard.type(annotationText);
      await popup.getByRole("button", { name: "Post annotation" }).click();
      // Posting flushes the annotation's ydoc through the collab server, so
      // its body landing is proof the composer's connection was live.
      await expect
        .poll(async () => (await getAnnotationStates(sharedDoc.id)).map((a) => a.bodyText), { timeout: 15_000 })
        .toContain(annotationText);

      expect(sockets()).toBe(1);
    });

    test("/doc/[slug]/edit: the editor plus a posted annotation", async ({ page, sharedDoc }) => {
      const sockets = countCollabSockets(page);
      await page.setViewportSize({ width: 1280, height: 900 });

      await page.goto(`/doc/${sharedDoc.id}/edit`);
      await waitForDocCollabReady(page);
      await selectTextInBody(page, QUOTED_TEXT);
      await page.locator("[data-testid='annotate-marker']").click();
      const popup = page.getByTestId("annotation-popup");
      await annotationEditor(page).click();
      const annotationText = `Shared socket, editor ${Date.now()}`;
      await page.keyboard.type(annotationText);
      await popup.getByRole("button", { name: "Post annotation" }).click();
      await expect
        .poll(async () => (await getAnnotationStates(sharedDoc.id)).map((a) => a.bodyText), { timeout: 15_000 })
        .toContain(annotationText);

      expect(sockets()).toBe(1);
    });

    test("/pdf/[slug]: presence plus a saved annotation", async ({ page }) => {
      const file = await createTestFile({
        ownerEmail: ADMIN_EMAIL,
        visibility: "SHARED",
        pages: [["The quick brown fox jumps over the lazy dog on page one."]],
      });
      try {
        await signIn(page, ADMIN_EMAIL);
        const sockets = countCollabSockets(page);
        await gotoOk(page, `/pdf/${file.slug}`);
        await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
          timeout: 30_000,
        });

        // An unanchored annotation is enough: the point is the composer's
        // connection, not the anchor.
        await page.getByRole("button", { name: "Write an annotation..." }).click();
        const editor = annotationEditor(page);
        await editor.click();
        const annotationText = `Shared socket, pdf ${Date.now()}`;
        await editor.pressSequentially(annotationText);
        await page.getByRole("button", { name: "Save" }).click();
        // The row, not the panel: an unanchored entry sits behind the panel's
        // "on screen" filter ("Show all 1"), so its text is deliberately not
        // visible. Same signal as the doc tests — the body landing in the row
        // means the composer's connection was live.
        await expect
          .poll(async () => (await getFileAnnotationFacts(file.id)).map((a) => a.bodyText), { timeout: 15_000 })
          .toContain(annotationText);

        expect(sockets()).toBe(1);
      } finally {
        await deleteTestFile(file.id);
      }
    });
  });
});
