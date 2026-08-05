import { test, expect } from "@playwright/test";
import { testPool, nextWeekday } from "./helpers";

// The booking form's checkbox is only ever a frontend suggestion — a direct
// API call bypassing it must be rejected server-side too, with a specific
// enough message that it can't be confused with a generic validation error.
test.describe("women-only salon confirmation", () => {
  test("a booking request without womenOnlyConfirmed is rejected", async ({ request }) => {
    const token = testPool().customers[0].token;
    const date = nextWeekday(70);

    const omitted = await request.post("/api/bookings", {
      headers: { Authorization: `Bearer ${token}` },
      data: { serviceKey: "haircut", date, time: "10:00" },
    });
    expect(omitted.status()).toBe(400);
    expect((await omitted.json()).error).toContain("مخصوص بانوان");

    const explicitFalse = await request.post("/api/bookings", {
      headers: { Authorization: `Bearer ${token}` },
      data: { serviceKey: "haircut", date, time: "10:00", womenOnlyConfirmed: false },
    });
    expect(explicitFalse.status()).toBe(400);
    expect((await explicitFalse.json()).error).toContain("مخصوص بانوان");
  });

  test("a booking request with womenOnlyConfirmed:true succeeds and records the confirmation timestamp", async ({
    request,
  }) => {
    const token = testPool().customers[1].token;
    const date = nextWeekday(70);

    const res = await request.post("/api/bookings", {
      headers: { Authorization: `Bearer ${token}` },
      data: { serviceKey: "haircut", date, time: "11:20", womenOnlyConfirmed: true },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    expect(body.booking.womenOnlyConfirmedAt).toBeTruthy();
    // recorded at booking-creation time, not some far-off/default value
    const confirmedAt = new Date(body.booking.womenOnlyConfirmedAt).getTime();
    expect(Math.abs(Date.now() - confirmedAt)).toBeLessThan(60_000);
  });
});
