-- AlterEnum
--
-- docs/WIKI.md "Data model" — a migration of its own: a value added to an
-- enum can't be used in the transaction that adds it, and wiki_pages' CHECKs
-- name 'PUBLIC'.
ALTER TYPE "doc_visibility" ADD VALUE 'PUBLIC';
