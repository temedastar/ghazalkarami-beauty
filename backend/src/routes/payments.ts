import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { env } from "../lib/env";
import { createZarinpalPayment, verifyZarinpalPayment } from "../services/zarinpal";
import { requestZarinpalRefund } from "../services/zarinpalRefund";
import { sendBookingConfirmationSms, sendRefundSms } from "../services/kavenegar";
import { toJalaliDateLabel } from "../lib/dates";

const router = Router();

const requestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "درخواست‌های زیاد. کمی صبر کنید." },
});

// hit by ZarinPal's own redirect, not a form submit — a real customer only
// ever lands here once or twice per booking (initial + maybe a manual
// refresh), so this stays generous; it exists purely so a replay/guessing
// loop can't hammer the real ZarinPal verify API or the DB indefinitely
const callbackLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "درخواست‌های زیاد. کمی صبر کنید." },
});

const requestSchema = z.object({ bookingId: z.string() });

router.post("/zarinpal/request", requestLimiter, requireAuth, async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const booking = await prisma.booking.findUnique({
    where: { id: parsed.data.bookingId },
    include: { service: true, user: true, payment: true },
  });
  if (!booking || !booking.service || !booking.user) return res.status(404).json({ error: "رزرو یافت نشد." });
  if (booking.userId !== req.auth!.userId) return res.status(403).json({ error: "دسترسی غیرمجاز." });
  if (booking.status !== "PENDING_PAYMENT") {
    return res.status(400).json({ error: "این رزرو در وضعیت پرداخت نیست." });
  }
  if (booking.holdExpiresAt && booking.holdExpiresAt < new Date()) {
    return res.status(410).json({ error: "زمان نگه‌داری نوبت شما به پایان رسیده. دوباره رزرو کنید." });
  }

  const { authority, paymentUrl } = await createZarinpalPayment({
    amountToman: booking.depositAmount,
    description: `بیعانه رزرو ${booking.service.name} - غزل کرمی`,
    mobile: booking.user.phone,
    callbackUrl: `${env.zarinpal.callbackUrl}?bookingId=${booking.id}`,
  });

  await prisma.payment.upsert({
    where: { bookingId: booking.id },
    create: {
      bookingId: booking.id,
      amount: booking.depositAmount,
      authority,
      status: "INITIATED",
    },
    update: { authority, status: "INITIATED" },
  });

  res.json({ paymentUrl });
});

router.get("/zarinpal/callback", callbackLimiter, async (req, res) => {
  const bookingId = typeof req.query.bookingId === "string" ? req.query.bookingId : "";
  const authority = typeof req.query.Authority === "string" ? req.query.Authority : "";
  const status = typeof req.query.Status === "string" ? req.query.Status : "";

  const redirect = (path: string) => res.redirect(`${env.frontendBaseUrl}${path}`);

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { service: true, user: true, payment: true },
  });
  if (!booking || !booking.payment || !booking.service || !booking.user) return redirect("/?payment=not_found");

  // Authority is the unguessable secret tied to this specific payment
  // session — without checking it, this public, unauthenticated callback
  // would let anyone who learns/guesses a bookingId force-cancel someone
  // else's pending booking just by hitting this URL with Status=NOK.
  if (booking.payment.authority !== authority) return redirect("/?payment=not_found");

  // replaying a past successful callback (bookmarked/shared URL, browser
  // back-button, or a deliberate replay attempt) must not re-run
  // verification, re-send the confirmation SMS, or rewrite already-correct
  // state — ZarinPal itself would just report "already verified" (code 101)
  // and let this fall through to the same side effects every time otherwise
  if (booking.payment.status === "PAID") return redirect(`/?payment=success&bookingId=${booking.id}`);

  if (status !== "OK") {
    await prisma.$transaction([
      prisma.payment.update({ where: { bookingId: booking.id }, data: { status: "FAILED" } }),
      prisma.slotHold.deleteMany({ where: { bookingId: booking.id } }),
      prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } }),
    ]);
    return redirect("/?payment=cancelled");
  }

  const verified = await verifyZarinpalPayment({
    amountToman: booking.depositAmount,
    authority,
  });

  if (!verified.ok) {
    await prisma.payment.update({ where: { bookingId: booking.id }, data: { status: "FAILED" } });
    return redirect("/?payment=failed");
  }

  // ZarinPal has genuinely captured the money at this point — record that
  // regardless of what happens below. The 15-min hold can expire (and its
  // SlotHold get deleted by jobs/expireHolds.ts) while this callback was in
  // flight, so the slot below is re-acquired atomically rather than assumed
  // still free; if that fails, this Payment row is how the refund gets found.
  await prisma.payment.update({
    where: { bookingId: booking.id },
    data: { status: "PAID", refId: verified.refId, verifiedAt: new Date() },
  });

  try {
    await prisma.$transaction([
      prisma.slotHold.upsert({
        where: { bookingId: booking.id },
        create: { categoryId: booking.categoryId, date: booking.date, time: booking.time, bookingId: booking.id },
        update: {},
      }),
      prisma.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED" } }),
    ]);
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;

    // someone else took this exact category/date/time slot while the
    // delayed callback was still in flight — the appointment can't be
    // honored, so refund in full. Not subject to the 48h late-cancellation
    // policy (lib/cancellationPolicy.ts): that's for a customer changing
    // their mind, not a system race that isn't the customer's fault.
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const result = await requestZarinpalRefund(authority, booking.depositAmount);
    if (result.success) {
      await prisma.payment.update({
        where: { bookingId: booking.id },
        data: { refundStatus: "SUCCEEDED", refundedAt: new Date(), refundNote: result.note, refId: result.refundRefId },
      });
      await sendRefundSms(booking.user.phone, {
        serviceName: booking.service.name,
        amountToman: booking.depositAmount,
      }).catch((refundSmsErr) => console.error("Failed to send refund SMS:", refundSmsErr));
    } else {
      await prisma.payment.update({
        where: { bookingId: booking.id },
        data: { refundStatus: "NEEDS_MANUAL_FOLLOWUP", refundNote: result.note },
      });
    }
    return redirect("/?payment=slot_taken");
  }

  await sendBookingConfirmationSms(booking.user.phone, {
    serviceName: booking.service.name,
    dateLabel: toJalaliDateLabel(booking.date),
    time: booking.time,
  }).catch((err) => console.error("Failed to send confirmation SMS:", err));

  return redirect(`/?payment=success&bookingId=${booking.id}`);
});

export default router;
