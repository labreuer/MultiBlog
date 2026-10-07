import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { verifyYdocToken } from "../src/lib/ydoc-token";
import { docIdFromYdocId } from "../src/lib/ydoc-names";
import {
  docContentExtensions,
  pmDocContentSchema,
  pmTitleSchema,
  titleAuthorHighlightExtensions,
} from "../src/lib/tiptap-schema";
import { planEdits, planTitle, type EditPlan, type EditSpec } from "../src/lib/doc-edit";
import { writeBackDoc } from "../src/lib/doc-edit-yjs";
import { markdownToText } from "../src/lib/markdown-import";
import { resolveAnchorInDoc } from "../src/lib/anchors/resolve";
import { collectAnnotationMarkRanges } from "../src/lib/annotation-marks";
import { ydocStore, UNAVAILABLE, isDegraded } from "./ydoc-store";
import { getClientsMap, readJsonBody, send, type YdocContext } from "./ydoc-hooks";
import { expectAppend } from "./edit-appends";

// POST /admin/doc-edit (docs/MCP.md §6) — a targeted edit of a doc: each
// passage named by its words or its ends, its replacement given as TipTap
// JSON the Next process parsed from Markdown and validated, the whole request
// all-or-nothing. src/lib/doc-edit.ts plans it; this applies it.
//
// A sibling of doc-apply-update, built on its guards:
//
//   - it refuses a read-only token, a name that isn't a doc's, and a doc that
//     loaded degraded;
//   - it opens its connection with the actor's context, so the store names
//     the actor as the last editor;
//   - it waits a macrotask before closing, so its append is queued before the
//     store drains;
//   - **it matches before it opens.** Closing a direct connection stores the
//     doc, moving its Updated date and naming the actor as its last editor
//     whether or not anything changed, so every passage is found in the open
//     document, or the stored one, before a connection exists, and a request
//     that would be refused is refused there. The match inside the
//     transaction is the one that decides.
//
// **The change is built on a scratch Y.Doc copied from the live state** and
// then applied to the live document, with the scratch's Yjs client mapped to
// the actor in `clients` — the attribution doc-apply-update does. Writing
// through the direct connection itself would leave the update unattributed:
// the in-memory document's own client is shared by every server-side write,
// and attributeUpdate skips a direct connection.
//
// The matcher is COLLAB.md §9's normalizing one, run against a live document.
// All three of §9's reasons hold inside one `transact`: the search runs once,
// server-side, against a state nothing changes while it runs; every hit is
// verified with `textBetween` after mapping back; and the range replaced is
// the verified one. A flattening mistake costs a refused edit, never a wrong
// one.

type AnchorIn = { id: string; from: number | null; to: number | null; quotedText: string };

type EditRequest = {
  token: string;
  documentName: string;
  edits: EditSpec[];
  /** The new title, when the request sets one. */
  title?: string;
  /** Revert: what the edit writes keeps its own marks (§6, "Reverting an edit"). */
  keepMarks?: boolean;
  /** The annotations on the doc anchored by columns, and the ids of those anchored by marks, for what the edit touched. */
  annotations?: AnchorIn[];
  markAnnotations?: string[];
  /** The anchored-link parts into the doc the actor can see. */
  linkParts?: AnchorIn[];
};

function decode(doc: Y.Doc): { body: PMNode; title: PMNode | null } {
  const json = TiptapTransformer.extensions(docContentExtensions).fromYdoc(doc, "default") as JSONContent;
  const body = pmDocContentSchema.nodeFromJSON(
    Array.isArray(json.content) && json.content.length > 0 ? json : { type: "doc", content: [{ type: "paragraph" }] },
  );
  const titleFragment = doc.getXmlFragment("title");
  const title =
    titleFragment.length > 0
      ? pmTitleSchema.nodeFromJSON(TiptapTransformer.extensions(titleAuthorHighlightExtensions).fromYdoc(doc, "title"))
      : null;
  return { body, title };
}

type Planned = { body: PMNode; title: PMNode | null; plan: Extract<EditPlan, { ok: true }>; nextTitle: PMNode | null };

function planOn(doc: Y.Doc, request: EditRequest, authorId: string): Planned | { refusal: Extract<EditPlan, { ok: false }>["refusal"] } {
  const { body, title } = decode(doc);
  const plan = planEdits(body, request.edits, {
    schema: pmDocContentSchema,
    authorId,
    keepMarks: request.keepMarks === true,
    asText: markdownToText,
  });
  if (!plan.ok) return { refusal: plan.refusal };
  const nextTitle =
    request.title === undefined ? null : planTitle(title, request.title, { schema: pmTitleSchema, authorId, keepMarks: false });
  return { body, title, plan, nextTitle };
}

