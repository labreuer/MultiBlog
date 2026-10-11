import type { Page } from "@playwright/test";
import { collabHttpOrigin } from "../src/lib/collab-http-origin";
import {
  ANNOTATION_FLUSH_PATH,
  ANNOTATION_MARK_PATH,
  ANNOTATION_REPLACE_PATH,
  ANNOTATION_UNMARK_PATH,
  DOC_APPLY_UPDATE_PATH,
  YDOC_SNAPSHOT_PATH,
} from "../src/lib/ydoc-names";
import { test, expect } from "./fixtures";
import { getDocState } from "./db";

// Every /admin endpoint refuses a read-only ydoc token (verifyAdminToken in
// server/ydoc-hooks.ts; docs/YDOC.md, "The /admin endpoints"). The token
// routes hand one to any reader's browser, and the admin paths share the
// websocket's port, so the token is the gate wherever that port is reachable.
//
// One reader's token for a doc goes to all six, each with a body shaped well
// enough to pass the handler's own 400 check, so only the token can be what
// refuses it: every handler checks the token before it looks at what the name
// is for. A writable token on a harmless request then shows the refusal is
// the token's, not the shape's.

const ENDPOINTS: { path: string; body: Record<string, unknown> }[] = [
  { path: YDOC_SNAPSHOT_PATH, body: {} },
  { path: ANNOTATION_MARK_PATH, body: { annotationId: "no-such-annotation", from: 1, to: 2, quotedText: "x" } },
  { path: ANNOTATION_UNMARK_PATH, body: { annotationId: "no-such-annotation" } },
  { path: ANNOTATION_FLUSH_PATH, body: { writeCache: false } },
  { path: ANNOTATION_REPLACE_PATH, body: { proseJson: { type: "doc", content: [{ type: "paragraph" }] } } },
  { path: DOC_APPLY_UPDATE_PATH, body: { update: "AA==", stateVector: "AA==" } },
];

type TokenResponse = { token: string; documentName: string; readOnly: boolean };

async function mintToken(page: Page, docId: string): Promise<TokenResponse> {
  const res = await page.request.post(`/api/doc/${docId}/token`);
  expect(res.ok(), `token route answered ${res.status()}`).toBe(true);
  return (await res.json()) as TokenResponse;
}

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${collabHttpOrigin()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

test("every /admin endpoint refuses a reader's read-only token, and changes nothing", async ({
  page,
  sharedDoc,
  secondUser,
}) => {
  const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });
  const reader = await mintToken(readerPage, sharedDoc.id);
  expect(reader.readOnly).toBe(true);
  const before = await getDocState(sharedDoc.id);

  for (const { path, body } of ENDPOINTS) {
    const refused = await post(path, { token: reader.token, documentName: reader.documentName, ...body });
    expect.soft(refused.status, `${path}: ${refused.text}`).toBe(403);
  }
  expect(await getDocState(sharedDoc.id)).toEqual(before);

  const writer = await mintToken(page, sharedDoc.id);
  expect(writer.readOnly).toBe(false);
  const flushed = await post(ANNOTATION_FLUSH_PATH, { token: writer.token, documentName: writer.documentName, writeCache: false });
  expect(flushed.status, flushed.text).toBe(200);
});
