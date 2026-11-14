import { NextResponse } from "next/server";
import { authenticateByteRequest, unauthorizedResponse } from "@/lib/api/request-auth";
import { ApiError, httpStatusOf, type ApiErrorCode } from "@/lib/api/errors";
import { onceWithin } from "@/lib/api/idempotency";
import { UploadError } from "@/lib/file-storage";
import { assertMayUploadVersion, discardStagedUpload, recordUpload, recordVersionUpload, stageUpload } from "@/lib/file-ingest";
import { newObjectPeople } from "@/lib/mcp/doc-writes";

// docs/MCP.md §5, §8 — an upload from a raw request body
// (`curl --data-binary @paper.pdf`), with the `write` scope, through a grant
// from `upload` or the bearer token: a PDF or a .docx, as /files takes.
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
//
// **`?versionOf=<file id>` uploads a new version of that file**
// (docs/PDF.md §13, "The upload"): the bytes become its next version, a
// candidate, and nothing more: it builds no page map and promotes nothing,
// which stay a person's acts on the candidate's page. `title`, `issuerOnly`
// and `duplicate` are a new file's, and are refused beside it. Whoever
// uploads may manage the file, or is a bot whose person may
// (`canUserUploadFileVersion`); those checks come before the body is read.
// A repeat is keyed as any upload's is, so a retry is answered with the
// candidate the first request made, where it would otherwise be refused for
// the candidate standing: which is why this route leaves that one check to
// the write, inside the key.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/mcp/files";

const CODE_FOR_STATUS: Record<number, ApiErrorCode> = { 400: "invalid", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "too_large", 415: "invalid" };

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
    const versionOf = url.searchParams.get("versionOf")?.trim() || undefined;
    if (versionOf !== undefined) {
      for (const newFileOnly of ["title", "issuerOnly", "duplicate"]) {
        if (url.searchParams.has(newFileOnly)) throw new ApiError("invalid", `${newFileOnly} is for a new file; a new version keeps its file's title and owners.`);
      }
      // Before the body is read. A candidate standing is left to the write, so a retry reaches its key.
      await assertMayUploadVersion(ctx.actor, versionOf, { allowCandidate: true });
      const staged = await stageUpload(ctx.actor, { body: request.body, filename });
      const keyArgs = { sha256: staged.stored.sha256, filename, versionOf };
      const recorded = await onceWithin(token.id, `POST ${ROUTE}`, keyArgs, url.searchParams.get("idempotencyKey") ?? undefined, async () => {
        const made = await recordVersionUpload(ctx.actor, versionOf, staged);
        if (made.unchanged) {
          return { url: `/pdf/${made.file.slug}`, id: made.file.id, title: made.file.title, unchanged: true, note: "These bytes are already this file's latest version; nothing was written." };
        }
        return {
          url: made.url,
          id: made.file.id,
          title: made.file.title,
          version: made.version.number,
          note: `Version ${made.version.number} is uploaded and waiting: it is readable at its own address, and /pdf/${made.file.slug} shows what it did until a person promotes it there.`,
        };
      }).catch(async (err: unknown) => {
        // A repeat refused by its key wrote nothing: its bytes, if this request put them there, go again.
        if (err instanceof ApiError && err.code === "already_done") await discardStagedUpload(staged);
        throw err;
      });
      console.log(JSON.stringify({ at: "mcp", token: token.prefix, user: token.user.id, tool: `POST ${ROUTE}`, outcome: "ok" }));
      return NextResponse.json(recorded, { status: "unchanged" in recorded ? 200 : 201 });
    }
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
