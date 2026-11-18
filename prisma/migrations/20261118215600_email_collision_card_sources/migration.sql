-- docs/COMMENTS.md, "The log": the two sources a join card adds
-- (docs/EMAIL.md §10). In a migration of their own, since a value added to an
-- enum can't be used in the transaction that adds it.
ALTER TYPE "email_collision_source" ADD VALUE 'CARD_CLAIM';
ALTER TYPE "email_collision_source" ADD VALUE 'CARD_CONFIRM';
