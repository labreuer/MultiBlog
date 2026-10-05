-- A signed-in commenter with no name used to get their email as the display
-- name their comments show the public, fixed when the commenter row is made.
-- New rows take displayNameOf (src/lib/display-name.ts) instead; this
-- rewrites the rows that already hold their account's email, to the
-- account's name where it now has one and to the same fixed label otherwise.
UPDATE "commenter" AS c
SET "display_name" = COALESCE(NULLIF(btrim(u."name"), ''), 'Anonymous')
FROM "user" AS u
WHERE u."id" = c."user_id"
  AND c."display_name" = u."email";
