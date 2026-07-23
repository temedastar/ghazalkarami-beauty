-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('NOT_APPLICABLE', 'NEEDS_MANUAL_FOLLOWUP', 'SUCCEEDED');

-- AlterEnum
ALTER TYPE "SmsType" ADD VALUE 'REFUND';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "cancelledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "refundNote" TEXT,
ADD COLUMN     "refundStatus" "RefundStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
ADD COLUMN     "refundedAt" TIMESTAMP(3);
