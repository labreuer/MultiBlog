import type { JSONContent } from "@tiptap/core";
import type { Role } from "@/generated/prisma/enums";
import { signCollabToken } from "./collab-token";

// Server-to-server channel from the Next app to the Hocuspocus server, for the
// one operation that has to change a post's *live* document rather than just
// its rows: restoring an old revision.
//
// Writing a Revision row isn't enough on its own. The editor's content comes
// from the collab Y.Doc, and onLoadDocument only seeds that from a revision
// when no PostCollab row exists — which stops being true the moment a post is
// edited once (see the PostCollab lifecycle note in CLAUDE.md). Without this,
// a restore leaves the live doc untouched: the author is dropped back into the
// editor still looking at the content they meant to discard, and the next
// Publish snapshots that, silently undoing the restore.
//
// Deleting the PostCollab row instead would not work — a document with a
// connected editor stays loaded in the collab server's memory, so
// onLoadDocument never re-runs and the connected client just re-flushes its
// old state. Going through the running server is what makes the change reach
// every open editor live.

/** Path the collab server's onRequest hook listens on; shared so the two can't drift. */
export const REPLACE_DOC_PATH = "/admin/replace-doc";

export type ReplaceDocRequest = {
  token: string;
  postId: string;
  doc: JSONContent;
  title: string;
};

// NEXT_PUBLIC_COLLAB_URL is a websocket URL (ws://host:port); the same
// Hocuspocus process serves plain HTTP on that origin, so the only difference
// is the scheme — ws→http, wss→https.
function collabHttpOrigin(): string {
  const wsUrl = process.env.NEXT_PUBLIC_COLLAB_URL ?? `ws://localhost:${process.env.COLLAB_PORT ?? 1234}`;
  return wsUrl.replace(/^ws/, "http").replace(/\/$/, "");
}

/**
 * Replaces a post's live collaborative document (body and title) with `doc`
 * and `title`, broadcasting to every editor currently connected to it.
 *
 * Throws if the collab server can't be reached or refuses — deliberately, so a
 * restore that only half-applied surfaces as an error instead of looking like
 * it worked. The caller has already written the revision row by then, which is
 * recoverable: it's a draft revision either way.
 */
export async function replaceCollabDoc(opts: {
  postId: string;
  userId: string;
  role: Role;
  doc: JSONContent;
  title: string;
}): Promise<void> {
  const { postId, userId, role, doc, title } = opts;

  // The same short-lived token the browser uses to open an editing session —
  // minted here only after the caller has already checked edit permission, so
  // possession of a token naming this post is the authorization.
  const token = await signCollabToken({ sub: userId, postId, role });

  const body: ReplaceDocRequest = { token, postId, doc, title };
  let response: Response;
  try {
    response = await fetch(`${collabHttpOrigin()}${REPLACE_DOC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Couldn't reach the live-editing server, so the editor still shows the old content. " +
        "The restored revision was saved — reopen the editor once live editing is back.",
    );
  }

  if (!response.ok) {
    throw new Error(
      `The live-editing server rejected the restore (${response.status}), so the editor still shows the old content. ` +
        "The restored revision was saved.",
    );
  }
}
