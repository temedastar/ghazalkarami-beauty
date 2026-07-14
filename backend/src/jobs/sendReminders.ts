import cron from "node-cron";
import { prisma } from "../lib/prisma";
import { sendBookingReminderSms } from "../services/kavenegar";
import { toDateOnlyString } from "../lib/dates";

async function sendTomorrowReminders() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

  const bookings = await prisma.booking.findMany({
    where: { status: "CONFIRMED", date: tomorrow, reminderSentAt: null },
    include: { service: true, user: true },
  });

  for (const booking of bookings) {
    try {
      await sendBookingReminderSms(booking.user.phone, {
        serviceName: booking.service.name,
        dateLabel: toDateOnlyString(booking.date),
        time: booking.time,
      });
      await prisma.booking.update({
        where: { id: booking.id },
        data: { reminderSentAt: new Date() },
      });
    } catch (err) {
      console.error(`[jobs] failed to send reminder for booking ${booking.id}:`, err);
    }
  }

  if (bookings.length > 0) {
    console.log(`[jobs] sent ${bookings.length} booking reminder(s)`);
  }
}

export function startReminderJob() {
  // once a day, 11:00 server time — comfortably a "day before" nudge
  cron.schedule("0 11 * * *", () => {
    sendTomorrowReminders().catch((err) => console.error("[jobs] sendTomorrowReminders failed:", err));
  });
}
