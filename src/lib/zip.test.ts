import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { zipStored } from "./zip";

// docs/MCP.md §21, "The skill" — the skill's ZIP, checked against the
// system's own `unzip` where there is one, and against the format's fixed
// offsets everywhere.

const encoder = new TextEncoder();
const body = "---\nname: x\n---\n\n# Héllo\n";

function archive(): Uint8Array {
  return zipStored([{ name: "skill/" }, { name: "skill/SKILL.md", content: encoder.encode(body) }]);
}

function hasUnzip(): boolean {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("the end record counts both entries and points at a central directory that names them", () => {
  const zip = archive();
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
  const directory = view.getUint32(end + 16, true);
  assert.equal(view.getUint32(directory, true), 0x02014b50);
  const nameLength = view.getUint16(directory + 28, true);
  assert.equal(new TextDecoder().decode(zip.subarray(directory + 46, directory + 46 + nameLength)), "skill/");
});

test("a file's entry carries its CRC and its bytes as they are", () => {
  const zip = archive();
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The directory's local header is 30 bytes and its name; the file's follows.
  const at = 30 + "skill/".length;
  assert.equal(view.getUint32(at, true), 0x04034b50);
  const content = encoder.encode(body);
  assert.equal(view.getUint32(at + 14, true), crc32(content) >>> 0);
  assert.equal(view.getUint32(at + 18, true), content.length);
  const start = at + 30 + "skill/SKILL.md".length;
  assert.deepEqual(zip.subarray(start, start + content.length), content);
});

test("the same entries make the same bytes", () => {
  assert.deepEqual(archive(), archive());
});

test("the system's unzip tests it clean and extracts the folder", { skip: !hasUnzip() && "no unzip on this machine" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  try {
    writeFileSync(join(dir, "a.zip"), archive());
    execFileSync("unzip", ["-tq", "a.zip"], { cwd: dir });
    execFileSync("unzip", ["-q", "a.zip"], { cwd: dir });
    assert.equal(statSync(join(dir, "skill")).isDirectory(), true);
    assert.equal(readFileSync(join(dir, "skill", "SKILL.md"), "utf8"), body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
