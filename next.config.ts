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
  // own devices on the same network need an explicit allowlist entry — these
  // are LAN IPs, not public ones, so it's safe to commit rather than putting
  // it behind an env var.
  //
  // A wildcard over the subnet rather than a list of literal addresses: these
  // are DHCP leases, so a pinned address silently stops matching whenever one
  // moves. It already did — the entry here was 192.168.1.63 while the machine
  // had become .209, and the symptom is not a message about origins but an
  // iPad that simply fails to load the page. Whoever hits that has no reason
  // to suspect this file, and testing from a phone or tablet is exactly when
  // the lease is least likely to be the one written down.
  //
  // What this widens: any device on the same 192.168.1.0/24 can reach the dev
  // server's HMR and RSC endpoints. That is the LAN you already trust enough
  // to run an unauthenticated Postgres and a dev server on, and the guard's
  // threat model is a malicious *website* driving a browser at your dev
  // server, which an origin allowlist of any shape does nothing about once
  // the attacker is already on the subnet. Read at `next dev` startup, so a
  // change here needs a restart, not a rebuild.
  allowedDevOrigins: ["192.168.1.*"],
};

export default nextConfig;
