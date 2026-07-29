import type { Role } from "@/generated/prisma/enums";
import { signYdocToken } from "./ydoc-token";
import { YDOC_SNAPSHOT_PATH } from "./ydoc-names";

// Server-to-server channel from the Next app to the Hocuspocus server for the
// ydoc stack's one admin operation — parallels collab-admin.ts's
// replaceCollabDoc, kept as a separate file rather than added to that one so
// the two stacks stay independent end to end (PLAN.md §11).
//
// NEXT_PUBLIC_COLLAB_URL is a websocket URL (ws://host:port); the same
// Hocuspocus process serves plain HTTP on that origin, so the only
// difference is the scheme.
function collabHttpOrigin(): string {
  const wsUrl = process.env.NEXT_PUBLIC_COLLAB_URL ?? `ws://localhost:${process.env.COLLAB_PORT ?? 1234}`;
  return wsUrl.replace(/^ws/, "http").replace(/\/$/, "");
}

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
