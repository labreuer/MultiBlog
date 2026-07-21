import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next's server compiler builds separate bundles per layer (RSC, SSR), each of
  // which would otherwise get its own copy of yjs's module scope. yjs guards
  // against being loaded twice in the same JS realm via a globalThis flag
  // (see node_modules/yjs/src/index.js), so two bundled copies in the same
  // Node process trip its "Yjs was already imported" warning even though only
  // one yjs version is installed. Marking it external makes every server-side
  // layer resolve it through Node's own require cache instead.
  // https://github.com/yjs/yjs/issues/438
  serverExternalPackages: ["yjs"],
};

export default nextConfig;
