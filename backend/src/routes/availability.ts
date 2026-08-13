import { Router } from "express";
import { prisma } from "../lib/prisma";
import { parseDateOnly, dayOfWeekUTC, isPastDate, todayInTehran, toDateOnlyString } from "../lib/dates";
import { getDayOpenInfo, isTimeAllowed, isSlotTooSoon, DayOpenInfo } from "../lib/schedule";

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

  // a same-day slot that's already started (or is about to, within
  // BOOKING_LEAD_MINUTES) still shows up in the list — the frontend renders
  // it disabled/struck-through with a "this time has passed" message on
  // click, rather than silently vanishing — but it's never `available`, and
  // POST /api/bookings independently re-checks isSlotTooSoon() regardless
  // of what this endpoint returns, since the frontend list is only ever a
  // suggestion. isSlotTooSoon() is always false for a future date.
  const slots = timeSlots
    .filter((s) => isTimeAllowed(s.time, dayInfo))
    .map((s) => {
      const past = isSlotTooSoon(date, s.time);
      return { time: s.time, available: !past && !takenTimes.has(s.time), past };
    });
  res.json({ dayOpen: true, slots });
});

// "نزدیک‌ترین نوبت خالی" + the next handful after it — the same
// day-open/isTimeAllowed/isSlotTooSoon/SlotHold rules as the single-day
// endpoint above, just evaluated across a forward-looking window in one
// batch instead of one HTTP round-trip per candidate day (which is what a
// naive "call GET / in a loop from the frontend" would otherwise mean).
const NEXT_SLOTS_HORIZON_DAYS = 90;

router.get("/next", async (req, res) => {
  const categoryKey = typeof req.query.categoryKey === "string" ? req.query.categoryKey : "";
  const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 20);

  const category = await prisma.serviceCategory.findUnique({ where: { key: categoryKey } });
  if (!category) return res.status(404).json({ error: "دسته‌بندی خدمت یافت نشد." });

  const start = todayInTehran();
  const end = new Date(start.getTime() + (NEXT_SLOTS_HORIZON_DAYS - 1) * 86400000);

  const [timeSlots, exceptions, workingDays] = await Promise.all([
    prisma.timeSlot.findMany({ where: { categoryId: category.id, isActive: true }, orderBy: { time: "asc" } }),
    prisma.dayException.findMany({ where: { date: { gte: start, lte: end } } }),
    prisma.workingDay.findMany(),
  ]);
  if (!timeSlots.length) return res.json({ slots: [] });

  // same expired-hold cleanup the single-day endpoint does, batched across
  // the whole scanned range instead of one date at a time
  await prisma.booking.updateMany({
    where: { categoryId: category.id, date: { gte: start, lte: end }, status: "PENDING_PAYMENT", holdExpiresAt: { lt: new Date() } },
    data: { status: "EXPIRED" },
  });
  await prisma.slotHold.deleteMany({
    where: { categoryId: category.id, date: { gte: start, lte: end }, booking: { status: "EXPIRED" } },
  });

  const holds = await prisma.slotHold.findMany({
    where: { categoryId: category.id, date: { gte: start, lte: end } },
    select: { date: true, time: true },
  });
  const takenByDate = new Map<string, Set<string>>();
  for (const h of holds) {
    const key = toDateOnlyString(h.date);
    if (!takenByDate.has(key)) takenByDate.set(key, new Set());
    takenByDate.get(key)!.add(h.time);
  }

  const exceptionByDate = new Map<string, (typeof exceptions)[number]>();
  for (const e of exceptions) exceptionByDate.set(toDateOnlyString(e.date), e);

  const workingDayByDow = new Map<number, (typeof workingDays)[number]>();
  for (const w of workingDays) workingDayByDow.set(w.dayOfWeek, w);

  const slotsByDow = new Map<number, typeof timeSlots>();
  for (const s of timeSlots) {
    if (!slotsByDow.has(s.dayOfWeek)) slotsByDow.set(s.dayOfWeek, []);
    slotsByDow.get(s.dayOfWeek)!.push(s);
  }

  const results: { date: string; time: string }[] = [];
  for (let d = new Date(start); d <= end && results.length < limit; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = toDateOnlyString(d);
    const exception = exceptionByDate.get(dateStr);
    const workingDay = workingDayByDow.get(dayOfWeekUTC(d));
    const dayInfo: DayOpenInfo = exception
      ? { open: exception.isOpen, openTime: exception.openTime, closeTime: exception.closeTime }
      : { open: workingDay?.isOpen ?? false, openTime: null, closeTime: null };
    if (!dayInfo.open) continue;

    const taken = takenByDate.get(dateStr);
    const daySlots = (slotsByDow.get(dayOfWeekUTC(d)) || []).filter((s) => isTimeAllowed(s.time, dayInfo));
    for (const s of daySlots) {
      if (taken?.has(s.time)) continue;
      if (isSlotTooSoon(d, s.time)) continue;
      results.push({ date: dateStr, time: s.time });
      if (results.length >= limit) break;
    }
  }

  res.json({ slots: results });
});

export default router;
