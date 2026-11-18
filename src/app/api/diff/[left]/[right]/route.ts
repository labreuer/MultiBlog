import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { gateDiffPair, readDiffPair } from "@/lib/diff-pair";

// docs/FORKS.md "Sliders on the diff page" — a diff's pair, for the page a
// slider has moved on: the same sides, headers' facts and blocks the diff
// page at `/diff/<left>/<right>` is rendered from, as JSON. The page there
// asks this for each pair its sliders name, so it follows them without a
// navigation.
//
// **Nothing is read before the gate, and this holds no check of its own**:
// `gateDiffPair` is the page's gate, and `readDiffPair` its read
// (src/lib/diff-pair.ts). Signed out is a 401, and the gate's two refusals a
// 403 and a 404; the page that asked then goes to the pair's own address,
// which shows each as it does for a pasted one.
//
// Never cached: a side with no version is the doc as it is when asked.
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(_request: Request, { params }: { params: Promise<{ left: string; right: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const { left, right } = await params;
  const pair = await gateDiffPair(session.user, left, right);
  if (pair === "not-found") return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  if (pair === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });

  return NextResponse.json(await readDiffPair(pair), { headers: NO_STORE });
}
