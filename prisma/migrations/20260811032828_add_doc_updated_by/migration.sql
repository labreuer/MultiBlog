-- AlterTable
ALTER TABLE "doc" ADD COLUMN     "updated_by_user_id" TEXT;

-- AddForeignKey
ALTER TABLE "doc" ADD CONSTRAINT "doc_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
