import { test, expect } from "@playwright/test";
import { testPool, randomPhone } from "./helpers";

// GET /api/availability/next?categoryKey=&limit= scans forward across many
// days in one batched query instead of the frontend looping GET / (single
// day) once per candidate day — this exercises that it applies the exact
// same rules the single-day endpoint does (day-open, shared-line SlotHold
// conflicts, 30-min lead time), just across a date range.
test.describe("GET /api/availability/next", () => {
  test("returns slots in chronological order, respects the limit, and 404s an unknown category", async ({
    request,
  }) => {
    const unknown = await request.get("/api/availability/next?categoryKey=does-not-exist");
    expect(unknown.status()).toBe(404);

    const res = await request.get("/api/availability/next?categoryKey=h&limit=5");
    expect(res.status(), await res.text()).toBe(200);
    const { slots } = await res.json();
    expect(slots.length).toBeLessThanOrEqual(5);
    expect(slots.length).toBeGreaterThan(0);
    const timestamps = slots.map((s: { date: string; time: string }) => `${s.date}T${s.time}`);
    const sorted = [...timestamps].sort();
    expect(timestamps).toEqual(sorted);
  });

  test("a booked slot in the shared-line category is skipped, but that same time in an independent category is not", async ({
    request,
  }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const chem = categories.find((c: { key: string }) => c.key === "chem");
    const haircut = categories.find((c: { key: string }) => c.key === "h");

    // find the very next available chem slot, then block it, then confirm
    // /next skips straight past it to whatever comes after
    const before = await request.get("/api/availability/next?categoryKey=chem&limit=1");
    const firstChem = (await before.json()).slots[0];
    expect(firstChem, "seed data should have at least one open chem slot in the next 90 days").toBeTruthy();

    const booked = await request.post("/api/admin/bookings/manual", {
      headers: adminAuth,
      data: { categoryId: chem.id, date: firstChem.date, time: firstChem.time, customerName: "تست", customerPhone: randomPhone() },
    });
    expect(booked.status(), await booked.text()).toBe(201);

    try {
      const after = await request.get("/api/availability/next?categoryKey=chem&limit=1");
      const newFirstChem = (await after.json()).slots[0];
      expect(newFirstChem).toBeTruthy();
      expect(`${newFirstChem.date}T${newFirstChem.time}`).not.toBe(`${firstChem.date}T${firstChem.time}`);

      // haircut is a fully independent category/timeline — blocking chem
      // must never remove a haircut slot at the exact same date+time
      const haircutRes = await request.get(`/api/availability?categoryKey=h&date=${firstChem.date}`);
      const haircutSlot = (await haircutRes.json()).slots.find((s: { time: string }) => s.time === firstChem.time);
      if (haircutSlot) expect(haircutSlot.available).toBe(true);
    } finally {
      await request.patch(`/api/admin/bookings/${(await booked.json()).booking.id}/status`, {
        headers: adminAuth,
        data: { status: "CANCELLED" },
      });
    }
  });

  test("a day closed via day-exception never contributes a slot", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };

    const before = await request.get("/api/availability/next?categoryKey=s&limit=3");
    const firstFew = (await before.json()).slots;
    expect(firstFew.length).toBeGreaterThan(0);
    const targetDate = firstFew[0].date;

    const closed = await request.post("/api/admin/day-exceptions", {
      headers: adminAuth,
      data: { date: targetDate, isOpen: false, reason: "تست" },
    });
    expect(closed.status(), await closed.text()).toBe(201);

    try {
      const after = await request.get("/api/availability/next?categoryKey=s&limit=3");
      const afterSlots = (await after.json()).slots;
      expect(afterSlots.every((s: { date: string }) => s.date !== targetDate)).toBe(true);
    } finally {
      const exRes = await request.get(`/api/admin/day-exceptions?from=${targetDate}&to=${targetDate}`, { headers: adminAuth });
      const ex = (await exRes.json()).exceptions[0];
      if (ex) await request.delete(`/api/admin/day-exceptions/${ex.id}`, { headers: adminAuth });
    }
  });
});
