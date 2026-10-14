import { test } from "node:test";
import assert from "node:assert/strict";
import { namesEndpoint } from "./resource";

// docs/MCP.md §21, Testing — the canonical resource (RFC 8707).

const ENDPOINT = new URL("https://multiblog.example/api/mcp");

test("the endpoint's URL names it, written any way URL canonicalizes", () => {
  for (const value of [
    "https://multiblog.example/api/mcp",
    "https://multiblog.example/api/mcp/",
    "HTTPS://MultiBlog.Example/api/mcp",
    "https://multiblog.example:443/api/mcp",
    "https://multiblog.example/api/mcp?",
  ]) {
    assert.equal(namesEndpoint(value, ENDPOINT), true, value);
  }
});

test("anything else doesn't", () => {
  for (const value of [
    // A fragment is refused, never stripped.
    "https://multiblog.example/api/mcp#x",
    "https://multiblog.example/api/mcp#",
    // A query: the header trial's second connector, /api/mcp?probe=1.
    "https://multiblog.example/api/mcp?probe=1",
    "https://multiblog.example/api/mcp/read",
    "https://multiblog.example/api/MCP",
    "https://multiblog.example/",
    "http://multiblog.example/api/mcp",
    "https://multiblog.example:8443/api/mcp",
    "https://evil.example/api/mcp",
    "https://user@multiblog.example/api/mcp",
    "/api/mcp",
    "not a url",
  ]) {
    assert.equal(namesEndpoint(value, ENDPOINT), false, value);
  }
});
