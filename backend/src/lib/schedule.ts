import { prisma } from "./prisma";
import { dayOfWeekUTC } from "./dates";
import type { Service } from "@prisma/client";

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
