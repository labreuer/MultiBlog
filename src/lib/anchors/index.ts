// PLAN.md §20h step 1 — the shared anchor library's **browser-safe** face.
//
// Everything re-exported here is pure: no Prisma, no filesystem, no `server-only`
// dependency. That matters because `annotation-highlight-extension.ts` imports
// the resolve half and ships to the browser.
//
// `./capture` is deliberately **not** re-exported. It reaches Postgres through
// `materializeYdocAt`, so a barrel that included it would pull PrismaClient
// into every client bundle that wanted `resolveAnchorInDoc` — the same reason
// `avatar.ts` (server) and `avatar-url.ts` (browser) are two files rather than
// one with a conditional. Server callers import `@/lib/anchors/capture`
// explicitly, which makes the boundary visible at the call site.
export { resolveAnchorInDoc } from "./resolve";
export {
  targetToColumns,
  targetFromColumns,
  parseAnchorTargetKind,
  targetKey,
  type AnchorTargetColumns,
} from "./target";
export {
  parseSelector,
  parseSelectorKind,
  deriveDocRangeSelector,
  type AnchorSelector,
  type DocRangeSelector,
  type PdfTextSelector,
} from "./selector";
export {
  ANCHOR_TARGET_KINDS,
  SELECTOR_KINDS,
  type AnchorRange,
  type AnchorTarget,
  type AnchorTargetKind,
  type SelectorKind,
} from "./types";
