import { previewCarryAtPromotion } from "@/lib/file-anchor-move";
import { versionHandler } from "@/lib/file-version-handlers";

// docs/PDF.md §14, "What the page holds", item 6 — what promoting a waiting
// version with the carry would move: `GET
// /api/files/versions/<versionId>/promotion-carry`. `null` where the version
// has no page map, and so no carry to offer. It stores nothing.
//
// **A Route Handler and not a server action** for the map build's reason
// (../map/route.ts): it reads both versions' sheets and takes seconds, and
// it runs when a candidate's card mounts and again after each answer to a
// run, so as an action it would hold the page's other saves behind it.
//
// `no-store`: an answer is true of the notes and the map as they stood when
// it was asked, and the card asks again whenever either has changed.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  return versionHandler("a promotion's carry preview", (actor) => previewCarryAtPromotion(actor, versionId), {
    headers: { "Cache-Control": "no-store" },
  });
}
