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
  //
  // pdfjs-dist is external for a different reason (PLAN.md §19): the
  // server-side text extraction resolves pdfjs's *own* worker and standard-font
  // files by path (`createRequire(...).resolve`, src/lib/pdf-extract.ts), which
  // only answers correctly if the package is being loaded from node_modules
  // rather than inlined into a bundle. Bundling it would also drag several MB
  // of parser into every server chunk that transitively touches the upload
  // route.
  serverExternalPackages: ["yjs", "pdfjs-dist"],
  // Next 15+ blocks cross-origin dev requests by default (HMR, RSC) as a CSRF
  // guard against a malicious site on the LAN reaching your dev server. Your
  // own devices on the same network need an explicit allowlist entry — this
  // is a LAN IP, not a public one, so it's safe to commit rather than putting
  // it behind an env var. Add another entry here (or use a wildcard like
  // "192.168.1.*") if it changes or a second device needs it.
  allowedDevOrigins: ["192.168.1.63"],
};

export default nextConfig;
