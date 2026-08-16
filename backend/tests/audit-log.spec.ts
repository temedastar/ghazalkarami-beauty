import { test, expect } from "@playwright/test";
import { testPool, nextWeekday } from "./helpers";

// "تاریخچه‌ی اقدامات" — a plain activity feed so Ghazal can answer "چرا این
// نوبت لغو شد؟" or "کِی این روز رو بستم؟" without digging through raw data.
// This exercises that the highest-value mutations actually write a readable
// entry, not every single one (see lib/auditLog.ts / routes/admin.ts).
test.describe("audit log", () => {
  test("day-exception open/close is logged", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const date = nextWeekday(300);

    const created = await request.post("/api/admin/day-exceptions", {
      headers: adminAuth,
      data: { date, isOpen: false, reason: "تست بازبینی" },
    });
    expect(created.status(), await created.text()).toBe(201);

    try {
      const { logs } = await (await request.get("/api/admin/audit-log?limit=20", { headers: adminAuth })).json();
      const entry = logs.find((l: { action: string; description: string }) => l.action === "DAY_EXCEPTION_SET" && l.description.includes("تست بازبینی"));
      expect(entry, "expected a DAY_EXCEPTION_SET log entry mentioning the reason").toBeTruthy();
      expect(entry.description).toContain("تعطیل شد");
      expect(entry.actorLabel).toBeTruthy();
    } finally {
      const { exceptions } = await (await request.get(`/api/admin/day-exceptions?from=${date}&to=${date}`, { headers: adminAuth })).json();
      for (const e of exceptions) await request.delete(`/api/admin/day-exceptions/${e.id}`, { headers: adminAuth });
    }
  });

  test("a customer cancelling their own booking is logged with their name, not a generic actor", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const token = testPool().customers[2].token;
    const auth = { Authorization: `Bearer ${token}` };
    const date = nextWeekday(301);

    const booking = await request.post("/api/bookings", {
      headers: auth,
      data: { serviceKey: "haircut", date, time: "10:00", womenOnlyConfirmed: true },
    });
    expect(booking.status(), await booking.text()).toBe(201);
    const bookingId = (await booking.json()).booking.id;

    const cancel = await request.delete(`/api/bookings/${bookingId}`, { headers: auth });
    expect(cancel.status(), await cancel.text()).toBe(200);

    const { logs } = await (await request.get("/api/admin/audit-log?limit=20", { headers: adminAuth })).json();
    const entry = logs.find((l: { action: string }) => l.action === "BOOKING_CANCELLED");
    expect(entry, "expected a BOOKING_CANCELLED log entry").toBeTruthy();
    expect(entry.description).toContain("هیرکات");
    expect(entry.actorLabel).not.toBe("سیستم");
    expect(entry.actorLabel).not.toBe("ادمین");
  });

  test("marking a manual-followup refund as paid is logged", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const token = testPool().customers[3].token;
    const auth = { Authorization: `Bearer ${token}` };
    const date = nextWeekday(302);

    const booking = await request.post("/api/bookings", {
      headers: auth,
      data: { serviceKey: "haircut", date, time: "11:20", womenOnlyConfirmed: true },
    });
    const bookingId = (await booking.json()).booking.id;
    const paymentReq = await request.post("/api/payments/zarinpal/request", { headers: auth, data: { bookingId } });
    const { paymentUrl } = await paymentReq.json();
    await request.get(paymentUrl);

    await request.delete(`/api/bookings/${bookingId}`, {
      headers: auth,
      data: { refundCardNumber: "6037991234567890", refundCardHolder: "تست بازبینی" },
    });

    const pendingRes = await request.get("/api/admin/refunds/pending", { headers: adminAuth });
    const { payments } = await pendingRes.json();
    const entry = payments.find((p: { booking: { id: string } }) => p.booking.id === bookingId);
    expect(entry).toBeTruthy();

    const resolved = await request.patch(`/api/admin/payments/${entry.id}/refund-status`, {
      headers: adminAuth,
      data: { refundStatus: "SUCCEEDED" },
    });
    expect(resolved.status(), await resolved.text()).toBe(200);

    const { logs } = await (await request.get("/api/admin/audit-log?limit=20", { headers: adminAuth })).json();
    const logEntry = logs.find((l: { action: string }) => l.action === "REFUND_RESOLVED");
    expect(logEntry, "expected a REFUND_RESOLVED log entry").toBeTruthy();
    expect(logEntry.description).toContain("پرداخت شد");
  });

  test("a non-admin cannot read the audit log", async ({ request }) => {
    const token = testPool().customers[4].token;
    const res = await request.get("/api/admin/audit-log", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status()).toBe(403);
  });
});
