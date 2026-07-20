/*
  Warnings:

  - Made the column `adminInitials` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "User" ALTER COLUMN "adminInitials" SET NOT NULL;
