import { test, expect } from "@playwright/test";
import { testPool, randomPhone, nextWeekday } from "./helpers";
import { isRefundEligible, hoursUntilAppointment, REFUND_ELIGIBLE_HOURS } from "../src/lib/cancellationPolicy";

// the exact 48h boundary is tested against a fixed `now` here rather than
// real wall-clock time — a live E2E hitting that precise boundary would
// depend on which weekday/time-of-day the suite happens to run (Fri/Sat are
// closed, so "less than 48h from now" isn't reliably bookable at every run
// time); the real API wiring for both branches is exercised below with the
// pool's real accounts instead, using a booking far enough in the future to
// be unambiguously eligible no matter when the suite runs.
test.describe("cancellation policy: 48h refund-eligibility math", () => {
  test("exactly at the boundary and on either side of it", () => {
    const now = new Date("2026-01-10T12:00:00.000Z");
    const date = new Date(Date.UTC(2026, 0, 12)); // Jan 12

    expect(REFUND_ELIGIBLE_HOURS).toBe(48);

    // Jan 12 12:00 UTC is exactly 48h after Jan 10 12:00 UTC
    expect(hoursUntilAppointment(date, "12:00", now)).toBe(48);
    expect(isRefundEligible(date, "12:00", now)).toBe(true);

    // one minute short of 48h -> not eligible
    expect(isRefundEligible(date, "11:59", now)).toBe(false);

    // one minute past 48h -> eligible
    expect(isRefundEligible(date, "12:01", now)).toBe(true);
  });
});

test.describe("cancelling a CONFIRMED+PAID booking", () => {
  test("far enough in the future: refund is attempted (needs manual follow-up without live ZarinPal refund credentials)", async ({
    request,
  }) => {
    const token = testPool().customers[2].token;
    const auth = { Authorization: `Bearer ${token}` };
    const date = nextWeekday(60);

    const booking = await request.post("/api/bookings", {
      headers: auth,
      data: { serviceKey: "haircut", date, time: "17:00" },
    });
    expect(booking.status(), await booking.text()).toBe(201);
    const bookingId = (await booking.json()).booking.id;

    const paymentReq = await request.post("/api/payments/zarinpal/request", { headers: auth, data: { bookingId } });
    const { paymentUrl } = await paymentReq.json();
    await request.get(paymentUrl); // dev-mode auto-approves -> CONFIRMED + PAID

    const cancel = await request.delete(`/api/bookings/${bookingId}`, { headers: auth });
    expect(cancel.status(), await cancel.text()).toBe(200);
    const body = await cancel.json();
    // NOT "succeeded" — there are no live ZarinPal refund credentials in
    // this environment (see services/zarinpalRefund.ts), so an eligible
    // cancellation always lands here for now
    expect(body.refund).toBe("needs_manual_followup");
  });

  test("admin can resolve a needs-manual-followup refund, and a resolved one can't be resolved twice", async ({
    request,
  }) => {
    const token = testPool().customers[3].token;
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const date = nextWeekday(61);

    const booking = await request.post("/api/bookings", {
      headers: { Authorization: `Bearer ${token}` },
      data: { serviceKey: "haircut", date, time: "18:30" },
    });
    const bookingId = (await booking.json()).booking.id;

    const paymentReq = await request.post("/api/payments/zarinpal/request", {
      headers: { Authorization: `Bearer ${token}` },
      data: { bookingId },
    });
    const { paymentUrl } = await paymentReq.json();
    await request.get(paymentUrl);

    await request.delete(`/api/bookings/${bookingId}`, { headers: { Authorization: `Bearer ${token}` } });

    const bookingsRes = await request.get("/api/admin/bookings", { headers: adminAuth });
    const { bookings } = await bookingsRes.json();
    const cancelled = bookings.find((b: { id: string }) => b.id === bookingId);
    expect(cancelled.payment.refundStatus).toBe("NEEDS_MANUAL_FOLLOWUP");

    const resolve = await request.patch(`/api/admin/payments/${cancelled.payment.id}/refund-status`, {
      headers: adminAuth,
      data: { refundStatus: "SUCCEEDED" },
    });
    expect(resolve.status(), await resolve.text()).toBe(200);
    expect((await resolve.json()).payment.refundStatus).toBe("SUCCEEDED");

    const resolveAgain = await request.patch(`/api/admin/payments/${cancelled.payment.id}/refund-status`, {
      headers: adminAuth,
      data: { refundStatus: "SUCCEEDED" },
    });
    expect(resolveAgain.status()).toBe(400);
  });

  test("a non-admin cannot resolve a refund", async ({ request }) => {
    const token = testPool().customers[4].token;
    const res = await request.patch("/api/admin/payments/does-not-matter/refund-status", {
      headers: { Authorization: `Bearer ${token}` },
      data: { refundStatus: "SUCCEEDED" },
    });
    expect(res.status()).toBe(403);
  });
});

test("cancelling a PENDING_PAYMENT (never-paid) booking never touches refund fields", async ({ request }) => {
  const token = testPool().customers[5].token;
  const auth = { Authorization: `Bearer ${token}` };
  const date = nextWeekday(62);

  const booking = await request.post("/api/bookings", { headers: auth, data: { serviceKey: "haircut", date, time: "10:00" } });
  const bookingId = (await booking.json()).booking.id;

  const cancel = await request.delete(`/api/bookings/${bookingId}`, { headers: auth });
  expect(cancel.status(), await cancel.text()).toBe(200);
  expect((await cancel.json()).refund).toBe("not_applicable");
});
