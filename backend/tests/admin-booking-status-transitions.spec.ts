import { test, expect } from "@playwright/test";
import { testPool, randomPhone, nextWeekday } from "./helpers";

// PATCH /admin/bookings/:id/status used to accept any status from any
// status with zero checks: a never-paid PENDING_PAYMENT booking could be
// marked COMPLETED (firing the customer thank-you/review SMS for a service
// that was never actually paid for or performed), and a CANCELLED booking
// could be flipped back to CONFIRMED without ever recreating its deleted
// SlotHold — silently allowing the same slot to be double-booked. This
// exercises the transition map that now guards the route directly (the
// admin panel's own dropdown already limits itself to valid choices, so
// this is the direct-API path a normal admin session never takes).
test.describe("admin booking status transitions", () => {
  test("a PENDING_PAYMENT booking can only be moved to CANCELLED, not COMPLETED or NO_SHOW", async ({ request }) => {
    const token = testPool().customers[6].token;
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const date = nextWeekday(120);

    const booking = await request.post("/api/bookings", {
      headers: { Authorization: `Bearer ${token}` },
      data: { serviceKey: "haircut", date, time: "10:00", womenOnlyConfirmed: true },
    });
    expect(booking.status(), await booking.text()).toBe(201);
    const bookingId = (await booking.json()).booking.id;

    const toCompleted = await request.patch(`/api/admin/bookings/${bookingId}/status`, {
      headers: adminAuth,
      data: { status: "COMPLETED" },
    });
    expect(toCompleted.status()).toBe(409);

    const toNoShow = await request.patch(`/api/admin/bookings/${bookingId}/status`, {
      headers: adminAuth,
      data: { status: "NO_SHOW" },
    });
    expect(toNoShow.status()).toBe(409);

    const toCancelled = await request.patch(`/api/admin/bookings/${bookingId}/status`, {
      headers: adminAuth,
      data: { status: "CANCELLED" },
    });
    expect(toCancelled.status(), await toCancelled.text()).toBe(200);
  });

  test("a CANCELLED booking can never be moved to any other status (no un-cancelling without a SlotHold)", async ({
    request,
  }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");
    const date = nextWeekday(123);

    const created = await request.post("/api/admin/bookings/manual", {
      headers: adminAuth,
      data: { categoryId: haircut.id, date, time: "11:00", customerName: "تست لغو", customerPhone: randomPhone() },
    });
    expect(created.status(), await created.text()).toBe(201);
    const bookingId = (await created.json()).booking.id;

    const cancelled = await request.patch(`/api/admin/bookings/${bookingId}/status`, {
      headers: adminAuth,
      data: { status: "CANCELLED" },
    });
    expect(cancelled.status(), await cancelled.text()).toBe(200);

    const unCancel = await request.patch(`/api/admin/bookings/${bookingId}/status`, {
      headers: adminAuth,
      data: { status: "CONFIRMED" },
    });
    expect(unCancel.status()).toBe(409);
  });

  test("a COMPLETED booking cannot be moved again (guards against re-firing the thank-you SMS)", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");
    const date = nextWeekday(126);

    const created = await request.post("/api/admin/bookings/manual", {
      headers: adminAuth,
      data: { categoryId: haircut.id, date, time: "11:00", customerName: "تست انجام‌شده", customerPhone: randomPhone() },
    });
    const bookingId = (await created.json()).booking.id;

    const completed = await request.patch(`/api/admin/bookings/${bookingId}/status`, {
      headers: adminAuth,
      data: { status: "COMPLETED" },
    });
    expect(completed.status(), await completed.text()).toBe(200);

    const again = await request.patch(`/api/admin/bookings/${bookingId}/status`, {
      headers: adminAuth,
      data: { status: "NO_SHOW" },
    });
    expect(again.status()).toBe(409);
  });

  test("a CONFIRMED booking can still be moved to COMPLETED, NO_SHOW, or CANCELLED", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");
    const date = nextWeekday(129);

    const created = await request.post("/api/admin/bookings/manual", {
      headers: adminAuth,
      data: { categoryId: haircut.id, date, time: "11:00", customerName: "تست عدم حضور", customerPhone: randomPhone() },
    });
    const bookingId = (await created.json()).booking.id;

    const noShow = await request.patch(`/api/admin/bookings/${bookingId}/status`, {
      headers: adminAuth,
      data: { status: "NO_SHOW" },
    });
    expect(noShow.status(), await noShow.text()).toBe(200);
  });
});
