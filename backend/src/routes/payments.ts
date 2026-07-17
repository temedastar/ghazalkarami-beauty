import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { env } from "../lib/env";
import { createZarinpalPayment, verifyZarinpalPayment } from "../services/zarinpal";
import { sendBookingConfirmationSms } from "../services/kavenegar";
import { toDateOnlyString } from "../lib/dates";

const router = Router();

const requestSchema = z.object({ bookingId: z.string() });

router.post("/zarinpal/request", requireAuth, async (req, res) => {
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

router.get("/zarinpal/callback", async (req, res) => {
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

  await prisma.$transaction([
    prisma.payment.update({
      where: { bookingId: booking.id },
      data: { status: "PAID", refId: verified.refId, verifiedAt: new Date() },
    }),
    prisma.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED" } }),
  ]);

  await sendBookingConfirmationSms(booking.user.phone, {
    serviceName: booking.service.name,
    dateLabel: toDateOnlyString(booking.date),
    time: booking.time,
  }).catch((err) => console.error("Failed to send confirmation SMS:", err));

  return redirect(`/?payment=success&bookingId=${booking.id}`);
});

export default router;
