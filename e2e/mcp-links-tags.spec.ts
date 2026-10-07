import { test, expect } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestAnnotation,
  createTestDoc,
  createTestFile,
  createTestPost,
  deleteTestDoc,
  deleteTestFile,
  deleteTestPost,
  deleteTestTag,
  getTagFacts,
} from "./db";
import { createAgent } from "./mcp";
import { uniqueTitle } from "./naming";

// docs/MCP.md §10, §11: anchored links minted without the tray, their parts
// captured by quote before anything is written, edited by part number by
// their creator; and tags applied by name, minted when new, refused on a post
// whose chips are public at once.

type LinkRead = { groups: { kind: string; parts: { n?: number; quote: string; blocks?: string; page?: number; lost?: true }[] }[] };

test("create_link mints several links in one call, each part captured by quote; a miss refuses them all", async ({ request }) => {
  const agent = await createAgent(request);
  const reader = await createAgent(request, { scopes: ["READ"] });
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    bodyText: "Participation is the theme. It recurs.\n\nOriginal participation came first.",
  });
  const file = await createTestFile({
    ownerEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    pages: [["A first page."], ["Final participation is the goal."]],
  });
  try {
    const version = String((await agent.call("read", { url: `/doc/${doc.slug}` })).result.version);
    const refused = await agent.call("create_link", {
      links: [
        { parts: [{ on: `/doc/${doc.slug}`, quote: "Participation is the theme", version }] },
        { parts: [{ on: `/pdf/${file.slug}`, quote: "Initial participation" }] },
      ],
    });
    expect(refused.error).toMatchObject({ code: "no_match", link: 2, part: 1 });
    expect(String(refused.error.message)).toMatch(/^Link 2, part 1: /);
    const before = await agent.call("read", { url: `/doc/${doc.slug}`, include: ["links"] });
    expect((before.result.links as { total: number }).total).toBe(0);

    const minted = await agent.call("create_link", {
      links: [
        { name: "The theme", parts: [{ on: `/doc/${doc.slug}`, quote: "Participation is the theme", version }] },
        {
          parts: [
            { on: `/doc/${doc.slug}`, quote: "Original participation came first", version },
            { on: `/pdf/${file.slug}`, quote: "Final participation", page: 2 },
          ],
        },
      ],
    });
    expect(minted.isError, JSON.stringify(minted.error)).toBe(false);
    const [theme, pair] = minted.result.links as { url: string; name?: string; parts: number }[];
    expect(theme).toMatchObject({ name: "The theme", parts: 1 });
    expect(pair.parts).toBe(2);

    const read = (await agent.call("read", { url: pair.url })).result as LinkRead;
    expect(read.groups.map((g) => g.kind)).toEqual(["doc", "pdf"]);
    expect(read.groups[0].parts[0]).toMatchObject({ n: 1, quote: "Original participation came first", blocks: "2" });
    expect(read.groups[1].parts[0]).toMatchObject({ n: 2, quote: "Final participation", page: 2 });
    // Only the creator is shown part numbers.
    const theirs = (await reader.call("read", { url: pair.url })).result as LinkRead;
    expect(theirs.groups[0].parts[0].n).toBeUndefined();

    const into = await agent.call("read", { url: `/doc/${doc.slug}`, include: ["links"] });
    expect((into.result.links as { total: number }).total).toBe(2);

    const again = await agent.call("create_link", {
      links: [{ name: "The theme", parts: [{ on: `/doc/${doc.slug}`, quote: "Participation is the theme", version }] }, {
        parts: [
          { on: `/doc/${doc.slug}`, quote: "Original participation came first", version },
          { on: `/pdf/${file.slug}`, quote: "Final participation", page: 2 },
        ],
      }],
    });
    expect(again.error.code).toBe("already_done");
  } finally {
    await deleteTestDoc(doc.id);
    await deleteTestFile(file.id);
    await agent.dispose();
    await reader.dispose();
  }
});

