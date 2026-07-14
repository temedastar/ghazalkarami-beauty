-- DropIndex
DROP INDEX "Booking_categoryId_date_time_key";

-- CreateTable
CREATE TABLE "SlotHold" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "time" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlotHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SlotHold_bookingId_key" ON "SlotHold"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "SlotHold_categoryId_date_time_key" ON "SlotHold"("categoryId", "date", "time");

-- CreateIndex
CREATE INDEX "Booking_categoryId_date_time_idx" ON "Booking"("categoryId", "date", "time");

-- AddForeignKey
ALTER TABLE "SlotHold" ADD CONSTRAINT "SlotHold_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
