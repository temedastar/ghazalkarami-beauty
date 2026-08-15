-- AlterTable
ALTER TABLE "ContactInfo" ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "refundCardHolder" TEXT,
ADD COLUMN     "refundCardNumber" TEXT;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "ownerNotifyPhone" TEXT;

-- CreateTable
CREATE TABLE "SpecialSlot" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "time" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "categoryId" TEXT NOT NULL,
    "serviceId" TEXT,

    CONSTRAINT "SpecialSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpecialSlot_categoryId_date_time_key" ON "SpecialSlot"("categoryId", "date", "time");

-- AddForeignKey
ALTER TABLE "SpecialSlot" ADD CONSTRAINT "SpecialSlot_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialSlot" ADD CONSTRAINT "SpecialSlot_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
