import { prisma } from "./prisma";
import { dayOfWeekUTC, minutesUntil } from "./dates";
import type { Service } from "@prisma/client";

// a customer arriving (or a walk-in being squeezed in) with zero notice
// isn't a real appointment — this also closes the specific bug where a
// same-day slot whose start time had already passed was still shown as
// bookable, since date-level checks alone (isPastDate) never look at the
// clock once the date itself is "today"
export const BOOKING_LEAD_MINUTES = 30;

/** True once a same-day slot is within BOOKING_LEAD_MINUTES of its start
 * (or has already started/passed) — evaluated in Tehran time regardless of
 * what timezone the server process itself is running in. A slot on a
 * future date is never "too soon" here. */
export function isSlotTooSoon(date: Date, time: string): boolean {
  return minutesUntil(date, time) < BOOKING_LEAD_MINUTES;
}

export interface DayOpenInfo {
  open: boolean;
  // set only when a DayException restricts this specific date to a
  // sub-range of the category's normal TimeSlot pattern (e.g. closing
  // early for a one-off reason) — null means no restriction beyond the
  // normal per-category TimeSlot pattern
  openTime: string | null;
  closeTime: string | null;
}

/** Whether the salon is open at all on this calendar date, and — for a
 * DayException with custom hours — the specific window bookable that day.
 * A DayException (vacation, or an extra opened Saturday) always overrides
 * the recurring WorkingDay pattern for that one date. */
export async function getDayOpenInfo(date: Date): Promise<DayOpenInfo> {
  const dow = dayOfWeekUTC(date);
  // both lookups are independent of each other, so fire them together instead
  // of paying two sequential round-trips on the hot booking-creation path
  const [exception, workingDay] = await Promise.all([
    prisma.dayException.findUnique({ where: { date } }),
    prisma.workingDay.findUnique({ where: { dayOfWeek: dow } }),
  ]);
  if (exception) {
    return { open: exception.isOpen, openTime: exception.openTime, closeTime: exception.closeTime };
  }
  return { open: workingDay?.isOpen ?? false, openTime: null, closeTime: null };
}

/** A slot's start time must fall within a DayException's custom hours, if
 * any are set for that date — closeTime is an exclusive bound on the slot's
 * *start* time (TimeSlot has no stored duration to check the end against). */
export function isTimeAllowed(time: string, info: DayOpenInfo): boolean {
  if (info.openTime && time < info.openTime) return false;
  if (info.closeTime && time >= info.closeTime) return false;
  return true;
}

/** FIXED -> flat toman amount. PERCENT -> percentage of priceMin (falls back
 * to the global Settings default when there's no priceMin to base it on). */
export async function computeDepositAmount(service: Service): Promise<number> {
  if (service.depositType === "FIXED") return service.depositValue;

  if (service.priceMin) {
    return Math.round((service.priceMin * service.depositValue) / 100);
  }
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  return settings?.defaultDepositValue ?? 0;
}
