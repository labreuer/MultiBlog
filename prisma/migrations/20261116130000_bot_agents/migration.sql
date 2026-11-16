-- CreateEnum
CREATE TYPE "agent" AS ENUM ('CLAUDE', 'CHATGPT', 'ANTIGRAVITY');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "agent" "agent",
ADD COLUMN     "mcp_allowed" BOOLEAN NOT NULL DEFAULT true;

-- Hand-written from here: a partial index and a CHECK, which Prisma has no
-- DSL for. docs/MCP.md §21, "A bot's agent".

-- One live bot per agent per person. It is what makes two approvals at once
-- end with one bot: a check in code alone has a gap between its read and its
-- insert. Live is `deleted_by_user_id IS NULL`, the column every read of
-- `user` filters on (src/lib/prisma.ts), so the index and those reads can't
-- disagree about a bot. A deleted bot holds no agent, and neither does one
-- whose person was hard-deleted: `works_for_user_id` goes null, and Postgres
-- counts nulls as distinct.
CREATE UNIQUE INDEX "user_agent_per_person_key"
  ON "user" ("works_for_user_id", "agent")
  WHERE "agent" IS NOT NULL AND "deleted_by_user_id" IS NULL;

-- No account with a password has an agent. A bot whose person was
-- hard-deleted works for no one, so `user_bot_has_no_password_check` no
-- longer stops it gaining a password; this does, and it survives that delete,
-- which changes neither column. There is deliberately no CHECK that only a
-- bot has an agent: `works_for_user_id` is ON DELETE SET NULL, so one would
-- refuse the hard delete of any person with such a bot.
ALTER TABLE "user"
  ADD CONSTRAINT "user_agent_has_no_password_check"
  CHECK ("agent" IS NULL OR "password_hash" IS NULL);
