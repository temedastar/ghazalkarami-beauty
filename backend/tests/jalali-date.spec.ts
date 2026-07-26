import { test, expect } from "@playwright/test";
import { toJalaliDateLabel } from "../src/lib/dates";

// every SMS that mentions a booking date (confirmation, reminder) must show
// a Jalali date, never the Gregorian ISO string toDateOnlyString() produces.
// Reference values cross-checked against ICU's own persian-calendar output
// (Intl.DateTimeFormat with u-ca-persian) for several Nowruz/leap-year
// boundaries before trusting this conversion.
test("toJalaliDateLabel converts Gregorian dates to a readable Jalali label", () => {
  const cases: [string, string][] = [
    ["2026-07-26", "۴ مرداد ۱۴۰۵"],
    ["2026-01-01", "۱۱ دی ۱۴۰۴"],
    // the day before Nowruz — last day of the Jalali year
    ["2025-03-20", "۳۰ اسفند ۱۴۰۳"],
    // Nowruz itself — first day of the new Jalali year
    ["2025-03-21", "۱ فروردین ۱۴۰۴"],
    // a Gregorian leap day
    ["2024-02-29", "۱۰ اسفند ۱۴۰۲"],
    ["2020-12-31", "۱۱ دی ۱۳۹۹"],
    ["2027-03-20", "۲۹ اسفند ۱۴۰۵"],
  ];

  for (const [gregorian, expected] of cases) {
    const date = new Date(`${gregorian}T00:00:00.000Z`);
    expect(toJalaliDateLabel(date), `for ${gregorian}`).toBe(expected);
  }
});

test("toJalaliDateLabel never leaks a Gregorian-looking date", () => {
  const label = toJalaliDateLabel(new Date("2026-07-26T00:00:00.000Z"));
  expect(label).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(label).not.toContain("2026");
  // has a real Persian month name in it, not just digits
  expect(label).toMatch(/[آ-ی]/);
});
