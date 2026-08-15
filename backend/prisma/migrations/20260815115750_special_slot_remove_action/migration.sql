-- CreateEnum
CREATE TYPE "SpecialSlotAction" AS ENUM ('ADD', 'REMOVE');

-- AlterTable
ALTER TABLE "SpecialSlot" ADD COLUMN     "action" "SpecialSlotAction" NOT NULL DEFAULT 'ADD';
