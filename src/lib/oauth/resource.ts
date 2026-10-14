// docs/MCP.md §21, "The consent page" and "The token endpoint" — the
// `resource` a request names (RFC 8707), which must be the MCP endpoint after
// canonicalization. Pure, so the comparison is unit-tested (resource.test.ts).

/**
 * Whether `value` names `endpoint`: the same origin, which `URL` lowercases
 * and strips of a default port; the same path, less a trailing slash, which
 * claude.ai strips from a connector's URL; and no query. A fragment is
 * refused rather than stripped, since RFC 8707 forbids one.
 */
export function namesEndpoint(value: string, endpoint: URL): boolean {
  if (value.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.search !== "" || url.username !== "" || url.password !== "") return false;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
  return url.origin === endpoint.origin && path === endpoint.pathname;
}
