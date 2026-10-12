import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTar, tarEnd, tarEntry } from "./tar";

// docs/MCP.md §6 — the export's tar, checked against the system's own `tar`
// as well as against its reading half.

const encoder = new TextEncoder();

function archive(): Uint8Array {
  const parts = [
    tarEntry("cabc123.md", encoder.encode("---\nid: cabc123\n---\n\n# Héllo\n")),
    tarEntry("manifest.json", encoder.encode('[{"id":"cabc123"}]')),
    tarEnd(),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

test("an archive reads back as the files written into it", () => {
  const files = readTar(archive());
  assert.deepEqual([...files.keys()], ["cabc123.md", "manifest.json"]);
  assert.equal(files.get("cabc123.md"), "---\nid: cabc123\n---\n\n# Héllo\n");
});

test("the system's tar extracts it", () => {
  const dir = mkdtempSync(join(tmpdir(), "tar-test-"));
  try {
    writeFileSync(join(dir, "a.tar"), archive());
    execFileSync("tar", ["-xf", "a.tar"], { cwd: dir });
    assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), '[{"id":"cabc123"}]');
    assert.equal(readFileSync(join(dir, "cabc123.md"), "utf8").includes("Héllo"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a name past ustar's 99 bytes is refused rather than truncated", () => {
  assert.throws(() => tarEntry("x".repeat(100), new Uint8Array()));
});
