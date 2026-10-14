import type { McpTool } from "../tool";
import { searchTool } from "./search";
import { readTool } from "./read";
import { findTagsTool, findUsersTool } from "./lookup";
import { downloadTool, uploadTool } from "./urls";
import { createDocTool, editDocTool } from "./docs";
import { manageTool } from "./manage";
import { addNoteTool, editNoteTool } from "./annotations";
import { createLinkTool, editLinkTool, extendLinkTool } from "./links";
import { tagTool, untagTool } from "./tags";
import { renameFileTool } from "./files";

// docs/MCP.md §15 — every tool, in the order a client lists them. The server
// (../server.ts) shows a token only the ones its scopes and client allow.
export const TOOLS: McpTool[] = [
  searchTool,
  readTool,
  findUsersTool,
  findTagsTool,
  downloadTool,
  uploadTool,
  createDocTool,
  editDocTool,
  renameFileTool,
  addNoteTool,
  editNoteTool,
  createLinkTool,
  extendLinkTool,
  editLinkTool,
  tagTool,
  untagTool,
  manageTool,
];
