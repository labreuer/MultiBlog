// Fetches each pinned OAuth client's published document, Claude's and Claude
// Code's, and compares it with its pin in src/lib/oauth/pinned-clients.ts
// (docs/MCP.md §21, "Which clients").
//
// Usage:
//   npx tsx scripts/check-oauth-clients.ts
//
// **deploy/deploy.sh runs it on every deploy**, once the new build answers,
// and ignores its exit status: it prints what it finds and never fails the
// deploy. Nothing else would run it, there being no CI or cron, and drift
// would otherwise first show as claude.ai failing to connect.
//
// A **warning** is a difference the server acts on (a redirect URI, the
// token endpoint's authentication, the grants, a key appearing) or an answer
// that isn't the document; it exits 1. A **note** is anything else: a
// cosmetic edit, or a fetch that couldn't complete, a Cloudflare challenge
// among them. When Anthropic has changed a document, update its pin, and
// read §21's Open on a key appearing.
//
// It follows no redirect, as the client-metadata draft forbids an
// authorization server to (-02, §5), and needs no database or .env.

import { documentDrift, type FetchedDocument } from "../src/lib/oauth/client-drift";
import { PINNED_CLIENTS } from "../src/lib/oauth/pinned-clients";

const TIMEOUT_MS = 10_000;

async function fetchDocument(url: string): Promise<FetchedDocument> {
  try {
    const res = await fetch(url, { redirect: "manual", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return {
      kind: "answered",
      status: res.status,
      location: res.headers.get("location"),
      cfMitigated: res.headers.get("cf-mitigated"),
      body: await res.text(),
    };
  } catch (err) {
    return { kind: "unreachable", reason: err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err) };
  }
}

async function main() {
  let warned = false;
  const checked = await Promise.all(
    PINNED_CLIENTS.map(async ({ document }) => ({ document, findings: documentDrift(document, await fetchDocument(document.client_id)) })),
  );
  for (const { document, findings } of checked) {
    const label = `${document.client_name} (${document.client_id})`;
    if (findings.length === 0) {
      console.log(`    ${label}: matches its pin.`);
      continue;
    }
    console.log(`    ${label}:`);
    for (const finding of findings) {
      console.log(`      ${finding.level === "warning" ? "WARNING" : "note"}: ${finding.message}`);
      warned ||= finding.level === "warning";
    }
  }
  if (warned) {
    console.log("    A warning means claude.ai or Claude Code may stop connecting. Update the pin in");
    console.log("    src/lib/oauth/pinned-clients.ts once the change is understood (docs/MCP.md §21).");
    process.exitCode = 1;
  }
}

void main();
