// The token *refresher* half of every collab connection: what a provider calls
// on each reconnect, after the first token (fetched alongside lineage and the
// document name) has been spent.
//
// Two answers from a token route are final, and retrying cannot change them:
// 401, the viewer's session is gone, and 403, the viewer is signed in but may
// no longer open this document. The provider cannot tell those from a network
// blip on its own: a `token` function that throws becomes an
// `authenticationFailed` event carrying only a string, and the document sits
// unauthenticated on a socket that will reconnect — Hocuspocus drops a socket
// with nothing authenticated on it after its timeout, and the client's retry
// loop has no attempt limit — and call the refresher again. A signed-out tab
// left open on a doc asks for a token about once a minute, indefinitely.
// `CollabTokenDenied` is how a refresher tells its caller to stop the
// connection instead.
//
// Only refreshers use this. A surface's *first* fetch keeps its own handling,
// because a 401 there means something else: an anonymous reader of a public
// doc, who was never signed in and has nothing to be told.

export type TokenDenial = "signed-out" | "forbidden";

export class CollabTokenDenied extends Error {
  constructor(readonly denial: TokenDenial) {
    super(denial === "signed-out" ? "Signed out." : "No access to this document.");
    this.name = "CollabTokenDenied";
  }
}

/**
 * POSTs to a token route and returns its token. Throws `CollabTokenDenied` on
 * 401 or 403 and a plain `Error(failureMessage)` on anything else unsuccessful,
 * which the provider keeps retrying as it always has.
 */
export async function refreshCollabToken(url: string, failureMessage = "Failed to authenticate."): Promise<string> {
  const res = await fetch(url, { method: "POST" });
  if (res.status === 401) throw new CollabTokenDenied("signed-out");
  if (res.status === 403) throw new CollabTokenDenied("forbidden");
  if (!res.ok) throw new Error(failureMessage);
  const { token } = (await res.json()) as { token: string };
  return token;
}
