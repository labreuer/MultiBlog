import { test, expect } from "./fixtures";
import { getAnnotationStates } from "./db";
import { createAgent } from "./mcp";

// An annotation body has no length limit, as a doc has none
// (docs/ANNOTATIONS.md, "Posting"). Each test posts one of about 7,000
// characters, through one front door.

/** About 7,200 characters in twelve paragraphs, each naming its own number. */
const PARAGRAPHS = Array.from(
  { length: 12 },
  (_, i) => `E2E long paragraph ${i + 1} of 12. ` + "A margin note this long is an essay beside its passage. ".repeat(10).trim(),
);
/** The body as `bodyText` holds it: blocks joined by a blank line. */
const LONG_TEXT = PARAGRAPHS.join("\n\n");

test("a long note posts and is edited through MCP", async ({ request, sharedDoc }) => {
  const agent = await createAgent(request);
  try {
    const note = await agent.call("add_note", { on: `/doc/${sharedDoc.slug}`, body: LONG_TEXT });
    expect(note.isError, JSON.stringify(note.error)).toBe(false);

    const added = "E2E paragraph added by edit_note.";
    const edited = await agent.call("edit_note", { id: note.result.id, body: `${LONG_TEXT}\n\n${added}` });
    expect(edited.isError, JSON.stringify(edited.error)).toBe(false);

    const [row] = await getAnnotationStates(sharedDoc.id);
    expect([row.status, row.bodyText]).toEqual(["LIVE", `${LONG_TEXT}\n\n${added}`]);
  } finally {
    await agent.dispose();
  }
});
