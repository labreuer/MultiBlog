import type { McpTool } from "../tool";
import { searchTool } from "./search";
import { readTool } from "./read";
import { findTagsTool, findUsersTool } from "./lookup";
import { downloadUrlTool, uploadUrlTool } from "./urls";
import { createDocTool, editDocTool } from "./docs";
import { manageTool } from "./manage";
import { annotateTool, editAnnotationTool } from "./annotations";
import { addLinkPartsTool, createLinkTool, editLinkTool } from "./links";
import { tagTool, untagTool } from "./tags";
import { editFileTool } from "./files";

// docs/MCP.md §15 — every tool, in the order a client lists them. The server
// (../server.ts) shows a token only the ones its scopes and client allow.
export const TOOLS: McpTool[] = [
  searchTool,
  readTool,
  findUsersTool,
  findTagsTool,
  downloadUrlTool,
  uploadUrlTool,
  createDocTool,
  editDocTool,
  editFileTool,
  annotateTool,
  editAnnotationTool,
  createLinkTool,
  addLinkPartsTool,
  editLinkTool,
  tagTool,
  untagTool,
  manageTool,
];
