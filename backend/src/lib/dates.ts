/** Parses a "YYYY-MM-DD" string as a UTC calendar date (no timezone drift). */
export function parseDateOnly(dateStr: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** 0=Sunday .. 6=Saturday, matching the frontend's Date.getDay() convention. */
export function dayOfWeekUTC(date: Date): number {
  return date.getUTCDay();
}

export function isPastDate(date: Date): boolean {
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return date.getTime() < todayUTC.getTime();
}

export function toDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
