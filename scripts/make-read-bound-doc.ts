// Writes the Markdown for the read-bound test doc (docs/MCP.md §21, Build
// order, step 3): a doc long enough that `read` with whole:true passes the
// size at which claude.ai stops passing a tool result inline, about 150,000
// characters, while staying under `read`'s own 200,000.
//
// Nine parts of about 20,000 characters, each a heading and twenty
// paragraphs. Every paragraph opens with the character it begins at, counted
// in the body as `read` returns it in Markdown (blocks joined by a blank
// line, the title not included), so the last paragraph Claude sees shows
// where a result was cut off or spilled to a file. A ranged read of the
// first N parts tries a size in steps of 20,000.
//
// Plain words, digits and full stops only: nothing Markdown would escape, so
// the offsets hold for the body as read.
//
// Usage: npx tsx scripts/make-read-bound-doc.ts <out.md>
// Then import it on the instance, in its checkout, as a doc private to its
// byline (docs/CLAUDE_IMPORT.md §8):
//   MB_EMAIL=<your account> npx tsx scripts/import-claude-chats.ts --markdown <out.md>

import { writeFileSync } from "node:fs";

const TITLE = "Read-bound test for the claude.ai trial";
const PARTS = 9;
const PARAGRAPHS_PER_PART = 20;
const PARAGRAPH_CHARS = 1_000;

const n = (value: number) => value.toLocaleString("en-US");

function readBoundMarkdown(): string {
  const blocks: string[] = [];
  let offset = 0;
  const add = (block: string) => {
    blocks.push(block);
    offset += block.length + 2;
  };

  add(
    "This doc is a fixture for the header trial in docs/MCP.md, section 21: a doc long enough that reading it whole passes the size at which claude.ai stops passing a tool result inline. " +
      `It has ${PARTS} parts of about ${n(PARAGRAPHS_PER_PART * PARAGRAPH_CHARS)} characters each, and every paragraph begins by saying at which character of this body it begins, so the last one a reader sees shows where a result was cut off. ` +
      "It says nothing else, and can be deleted once the trial is done.",
  );
  for (let part = 1; part <= PARTS; part++) {
    add(`## Part ${part}, from character ${n(offset)}`);
    for (let p = 1; p <= PARAGRAPHS_PER_PART; p++) {
      const label = `${part}.${String(p).padStart(2, "0")}`;
      let text = `Paragraph ${label} begins at character ${n(offset)} of this body, in part ${part} of ${PARTS}.`;
      for (let k = 1; ; k++) {
        const sentence = ` Filler sentence ${label}.${k} means nothing and is here to take up room, so that every part keeps its size.`;
        if (text.length + sentence.length > PARAGRAPH_CHARS) break;
        text += sentence;
      }
      add(text);
    }
  }
  add(`This is the last paragraph. It begins at character ${n(offset)}, and the body ends with it.`);
  return `# ${TITLE}\n\n${blocks.join("\n\n")}\n`;
}

const out = process.argv[2];
if (!out) {
  console.error("Usage: npx tsx scripts/make-read-bound-doc.ts <out.md>");
  process.exit(1);
}
const markdown = readBoundMarkdown();
writeFileSync(out, markdown);
console.log(`Wrote ${out}: ${n(markdown.length)} characters.`);
