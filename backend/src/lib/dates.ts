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

const PERSIAN_MONTHS = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
];
const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

function toPersianDigits(n: number): string {
  return String(n).replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

// standard Gregorian->Jalali (Shamsi) conversion algorithm — the exact same
// one already proven in public/index.html's toJalali() (used there for
// review dates and the customer's own booking list), ported here so the
// backend doesn't depend on frontend code. Cross-checked against ICU's own
// persian-calendar output (Intl.DateTimeFormat with u-ca-persian) across
// several Nowruz/leap-year boundaries before relying on it.
function gregorianToJalali(gy: number, gm: number, gd: number): [number, number, number] {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days =
    365 * gy +
    Math.floor((gy2 + 3) / 4) -
    Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) -
    80 +
    gd +
    g_d_m[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

/**
 * The one place a Gregorian Date becomes a human-readable Jalali (Shamsi)
 * date, e.g. "۴ مرداد ۱۴۰۵" — every SMS that mentions a booking date must go
 * through this, never toDateOnlyString() (that's Gregorian ISO, for
 * DB/query use only — never for anything a customer or admin actually
 * reads). Extracts UTC calendar components since Booking.date is always
 * constructed at UTC midnight (see parseDateOnly above); using the server
 * process's local time here would make this silently depend on whatever
 * timezone the container happens to be running in.
 */
export function toJalaliDateLabel(date: Date): string {
  const [jy, jm, jd] = gregorianToJalali(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  return `${toPersianDigits(jd)} ${PERSIAN_MONTHS[jm - 1]} ${toPersianDigits(jy)}`;
}
