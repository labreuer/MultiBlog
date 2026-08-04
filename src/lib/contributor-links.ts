// Validation for the contributor-card fields that aren't the blurb (PLAN.md
// §17e) — shared by the self-service action (actions/contributor.ts) and the
// admin action (actions/users.ts) so the two write paths can't diverge on
// what they accept.

const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

// ISO 7064 mod-11-2 checksum over the first 15 digits, matching ORCID's own
// check-digit algorithm — catches a transposed digit a shape-only regex
// would let through.
function orcidChecksumValid(digits: string): boolean {
  let total = 0;
  for (const ch of digits.slice(0, 15)) {
    total = (total + Number(ch)) * 2;
  }
  const remainder = total % 11;
  const check = (12 - remainder) % 11;
  const expected = check === 10 ? "X" : String(check);
  return expected === digits[15];
}

// Accepts a bare id ("0000-0002-1825-0097") or a full https://orcid.org/...
// URL and returns the bare id — the column stores one canonical form (PLAN.md
// §17e); the https://orcid.org/... link is built at render by orcidUrl().
// Returns null for anything that isn't a validly-shaped, checksum-valid id.
export function normalizeOrcid(input: string): string | null {
  const trimmed = input.trim();
  const bare = trimmed.replace(/^https?:\/\/(www\.)?orcid\.org\//i, "");
  if (!ORCID_RE.test(bare)) {
    return null;
  }
  const digits = bare.replace(/-/g, "");
  return orcidChecksumValid(digits) ? bare : null;
}

export function orcidUrl(orcid: string): string {
  return `https://orcid.org/${orcid}`;
}

// Requires http:/https: — this check, not a hostname allowlist, is what
// makes a stored javascript: href impossible (PLAN.md §17e). Returns the
// normalized .href so the stored form is canonical.
export function normalizeWebsite(input: string): string | null {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
