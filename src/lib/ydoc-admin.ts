import type { Role } from "@/generated/prisma/enums";
import { signYdocToken } from "./ydoc-token";
import { collabHttpOrigin } from "./collab-http-origin";
import { YDOC_SNAPSHOT_PATH } from "./ydoc-names";

// Server-to-server channel from the Next app to the Hocuspocus server for the
// ydoc stack's one admin operation — the same idiom annotation-admin.ts uses,
// sharing collabHttpOrigin with it (see that module for why the origin is the
// loopback address and not NEXT_PUBLIC_COLLAB_URL).

/**
 * Takes a snapshot of a ydoc-stack document through the running collab
 * server (never from the stored blob in Next — see PLAN.md §11d for why the
 * blob can be stale relative to the update log).
 */
export async function snapshotYdoc(opts: { documentName: string; userId: string; role: Role }): Promise<void> {
  const { documentName, userId, role } = opts;
  const token = await signYdocToken({ sub: userId, documentName, role });

  let response: Response;
  try {
    response = await fetch(`${collabHttpOrigin()}${YDOC_SNAPSHOT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, documentName }),
    });
  } catch {
    throw new Error("Couldn't reach the live-editing server to take a snapshot.");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`The live-editing server rejected the snapshot (${response.status})${detail ? `: ${detail}` : "."}`);
  }
}
