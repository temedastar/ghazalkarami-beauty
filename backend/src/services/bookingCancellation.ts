import { z } from "zod";
import { prisma } from "../lib/prisma";
import { isRefundEligible } from "../lib/cancellationPolicy";
import { toJalaliDateLabel } from "../lib/dates";
import { sendCancellationNotifySms } from "./kavenegar";
import { logAction } from "../lib/auditLog";

export type RefundOutcome = "not_applicable" | "needs_manual_followup";

export interface CancelResult {
  refund: RefundOutcome;
  message: string;
}

interface CancellableBooking {
  id: string;
  date: Date;
  time: string;
  status: string;
  payment: { id: string; status: string; amount: number } | null;
  user: { phone: string; firstName: string; lastName: string } | null;
  service: { name: string } | null;
}

export const refundCardSchema = z.object({
  refundCardNumber: z.string().trim().min(1),
  refundCardHolder: z.string().trim().min(1, "نام صاحب کارت را وارد کنید.").max(120),
});

function normalizeCardNumber(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

export interface RefundCard {
  number: string;
  holder: string;
}

/**
 * Validates the card-number/cardholder-name pair collected at cancel time —
 * required whenever a cancellation is refund-eligible, since ZarinPal's
 * refund service (via Shaparak) is permanently disabled and every eligible
 * refund is now a manual card-to-card transfer (see cancelBookingAndMaybeRefund).
 */
export function validateRefundCard(input: unknown): { ok: true; card: RefundCard } | { ok: false; error: string } {
  const parsed = refundCardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "برای بازگشت بیعانه، شماره کارت و نام صاحب کارت را وارد کنید." };
  }
  const number = normalizeCardNumber(parsed.data.refundCardNumber);
  if (!/^\d{16}$/.test(number)) {
    return { ok: false, error: "شماره کارت باید ۱۶ رقم باشد." };
  }
  return { ok: true, card: { number, holder: parsed.data.refundCardHolder.trim() } };
}

/**
 * Cancels a booking (deletes its SlotHold, sets status CANCELLED) and, if it
 * was CONFIRMED with a PAID deposit, decides refund eligibility (see
 * lib/cancellationPolicy.ts). Shared by the customer self-service cancel
 * (routes/bookings.ts) and the admin status-change/block-range endpoints
 * (routes/admin.ts) so the same 48h policy applies no matter who initiates
 * the cancellation.
 *
 * ZarinPal's refund API via Shaparak is permanently disabled — there is no
 * automatic refund path anymore. Every eligible refund is a manual
 * card-to-card transfer, so `refundCard` (validated by whichever route
 * called this, via validateRefundCard above) is stored on the Payment and
 * surfaced in the admin "بازگشت وجه در انتظار" list until Ghazal marks it paid.
 */
export async function cancelBookingAndMaybeRefund(
  booking: CancellableBooking,
  refundCard?: RefundCard,
  actorLabel: string = "سیستم",
  // block-range's bulk reopen calls this once per slot in a range that can
  // run to hundreds of ADMIN_BLOCK placeholder entries — an individual
  // "نوبت لغو شد" line per slot would drown out real customer cancellations
  // in the audit log. That caller logs one summary line for the whole range
  // itself instead (see routes/admin.ts).
  skipLog: boolean = false
): Promise<CancelResult> {
  const hadPaidDeposit = booking.status === "CONFIRMED" && booking.payment?.status === "PAID";
  const eligible = hadPaidDeposit && isRefundEligible(booking.date, booking.time);

  await prisma.$transaction([
    prisma.slotHold.deleteMany({ where: { bookingId: booking.id } }),
    prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED", cancelledAt: new Date() } }),
  ]);

  const svcName = booking.service?.name ?? "بدون سرویس";
  const whenLabel = `${toJalaliDateLabel(booking.date)} ساعت ${booking.time}`;

  if (!hadPaidDeposit) {
    if (!skipLog) {
      logAction("BOOKING_CANCELLED", `نوبت «${svcName}» — ${whenLabel} — توسط ${actorLabel} لغو شد (بدون بیعانه‌ی پرداخت‌شده).`, actorLabel);
    }
    return { refund: "not_applicable", message: "نوبت با موفقیت لغو شد." };
  }

  if (!eligible) {
    await prisma.payment.update({ where: { id: booking.payment!.id }, data: { refundStatus: "NOT_APPLICABLE" } });
    if (!skipLog) {
      logAction(
        "BOOKING_CANCELLED",
        `نوبت «${svcName}» — ${whenLabel} — توسط ${actorLabel} لغو شد. کمتر از ۴۸ ساعت مانده بود؛ طبق قوانین، بیعانه سوخت.`,
        actorLabel
      );
    }
    return {
      refund: "not_applicable",
      message:
        "نوبت لغو شد. از آنجا که کمتر از ۴۸ ساعت به زمان نوبت باقی مانده بود، طبق قوانین لغو و بازگشت وجه، بیعانه قابل بازگشت نیست.",
    };
  }

  await prisma.payment.update({
    where: { id: booking.payment!.id },
    data: {
      refundStatus: "NEEDS_MANUAL_FOLLOWUP",
      refundCardNumber: refundCard?.number ?? null,
      refundCardHolder: refundCard?.holder ?? null,
      refundNote: "بازگشت به‌صورت کارت‌به‌کارت توسط سالن انجام می‌شود.",
    },
  });

  const customerName = booking.user ? `${booking.user.firstName} ${booking.user.lastName}`.trim() : "مشتری";
  notifyOwnerOfCancellation(customerName, booking.date).catch((err) =>
    console.error("Failed to send cancellation-notify SMS:", err)
  );
  if (!skipLog) {
    logAction(
      "BOOKING_CANCELLED",
      `نوبت «${svcName}» — ${whenLabel} — توسط ${actorLabel} لغو شد. بیعانه مشمول بازگشت است و در «بازگشت وجه در انتظار» ثبت شد.`,
      actorLabel
    );
  }

  return {
    refund: "needs_manual_followup",
    message: "نوبت لغو شد. بیعانه طی چند روز کاری به شماره کارت اعلام‌شده واریز خواهد شد.",
  };
}

async function notifyOwnerOfCancellation(customerName: string, date: Date): Promise<void> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!settings?.ownerNotifyPhone) return;
  await sendCancellationNotifySms(settings.ownerNotifyPhone, {
    customerName,
    dateLabel: toJalaliDateLabel(date),
  });
}
