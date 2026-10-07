import type { McpTool } from "../tool";
import { searchTool } from "./search";
import { readTool } from "./read";
import { findTagsTool, findUsersTool } from "./lookup";
import { downloadUrlTool, uploadUrlTool } from "./urls";
import { createDocTool, editDocTool } from "./docs";
import { manageTool } from "./manage";
import { annotateTool, editAnnotationTool } from "./annotations";

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
  annotateTool,
  editAnnotationTool,
  manageTool,
];
