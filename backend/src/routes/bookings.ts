import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { parseDateOnly, dayOfWeekUTC, isPastDate } from "../lib/dates";
import { getDayOpenInfo, isTimeAllowed, isSlotTooSoon, computeDepositAmount } from "../lib/schedule";
import { cancelBookingAndMaybeRefund, validateRefundCard } from "../services/bookingCancellation";
import { isRefundEligible } from "../lib/cancellationPolicy";
import { customerActorLabel } from "../lib/auditLog";
import { env } from "../lib/env";

const router = Router();

const HOLD_MINUTES = 15;

// each successful create holds a real slot for 15 minutes — without a
// limit, one authenticated account could loop over every open slot in a
// day/week and grief every other customer's availability, well within a
// single hold window
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.rateLimits.bookingCreatePer15Min,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "تعداد درخواست رزرو زیاد بوده، کمی بعد دوباره تلاش کنید." },
});

const createSchema = z.object({
  serviceKey: z.string(),
  date: z.string(),
  time: z.string(),
  note: z.string().max(300).optional(),
  womenOnlyConfirmed: z.boolean().optional(),
});

router.post("/", createLimiter, requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  // the frontend checkbox disables the submit button until this is checked,
  // but that's only ever a suggestion — a direct API call bypassing the UI
  // must be rejected here too, with a specific enough message that it can't
  // be mistaken for a generic validation failure
  if (!parsed.data.womenOnlyConfirmed) {
    return res.status(400).json({
      error: "برای ثبت رزرو لازم است تایید کنید که این سالن مخصوص بانوان است.",
    });
  }

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
  // isPastDate() above only rejects a past calendar day — it says nothing
  // about a same-day slot whose start time (or the required lead time
  // before it) has already gone by. Checked here, not just filtered out of
  // GET /availability, since the frontend list is only ever a suggestion —
  // this is the actual point of no return for creating the booking.
  if (isSlotTooSoon(date, timeSlot.time)) {
    return res.status(400).json({ error: "این ساعت گذشته یا خیلی نزدیک است — لطفاً ساعت دیگری انتخاب کنید." });
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
          // parsed.data.womenOnlyConfirmed was already required to be true above
          womenOnlyConfirmedAt: new Date(),
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
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { payment: true, user: true, service: true },
  });
  if (!booking) return res.status(404).json({ error: "رزرو یافت نشد." });
  if (booking.userId !== req.auth!.userId && req.auth!.role !== "ADMIN") {
    return res.status(403).json({ error: "دسترسی غیرمجاز." });
  }
  if (booking.status === "COMPLETED") {
    return res.status(400).json({ error: "این رزرو قبلاً انجام شده است." });
  }
  if (["CANCELLED", "EXPIRED", "NO_SHOW"].includes(booking.status)) {
    return res.status(400).json({ error: "این رزرو قبلاً لغو یا منقضی شده است." });
  }

  // ZarinPal's refund API via Shaparak is permanently disabled — every
  // eligible refund is now a manual card-to-card transfer, so the card
  // details have to be collected up front, before the booking is actually
  // cancelled below (see services/bookingCancellation.ts).
  const hadPaidDeposit = booking.status === "CONFIRMED" && booking.payment?.status === "PAID";
  const eligible = hadPaidDeposit && isRefundEligible(booking.date, booking.time);
  let refundCard: { number: string; holder: string } | undefined;
  if (eligible) {
    const validated = validateRefundCard(req.body);
    if (!validated.ok) return res.status(400).json({ error: validated.error });
    refundCard = validated.card;
  }

  // this route is customer self-service — the admin.role branch above only
  // exists so an admin acting on a customer's behalf (over the phone) isn't
  // blocked by the ownership check, not because this is the panel's own
  // cancel flow (that's PATCH /admin/bookings/:id/status instead)
  const actorLabel = booking.userId === req.auth!.userId ? customerActorLabel(booking.user) : "ادمین (از طرف مشتری)";
  const result = await cancelBookingAndMaybeRefund(booking, refundCard, actorLabel);
  res.json({ ok: true, refund: result.refund, message: result.message });
});

export default router;
