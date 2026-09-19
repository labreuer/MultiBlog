"use client";

import { HocuspocusProvider, HocuspocusProviderWebsocket, type HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import { getCollabUrl } from "./collab-url";

// One websocket per page, every document on it — docs/YDOC.md "One socket
// per page". A surface's own document (a doc's live tap, the doc editor, a
// PDF's presence channel) and every annotation body opened on that surface
// are separate Hocuspocus *documents*, each with its own token, its own
// `onAuthenticate` run and its own read-only flag on the server, but they
// share the one TCP/TLS/upgrade handshake. `HocuspocusProviderWebsocket`
// routes each incoming message to the provider whose document it names.
//
// Both helpers are browser-only (`getCollabUrl` reads `window`, and the
// socket connects in its constructor), so they are called from effects, never
// during render. `DocPresenceProvider` owns the socket's lifetime.

export type CollabSocket = HocuspocusProviderWebsocket;

export function createCollabSocket(): CollabSocket {
  return new HocuspocusProviderWebsocket({ url: getCollabUrl() });
}

type SharedProviderConfiguration = Omit<HocuspocusProviderConfiguration, "url" | "websocketProvider">;

/**
 * Constructs a provider on a shared socket, attached.
 *
 * The explicit `attach()` is the whole reason this exists rather than a bare
 * `new HocuspocusProvider({ websocketProvider })`: a provider given its own
 * `url` attaches itself in its constructor, one handed an existing socket
 * does not, and an unattached provider silently sends nothing — no token, no
 * sync, no error. `destroy()` detaches it again and leaves the socket to its
 * owner.
 */
export function attachProvider(socket: CollabSocket, configuration: SharedProviderConfiguration): HocuspocusProvider {
  const provider = new HocuspocusProvider({ ...configuration, websocketProvider: socket } as HocuspocusProviderConfiguration);
  provider.attach();
  return provider;
}
