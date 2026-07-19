/*
  Warnings:

  - You are about to drop the column `depositAmount` on the `Service` table. All the data in the column will be lost.
  - You are about to drop the column `allowOnlineBooking` on the `ServiceCategory` table. All the data in the column will be lost.
  - You are about to drop the column `fridayAvailable` on the `ServiceCategory` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('ONLINE', 'ADMIN_MANUAL', 'ADMIN_BLOCK');

-- CreateEnum
CREATE TYPE "DepositType" AS ENUM ('FIXED', 'PERCENT');

-- CreateEnum
CREATE TYPE "SmsType" AS ENUM ('OTP', 'BOOKING_CONFIRM', 'REMINDER', 'THANK_YOU_REVIEW');

-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('SUCCESS', 'FAILED', 'DEV');

-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'NO_SHOW';

-- DropForeignKey
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_serviceId_fkey";

-- DropForeignKey
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_userId_fkey";

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "blockReason" TEXT,
ADD COLUMN     "source" "BookingSource" NOT NULL DEFAULT 'ONLINE',
ALTER COLUMN "depositAmount" SET DEFAULT 0,
ALTER COLUMN "userId" DROP NOT NULL,
ALTER COLUMN "serviceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Service" DROP COLUMN "depositAmount",
ADD COLUMN     "allowOnlineBooking" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "depositType" "DepositType" NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "depositValue" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "durationMin" INTEGER;

-- AlterTable
ALTER TABLE "ServiceCategory" DROP COLUMN "allowOnlineBooking",
DROP COLUMN "fridayAvailable";

-- CreateTable
CREATE TABLE "DayException" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "isOpen" BOOLEAN NOT NULL,
    "openTime" TEXT,
    "closeTime" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DayException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "reminderHoursBefore" INTEGER NOT NULL DEFAULT 24,
    "defaultDepositType" "DepositType" NOT NULL DEFAULT 'FIXED',
    "defaultDepositValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteContent" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteContent_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ContactInfo" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "phone" TEXT,
    "whatsapp" TEXT,
    "instagram" TEXT,
    "telegram" TEXT,
    "baleh" TEXT,
    "address" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactInfo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsLog" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "type" "SmsType" NOT NULL,
    "status" "SmsStatus" NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DayException_date_key" ON "DayException"("date");

-- CreateIndex
CREATE INDEX "SmsLog_createdAt_idx" ON "SmsLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