/** Each annotation and link part the edit's passages overlapped, and whether it still resolves after it. */
function touched(request: EditRequest, before: PMNode, after: PMNode, ranges: { from: number; to: number }[]) {
  const overlaps = (range: { from: number; to: number } | null) =>
    range !== null && ranges.some((r) => range.from < r.to && r.from < range.to);
  const columns = (items: AnchorIn[] | undefined) =>
    (items ?? []).flatMap((item) => {
      if (item.from === null || item.to === null || !item.quotedText) return [];
      const was = resolveAnchorInDoc(before, item.from, item.to, item.quotedText);
      if (!overlaps(was)) return [];
      return [{ id: item.id, resolves: resolveAnchorInDoc(after, item.from, item.to, item.quotedText) !== null }];
    });
  const marksBefore = collectAnnotationMarkRanges(before);
  const marksAfter = collectAnnotationMarkRanges(after);
  const marked = (request.markAnnotations ?? []).flatMap((id) =>
    overlaps(marksBefore.get(id) ?? null) ? [{ id, resolves: marksAfter.has(id) }] : [],
  );
  return { annotations: [...columns(request.annotations), ...marked], linkParts: columns(request.linkParts) };
}

export async function handleEditDoc(request: IncomingMessage, response: ServerResponse, instance: Hocuspocus): Promise<void> {
  const body = (await readJsonBody(request, 4_000_000)) as Partial<EditRequest>;
  if (typeof body.token !== "string" || typeof body.documentName !== "string" || !Array.isArray(body.edits)) {
    send(response, 400, "Expected token, documentName and edits.");
    return;
  }
  const editRequest = body as EditRequest;
  const documentName = editRequest.documentName;
  const payload = await verifyYdocToken(editRequest.token).catch(() => null);
  if (!payload || payload.documentName !== documentName || payload.readOnly) {
    send(response, 403, "Invalid, mismatched or read-only ydoc token.");
    return;
  }
  if (!docIdFromYdocId(documentName)) {
    send(response, 400, "Not a doc's document.");
    return;
  }

  // Matched before opening (above). A document nobody has open is its row.
  const open = instance.documents.get(documentName);
  let probe: Y.Doc;
  if (open) {
    probe = open;
  } else {
    const stored = await ydocStore.load(documentName);
    if (stored === UNAVAILABLE) {
      send(response, 503, "The database is unavailable.");
      return;
    }
    if (!stored) {
      send(response, 404, "No such document.");
      return;
    }
    probe = new Y.Doc();
    Y.applyUpdate(probe, stored.ydoc);
  }
  const pre = planOn(probe, editRequest, payload.sub);
  if (probe !== open) probe.destroy();
  if ("refusal" in pre) {
    send(response, 422, JSON.stringify({ refusal: pre.refusal }));
    return;
  }
  const unchanged = pre.plan.next.eq(pre.body) && (pre.nextTitle === null || (pre.title !== null && pre.nextTitle.eq(pre.title)));
  if (unchanged) {
    send(response, 200, JSON.stringify({ applied: false, updateId: null, changed: [], touched: { annotations: [], linkParts: [] } }));
    return;
  }

  const editId = randomUUID();
  const context: YdocContext = { userId: payload.sub, role: payload.role, editId };
  const wait = expectAppend(editId);
  const outcome: { result?: Planned; refusal?: Extract<EditPlan, { ok: false }>["refusal"]; touched?: ReturnType<typeof touched> } = {};
  const connection = await instance.openDirectConnection(documentName, context);
  try {
    if (isDegraded(documentName)) {
      wait.cancel();
      send(response, 503, "The document's database was unavailable when it loaded.");
      return;
    }
    await connection.transact((document) => {
      const scratch = new Y.Doc();
      try {
        Y.applyUpdate(scratch, Y.encodeStateAsUpdate(document));
        const before = Y.encodeStateVector(scratch);
        const planned = planOn(scratch, editRequest, payload.sub);
        if ("refusal" in planned) {
          outcome.refusal = planned.refusal;
          return;
        }
        scratch.transact(() => {
          writeBackDoc(scratch.getXmlFragment("default"), planned.body, planned.plan.next);
          if (planned.nextTitle) prosemirrorToYXmlFragment(planned.nextTitle, scratch.getXmlFragment("title"));
        });
        const update = Y.encodeStateAsUpdate(scratch, before);
        Y.applyUpdate(document, update);
        if (Y.parseUpdateMeta(update).from.has(scratch.clientID)) {
          const clients = getClientsMap(document);
          if (!clients.has(String(scratch.clientID))) clients.set(String(scratch.clientID), payload.sub);
        }
        outcome.result = planned;
        outcome.touched = touched(editRequest, planned.body, planned.plan.next, planned.plan.ranges);
      } finally {
        scratch.destroy();
      }
    });
    if (outcome.result) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await connection.disconnect();
  }
  if (outcome.refusal) {
    wait.cancel();
    send(response, 422, JSON.stringify({ refusal: outcome.refusal }));
    return;
  }
  const updateId = await wait.appended;
  send(
    response,
    200,
    JSON.stringify({
      applied: true,
      updateId: updateId?.toString() ?? null,
      changed: outcome.result!.plan.changed,
      blocks: outcome.result!.plan.next.childCount,
      touched: outcome.touched,
    }),
  );
}
