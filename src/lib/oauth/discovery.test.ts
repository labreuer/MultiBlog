import { test } from "node:test";
import assert from "node:assert/strict";
import { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/core";
import { buildOAuthProtectedResourceMetadata } from "@modelcontextprotocol/server";
import { authorizationServerMetadata, issuer, mcpEndpointUrl, metadataOptions, resourceMetadataUrl } from "./discovery";

// docs/MCP.md §21, "Discovery" — one issuer string everywhere, and both
// documents as SDK v2's own schemas read them.

function withAppUrl(value: string, run: () => void): void {
  const before = process.env.APP_URL;
  process.env.APP_URL = value;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = before;
  }
}

test("the issuer is APP_URL's origin exactly, with no trailing slash", () => {
  withAppUrl("https://multiblog.example", () => {
    assert.equal(issuer(), "https://multiblog.example");
    assert.equal(mcpEndpointUrl().href, "https://multiblog.example/api/mcp");
    assert.equal(resourceMetadataUrl(), "https://multiblog.example/.well-known/oauth-protected-resource/api/mcp");
  });
  withAppUrl("https://multiblog.example/", () => assert.equal(issuer(), "https://multiblog.example"));
});

test("the authorization server's metadata parses, names the issuer and lists what it offers", () => {
  withAppUrl("https://multiblog.example", () => {
    const metadata = OAuthMetadataSchema.parse(authorizationServerMetadata());
    assert.equal(metadata.issuer, "https://multiblog.example");
    assert.equal(metadata.authorization_endpoint, "https://multiblog.example/authorize");
    assert.equal(metadata.token_endpoint, "https://multiblog.example/token");
    assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
    // offline_access here and nowhere else, as the spec asks.
    assert.deepEqual(metadata.scopes_supported, ["read", "write", "offline_access"]);
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
    assert.equal(metadata.registration_endpoint, undefined);
  });
});

test("the endpoint's metadata names it and the issuer, and an http issuer is allowed only by name", () => {
  withAppUrl("https://multiblog.example", () => {
    const options = metadataOptions();
    assert.equal(options.dangerouslyAllowInsecureIssuerUrl, false);
    const resource = OAuthProtectedResourceMetadataSchema.parse(buildOAuthProtectedResourceMetadata(options));
    assert.equal(resource.resource, "https://multiblog.example/api/mcp");
    assert.deepEqual(resource.authorization_servers, ["https://multiblog.example"]);
    assert.deepEqual(resource.scopes_supported, ["read", "write"]);
  });
  // A dev slot's host is http and not localhost, which v2 refuses unless told.
  withAppUrl("http://c.localhost:3010", () => {
    assert.equal(metadataOptions().dangerouslyAllowInsecureIssuerUrl, true);
    assert.doesNotThrow(() => buildOAuthProtectedResourceMetadata(metadataOptions()));
  });
});
