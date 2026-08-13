import { test, expect } from "@playwright/test";
import { testPool, randomPhone, nextWeekday } from "./helpers";

// DayException is purely a day-open flag — closing a day/range through it
// never touches existing Booking rows (whether to auto-cancel them, and
// under what refund policy, is a decision left to the admin, not automated
// here). POST /day-exceptions and /day-exceptions/closure-range now return
// affectedBookings so that isn't discovered by surprise after the fact.
test.describe("closing a day/range surfaces how many confirmed bookings already sit inside it", () => {
  test("POST /day-exceptions (single day) reports affectedBookings only when closing, not when opening", async ({
    request,
  }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");
    const date = nextWeekday(150);

    const booking = await request.post("/api/admin/bookings/manual", {
      headers: auth,
      data: { categoryId: haircut.id, date, time: "10:00", customerName: "تست هشدار تعطیلی", customerPhone: randomPhone() },
    });
    expect(booking.status(), await booking.text()).toBe(201);
    const bookingId = (await booking.json()).booking.id;

    try {
      const closed = await request.post("/api/admin/day-exceptions", { headers: auth, data: { date, isOpen: false } });
      expect(closed.status(), await closed.text()).toBe(201);
      expect((await closed.json()).affectedBookings).toBe(1);

      // the booking itself must still exist, untouched — this is a warning,
      // not an auto-cancel
      const stillThere = await request.get(`/api/admin/bookings?date=${date}`, { headers: auth });
      const rows = (await stillThere.json()).bookings;
      expect(rows.find((b: { id: string }) => b.id === bookingId).status).toBe("CONFIRMED");

      const reopened = await request.post("/api/admin/day-exceptions", { headers: auth, data: { date, isOpen: true } });
      expect(reopened.status(), await reopened.text()).toBe(201);
      expect((await reopened.json()).affectedBookings).toBe(0);
    } finally {
      await request.patch(`/api/admin/bookings/${bookingId}/status`, { headers: auth, data: { status: "CANCELLED" } });
      const exRes = await request.get(`/api/admin/day-exceptions?from=${date}&to=${date}`, { headers: auth });
      const ex = (await exRes.json()).exceptions[0];
      if (ex) await request.delete(`/api/admin/day-exceptions/${ex.id}`, { headers: auth });
    }
  });

  test("POST /day-exceptions/closure-range reports the total across every date in the range", async ({ request }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");
    const dateA = nextWeekday(153);
    const dateB = nextWeekday(155);

    const bookingA = await request.post("/api/admin/bookings/manual", {
      headers: auth,
      data: { categoryId: haircut.id, date: dateA, time: "10:00", customerName: "تست ۱", customerPhone: randomPhone() },
    });
    const bookingB = await request.post("/api/admin/bookings/manual", {
      headers: auth,
      data: { categoryId: haircut.id, date: dateB, time: "11:20", customerName: "تست ۲", customerPhone: randomPhone() },
    });
    expect(bookingA.status()).toBe(201);
    expect(bookingB.status()).toBe(201);
    const bookingAId = (await bookingA.json()).booking.id;
    const bookingBId = (await bookingB.json()).booking.id;

    try {
      const closed = await request.post("/api/admin/day-exceptions/closure-range", {
        headers: auth,
        data: { startDate: dateA, endDate: dateB },
      });
      expect(closed.status(), await closed.text()).toBe(201);
      expect((await closed.json()).affectedBookings).toBe(2);
    } finally {
      await request.patch(`/api/admin/bookings/${bookingAId}/status`, { headers: auth, data: { status: "CANCELLED" } });
      await request.patch(`/api/admin/bookings/${bookingBId}/status`, { headers: auth, data: { status: "CANCELLED" } });
      await request.delete(`/api/admin/day-exceptions/closure-range?startDate=${dateA}&endDate=${dateB}`, { headers: auth });
    }
  });
});
