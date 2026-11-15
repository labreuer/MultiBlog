import { buildFileVersionMap } from "@/lib/file-manage";
import { versionHandler } from "@/lib/file-version-handlers";

// docs/PDF.md §14, "What the page holds", item 6 — builds and stores a
// version's page map, where it has none: `POST
// /api/files/versions/<versionId>/map`. A POST, since it writes.
//
// **A Route Handler and not a server action**, because it takes seconds
// (around ten for a book over a thousand sheets) and nobody is waiting on it:
// it starts by itself after a better copy's upload. Next's client sends a
// page's server actions one at a time, so as an action it would hold every
// save made on the manage page meanwhile. A handler is an ordinary `fetch`
// and runs beside them.
//
// It revalidates nothing: the page that asked refreshes itself when this
// answers. A build the page stops waiting for still finishes, and is stored
// once (`writePageMapIfNone`).
//
// Answers what `buildFileVersionMap` does: the version's slug and number,
// whether this request stored the map, and the map in numbers.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  // A cuid holds nothing `encodeURIComponent` alters, so the param needs no decoding.
  const { versionId } = await params;
  return versionHandler("a page map's build", (actor) => buildFileVersionMap(actor, versionId));
}
