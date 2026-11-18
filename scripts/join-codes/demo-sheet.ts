// Renders a sample card sheet (docs/EMAIL.md §10, "Minting and printing")
// for a fake batch of twelve cards, under a fixed fake secret: no database,
// no .env, and no code that works anywhere. For looking at the layout and
// for checking that the printed QRs decode to their cards' URLs.
//
// Usage:
//   npx tsx scripts/join-codes/demo-sheet.ts [<out.html>]
//
// The default output path is in the system temp directory, outside the tree.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deriveJoinCode, deriveJoinKey } from "../../src/lib/join-codes/code";
import { renderCardSheet } from "../../src/lib/join-codes/sheet";

const DEFAULT_OUT = join(tmpdir(), "join-cards-demo", "sample-sheet.html");

const FAKE_SECRET = "demo-sheet: a fake secret that no instance uses";
const FAKE_BATCH = "cdemobatch000000000000000";
const COUNT = 12;

const out = resolve(process.argv[2] ?? DEFAULT_OUT);
const key = deriveJoinKey(FAKE_SECRET);
const cards = Array.from({ length: COUNT }, (_, i) => ({
  serial: i + 1,
  code: deriveJoinCode(key, FAKE_BATCH, i + 1),
}));

const html = renderCardSheet({
  siteTitle: "MultiBlog",
  host: "explore.example.org",
  line: "Scan to make an account. This card works once.",
  cards,
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`Wrote ${cards.length} cards to ${out}`);
