-- Lets a TimeSlot be scoped to one specific service instead of the whole
-- category — e.g. کراتینه only at 10:00, پروتئین‌تراپی only at 15:00,
-- within the same shared "chem" timeline. NULL (every existing row) keeps
-- meaning exactly what it always did: offered to every service in the
-- category. SlotHold (the thing that actually enforces the shared-line
-- conflict) stays keyed on categoryId only — this column only changes
-- which services a given time is ever offered to, not how conflicts
-- between them are resolved.
-- AlterTable
ALTER TABLE "TimeSlot" ADD COLUMN     "serviceId" TEXT;

-- AddForeignKey
ALTER TABLE "TimeSlot" ADD CONSTRAINT "TimeSlot_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
