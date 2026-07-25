// Names and constants shared by both sides of the DB helper split — the
// Playwright process (e2e/db.ts) and the tsx child that actually talks to
// Postgres (e2e/db-worker.ts). Kept free of any Prisma import so the
// Playwright side can load it directly.

export const SAFE_EMAIL = /^[\w.+-]+@example\.com$/i;

export const TEST_PASSWORD = "testpass123";
export const ADMIN_EMAIL = "e2e-admin@example.com";

/** Everything this suite creates is named so the teardown sweep can find it. */
export const E2E_PREFIX = "e2e-";
export const E2E_TITLE_PREFIX = "E2E ";

/** Unique per call, so parallel workers never collide on User.email. */
export function uniqueEmail(label: string): string {
  return `${E2E_PREFIX}${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

export function uniqueTitle(label: string): string {
  return `${E2E_TITLE_PREFIX}${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A minimal TipTap doc — one paragraph per blank-line-separated block. */
export function docFromText(text: string) {
  return {
    type: "doc",
    content: text.split("\n\n").map((para) => ({
      type: "paragraph",
      ...(para ? { content: [{ type: "text", text: para }] } : {}),
    })),
  };
}
