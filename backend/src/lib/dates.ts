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

// Iran Standard Time is a fixed UTC+3:30 offset — Iran abolished DST in
// September 2022, so (unlike most timezones) this never needs to account
// for a seasonal shift. The container this server runs in is not
// guaranteed to be set to Tehran time (Liara's build/runtime is UTC), so
// "today"/"now" must be computed from this offset rather than from the
// process's own local time — otherwise a booking near midnight, or a
// same-day time-of-day check, silently uses the wrong calendar day/hour.
const TEHRAN_OFFSET_MINUTES = 3 * 60 + 30;

/** The current moment, shifted so its UTC getters read as Tehran wall-clock
 * time (e.g. `.getUTCHours()` gives the hour in Tehran, not in the
 * server's own timezone). */
function nowInTehran(): Date {
  return new Date(Date.now() + TEHRAN_OFFSET_MINUTES * 60000);
}

/** Today's calendar date in Tehran, as a UTC-midnight Date — the same
 * representation parseDateOnly() produces, so it's directly comparable to
 * a Booking.date value. */
function todayInTehran(): Date {
  const t = nowInTehran();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

export function isPastDate(date: Date): boolean {
  return date.getTime() < todayInTehran().getTime();
}

/** How many minutes from right now (in Tehran) until this date+time — negative
 * once the moment has already passed. Only meaningful for `date` being today
 * or in the future; a genuinely past date should already be rejected by
 * isPastDate() before this is ever called. */
export function minutesUntil(date: Date, time: string): number {
  const today = todayInTehran();
  const [h, m] = time.split(":").map(Number);
  const slotMinutesFromToday = Math.round((date.getTime() - today.getTime()) / 60000) + h * 60 + m;
  const t = nowInTehran();
  const nowMinutesFromToday = t.getUTCHours() * 60 + t.getUTCMinutes();
  return slotMinutesFromToday - nowMinutesFromToday;
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
