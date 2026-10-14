-- Hand-written: no schema.prisma change, a backfill and a CHECK (Prisma has
-- no CHECK DSL). docs/MCP.md §21, "The bearer check, on v2's terms".

-- SDK v2's bearer check refuses a token whose verifier reports no expiry, so
-- every token issued without one gets a year from now: none already issued
-- is refused when the check ships. Revoked rows too, so the CHECK below holds
-- for every row.
UPDATE "api_token"
SET "expires_at" = now() + interval '365 days'
WHERE "token_hash" IS NOT NULL AND "expires_at" IS NULL;

-- Every header token expires. A row without a hash of its own — an OAuth
-- connection, from §21's thin slice on — has no expiry either, since each of
-- its access tokens carries one.
ALTER TABLE "api_token"
  ADD CONSTRAINT "api_token_header_token_expires_check"
  CHECK ("token_hash" IS NULL OR "expires_at" IS NOT NULL);
