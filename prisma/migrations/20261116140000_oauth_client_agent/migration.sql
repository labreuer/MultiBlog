-- AlterTable
ALTER TABLE "oauth_client" ADD COLUMN     "agent" "agent";

-- Hand-written from here. docs/MCP.md §21, "Which agent a client is".

-- The clients already registered take their agent from their kind, as one
-- registered without --agent does: a claude-ai client is claude.ai's fallback
-- and a chatgpt one ChatGPT's. An `other` stays with none.
UPDATE "oauth_client" SET "agent" = 'CLAUDE' WHERE "client" = 'CLAUDE_AI';
UPDATE "oauth_client" SET "agent" = 'CHATGPT' WHERE "client" = 'CHATGPT';
