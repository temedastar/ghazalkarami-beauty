import { test, expect } from "@playwright/test";
import fs from "fs";
import { testPool, randomPhone, nextWeekday } from "./helpers";
import { SERVER_LOG_PATH } from "../playwright.config";

test.describe("special slots (date-specific additions to the weekly pattern)", () => {
  test("a special slot appears only on its exact date, respects service scoping, and is protected from deletion once booked", async ({
    request,
  }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");

    // close enough that it lands within /next's own 20-result cap (haircut
    // alone has 7 seeded slots/weekday, so anything much further out would
    // already be past the cap before this one-off time is ever reached —
    // see the identical caveat in timeslot-per-service.spec.ts)
    const date = nextWeekday(2);
    const otherWeek = nextWeekday(9); // same weekday, one week later
    const time = "20:15"; // well past the normal seeded closing hours

    const created = await request.post("/api/admin/special-slots", {
      headers: adminAuth,
      data: { categoryId: haircut.id, date, time },
    });
    expect(created.status(), await created.text()).toBe(201);
    const slotId = (await created.json()).slot.id;

    try {
      const onDate = await request.get(`/api/availability?categoryKey=h&date=${date}`);
      expect((await onDate.json()).slots.some((s: { time: string }) => s.time === time)).toBe(true);

      // the exact same weekday, one week later, must NOT get this time —
      // it's a one-off for this date only, not a new weekly pattern entry
      const onOtherWeek = await request.get(`/api/availability?categoryKey=h&date=${otherWeek}`);
      expect((await onOtherWeek.json()).slots.some((s: { time: string }) => s.time === time)).toBe(false);

      const inNext = await request.get("/api/availability/next?categoryKey=h&limit=20");
      expect((await inNext.json()).slots.some((s: { date: string; time: string }) => s.date === date && s.time === time)).toBe(true);

      const booked = await request.post("/api/admin/bookings/manual", {
        headers: adminAuth,
        data: { categoryId: haircut.id, date, time, customerName: "تست اسلات ویژه", customerPhone: randomPhone() },
      });
      expect(booked.status(), await booked.text()).toBe(201);

      const blockedDelete = await request.delete(`/api/admin/special-slots/${slotId}`, { headers: adminAuth });
      expect(blockedDelete.status()).toBe(409);

      await request.patch(`/api/admin/bookings/${(await booked.json()).booking.id}/status`, {
        headers: adminAuth,
        data: { status: "CANCELLED" },
      });
    } finally {
      await request.delete(`/api/admin/special-slots/${slotId}`, { headers: adminAuth });
    }
  });

  test("service-exclusive special slots don't leak to a sibling service", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const chem = categories.find((c: { key: string }) => c.key === "chem");
    const keratin = chem.services.find((s: { key: string }) => s.key === "keratin");

    const date = nextWeekday(210);
    const time = "20:30";

    const created = await request.post("/api/admin/special-slots", {
      headers: adminAuth,
      data: { categoryId: chem.id, date, time, serviceId: keratin.id },
    });
    expect(created.status(), await created.text()).toBe(201);
    const slotId = (await created.json()).slot.id;

    try {
      const forKeratin = await request.get(`/api/availability?categoryKey=chem&serviceKey=keratin&date=${date}`);
      expect((await forKeratin.json()).slots.some((s: { time: string }) => s.time === time)).toBe(true);

      const forBotox = await request.get(`/api/availability?categoryKey=chem&serviceKey=botox&date=${date}`);
      expect((await forBotox.json()).slots.some((s: { time: string }) => s.time === time)).toBe(false);
    } finally {
      await request.delete(`/api/admin/special-slots/${slotId}`, { headers: adminAuth });
    }
  });

  test("past dates are rejected", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");

    const res = await request.post("/api/admin/special-slots", {
      headers: adminAuth,
      data: { categoryId: haircut.id, date: "2020-01-01", time: "10:00" },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe("service group (category) creation and reassignment", () => {
  test("a new group can be created, and a service can be moved into it, clearing its old exclusive slots back to shared", async ({
    request,
  }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const chem = categories.find((c: { key: string }) => c.key === "chem");
    const keratin = chem.services.find((s: { key: string }) => s.key === "keratin");

    const key = `test_group_${Date.now()}`;
    const createdCategory = await request.post("/api/admin/categories", {
      headers: adminAuth,
      data: { key, name: "گروه تست مستقل" },
    });
    expect(createdCategory.status(), await createdCategory.text()).toBe(201);
    const newCategoryId = (await createdCategory.json()).category.id;

    const dupe = await request.post("/api/admin/categories", { headers: adminAuth, data: { key, name: "دوباره" } });
    expect(dupe.status()).toBe(409);

    // give keratin an exclusive slot in its current (chem) category first
    const exclusiveSlot = await request.post("/api/admin/time-slots", {
      headers: adminAuth,
      data: { categoryId: chem.id, dayOfWeek: 1, time: "13:13", serviceId: keratin.id },
    });
    expect(exclusiveSlot.status(), await exclusiveSlot.text()).toBe(201);
    const slotId = (await exclusiveSlot.json()).slot.id;

    try {
      const moved = await request.patch(`/api/admin/services/${keratin.id}`, {
        headers: adminAuth,
        data: { categoryId: newCategoryId },
      });
      expect(moved.status(), await moved.text()).toBe(200);
      const movedBody = await moved.json();
      expect(movedBody.service.categoryId).toBe(newCategoryId);
      expect(movedBody.reassignedSlotCount).toBeGreaterThanOrEqual(1);

      // the old slot survives, but is no longer owned by keratin — it
      // reverted to shared within its original (chem) category rather than
      // silently going dark
      const refetched = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
      const stillChem = refetched.find((c: { id: string }) => c.id === chem.id);
      const survivingSlot = stillChem.timeSlots.find((s: { id: string }) => s.id === slotId);
      expect(survivingSlot).toBeTruthy();
      expect(survivingSlot.serviceId).toBeNull();
    } finally {
      await request.delete(`/api/admin/time-slots/${slotId}`, { headers: adminAuth });
      // move keratin back and remove the temporary group so neither
      // pollutes shared seed data for other tests (e.g. block-range tests
      // that iterate "every category")
      await request.patch(`/api/admin/services/${keratin.id}`, { headers: adminAuth, data: { categoryId: chem.id } });
      await request.delete(`/api/admin/categories/${newCategoryId}`, { headers: adminAuth });
    }
  });

  test("a category still in use (has a service on it) cannot be deleted", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");

    const res = await request.delete(`/api/admin/categories/${haircut.id}`, { headers: adminAuth });
    expect(res.status()).toBe(409);
  });
});

test.describe("manual refund workflow", () => {
  test("dashboard exposes a pendingRefundCount, and /admin/refunds/pending lists both eligible and forfeited cancellations with card details", async ({
    request,
  }) => {
    const token = testPool().customers[7].token;
    const auth = { Authorization: `Bearer ${token}` };
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const date = nextWeekday(220);

    const before = await request.get("/api/admin/dashboard", { headers: adminAuth });
    const countBefore = (await before.json()).pendingRefundCount;

    const booking = await request.post("/api/bookings", {
      headers: auth,
      data: { serviceKey: "haircut", date, time: "14:30", womenOnlyConfirmed: true },
    });
    expect(booking.status(), await booking.text()).toBe(201);
    const bookingId = (await booking.json()).booking.id;

    const paymentReq = await request.post("/api/payments/zarinpal/request", { headers: auth, data: { bookingId } });
    const { paymentUrl } = await paymentReq.json();
    await request.get(paymentUrl);

    const cancel = await request.delete(`/api/bookings/${bookingId}`, {
      headers: auth,
      data: { refundCardNumber: "6219861234567890", refundCardHolder: "آزمون بازگشت وجه" },
    });
    expect(cancel.status(), await cancel.text()).toBe(200);

    const after = await request.get("/api/admin/dashboard", { headers: adminAuth });
    const countAfter = (await after.json()).pendingRefundCount;
    expect(countAfter).toBe(countBefore + 1);

    const pendingRes = await request.get("/api/admin/refunds/pending", { headers: adminAuth });
    expect(pendingRes.status(), await pendingRes.text()).toBe(200);
    const { payments } = await pendingRes.json();
    const entry = payments.find((p: { booking: { id: string } }) => p.booking.id === bookingId);
    expect(entry).toBeTruthy();
    expect(entry.refundStatus).toBe("NEEDS_MANUAL_FOLLOWUP");
    expect(entry.refundCardNumber).toBe("6219861234567890");
    expect(entry.refundCardHolder).toBe("آزمون بازگشت وجه");

    const resolved = await request.patch(`/api/admin/payments/${entry.id}/refund-status`, {
      headers: adminAuth,
      data: { refundStatus: "SUCCEEDED" },
    });
    expect(resolved.status(), await resolved.text()).toBe(200);

    // resolved refunds drop out of the pending list
    const afterResolve = await request.get("/api/admin/refunds/pending", { headers: adminAuth });
    const stillThere = (await afterResolve.json()).payments.some((p: { booking: { id: string } }) => p.booking.id === bookingId);
    expect(stillThere).toBe(false);
  });

  test("admin cancelling an eligible CONFIRMED+PAID booking also requires card details", async ({ request }) => {
    const token = testPool().customers[0].token;
    const auth = { Authorization: `Bearer ${token}` };
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const date = nextWeekday(225);

    const booking = await request.post("/api/bookings", {
      headers: auth,
      data: { serviceKey: "haircut", date, time: "15:45", womenOnlyConfirmed: true },
    });
    const bookingId = (await booking.json()).booking.id;

    const paymentReq = await request.post("/api/payments/zarinpal/request", { headers: auth, data: { bookingId } });
    const { paymentUrl } = await paymentReq.json();
    await request.get(paymentUrl);

    const missingCard = await request.patch(`/api/admin/bookings/${bookingId}/status`, {
      headers: adminAuth,
      data: { status: "CANCELLED" },
    });
    expect(missingCard.status(), await missingCard.text()).toBe(400);

    const withCard = await request.patch(`/api/admin/bookings/${bookingId}/status`, {
      headers: adminAuth,
      data: { status: "CANCELLED", refundCardNumber: "5022291234567890", refundCardHolder: "غزل کرمی" },
    });
    expect(withCard.status(), await withCard.text()).toBe(200);
  });

  test("an eligible cancellation notifies the owner's phone with the customer's name and the appointment date (Kavenegar rejects a template with zero tokens)", async ({
    request,
  }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const token = testPool().customers[1].token;
    const auth = { Authorization: `Bearer ${token}` };
    const date = nextWeekday(230);

    const settingsBefore = (await (await request.get("/api/admin/settings", { headers: adminAuth })).json()).settings;
    const ownerPhone = randomPhone();
    await request.patch("/api/admin/settings", { headers: adminAuth, data: { ownerNotifyPhone: ownerPhone } });

    try {
      const booking = await request.post("/api/bookings", {
        headers: auth,
        data: { serviceKey: "haircut", date, time: "10:00", womenOnlyConfirmed: true },
      });
      const bookingId = (await booking.json()).booking.id;

      const paymentReq = await request.post("/api/payments/zarinpal/request", { headers: auth, data: { bookingId } });
      const { paymentUrl } = await paymentReq.json();
      await request.get(paymentUrl);

      await request.delete(`/api/bookings/${bookingId}`, {
        headers: auth,
        data: { refundCardNumber: "6104331234567890", refundCardHolder: "تست اطلاع‌رسانی" },
      });

      // sendLookup logs a dev-mode line (no live Kavenegar credentials in
      // this environment) instead of failing — see services/kavenegar.ts
      let logLine: string | undefined;
      for (let attempt = 0; attempt < 20 && !logLine; attempt++) {
        const log = fs.readFileSync(SERVER_LOG_PATH, "utf8");
        logLine = log
          .split("\n")
          .reverse()
          .find((l) => l.includes(`would send CANCEL_NOTIFY to ${ownerPhone}`));
        if (!logLine) await new Promise((r) => setTimeout(r, 150));
      }
      expect(logLine, "expected a dev-mode CANCEL_NOTIFY log line").toBeTruthy();
      // sanitizeToken() (space -> hyphen) only runs on the real Kavenegar
      // HTTP request, not this dev-mode log line — it logs the raw tokens
      expect(logLine).toContain("مشتری تست 2"); // customers[1]'s seeded name
      expect(logLine).toMatch(/[۰-۹]{4}/); // Jalali year, as part of the date token
    } finally {
      await request.patch("/api/admin/settings", {
        headers: adminAuth,
        data: { ownerNotifyPhone: settingsBefore.ownerNotifyPhone ?? null },
      });
    }
  });
});
