import { NextResponse } from "next/server";
import { authenticateByteRequest, unauthorizedResponse } from "@/lib/api/request-auth";
import { ApiError, httpStatusOf, type ApiErrorCode } from "@/lib/api/errors";
import { onceWithin } from "@/lib/api/idempotency";
import { UploadError } from "@/lib/file-storage";
import { recordUpload, stageUpload } from "@/lib/file-ingest";
import { newObjectPeople } from "@/lib/mcp/doc-writes";

// docs/MCP.md §5, §8 — an upload from a raw request body
// (`curl --data-binary @paper.pdf`), with the `write` scope, through a grant
// from `upload_url` or the bearer token: a PDF or a .docx, as /files takes.
// It is src/lib/file-ingest.ts behind the token, with three parameters the UI's
// route doesn't pass:
//
// - `?title=`, in place of the filename's;
// - `?issuerOnly=1`, the issuer as the only owner — otherwise the actor
//   first and the issuer second, as a doc's byline is;
// - `?duplicate=1`, a new row even for bytes the actor can already read in
//   another file. Without it those bytes come back as that file
//   (`existing: true`): an agent uploading a paper again wants the one it has
//   already annotated.
//
// The file is PRIVATE. A repeat within a day is refused as already done,
// keyed on the bytes' hash and the parameters (§4) — so the hash is taken
// first, by staging the bytes, and the row is written inside the key.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/mcp/files";

const CODE_FOR_STATUS: Record<number, ApiErrorCode> = { 400: "invalid", 403: "forbidden", 413: "too_large", 415: "invalid" };

export async function POST(request: Request) {
  const token = await authenticateByteRequest(request, ROUTE);
  if (!token) return unauthorizedResponse();
  const ctx = { token, actor: { userId: token.user.id, role: token.user.role } };
  const url = new URL(request.url);
  try {
    if (!token.scopes.includes("WRITE")) throw new ApiError("forbidden", "This token can't write.");
    if (!request.body) throw new ApiError("invalid", "Send the file as the request body.");
    const filename = url.searchParams.get("filename")?.trim();
    if (!filename) throw new ApiError("invalid", "Name the file: &filename=<name>.pdf or .docx.");
    const title = url.searchParams.get("title")?.trim() || undefined;
    const issuerOnly = url.searchParams.get("issuerOnly") === "1";
    const duplicate = url.searchParams.get("duplicate") === "1";
    const owners = newObjectPeople(ctx, issuerOnly);

    const staged = await stageUpload(ctx.actor, { body: request.body, filename });
    const keyArgs = { sha256: staged.stored.sha256, filename, title, issuerOnly, duplicate };
    const recorded = await onceWithin(token.id, `POST ${ROUTE}`, keyArgs, url.searchParams.get("idempotencyKey") ?? undefined, async () => {
      const { file, existing } = await recordUpload(ctx.actor, staged, { title, owners, reuseReadable: !duplicate });
      const isPdf = staged.kind === "pdf";
      return {
        url: `/${isPdf ? "pdf" : "files"}/${file.slug}`,
        id: file.id,
        title: file.title,
        ...(existing ? { existing: true, note: "These bytes were already this file; pass duplicate=1 for a new one." } : {}),
      };
    });
    console.log(JSON.stringify({ at: "mcp", token: token.prefix, user: token.user.id, tool: `POST ${ROUTE}`, outcome: "ok" }));
    return NextResponse.json(recorded, { status: "existing" in recorded ? 200 : 201 });
  } catch (err) {
    if (err instanceof ApiError) return NextResponse.json(err.body(), { status: httpStatusOf(err) });
    if (err instanceof UploadError) {
      return NextResponse.json({ code: CODE_FOR_STATUS[err.status] ?? "internal", message: err.message }, { status: err.status });
    }
    console.error("[mcp/files] failed:", err);
    return NextResponse.json({ code: "internal", message: "The upload failed." }, { status: 500 });
  }
}
