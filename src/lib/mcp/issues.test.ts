import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { issueLines } from "./issues";

const item = z.union([
  z.strictObject({ old: z.string(), new: z.string() }),
  z.strictObject({ append: z.string() }),
]);
const schema = z.strictObject({ edits: z.array(item), title: z.string().optional() });

const linesFor = (value: unknown) => issueLines(schema.safeParse(value).error!.issues, schema);

test("a union no branch fits names its forms and the closest branch's issues", () => {
  assert.deepEqual(linesFor({ edits: [{ replace: "a", with: "b" }] }), [
    "edits.0: fits none of its forms, which need old + new | append",
    "edits.0.append: Invalid input: expected string, received undefined",
    'edits.0: Unrecognized keys: "replace", "with"',
  ]);
});

test("a near miss reports the branch it nearly fit", () => {
  assert.deepEqual(linesFor({ edits: [{ old: "a", neww: "b" }] }), [
    "edits.0: fits none of its forms, which need old + new | append",
    "edits.0.new: Invalid input: expected string, received undefined",
    'edits.0: Unrecognized key: "neww"',
  ]);
});

test("a union of non-objects reports only the closest branch", () => {
  const passage = z.strictObject({ quote: z.union([z.string(), z.strictObject({ start: z.string(), end: z.string() })]) });
  assert.deepEqual(issueLines(passage.safeParse({ quote: 3 }).error!.issues, passage), ["quote: Invalid input: expected string, received number"]);
});

test("other issues keep their path and message", () => {
  assert.deepEqual(linesFor({ edits: [], title: 3, extra: 1 }), [
    "title: Invalid input: expected string, received number",
    '(arguments): Unrecognized key: "extra"',
  ]);
});
