import { z } from "zod";
import { setFileTitle } from "@/lib/file-manage";
import { defineTool, objectRef } from "../tool";
import { readableFile } from "../resolve";

// docs/MCP.md §8, §15 — edit_file: a file's title, the one thing about a file
// a write changes, since its bytes are its identity. A title keeps no history,
// so every call prompts.

export const editFileTool = defineTool({
  name: "edit_file",
  scope: "WRITE",
  description: "Retitle a file you own (a PDF or .docx). A file's bytes never change; its title keeps no history, so each call prompts the person.",
  input: z.strictObject({
    file: objectRef.describe("The file: /pdf/<slug>, /files/<slug> or its id."),
    title: z.string().min(1).max(500),
  }),
  output: z.looseObject({ url: z.string(), title: z.string() }),
  readOnly: false,
  destructive: true,
  forcePrompt: true,
  searchHint: "file pdf title rename retitle",
  async run(args, ctx) {
    const file = await readableFile(ctx.actor, args.file);
    const title = await setFileTitle(ctx.actor, file.id, args.title);
    return { url: `/${file.pageCount !== null ? "pdf" : "files"}/${file.slug}`, title } as never;
  },
});
