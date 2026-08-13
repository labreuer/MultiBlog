-- AlterTable
ALTER TABLE "annotation" ADD COLUMN     "anchor_from" INTEGER,
ADD COLUMN     "anchor_to" INTEGER,
ADD COLUMN     "quoted_text" TEXT NOT NULL DEFAULT '';
