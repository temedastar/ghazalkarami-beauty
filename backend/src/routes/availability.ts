import { Router } from "express";
import { prisma } from "../lib/prisma";
import { parseDateOnly, dayOfWeekUTC, isPastDate } from "../lib/dates";

const router = Router();

router.get("/", async (req, res) => {
  const categoryKey = typeof req.query.categoryKey === "string" ? req.query.categoryKey : "";
  const dateStr = typeof req.query.date === "string" ? req.query.date : "";

  const category = await prisma.serviceCategory.findUnique({ where: { key: categoryKey } });
  if (!category) return res.status(404).json({ error: "دسته‌بندی خدمت یافت نشد." });

  if (!category.allowOnlineBooking) {
    return res.json({ onlineBooking: false, slots: [] });
  }

  const date = parseDateOnly(dateStr);
  if (!date) return res.status(400).json({ error: "تاریخ نامعتبر است." });
  if (isPastDate(date)) return res.json({ onlineBooking: true, slots: [] });

  const dow = dayOfWeekUTC(date);
  if (dow === 6) return res.json({ onlineBooking: true, slots: [] }); // Saturday: always closed
  if (dow === 5 && !category.fridayAvailable) {
    return res.json({ onlineBooking: true, slots: [] });
  }

  const workingDay = await prisma.workingDay.findUnique({ where: { dayOfWeek: dow } });
  if (workingDay && !workingDay.isOpen) {
    return res.json({ onlineBooking: true, slots: [] });
  }

  const timeSlots = await prisma.timeSlot.findMany({
    where: { categoryId: category.id, dayOfWeek: dow, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { time: "asc" }],
  });

  // release any holds whose payment window has expired, so they show as free again
  await prisma.booking.updateMany({
    where: {
      categoryId: category.id,
      date,
      status: "PENDING_PAYMENT",
      holdExpiresAt: { lt: new Date() },
    },
    data: { status: "EXPIRED" },
  });
  await prisma.slotHold.deleteMany({
    where: { categoryId: category.id, date, booking: { status: "EXPIRED" } },
  });

  const holds = await prisma.slotHold.findMany({
    where: { categoryId: category.id, date },
    select: { time: true },
  });
  const takenTimes = new Set(holds.map((h) => h.time));

  const slots = timeSlots.map((s) => ({ time: s.time, available: !takenTimes.has(s.time) }));
  res.json({ onlineBooking: true, slots });
});

export default router;
