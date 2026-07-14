import { prisma } from "./prisma";
import { dayOfWeekUTC } from "./dates";
import type { Service } from "@prisma/client";

/** Whether the salon is open at all on this calendar date — a DayException
 * (vacation, or an extra opened Saturday) always overrides the recurring
 * WorkingDay pattern for that one date. */
export async function isDateOpen(date: Date): Promise<boolean> {
  const exception = await prisma.dayException.findUnique({ where: { date } });
  if (exception) return exception.isOpen;
  const dow = dayOfWeekUTC(date);
  const workingDay = await prisma.workingDay.findUnique({ where: { dayOfWeek: dow } });
  return workingDay?.isOpen ?? false;
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