test("add_link_parts and edit_link: the creator's alone, by part number, keeping the last part", async ({ request }) => {
  const agent = await createAgent(request);
  const other = await createAgent(request);
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Alpha one. Beta two. Gamma three." });
  try {
    const minted = await agent.call("create_link", { links: [{ parts: [{ on: `/doc/${doc.slug}`, quote: "Alpha one" }] }] });
    const url = (minted.result.links as { url: string }[])[0].url;

    const added = await agent.call("add_link_parts", { link: url, parts: [{ on: doc.id, quote: "Beta two" }, { on: doc.id, quote: "Gamma three" }] });
    expect(added.result).toEqual({ url, parts: 3 });
    expect((await other.call("add_link_parts", { link: url, parts: [{ on: doc.id, quote: "Beta two" }] })).error.code).toBe("not_found");

    const reordered = await agent.call("edit_link", { link: url, order: [3, 1, 2], name: "Greek" });
    expect(reordered.result).toMatchObject({ changed: ["order", "name"], parts: 3 });
    const read = (await agent.call("read", { url })).result as LinkRead & { name: string };
    expect(read.name).toBe("Greek");
    expect(read.groups[0].parts.map((p) => p.quote)).toEqual(["Gamma three", "Alpha one", "Beta two"]);

    const removed = await agent.call("edit_link", { link: url, remove: [1, 2] });
    expect(removed.result.parts).toBe(1);
    expect((await agent.call("edit_link", { link: url, remove: [1] })).error.code).toBe("invalid");
    expect((await agent.call("edit_link", { link: url, order: [1, 2] })).error.code).toBe("invalid");
    expect((await other.call("edit_link", { link: url, name: "Mine" })).error.code).toBe("forbidden");
  } finally {
    await deleteTestDoc(doc.id);
    await agent.dispose();
    await other.dispose();
  }
});

test("tag and untag: minted by name, applied once, refused on a published post, and an annotation by its id", async ({ request }) => {
  const agent = await createAgent(request);
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Something to tag." });
  const note = await createTestAnnotation({ docId: doc.id, authorEmail: ADMIN_EMAIL, bodyText: "A note to tag." });
  const published = await createTestPost({ authorEmail: ADMIN_EMAIL, publish: true });
  const draft = await createTestPost({ authorEmail: agent.user.email });
  const term = uniqueTitle("term");
  const slugs: string[] = [];
  try {
    const tagged = await agent.call("tag", { target: `/doc/${doc.slug}`, tags: [term] });
    expect(tagged.isError, JSON.stringify(tagged.error)).toBe(false);
    const [applied] = tagged.result.applied as { name: string; url: string; new?: true }[];
    expect(applied).toMatchObject({ name: term, new: true });
    slugs.push(applied.url.replace("/tag/", ""));
    expect(tagged.result.tags).toEqual([{ name: term, slug: slugs[0] }]);

    // By another case: the same term, already this agent's on this doc.
    const again = await agent.call("tag", { target: `/doc/${doc.slug}`, tags: [term.toUpperCase()] });
    expect(again.result).toMatchObject({ applied: [], alreadyYours: [term] });

    expect((await agent.call("tag", { target: note.id, tags: [term] })).isError).toBe(false);
    expect((await agent.call("tag", { target: `/post/${draft.id}/edit`, tags: [term] })).isError).toBe(false);
    const publicPost = await agent.call("tag", { target: published.path!, tags: [term] });
    expect(publicPost.error.code).toBe("forbidden");

    const facts = await getTagFacts(slugs[0]);
    expect(facts!.targets.map((t) => t.kind).sort()).toEqual(["annotation", "doc", "post"]);

    const untagged = await agent.call("untag", { target: `/doc/${doc.slug}`, tags: [slugs[0], "E2E no such term"] });
    expect(untagged.error.code).toBe("not_found");
    const removed = await agent.call("untag", { target: `/doc/${doc.slug}`, tags: [slugs[0]] });
    expect(removed.result).toMatchObject({ removed: [term], tags: [] });
    expect((await agent.call("untag", { target: `/doc/${doc.slug}`, tags: [term] })).result.notTagged).toEqual([term]);
    expect((await agent.call("untag", { target: note.id, tags: [term], anyone: true })).error.code).toBe("forbidden");
  } finally {
    for (const slug of slugs) await deleteTestTag(slug);
    await deleteTestPost(published.id);
    await deleteTestPost(draft.id);
    await deleteTestDoc(doc.id);
    await agent.dispose();
  }
});
