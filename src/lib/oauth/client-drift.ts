// docs/MCP.md §21, "Which clients" — how a pinned identity's published
// document is compared with its pin (pinned-clients.ts). scripts/check-oauth-clients.ts
// fetches each document and hands what it got here; `deploy/deploy.sh` runs
// that on every deploy. Pure, and unit-tested (client-drift.test.ts).
//
// **It compares only what the server acts on.** A difference in one of those
// fields is a warning; a difference anywhere else, a reworded `client_name`
// or a new `logo_uri`, is a note. Compared whole, every cosmetic edit would
// raise the warning, and a warning that keeps proving false gets skimmed past.

/** A difference worth acting on, or one worth knowing about. */
export type DriftFinding = { level: "warning" | "note"; message: string };

/** What a fetch of a document got. */
export type FetchedDocument =
  | { kind: "unreachable"; reason: string }
  | {
      kind: "answered";
      status: number;
      /** The `Location` header, for a redirect. */
      location: string | null;
      /** The `cf-mitigated` header: Cloudflare's mark on a challenge. */
      cfMitigated: string | null;
      body: string;
    };

/**
 * The fields the server acts on: who the client is, where a code may go, how
 * it authenticates at the token endpoint, and what it may ask for. Lists
 * among them are compared as sets, since the server acts on none's order.
 */
const ACTED_ON = ["client_id", "redirect_uris", "token_endpoint_auth_method", "grant_types", "response_types"] as const;

/**
 * Either of these appearing names a key, which would announce Claude
 * becoming a confidential client: the token endpoint would then have to
 * verify `private_key_jwt` against it (§21, Open).
 */
const KEY_FIELDS = ["jwks_uri", "jwks"] as const;

function comparable(field: string, value: unknown): string {
  const actedOn: readonly string[] = ACTED_ON;
  if (actedOn.includes(field) && Array.isArray(value)) return JSON.stringify([...value].map(String).sort());
  return JSON.stringify(value);
}

function shown(value: unknown): string {
  return value === undefined ? "absent" : JSON.stringify(value);
}

/**
 * What differs between a pin and the document its URL answered, worst first.
 * Empty when they agree.
 *
 * - **An answer that isn't the document is a warning**, a 404 say, since the
 *   URL is the client's identity. So is a redirect: a client's document is
 *   never followed to another URL (client-metadata draft -02, §5).
 * - **A fetch that can't complete is a note**: it says nothing about the
 *   document. A Cloudflare challenge is one, a 403 carrying
 *   `cf-mitigated: challenge`, which Cloudflare has answered some
 *   datacenters with (`anthropics/claude-ai-mcp#650`).
 */
export function documentDrift(pinned: Readonly<Record<string, unknown>>, fetched: FetchedDocument): DriftFinding[] {
  if (fetched.kind === "unreachable") return [{ level: "note", message: `couldn't be fetched: ${fetched.reason}` }];

  const { status } = fetched;
  if (status === 403 && fetched.cfMitigated?.toLowerCase() === "challenge") {
    return [{ level: "note", message: "Cloudflare answered with a challenge, so the document couldn't be fetched from here." }];
  }
  if (status >= 300 && status < 400) {
    return [{ level: "warning", message: `answered ${status}, a redirect to ${fetched.location ?? "nowhere"}, not the document.` }];
  }
  if (status !== 200) return [{ level: "warning", message: `answered ${status}, not the document.` }];

  let document: unknown;
  try {
    document = JSON.parse(fetched.body);
  } catch {
    document = null;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return [{ level: "warning", message: "answered 200 with something that isn't a JSON document." }];
  }
  const published = document as Record<string, unknown>;

  const warnings: DriftFinding[] = [];
  const notes: DriftFinding[] = [];
  for (const field of ACTED_ON) {
    if (comparable(field, pinned[field]) !== comparable(field, published[field])) {
      warnings.push({ level: "warning", message: `${field} is ${shown(published[field])}; the pin has ${shown(pinned[field])}.` });
    }
  }
  for (const field of KEY_FIELDS) {
    if (published[field] !== undefined && pinned[field] === undefined) {
      warnings.push({ level: "warning", message: `${field} has appeared, which names a key: the client may have become a confidential one.` });
    }
  }
  const compared: readonly string[] = [...ACTED_ON, ...KEY_FIELDS];
  const others = new Set([...Object.keys(pinned), ...Object.keys(published)].filter((field) => !compared.includes(field)));
  for (const field of [...others].sort()) {
    if (comparable(field, pinned[field]) !== comparable(field, published[field])) {
      notes.push({ level: "note", message: `${field} is ${shown(published[field])}; the pin has ${shown(pinned[field])}.` });
    }
  }
  return [...warnings, ...notes];
}
