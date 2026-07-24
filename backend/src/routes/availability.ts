import { Router } from "express";
import { prisma } from "../lib/prisma";
import { parseDateOnly, dayOfWeekUTC, isPastDate } from "../lib/dates";
import { getDayOpenInfo, isTimeAllowed } from "../lib/schedule";

const router = Router();

router.get("/", async (req, res) => {
  const categoryKey = typeof req.query.categoryKey === "string" ? req.query.categoryKey : "";
  const dateStr = typeof req.query.date === "string" ? req.query.date : "";

  const category = await prisma.serviceCategory.findUnique({ where: { key: categoryKey } });
  if (!category) return res.status(404).json({ error: "دسته‌بندی خدمت یافت نشد." });

  const date = parseDateOnly(dateStr);
  if (!date) return res.status(400).json({ error: "تاریخ نامعتبر است." });
  if (isPastDate(date)) return res.json({ dayOpen: false, slots: [] });

  const dayInfo = await getDayOpenInfo(date);
  if (!dayInfo.open) return res.json({ dayOpen: false, slots: [] });

  const dow = dayOfWeekUTC(date);
  // chronological order by time, not sortOrder — sortOrder only reflects
  // generation sequence for slots created together via the bulk generator
  // (POST /admin/time-slots/generate), and defaults to 0 for anything added
  // individually (POST /admin/time-slots, the admin panel's "+ افزودن اسلات"
  // button), so a mix of the two sorted scrambled instead of by actual time.
  // "time" is always a zero-padded "HH:MM" string, so a plain string sort
  // is already correct chronological order — no parsing needed.
  const timeSlots = await prisma.timeSlot.findMany({
    where: { categoryId: category.id, dayOfWeek: dow, isActive: true },
    orderBy: { time: "asc" },
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

  const slots = timeSlots
    .filter((s) => isTimeAllowed(s.time, dayInfo))
    .map((s) => ({ time: s.time, available: !takenTimes.has(s.time) }));
  res.json({ dayOpen: true, slots });
});

export default router;
