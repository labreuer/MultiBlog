import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { MENTION } from "./kinds/mention";
import { mentionOption, mentionOptionFor, MENTION_OPTIONS } from "./kinds/mention-options";
import { chipStylesOf, observeChipStyles, parseChipStyles, sameChipStyles, setChipStyle } from "./settings";

// docs/ENTITY_CHIPS.md, "Styling" — a doc's chip styles live in its ydoc.

test("a style is stored per chip kind, normalized by its kind, and read back", () => {
  const doc = new Y.Doc();
  assert.deepEqual(chipStylesOf(doc), {});
  assert.equal(setChipStyle(doc, MENTION, { form: "initials", at: "yes", extra: 1 }), true);
  // Only what the kind understands is kept, and a malformed field is its default.
  assert.deepEqual(chipStylesOf(doc), { [MENTION]: { form: "initials", at: null } });
  setChipStyle(doc, MENTION, null);
  assert.deepEqual(chipStylesOf(doc), {});
  // A kind this build doesn't know can't be set: there is nothing to check it with.
  assert.equal(setChipStyle(doc, "hologram", { form: "x" }), false);
  assert.deepEqual(chipStylesOf(doc), {});
});

test("a replica gets the style with the document, and setting the same style again writes nothing", () => {
  const doc = new Y.Doc();
  setChipStyle(doc, MENTION, { form: "handle" });
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  assert.deepEqual(chipStylesOf(replica), { [MENTION]: { form: "handle", at: null } });

  let updates = 0;
  doc.on("update", () => updates++);
  setChipStyle(doc, MENTION, { form: "handle", at: null });
  assert.equal(updates, 0);
});

test("an observer hears each change, and nothing from a doc that holds no style yet", () => {
  const doc = new Y.Doc();
  const heard: unknown[] = [];
  const stop = observeChipStyles(doc, (styles) => heard.push(styles));
  // An unsynced doc and a doc with no style look the same: neither is reported as "no style".
  assert.deepEqual(heard, []);
  setChipStyle(doc, MENTION, { form: "initials" });
  setChipStyle(doc, MENTION, null);
  assert.deepEqual(heard, [{ [MENTION]: { form: "initials", at: null } }, {}]);
  stop();
  setChipStyle(doc, MENTION, { form: "handle" });
  assert.equal(heard.length, 2);

  // A doc that already has one says so at once.
  const late: unknown[] = [];
  observeChipStyles(doc, (styles) => late.push(styles));
  assert.deepEqual(late, [{ [MENTION]: { form: "handle", at: null } }]);
});

test("styles from a column are parsed, never cast", () => {
  assert.deepEqual(parseChipStyles(null), {});
  assert.deepEqual(parseChipStyles("x"), {});
  assert.deepEqual(parseChipStyles({ mention: "initials", other: [1], fine: { a: 1 } }), { fine: { a: 1 } });
  assert.deepEqual(parseChipStyles({ big: { blob: "x".repeat(5000) } }), {});
  assert.equal(sameChipStyles({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }), true);
  assert.equal(sameChipStyles({ a: { x: 1 } }, {}), false);
});

test("each offered mention style reads back as itself", () => {
  for (const option of MENTION_OPTIONS) {
    assert.equal(mentionOptionFor(option.style), option.value);
    assert.equal(mentionOption(option.value), option);
  }
  assert.equal(mentionOption("doc"), null);
});
