import { test, expect } from "@playwright/test";
import { testPool, randomPhone, nextWeekday } from "./helpers";
import { connectToTestDatabase } from "./dbSafety";

// The 15-min hold on a PENDING_PAYMENT booking can expire (its SlotHold row
// deleted by jobs/expireHolds.ts) while ZarinPal's own redirect back to our
// callback is merely slow, not actually abandoned. The callback used to
// blindly mark such a booking CONFIRMED+PAID without checking whether its
// slot was still free — if someone else had taken that exact category/date/
// time in the meantime, this would silently create a second CONFIRMED
// booking on a slot the SlotHold unique constraint is supposed to make
// impossible to double-book. The callback now re-acquires the SlotHold
// atomically before confirming, and refunds in full (not subject to the 48h
// late-cancellation policy — this is a system race, not the customer
// changing their mind) if that re-acquisition loses.
test.describe("ZarinPal callback: re-acquires the slot before confirming, refunds if it lost the race", () => {
  test("a delayed callback that arrives after the hold expired and someone else took the slot cancels + refunds instead of double-booking", async ({
    request,
  }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const customerToken = testPool().customers[0].token;
    const customerAuth = { Authorization: `Bearer ${customerToken}` };
    const date = nextWeekday(160);

    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");

    const booking = await request.post("/api/bookings", {
      headers: customerAuth,
      data: { serviceKey: "haircut", date, time: "11:20", womenOnlyConfirmed: true },
    });
    expect(booking.status(), await booking.text()).toBe(201);
    const bookingId = (await booking.json()).booking.id;

    const paymentReq = await request.post("/api/payments/zarinpal/request", {
      headers: customerAuth,
      data: { bookingId },
    });
    expect(paymentReq.status(), await paymentReq.text()).toBe(200);
    const { paymentUrl } = await paymentReq.json();
    const authority = new URL(paymentUrl).searchParams.get("Authority")!;
    expect(authority).toBeTruthy();

    // simulate the 15-min hold expiring (jobs/expireHolds.ts's own effect)
    // and someone else immediately taking the now-free slot — done via a
    // direct, safety-checked test-DB connection since there's no API for
    // "delete a specific SlotHold row" (nothing should ever need one)
    const testDb = await connectToTestDatabase();
    let competingBookingId: string;
    try {
      await testDb.slotHold.deleteMany({ where: { bookingId } });
      await testDb.booking.update({ where: { id: bookingId }, data: { status: "EXPIRED" } });
    } finally {
      await testDb.$disconnect();
    }

    const competing = await request.post("/api/admin/bookings/manual", {
      headers: adminAuth,
      data: { categoryId: haircut.id, date, time: "11:20", customerName: "رقیب", customerPhone: randomPhone() },
    });
    expect(competing.status(), await competing.text()).toBe(201);
    competingBookingId = (await competing.json()).booking.id;

    // now the delayed callback finally arrives
    const callback = await request.get(
      `/api/payments/zarinpal/callback?bookingId=${bookingId}&Authority=${authority}&Status=OK`,
      { maxRedirects: 0 }
    );
    expect(callback.status()).toBe(302);
    expect(callback.headers()["location"]).toContain("payment=slot_taken");

    const bookingsRes = await request.get(`/api/admin/bookings?date=${date}`, { headers: adminAuth });
    const rows = (await bookingsRes.json()).bookings;
    const raced = rows.find((b: { id: string }) => b.id === bookingId);
    const competitor = rows.find((b: { id: string }) => b.id === competingBookingId);

    // the payment was genuinely captured — must be recorded as PAID so a
    // refund is actually tracked, even though the booking itself is lost
    expect(raced.status).toBe("CANCELLED");
    expect(raced.payment.status).toBe("PAID");
    // no live ZarinPal refund credentials in this environment (see
    // services/zarinpalRefund.ts) — every refund attempt lands here for now
    expect(raced.payment.refundStatus).toBe("NEEDS_MANUAL_FOLLOWUP");

    // the slot the competitor actually holds must be completely undisturbed
    expect(competitor.status).toBe("CONFIRMED");
  });

  test("a delayed callback that arrives before anyone else takes the slot still confirms normally", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const customerToken = testPool().customers[1].token;
    const customerAuth = { Authorization: `Bearer ${customerToken}` };
    const date = nextWeekday(163);

    const booking = await request.post("/api/bookings", {
      headers: customerAuth,
      data: { serviceKey: "haircut", date, time: "12:45", womenOnlyConfirmed: true },
    });
    const bookingId = (await booking.json()).booking.id;

    const paymentReq = await request.post("/api/payments/zarinpal/request", {
      headers: customerAuth,
      data: { bookingId },
    });
    const { paymentUrl } = await paymentReq.json();
    const authority = new URL(paymentUrl).searchParams.get("Authority")!;

    // hold expired, but nobody took the slot in the meantime
    const testDb = await connectToTestDatabase();
    try {
      await testDb.slotHold.deleteMany({ where: { bookingId } });
      await testDb.booking.update({ where: { id: bookingId }, data: { status: "EXPIRED" } });
    } finally {
      await testDb.$disconnect();
    }

    const callback = await request.get(
      `/api/payments/zarinpal/callback?bookingId=${bookingId}&Authority=${authority}&Status=OK`,
      { maxRedirects: 0 }
    );
    expect(callback.status()).toBe(302);
    expect(callback.headers()["location"]).toContain("payment=success");

    const bookingsRes = await request.get(`/api/admin/bookings?date=${date}`, { headers: adminAuth });
    const rows = (await bookingsRes.json()).bookings;
    const recovered = rows.find((b: { id: string }) => b.id === bookingId);
    expect(recovered.status).toBe("CONFIRMED");
    expect(recovered.payment.status).toBe("PAID");
  });
});
