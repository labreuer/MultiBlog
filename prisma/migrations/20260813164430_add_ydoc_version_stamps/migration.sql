-- AlterTable
ALTER TABLE "annotation" ADD COLUMN     "prose_json_update_id" BIGINT;

-- AlterTable
ALTER TABLE "doc" ADD COLUMN     "prose_json_update_id" BIGINT;

-- AlterTable
ALTER TABLE "ydoc" ADD COLUMN     "last_update_id" BIGINT;
