"use client";

import { HocuspocusProvider, HocuspocusProviderWebsocket, type HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import { getCollabUrl } from "./collab-url";
import { SCHEMA_REFUSAL } from "./schema-version";

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

// What to tell when the server refuses a document on this socket for its
// schema version (docs/YDOC.md "A tab whose schema is out of date is
// refused"). The refusal is the bundle's, not the document's, so it is
// reported once to the socket's owner rather than handled by each provider:
// most of them (annotation bodies, the live tap, PDF presence) have no
// `onAuthenticationFailed` of their own to notice it with.
const schemaRefusalListeners = new WeakMap<CollabSocket, () => void>();

/** True for the reason the server gives a tab whose bundle is out of date. */
export function isSchemaRefusal(reason: string): boolean {
  return reason === SCHEMA_REFUSAL;
}

export function createCollabSocket(onSchemaRefused?: () => void): CollabSocket {
  const socket = new HocuspocusProviderWebsocket({ url: getCollabUrl() });
  if (onSchemaRefused) schemaRefusalListeners.set(socket, onSchemaRefused);
  return socket;
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
 *
 * It is also where a schema refusal is noticed, for every document on the
 * socket alike: the socket's owner is told, and the provider's own
 * `onAuthenticationFailed` still runs after.
 */
export function attachProvider(socket: CollabSocket, configuration: SharedProviderConfiguration): HocuspocusProvider {
  const provider = new HocuspocusProvider({
    ...configuration,
    websocketProvider: socket,
    onAuthenticationFailed: (data) => {
      if (isSchemaRefusal(data.reason)) schemaRefusalListeners.get(socket)?.();
      configuration.onAuthenticationFailed?.(data);
    },
  } as HocuspocusProviderConfiguration);
  provider.attach();
  return provider;
}
