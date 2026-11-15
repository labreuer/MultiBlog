import type { CarryPreview } from "@/lib/file-anchor-move";
import type { PageMapNumbers } from "@/lib/pdf-page-map";

// docs/PDF.md §14, "What the page holds", item 6 — the browser's half of a
// version's two Route Handlers (`file-version-handlers.ts` is the server's).
// Each answers as the manage page's actions do, `{ ok, value }` or
// `{ ok: false, error }`, so a caller reads a handler's refusal exactly as it
// reads an action's. Browser-safe: types only from server modules.

export type VersionRequestAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

/** What a map build answers (`buildFileVersionMap`). */
export type VersionMapBuilt = { slug: string; number: number; stored: boolean; numbers: PageMapNumbers };

const FAILED = "That didn't work. Reload the page and try again.";

export const versionMapPath = (versionId: string) => `/api/files/versions/${encodeURIComponent(versionId)}/map`;
export const promotionCarryPath = (versionId: string) => `/api/files/versions/${encodeURIComponent(versionId)}/promotion-carry`;

async function ask<T>(url: string, init: RequestInit): Promise<VersionRequestAnswer<T>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store" });
  } catch {
    return { ok: false, error: "The server couldn't be reached. Check the connection, then try again." };
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (response.ok) return { ok: true, value: body as T };
  const error = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : FAILED;
  return { ok: false, error };
}

/** Builds and stores a version's page map, where it has none. */
export function requestVersionMap(versionId: string): Promise<VersionRequestAnswer<VersionMapBuilt>> {
  return ask(versionMapPath(versionId), { method: "POST" });
}

/** What promoting a waiting version with the carry would move; null where it has no page map. */
export function requestPromotionCarry(versionId: string): Promise<VersionRequestAnswer<CarryPreview | null>> {
  return ask(promotionCarryPath(versionId), { method: "GET" });
}
