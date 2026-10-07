import type { Role } from "@/generated/prisma/enums";
import type { EditRefusal, EditSpec } from "./doc-edit";
import { signYdocToken } from "./ydoc-token";
import { collabHttpOrigin } from "./collab-http-origin";
import { DOC_EDIT_PATH, ydocIdForDoc } from "./ydoc-names";

// The Next process's half of a targeted edit (docs/MCP.md §6): a writable
// ydoc token for the actor, minted after the operation has authorized the
// edit, and the request to the collab server's /admin/doc-edit over loopback
// — the annotation-admin.ts idiom, sharing its origin. No ydoc token ever
// leaves the server.

export type AnchorRef = { id: string; from: number | null; to: number | null; quotedText: string };

export type DocEditAnswer =
  | {
      ok: true;
      applied: boolean;
      /** The `ydoc_update` the edit was appended as; null for one that changed nothing. */
      updateId: string | null;
      changed: number[];
      blocks: number;
      touched: { annotations: { id: string; resolves: boolean }[]; linkParts: { id: string; resolves: boolean }[] };
    }
  | { ok: false; refusal: EditRefusal }
  | { ok: false; unavailable: string };

export async function requestDocEdit(opts: {
  docId: string;
  userId: string;
  role: Role;
  edits: EditSpec[];
  title?: string;
  keepMarks?: boolean;
  annotations: AnchorRef[];
  markAnnotations: string[];
  linkParts: AnchorRef[];
}): Promise<DocEditAnswer> {
  const documentName = ydocIdForDoc(opts.docId);
  const token = await signYdocToken({ sub: opts.userId, documentName, role: opts.role });
  let response: Response;
  try {
    response = await fetch(`${collabHttpOrigin()}${DOC_EDIT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        documentName,
        edits: opts.edits,
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.keepMarks ? { keepMarks: true } : {}),
        annotations: opts.annotations,
        markAnnotations: opts.markAnnotations,
        linkParts: opts.linkParts,
      }),
    });
  } catch (err) {
    console.error(`[doc-edit] the collab server is unreachable for ${documentName}:`, err);
    return { ok: false, unavailable: "The live-editing server couldn't be reached." };
  }
  const text = await response.text();
  if (response.status === 422) {
    try {
      return { ok: false, refusal: (JSON.parse(text) as { refusal: EditRefusal }).refusal };
    } catch {
      return { ok: false, unavailable: "The live-editing server answered something unreadable." };
    }
  }
  if (!response.ok) {
    console.error(`[doc-edit] ${DOC_EDIT_PATH} answered ${response.status} for ${documentName}: ${text}`);
    return { ok: false, unavailable: `The live-editing server refused the edit (${response.status}).` };
  }
  try {
    return { ok: true, ...(JSON.parse(text) as Omit<Extract<DocEditAnswer, { ok: true }>, "ok">) };
  } catch {
    // A misrouted request gets Hocuspocus's plain-text welcome (annotation-admin.ts).
    console.error(`[doc-edit] ${DOC_EDIT_PATH} answered non-JSON for ${documentName} — is the endpoint routed correctly?`);
    return { ok: false, unavailable: "The live-editing server answered something unreadable." };
  }
}
