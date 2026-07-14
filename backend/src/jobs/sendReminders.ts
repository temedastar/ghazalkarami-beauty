import cron from "node-cron";
import { prisma } from "../lib/prisma";
import { sendBookingReminderSms } from "../services/kavenegar";
import { toDateOnlyString } from "../lib/dates";

async function sendDueReminders() {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const reminderHoursBefore = settings?.reminderHoursBefore ?? 24;

  const bookings = await prisma.booking.findMany({
    where: { status: "CONFIRMED", reminderSentAt: null, serviceId: { not: null }, userId: { not: null } },
    include: { service: true, user: true },
  });

  const now = Date.now();
  let sent = 0;
  for (const booking of bookings) {
    if (!booking.service || !booking.user) continue;
    const [hh, mm] = booking.time.split(":").map(Number);
    const apptMs = Date.UTC(
      booking.date.getUTCFullYear(),
      booking.date.getUTCMonth(),
      booking.date.getUTCDate(),
      hh,
      mm
    );
    const reminderDueAtMs = apptMs - reminderHoursBefore * 60 * 60 * 1000;
    if (reminderDueAtMs > now || apptMs <= now) continue; // not due yet, or appointment already passed

    try {
      await sendBookingReminderSms(booking.user.phone, {
        serviceName: booking.service.name,
        dateLabel: toDateOnlyString(booking.date),
        time: booking.time,
      });
      await prisma.booking.update({ where: { id: booking.id }, data: { reminderSentAt: new Date() } });
      sent++;
    } catch (err) {
      console.error(`[jobs] failed to send reminder for booking ${booking.id}:`, err);
    }
  }

  if (sent > 0) console.log(`[jobs] sent ${sent} booking reminder(s)`);
}

export function startReminderJob() {
  cron.schedule("*/15 * * * *", () => {
    sendDueReminders().catch((err) => console.error("[jobs] sendDueReminders failed:", err));
  });
}
