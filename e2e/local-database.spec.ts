import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Page } from "@playwright/test";
import { COLLAB_PORT, DEV_HOST } from "../scripts/dev-ports";
import { SCHEMA_PARAM, SCHEMA_VERSION, withSchemaVersion } from "../src/lib/schema-version";
import { ydocDbName } from "../src/lib/ydoc-db-name";
import { test, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";

// docs/YDOC.md "The local database is named by schema version": a bundle's
// IndexedDB copy of a doc is its own, so a tab never reads content a newer
// schema wrote. What an older bundle typed and hadn't synced is not lost to
// that: the next bundle takes the older database in, then deletes it.
//
// One build has no older bundle, so the spec makes its database: it types
// with collab cut off, which leaves the text in this bundle's database and
// nowhere else, then moves that database to the name the previous schema
// version would have given it.

const COLLAB_URL = `ws://${DEV_HOST}:${COLLAB_PORT}`;
const TYPED = "Typed while collab was down.";
const FROM_NEWER = "Written by a newer bundle.";
const FROM_STALE = "Written before the doc was re-seeded.";

type TokenResponse = { token: string; documentName: string; lineage: number };

async function mintToken(page: Page, docId: string): Promise<TokenResponse> {
  const res = await page.request.post(`/api/doc/${docId}/token`);
  expect(res.ok(), `token route answered ${res.status()}`).toBe(true);
  return (await res.json()) as TokenResponse;
}

/** The doc's body as the collab server holds it, read over a socket of the spec's own. */
async function serverBody(page: Page, docId: string): Promise<string> {
  const { documentName, token } = await mintToken(page, docId);
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: withSchemaVersion(COLLAB_URL), name: documentName, document: ydoc, token });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${documentName} did not sync`)), 15_000);
      provider.on("synced", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return ydoc.getXmlFragment("default").toString();
  } finally {
    provider.destroy();
  }
}

/**
 * Lets the spec cut the page off from collab: once `cutCollab` has run, the
 * page's open collab sockets are closed and every one it opens next goes to a
 * port nothing answers on, so the editor stays up and what is typed reaches
 * only IndexedDB. A navigation starts the script over, connected.
 */
async function withCollabSwitch(page: Page): Promise<void> {
  await page.addInitScript(
    ({ param }) => {
      const w = window as unknown as { __collabCut: boolean; __cutCollab: () => void };
      w.__collabCut = false;
      const Native = window.WebSocket;
      const open: WebSocket[] = [];
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = new URL(String(url));
          const collab = target.searchParams.has(param);
          if (collab && w.__collabCut) target.port = "9";
          super(target, protocols);
          if (collab) open.push(this);
        }
      };
      w.__cutCollab = () => {
        w.__collabCut = true;
        open.splice(0).forEach((socket) => socket.close());
      };
    },
    { param: SCHEMA_PARAM },
  );
}

async function databaseNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name ?? ""));
}

/** The updates a y-indexeddb database holds, as plain arrays so they cross to Node. */
async function readUpdates(page: Page, name: string): Promise<number[][]> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains("updates")) return [];
      const updates = await new Promise<Uint8Array[]>((resolve, reject) => {
        const request = db.transaction("updates", "readonly").objectStore("updates").getAll();
        request.onsuccess = () => resolve(request.result as Uint8Array[]);
        request.onerror = () => reject(request.error);
      });
      return updates.map((update) => Array.from(update));
    } finally {
      db.close();
    }
  }, name);
}

/** Deletes a database, waiting out whatever still has it open. */
async function deleteDatabase(page: Page, name: string): Promise<void> {
  await page.evaluate(
    (dbName) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }),
    name,
  );
}

/** Writes a database in y-indexeddb's layout: an auto-keyed `updates` store and a `custom` one. */
async function writeDatabase(page: Page, name: string, updates: number[][]): Promise<void> {
  await page.evaluate(
    async ({ dbName, rows }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("updates", { autoIncrement: true });
          request.result.createObjectStore("custom");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("updates", "readwrite");
        for (const row of rows) tx.objectStore("updates").add(new Uint8Array(row));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { dbName: name, rows: updates },
  );
}

function docOf(updates: number[][]): Y.Doc {
  const ydoc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(ydoc, new Uint8Array(update));
  return ydoc;
}

function bodyOf(updates: number[][]): string {
  return docOf(updates).getXmlFragment("default").toString();
}

/** `updates` with one more paragraph, as a database some other tab wrote would hold. */
function withParagraph(updates: number[][], text: string): number[][] {
  const ydoc = docOf(updates);
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  ydoc.getXmlFragment("default").push([paragraph]);
  return [Array.from(Y.encodeStateAsUpdate(ydoc))];
}

test("an older bundle's unsynced typing is taken in by the next bundle, and its database deleted", async ({ page, draftDoc }) => {
  test.skip(SCHEMA_VERSION === 0, "version 0 has no older bundle");

  const { documentName, lineage } = await mintToken(page, draftDoc.id);
  const current = ydocDbName(documentName, lineage);
  const older = ydocDbName(documentName, lineage, SCHEMA_VERSION - 1);
  const newer = ydocDbName(documentName, lineage, SCHEMA_VERSION + 1);
  const otherLineage = ydocDbName(documentName, lineage - 1);

  await withCollabSwitch(page);
  await page.goto(`/doc/${draftDoc.id}/edit`);
  await waitForDocCollabReady(page);
  expect(await databaseNames(page)).toContain(current);
  const synced = await readUpdates(page, current);

  // Cut off, the editor keeps taking text, and only IndexedDB receives it.
  await page.evaluate(() => (window as unknown as { __cutCollab: () => void }).__cutCollab());
  await expect(page.getByText("🟢 Live")).toHaveCount(0);
  await bodyEditor(page).click();
  await page.keyboard.type(TYPED);
  await expect(bodyEditor(page)).toContainText(TYPED);
  await expect.poll(async () => bodyOf(await readUpdates(page, current))).toContain(TYPED);

  // Leave the editor, so nothing holds the database, and make it an older
  // bundle's: the same updates under the previous version's name. Beside it
  // go the two databases a load must not take in, each with a paragraph of
  // its own.
  await page.goto("/sign-in");
  const updates = await readUpdates(page, current);
  await deleteDatabase(page, current);
  await writeDatabase(page, older, updates);
  await writeDatabase(page, newer, withParagraph(synced, FROM_NEWER));
  await writeDatabase(page, otherLineage, withParagraph(synced, FROM_STALE));
  expect(await serverBody(page, draftDoc.id)).not.toContain(TYPED);

  // The next load is this bundle's, connected again.
  await page.goto(`/doc/${draftDoc.id}/edit`);
  await waitForDocCollabReady(page);
  await expect(bodyEditor(page)).toContainText(TYPED);
  await expect.poll(() => serverBody(page, draftDoc.id), { timeout: 15_000 }).toContain(TYPED);

  // The older version's database is gone with the stale lineage's; a newer
  // version's is another build's to read, and stays.
  await expect.poll(() => databaseNames(page)).not.toContain(older);
  await expect.poll(() => databaseNames(page)).not.toContain(otherLineage);
  const names = await databaseNames(page);
  expect(names).toContain(current);
  expect(names).toContain(newer);

  // Neither of the other two was read.
  await expect(bodyEditor(page)).not.toContainText(FROM_NEWER);
  await expect(bodyEditor(page)).not.toContainText(FROM_STALE);
  const body = await serverBody(page, draftDoc.id);
  expect(body).not.toContain(FROM_NEWER);
  expect(body).not.toContain(FROM_STALE);
});
