import { test, expect } from "@playwright/test";
import { testPool, randomPhone, nextWeekday } from "./helpers";

// Booking has no foreign key to TimeSlot — it only shares categoryId+date+
// time by convention — so nothing at the DB level ever stopped deleting a
// slot (or renaming its `time`, which is really the same slot losing its
// old identity) out from under a future confirmed booking sitting on it.
// PATCH/DELETE /admin/time-slots/:id now check for that first.
test.describe("time-slot delete/edit is blocked when a future booking depends on it", () => {
  test("deleting a slot with a future CONFIRMED booking on it is rejected; deleting an empty one still works", async ({
    request,
  }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");
    const date = nextWeekday(140);
    const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
    const time = "10:00";

    const slot = haircut.timeSlots.find((s: { dayOfWeek: number; time: string }) => s.dayOfWeek === dayOfWeek && s.time === time);
    expect(slot, "seed data must include a haircut 10:00 slot on this weekday").toBeTruthy();

    const booking = await request.post("/api/admin/bookings/manual", {
      headers: auth,
      data: { categoryId: haircut.id, date, time, customerName: "تست حذف اسلات", customerPhone: randomPhone() },
    });
    expect(booking.status(), await booking.text()).toBe(201);
    const bookingId = (await booking.json()).booking.id;

    try {
      const del = await request.delete(`/api/admin/time-slots/${slot.id}`, { headers: auth });
      expect(del.status(), await del.text()).toBe(409);

      const rename = await request.patch(`/api/admin/time-slots/${slot.id}`, { headers: auth, data: { time: "10:15" } });
      expect(rename.status(), await rename.text()).toBe(409);

      // deactivating (not deleting/renaming) is unaffected — it only gates
      // *new* bookings, so it stays safe with an existing one in place
      const deactivate = await request.patch(`/api/admin/time-slots/${slot.id}`, { headers: auth, data: { isActive: false } });
      expect(deactivate.status(), await deactivate.text()).toBe(200);
      await request.patch(`/api/admin/time-slots/${slot.id}`, { headers: auth, data: { isActive: true } });
    } finally {
      await request.patch(`/api/admin/bookings/${bookingId}/status`, { headers: auth, data: { status: "CANCELLED" } });
    }

    const delAfterCancel = await request.delete(`/api/admin/time-slots/${slot.id}`, { headers: auth });
    expect(delAfterCancel.status(), await delAfterCancel.text()).toBe(200);

    // put the slot back so the seed data isn't left permanently mutated for
    // any other test/run that depends on the same haircut 10:00 grid cell
    await request.post("/api/admin/time-slots", { headers: auth, data: { categoryId: haircut.id, dayOfWeek, time } });
  });
});
