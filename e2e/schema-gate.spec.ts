import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Page } from "@playwright/test";
import { COLLAB_PORT, DEV_HOST } from "../scripts/dev-ports";
import { SCHEMA_PARAM, SCHEMA_REFUSAL, SCHEMA_VERSION, withSchemaVersion } from "../src/lib/schema-version";
import { test, expect, bodyEditor, titleEditor, visibleText, waitForDocCollabReady, QUOTED_BODY } from "./fixtures";

// The schema gate (docs/YDOC.md "A tab whose schema is out of date is
// refused"): a tab running a bundle from before a schema change deletes from
// the shared document whatever its schema can't build, so the collab server
// refuses any socket not stating its own schema version, and the page stops
// its editors and asks for a reload.
//
// A real out-of-date tab can't be had from one build, so the browser tests
// make one: an init script rewrites the version on the socket URL the page
// opens. Everything after that URL is the app's own — the server's refusal,
// `attachProvider` noticing it, and what each surface then does.

const COLLAB_URL = `ws://${DEV_HOST}:${COLLAB_PORT}`;
const OTHER_VERSION = SCHEMA_VERSION + 1;

type TokenResponse = { token: string; documentName: string };

async function mintToken(page: Page, docId: string): Promise<TokenResponse> {
  const res = await page.request.post(`/api/doc/${docId}/token`);
  expect(res.ok(), `token route answered ${res.status()}`).toBe(true);
  return (await res.json()) as TokenResponse;
}

/** Connects from Node on `url` and reports how the server answered: synced, or refused with a reason. */
async function connect(url: string, { documentName, token }: TokenResponse) {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({ url, name: documentName, document: ydoc, token });
  const outcome = await new Promise<{ synced: true } | { synced: false; reason: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${documentName} neither synced nor was refused`)), 15_000);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve({ synced: true });
    });
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
      clearTimeout(timer);
      resolve({ synced: false, reason });
    });
  });
  return { ydoc, provider, outcome };
}

/**
 * Makes `page` a tab on another schema version: every collab socket it opens
 * from now on states `OTHER_VERSION`. With `atLoad` false the page starts
 * current, and `goStale` turns it and drops its open sockets, which is a
 * deploy as a tab sees one: the socket closes, and the reconnect meets a
 * server on a version the tab's bundle isn't.
 */
async function withStaleBundle(page: Page, { atLoad }: { atLoad: boolean }): Promise<void> {
  await page.addInitScript(
    ({ param, version, stale }) => {
      const w = window as unknown as { __staleSchema: boolean; __dropCollabSockets: () => void };
      w.__staleSchema = stale;
      const Native = window.WebSocket;
      const open: WebSocket[] = [];
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = new URL(String(url));
          const collab = target.searchParams.has(param);
          if (collab && w.__staleSchema) target.searchParams.set(param, String(version));
          super(target, protocols);
          if (collab) open.push(this);
        }
      };
      w.__dropCollabSockets = () => open.splice(0).forEach((socket) => socket.close());
    },
    { param: SCHEMA_PARAM, version: OTHER_VERSION, stale: atLoad },
  );
}

async function goStale(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __staleSchema: boolean; __dropCollabSockets: () => void };
    w.__staleSchema = true;
    w.__dropCollabSockets();
  });
}

test("the server refuses a socket on another schema version, by name, and sends it nothing", async ({ page, sharedDoc }) => {
  const token = await mintToken(page, sharedDoc.id);

  const stale = await connect(withSchemaVersion(COLLAB_URL, OTHER_VERSION), token);
  try {
    expect(stale.outcome).toEqual({ synced: false, reason: SCHEMA_REFUSAL });
    // The refusal comes before any sync, so the content this tab's schema
    // might not be able to build never reaches it.
    expect(stale.ydoc.getXmlFragment("default").length).toBe(0);
  } finally {
    stale.provider.destroy();
  }

  // The same token on the server's own version is let in, so the refusal
  // above was the version's and nothing else's.
  const current = await connect(withSchemaVersion(COLLAB_URL), await mintToken(page, sharedDoc.id));
  try {
    expect(current.outcome).toEqual({ synced: true });
    expect(current.ydoc.getXmlFragment("default").toString()).toContain(QUOTED_BODY.slice(0, 20));
  } finally {
    current.provider.destroy();
  }
});

test("a socket stating no version is a tab from before the gate, and counts as version 0", async ({ page, sharedDoc }) => {
  const unstated = await connect(COLLAB_URL, await mintToken(page, sharedDoc.id));
  try {
    expect(unstated.outcome).toEqual(SCHEMA_VERSION === 0 ? { synced: true } : { synced: false, reason: SCHEMA_REFUSAL });
  } finally {
    unstated.provider.destroy();
  }
});

test("an editor refused on reconnect says so, stops both editors, and is live again after a reload", async ({ page, draftDoc }) => {
  await withStaleBundle(page, { atLoad: false });
  await page.goto(`/doc/${draftDoc.id}/edit`);
  await waitForDocCollabReady(page);

  await bodyEditor(page).click();
  await page.keyboard.type("Typed before the deploy.");
  await expect(bodyEditor(page)).toContainText("Typed before the deploy.");

  await goStale(page);

  await expect(page.getByText("Out of date")).toBeVisible({ timeout: 15_000 });
  await expect(bodyEditor(page)).toHaveAttribute("contenteditable", "false");
  await expect(titleEditor(page)).toHaveAttribute("contenteditable", "false");
  // What was on screen stays there, to be read and copied.
  await expect(bodyEditor(page)).toContainText("Typed before the deploy.");
  // The refusal is not also printed as a connection error.
  await expect(page.getByText("Live editing unavailable")).toHaveCount(0);

  // The reload brings a current bundle (here: the init script starts over,
  // current), and the text typed before the refusal is in the doc.
  await page.getByRole("button", { name: "reload" }).click();
  await waitForDocCollabReady(page);
  await expect(bodyEditor(page)).toHaveAttribute("contenteditable", "true");
  await expect(bodyEditor(page)).toContainText("Typed before the deploy.");
});

test("a reading view refused at load keeps its static body and asks for a reload", async ({ page, sharedDoc }) => {
  await withStaleBundle(page, { atLoad: true });
  await page.goto(`/doc/${sharedDoc.slug}`);

  await expect(page.getByRole("status").filter({ hasText: "This page is out of date" })).toBeVisible({ timeout: 15_000 });
  await expect(visibleText(page, QUOTED_BODY.slice(0, 40))).toBeVisible();
});
