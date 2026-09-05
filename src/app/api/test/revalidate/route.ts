import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

// Test-only on-demand revalidation, for the e2e suite's prod target
// (docs/playwright-flakiness.html). The suite's fixtures write straight to
// the database, bypassing the server actions whose revalidatePath calls keep
// ISR pages honest in production — so under `next start`, a fixture-seeded
// contributor can be invisible on `/` for up to its revalidate window while
// the cached render from an earlier test's visit is served. e2e's
// `freshGoto()` posts here before navigating.
//
// Guarded by E2E_REVALIDATE (bare env var — a restart, not a rebuild, same
// convention as SITE_BANNER et al.), which only scripts/prod-web.ts's e2e role sets: a
// real deployment never does, and without it this route answers 404,
// indistinguishable from not existing. `next dev` doesn't set it either — the
// dev server serves ISR pages fresh anyway, so the dev lane never needs it.
export async function POST(request: Request) {
  if (process.env.E2E_REVALIDATE !== "1") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const { path } = (await request.json().catch(() => ({}))) as { path?: string };
  if (!path || !path.startsWith("/")) {
    return NextResponse.json({ error: "A path starting with '/' is required." }, { status: 400 });
  }
  revalidatePath(path);
  return NextResponse.json({ ok: true });
}
