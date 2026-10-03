import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Page } from "@playwright/test";
import { COLLAB_PORT, DEV_HOST } from "../scripts/dev-ports";
import { collabHttpOrigin } from "../src/lib/collab-http-origin";
import { DOC_APPLY_UPDATE_PATH } from "../src/lib/ydoc-names";
import { test, expect, bodyEditor, QUOTED_BODY } from "./fixtures";
import { ADMIN_EMAIL, getDocState } from "./db";

// /admin/doc-apply-update — how scripts/import-claude-chats.ts's --update
// edits a doc while the collab server keeps running (docs/CLAUDE_IMPORT.md §5).
//
// The update is built the way the script builds one: against a state of the
// doc, sent with that state's vector. What is asserted is the endpoint's
// contract rather than the script's planning: an open page receives the edit
// live, the cache and the checkpoint name the update the endpoint reports, and
// a refused update leaves the doc exactly as it was — its Updated included,
// which a refusal that opened the document would move, since closing a direct
// connection stores the document whether or not anything changed.
//
// Not covered: the endpoint's wait for one macrotask before it stores. Under
// Hocuspocus 4.4's hook ordering the append is queued before the store drains
// either way, so this spec passes without that wait; it is there for the day
// the ordering changes.

const COLLAB_URL = `ws://${DEV_HOST}:${COLLAB_PORT}`;
const APPENDED = "Appended through the collab server's own document.";

type TokenResponse = { token: string; documentName: string; readOnly: boolean };

async function mintToken(page: Page, docId: string): Promise<TokenResponse> {
  const res = await page.request.post(`/api/doc/${docId}/token`);
  expect(res.ok(), `token route answered ${res.status()}`).toBe(true);
  return (await res.json()) as TokenResponse;
}

/**
 * Syncs a copy of the live doc from Node and builds an update on it that
 * appends one paragraph — returning the update and the state vector it was
 * built against, both base64, as the endpoint takes them.
 */
async function buildAppend({ documentName, token }: TokenResponse): Promise<{ update: string; stateVector: string }> {
  const live = new Y.Doc();
  const provider = new HocuspocusProvider({ url: COLLAB_URL, name: documentName, document: live, token });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${documentName} never synced`)), 15_000);
      provider.on("synced", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const before = Y.encodeStateVector(live);
    const work = new Y.Doc();
    Y.applyUpdate(work, Y.encodeStateAsUpdate(live));
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(APPENDED)]);
    const fragment = work.getXmlFragment("default");
    fragment.insert(fragment.length, [paragraph]);
    const update = Y.encodeStateAsUpdate(work, before);
    work.destroy();
    return { update: Buffer.from(update).toString("base64"), stateVector: Buffer.from(before).toString("base64") };
  } finally {
    provider.destroy();
    live.destroy();
  }
}

async function applyUpdate(body: { token: string; documentName: string; update: string; stateVector: string }) {
  const res = await fetch(`${collabHttpOrigin()}${DOC_APPLY_UPDATE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

test("an applied update reaches an open page, and a stale or read-only one changes nothing", async ({
  page,
  sharedDoc,
  secondUser,
}) => {
  const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });
  await readerPage.goto(`/doc/${sharedDoc.slug}`);
  await expect(bodyEditor(readerPage)).toContainText(QUOTED_BODY);
  // Synced before the update is sent, so the text can only arrive live.
  await expect(readerPage.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });

  const writer = await mintToken(page, sharedDoc.id);
  expect(writer.readOnly).toBe(false);
  const built = await buildAppend(writer);

  const applied = await applyUpdate({ token: writer.token, documentName: writer.documentName, ...built });
  expect(applied.status, applied.text).toBe(200);
  const { updateId } = JSON.parse(applied.text) as { updateId: string };

  await expect(bodyEditor(readerPage)).toContainText(APPENDED, { timeout: 15_000 });
  const after = await getDocState(sharedDoc.id);
  expect(after?.proseText).toContain(APPENDED);
  expect(after?.proseJsonUpdateId).toBe(updateId);
  expect(after?.stampsAgree).toBe(true);
  expect(after?.updatedByEmail).toBe(ADMIN_EMAIL);

  // The same update again: its base is now behind the live doc.
  const stale = await applyUpdate({ token: writer.token, documentName: writer.documentName, ...built });
  expect(stale.status, stale.text).toBe(409);

  // A current base this time, so only the token can be what refuses it.
  const reader = await mintToken(readerPage, sharedDoc.id);
  expect(reader.readOnly).toBe(true);
  const current = await buildAppend(writer);
  const readOnly = await applyUpdate({ token: reader.token, documentName: reader.documentName, ...current });
  expect(readOnly.status, readOnly.text).toBe(403);

  expect(await getDocState(sharedDoc.id)).toEqual(after);
});
