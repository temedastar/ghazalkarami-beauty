import { prisma } from "../lib/prisma";
import { isRefundEligible } from "../lib/cancellationPolicy";
import { requestZarinpalRefund } from "./zarinpalRefund";
import { sendRefundSms } from "./kavenegar";

export type RefundOutcome = "not_applicable" | "succeeded" | "needs_manual_followup";

export interface CancelResult {
  refund: RefundOutcome;
  message: string;
}

interface CancellableBooking {
  id: string;
  date: Date;
  time: string;
  status: string;
  payment: { id: string; status: string; authority: string | null; amount: number } | null;
  user: { phone: string } | null;
  service: { name: string } | null;
}

/**
 * Cancels a booking (deletes its SlotHold, sets status CANCELLED) and, if it
 * was CONFIRMED with a PAID deposit, decides refund eligibility (see
 * lib/cancellationPolicy.ts) and attempts the refund. Shared by both the
 * customer self-service cancel (routes/bookings.ts) and the admin
 * status-change endpoint (routes/admin.ts) so the same 48h policy applies
 * no matter who initiates the cancellation.
 */
export async function cancelBookingAndMaybeRefund(booking: CancellableBooking): Promise<CancelResult> {
  const hadPaidDeposit = booking.status === "CONFIRMED" && booking.payment?.status === "PAID";
  const eligible = hadPaidDeposit && isRefundEligible(booking.date, booking.time);

  await prisma.$transaction([
    prisma.slotHold.deleteMany({ where: { bookingId: booking.id } }),
    prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED", cancelledAt: new Date() } }),
  ]);

  if (!hadPaidDeposit) {
    return { refund: "not_applicable", message: "نوبت با موفقیت لغو شد." };
  }

  if (!eligible) {
    await prisma.payment.update({ where: { id: booking.payment!.id }, data: { refundStatus: "NOT_APPLICABLE" } });
    return {
      refund: "not_applicable",
      message:
        "نوبت لغو شد. از آنجا که کمتر از ۴۸ ساعت به زمان نوبت باقی مانده بود، طبق قوانین لغو و بازگشت وجه، بیعانه قابل بازگشت نیست.",
    };
  }

  const result = await requestZarinpalRefund(booking.payment!.authority ?? "", booking.payment!.amount);

  if (result.success) {
    await prisma.payment.update({
      where: { id: booking.payment!.id },
      data: { refundStatus: "SUCCEEDED", refundedAt: new Date(), refundNote: result.note, refId: result.refundRefId },
    });
    if (booking.user && booking.service) {
      await sendRefundSms(booking.user.phone, {
        serviceName: booking.service.name,
        amountToman: booking.payment!.amount,
      }).catch((err) => console.error("Failed to send refund SMS:", err));
    }
    return { refund: "succeeded", message: "نوبت لغو شد و بیعانه با موفقیت به حساب شما بازگردانده شد." };
  }

  await prisma.payment.update({
    where: { id: booking.payment!.id },
    data: { refundStatus: "NEEDS_MANUAL_FOLLOWUP", refundNote: result.note },
  });
  return {
    refund: "needs_manual_followup",
    message: "نوبت لغو شد. بازگشت خودکار بیعانه در حال حاضر ممکن نشد؛ تیم سالن به‌زودی بیعانه را به‌صورت دستی بازمی‌گرداند.",
  };
}
