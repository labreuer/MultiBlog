import type { McpTool } from "../tool";
import { searchTool } from "./search";
import { findTagsTool, findUsersTool } from "./lookup";

// docs/MCP.md §15 — every tool, in the order a client lists them. The server
// (../server.ts) shows a token only the ones its scopes and client allow.
export const TOOLS: McpTool[] = [
  searchTool,
  findUsersTool,
  findTagsTool,
];
