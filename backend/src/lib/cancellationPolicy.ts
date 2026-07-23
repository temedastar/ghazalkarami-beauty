// a CONFIRMED+PAID booking cancelled at least this many hours before its
// appointment gets a full automatic refund; cancelled later than this, the
// deposit is forfeited per the salon's cancellation policy (see
// public/refund-policy.html, section 3)
export const REFUND_ELIGIBLE_HOURS = 48;

/**
 * Combines a booking's separate date/time fields into a single timestamp,
 * the same way tests/helpers.ts and jobs/sendReminders.ts already do (both
 * treat the stored UTC date + "HH:MM" time string as the appointment's
 * wall-clock instant directly, with no further timezone conversion) —
 * kept consistent here rather than reinvented.
 */
export function appointmentTimestamp(date: Date, time: string): number {
  const [hh, mm] = time.split(":").map(Number);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hh, mm);
}

export function hoursUntilAppointment(date: Date, time: string, now: Date = new Date()): number {
  return (appointmentTimestamp(date, time) - now.getTime()) / (1000 * 60 * 60);
}

export function isRefundEligible(date: Date, time: string, now: Date = new Date()): boolean {
  return hoursUntilAppointment(date, time, now) >= REFUND_ELIGIBLE_HOURS;
}
