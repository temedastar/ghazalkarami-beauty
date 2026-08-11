import { test, expect } from "@playwright/test";
import { testPool, randomPhone, nextWeekday } from "./helpers";

// The admin calendar view fetches a whole visible week in one request
// instead of one call per day — these two optional range params are the
// only new backend surface that view needed; everything else it does
// (manual booking, day-exception create/delete, status changes) reuses
// existing endpoints untouched.
test.describe("admin calendar: date-range params on existing endpoints", () => {
  test("GET /admin/bookings?from&to returns only bookings within the inclusive range, without disturbing the existing date/upcoming modes", async ({
    request,
  }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
    const scalp = categories.find((c: { key: string }) => c.key === "s");

    const before = nextWeekday(50);
    const inRangeStart = nextWeekday(51);
    const inRangeEnd = nextWeekday(53);
    const after = nextWeekday(55);

    for (const [date, reason] of [
      [before, "قبل از بازه"],
      [inRangeStart, "ابتدای بازه"],
      [inRangeEnd, "انتهای بازه"],
      [after, "بعد از بازه"],
    ] as const) {
      const created = await request.post("/api/admin/bookings/manual", {
        headers: auth,
        data: { categoryId: scalp.id, date, time: "10:00", customerName: reason, customerPhone: randomPhone(), reason },
      });
      expect(created.status(), await created.text()).toBe(201);
    }

    const ranged = await request.get(`/api/admin/bookings?from=${inRangeStart}&to=${inRangeEnd}`, { headers: auth });
    expect(ranged.status()).toBe(200);
    const rangedDates = (await ranged.json()).bookings.map((b: { date: string }) => b.date.slice(0, 10));
    expect(rangedDates).toContain(inRangeStart);
    expect(rangedDates).toContain(inRangeEnd);
    expect(rangedDates).not.toContain(before);
    expect(rangedDates).not.toContain(after);

    // the pre-existing single-date mode is untouched by adding from/to support
    const singleDate = await request.get(`/api/admin/bookings?date=${inRangeStart}`, { headers: auth });
    const singleDateResults = (await singleDate.json()).bookings;
    expect(singleDateResults.length).toBeGreaterThan(0);
    expect(singleDateResults.every((b: { date: string }) => b.date.slice(0, 10) === inRangeStart)).toBe(true);
  });

  test("GET /admin/day-exceptions?from&to includes past exceptions, unlike the default future-only listing", async ({
    request,
  }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    // a fixed, deterministically-past date — no relative "yesterday" math
    // that could interact with today's own date across time zones
    const pastDate = "2020-06-15";

    const created = await request.post("/api/admin/day-exceptions", {
      headers: auth,
      data: { date: pastDate, isOpen: false, reason: "تست بازه‌ی گذشته" },
    });
    expect(created.status(), await created.text()).toBe(201);
    const exceptionId = (await created.json()).exception.id;

    try {
      const defaultList = await request.get("/api/admin/day-exceptions", { headers: auth });
      const defaultDates = (await defaultList.json()).exceptions.map((e: { date: string }) => e.date.slice(0, 10));
      expect(defaultDates, "the default (no range) listing is future-only and must not include a past exception").not.toContain(pastDate);

      const ranged = await request.get(`/api/admin/day-exceptions?from=2020-06-01&to=2020-06-30`, { headers: auth });
      const rangedDates = (await ranged.json()).exceptions.map((e: { date: string }) => e.date.slice(0, 10));
      expect(rangedDates).toContain(pastDate);
    } finally {
      await request.delete(`/api/admin/day-exceptions/${exceptionId}`, { headers: auth });
    }
  });
});
