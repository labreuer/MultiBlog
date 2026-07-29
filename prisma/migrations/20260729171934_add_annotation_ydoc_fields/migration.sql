-- CreateEnum
CREATE TYPE "annotation_status" AS ENUM ('DRAFT', 'LIVE', 'RAISED');

-- AlterTable
ALTER TABLE "annotation" ADD COLUMN     "body_text" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "prose_json" JSONB,
ADD COLUMN     "raised_at" TIMESTAMP(3),
ADD COLUMN     "status" "annotation_status" NOT NULL DEFAULT 'DRAFT';
