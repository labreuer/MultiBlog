import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { actorFromSessionUser } from "@/lib/actor";
import { chipInputsFor, type ChipTarget } from "@/lib/entity-chips/context-for";
import { chipKinds } from "@/lib/entity-chips/registry";
import { commentChipInputsFor } from "@/lib/comment-reading";

// docs/ENTITY_CHIPS.md, step 1, item 5 — what a browser computes its chips'
// labels from: `GET /api/chip-context?doc=<id>`, `?annotation=<id>` or
// `?comment=<id>`, gated by that object's read rule. A `<chip kind>=<id>,<id>` parameter asks about
// ids the stored body doesn't hold yet (a chip just inserted); each is
// answered only where the kind's insertion rule lets this viewer see it.

const MAX_ASKED = 200;

export async function GET(request: Request) {
  const session = await auth();
  const params = new URL(request.url).searchParams;
  const doc = params.get("doc");
  const annotation = params.get("annotation");
  const comment = params.get("comment");
  // A comment can be public, and its commenter signed out (docs/ENTITY_CHIPS.md,
  // "Chips in comments"); a doc or a note needs an account.
  if (!session?.user && !comment) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const target: ChipTarget | null = doc ? { doc } : annotation ? { annotation } : null;
  if (!target && !comment) {
    return NextResponse.json({ error: "Name a doc, an annotation or a comment." }, { status: 400 });
  }

  const asked: Record<string, string[]> = {};
  for (const kind of chipKinds()) {
    const ids = (params.get(kind.name) ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length > 0) asked[kind.name] = Array.from(new Set(ids)).slice(0, MAX_ASKED);
  }

  const actor = session?.user ? actorFromSessionUser(session.user) : null;
  const inputs = target && actor ? await chipInputsFor(actor, target, asked) : comment ? await commentChipInputsFor(actor, comment, asked) : null;
  if (!inputs) {
    // One answer for "no such object" and "not yours to read", so the route
    // doesn't say which ids exist.
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json(inputs);
}
