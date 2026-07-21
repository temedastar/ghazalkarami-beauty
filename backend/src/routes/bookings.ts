import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { parseDateOnly, dayOfWeekUTC, isPastDate } from "../lib/dates";
import { getDayOpenInfo, isTimeAllowed, computeDepositAmount } from "../lib/schedule";

const router = Router();

const HOLD_MINUTES = 15;

const createSchema = z.object({
  serviceKey: z.string(),
  date: z.string(),
  time: z.string(),
  note: z.string().max(300).optional(),
});

router.post("/", requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const date = parseDateOnly(parsed.data.date);
  if (!date) return res.status(400).json({ error: "تاریخ نامعتبر است." });
  if (isPastDate(date)) return res.status(400).json({ error: "تاریخ گذشته قابل انتخاب نیست." });

  // service lookup and the open-day check don't depend on each other — run
  // them concurrently instead of paying for both round-trips in sequence
  const [service, dayInfo] = await Promise.all([
    prisma.service.findUnique({ where: { key: parsed.data.serviceKey }, include: { category: true } }),
    getDayOpenInfo(date),
  ]);
  if (!service || !service.active) return res.status(404).json({ error: "سرویس یافت نشد." });
  if (!service.allowOnlineBooking) {
    return res.status(400).json({
      error: "این سرویس فقط با هماهنگی مستقیم قابل رزرو است.",
    });
  }
  if (!dayInfo.open) return res.status(400).json({ error: "سالن در این روز تعطیل است." });

  const dow = dayOfWeekUTC(date);
  const timeSlot = await prisma.timeSlot.findFirst({
    where: {
      categoryId: service.categoryId,
      dayOfWeek: dow,
      time: parsed.data.time,
      isActive: true,
    },
  });
  if (!timeSlot || !isTimeAllowed(timeSlot.time, dayInfo)) {
    return res.status(400).json({ error: "ساعت انتخابی معتبر نیست." });
  }

  const depositAmount = await computeDepositAmount(service);

  try {
    const booking = await prisma.$transaction(async (tx) => {
      // release a stale hold for this exact slot before checking availability
      const expiredHold = await tx.slotHold.findUnique({
        where: {
          categoryId_date_time: { categoryId: service.categoryId, date, time: parsed.data.time },
        },
        include: { booking: true },
      });
      if (
        expiredHold &&
        expiredHold.booking.status === "PENDING_PAYMENT" &&
        expiredHold.booking.holdExpiresAt &&
        expiredHold.booking.holdExpiresAt < new Date()
      ) {
        await tx.booking.update({
          where: { id: expiredHold.bookingId },
          data: { status: "EXPIRED" },
        });
        await tx.slotHold.delete({ where: { id: expiredHold.id } });
      }

      const created = await tx.booking.create({
        data: {
          userId: req.auth!.userId,
          serviceId: service.id,
          categoryId: service.categoryId,
          date,
          time: parsed.data.time,
          depositAmount,
          customerNote: parsed.data.note,
          holdExpiresAt: new Date(Date.now() + HOLD_MINUTES * 60 * 1000),
        },
      });

      await tx.slotHold.create({
        data: {
          categoryId: service.categoryId,
          date,
          time: parsed.data.time,
          bookingId: created.id,
        },
      });

      return created;
    });

    res.status(201).json({ booking });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "این زمان لحظاتی پیش توسط شخص دیگری رزرو شد. لطفاً زمان دیگری انتخاب کنید." });
    }
    throw err;
  }
});

router.get("/mine", requireAuth, async (req, res) => {
  const bookings = await prisma.booking.findMany({
    where: { userId: req.auth!.userId },
    include: { service: true, category: true, payment: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ bookings });
});

router.delete("/:id", requireAuth, async (req, res) => {
  const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
  if (!booking) return res.status(404).json({ error: "رزرو یافت نشد." });
  if (booking.userId !== req.auth!.userId && req.auth!.role !== "ADMIN") {
    return res.status(403).json({ error: "دسترسی غیرمجاز." });
  }
  if (booking.status === "CONFIRMED" || booking.status === "COMPLETED") {
    return res.status(400).json({
      error: "این رزرو تایید شده است؛ برای لغو با سالن تماس بگیرید.",
    });
  }

  await prisma.$transaction([
    prisma.slotHold.deleteMany({ where: { bookingId: booking.id } }),
    prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } }),
  ]);

  res.json({ ok: true });
});

export default router;
