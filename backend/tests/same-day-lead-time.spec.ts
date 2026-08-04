import { test, expect } from "@playwright/test";
import { testPool } from "./helpers";

// Iran Standard Time is a fixed UTC+3:30 offset (no DST since Sept 2022) —
// reimplemented independently here (not imported from src/lib/dates.ts) so
// this test doesn't just tautologically check the same arithmetic it's
// verifying.
const TEHRAN_OFFSET_MINUTES = 3 * 60 + 30;

function nowInTehran(): Date {
  return new Date(Date.now() + TEHRAN_OFFSET_MINUTES * 60000);
}

function hhmm(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutesFromMidnight % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

// Reproduces the exact reported bug: on a real Tuesday at 16:00 Tehran time,
// booking 11:20 the same day (already well past) succeeded. Root cause was
// that the only "is this bookable" check was isPastDate() — a date-only
// comparison that says nothing about the clock once the date itself is
// "today" — plus it compared against the server process's own timezone
// (UTC on Liara) rather than Tehran's.
test("a same-day slot that has already passed (or is within the booking lead time) is neither offered nor bookable", async ({
  request,
}) => {
  const now = nowInTehran();
  const dow = now.getUTCDay();
  // the salon is fully closed Saturdays — "too soon" isn't meaningfully
  // testable on a day with no open slots at all
  test.skip(dow === 6, "salon is closed on Saturdays (Tehran)");

  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  // avoid the rare case of the suite running close enough to midnight that
  // "90 minutes from now" would wrap into tomorrow and invert the test's
  // own assumptions
  test.skip(nowMinutes > 22 * 60 + 20, "too close to midnight Tehran time to safely construct same-day test slots");

  const todayStr = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);

  const tooSoonTime = hhmm(nowMinutes + 10); // 10 min out — well inside the 60-min lead requirement
  const okTime = hhmm(nowMinutes + 90); // 90 min out — clear of it

  const adminToken = testPool().adminToken;
  const auth = { Authorization: `Bearer ${adminToken}` };

  const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
  const haircut = categories.find((c: { key: string }) => c.key === "h");

  // same defensive cleanup as availability-order.spec.ts: POST /time-slots
  // upserts, so only delete ids that didn't already exist for this
  // category/day before this test added anything
  const preexistingIds = new Set<string>(
    haircut.timeSlots.filter((t: { dayOfWeek: number; id: string }) => t.dayOfWeek === dow).map((t: { id: string }) => t.id)
  );

  const createdIds: string[] = [];
  try {
    for (const time of [tooSoonTime, okTime]) {
      const created = await request.post("/api/admin/time-slots", {
        headers: auth,
        data: { categoryId: haircut.id, dayOfWeek: dow, time },
      });
      expect(created.status(), await created.text()).toBe(201);
      const id = (await created.json()).slot.id;
      if (!preexistingIds.has(id)) createdIds.push(id);
    }

    const availability = await request.get(`/api/availability?categoryKey=h&date=${todayStr}`);
    expect(availability.status()).toBe(200);
    const times: string[] = (await availability.json()).slots.map((s: { time: string }) => s.time);
    expect(times, "the already-past/too-soon slot must not be offered at all").not.toContain(tooSoonTime);
    expect(times, "a same-day slot safely past the lead time must still be offered").toContain(okTime);

    const customerToken = testPool().customers[7].token;
    const customerAuth = { Authorization: `Bearer ${customerToken}` };

    const tooSoonBooking = await request.post("/api/bookings", {
      headers: customerAuth,
      data: { serviceKey: "haircut", date: todayStr, time: tooSoonTime },
    });
    expect(tooSoonBooking.status()).toBe(400);
    expect((await tooSoonBooking.json()).error).toContain("گذشته");

    const okBooking = await request.post("/api/bookings", {
      headers: customerAuth,
      data: { serviceKey: "haircut", date: todayStr, time: okTime },
    });
    expect(okBooking.status(), await okBooking.text()).toBe(201);
  } finally {
    await Promise.all(createdIds.map((id) => request.delete(`/api/admin/time-slots/${id}`, { headers: auth })));
  }
});
