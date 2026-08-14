import { test, expect } from "@playwright/test";
import { testPool, nextWeekday } from "./helpers";

// TimeSlot.serviceId lets a slot be exclusive to one service within a
// shared-line category (e.g. کراتینه only at a given time, پروتئین‌تراپی
// only at another) instead of every slot being offered to every service in
// the category. serviceId:null (unchanged default) still means "offered to
// everyone" — SlotHold itself is untouched (still keyed on categoryId, not
// serviceId), so the shared-line conflict guarantee doesn't move at all;
// this only changes which services a given time is ever *offered* to.
test.describe("per-service TimeSlot scoping", () => {
  test("a service-exclusive slot appears in that service's availability, not a sibling service's, and not the no-serviceKey default", async ({
    request,
  }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const chem = categories.find((c: { key: string }) => c.key === "chem");
    const keratin = chem.services.find((s: { key: string }) => s.key === "keratin");

    const date = nextWeekday(170);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const time = "11:37"; // unusual, unlikely to collide with seeded slots

    const created = await request.post("/api/admin/time-slots", {
      headers: adminAuth,
      data: { categoryId: chem.id, dayOfWeek: dow, time, serviceId: keratin.id },
    });
    expect(created.status(), await created.text()).toBe(201);
    const slotId = (await created.json()).slot.id;

    try {
      const forKeratin = await request.get(`/api/availability?categoryKey=chem&serviceKey=keratin&date=${date}`);
      const keratinSlot = (await forKeratin.json()).slots.find((s: { time: string }) => s.time === time);
      expect(keratinSlot, "keratin should be offered its own exclusive slot").toBeTruthy();
      expect(keratinSlot.available).toBe(true);

      const forProteinTherapy = await request.get(`/api/availability?categoryKey=chem&serviceKey=protein_therapy&date=${date}`);
      expect((await forProteinTherapy.json()).slots.some((s: { time: string }) => s.time === time)).toBe(false);

      const noServiceKey = await request.get(`/api/availability?categoryKey=chem&date=${date}`);
      expect((await noServiceKey.json()).slots.some((s: { time: string }) => s.time === time)).toBe(false);
    } finally {
      await request.delete(`/api/admin/time-slots/${slotId}`, { headers: adminAuth });
    }
  });

  test("GET /api/availability/next respects the same per-service scoping", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const chem = categories.find((c: { key: string }) => c.key === "chem");
    const botox = chem.services.find((s: { key: string }) => s.key === "botox");

    // /next only ever returns up to 20 results (its own hard cap), so the
    // exclusive slot has to land within the very first few candidate days —
    // chem already has ~4 category-wide slots per weekday from seed data,
    // easily filling a 20-result budget within a week if this were placed
    // further out
    const date = nextWeekday(1);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const time = "11:41";

    const created = await request.post("/api/admin/time-slots", {
      headers: adminAuth,
      data: { categoryId: chem.id, dayOfWeek: dow, time, serviceId: botox.id },
    });
    expect(created.status(), await created.text()).toBe(201);
    const slotId = (await created.json()).slot.id;

    try {
      const forBotox = await request.get("/api/availability/next?categoryKey=chem&serviceKey=botox&limit=20");
      expect((await forBotox.json()).slots.some((s: { date: string; time: string }) => s.date === date && s.time === time)).toBe(true);

      const forKeratin = await request.get("/api/availability/next?categoryKey=chem&serviceKey=keratin&limit=20");
      expect((await forKeratin.json()).slots.some((s: { date: string; time: string }) => s.date === date && s.time === time)).toBe(false);
    } finally {
      await request.delete(`/api/admin/time-slots/${slotId}`, { headers: adminAuth });
    }
  });

  test("booking a service-exclusive slot still locks it via the same categoryId+date+time SlotHold, and the sibling service's own separate time is unaffected", async ({
    request,
  }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const chem = categories.find((c: { key: string }) => c.key === "chem");
    const keratin = chem.services.find((s: { key: string }) => s.key === "keratin");
    const proteinTherapy = chem.services.find((s: { key: string }) => s.key === "protein_therapy");

    const date = nextWeekday(176);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const keratinTime = "11:44";
    const proteinTime = "11:52";

    const keratinSlot = await request.post("/api/admin/time-slots", {
      headers: adminAuth,
      data: { categoryId: chem.id, dayOfWeek: dow, time: keratinTime, serviceId: keratin.id },
    });
    const proteinSlot = await request.post("/api/admin/time-slots", {
      headers: adminAuth,
      data: { categoryId: chem.id, dayOfWeek: dow, time: proteinTime, serviceId: proteinTherapy.id },
    });
    expect(keratinSlot.status(), await keratinSlot.text()).toBe(201);
    expect(proteinSlot.status(), await proteinSlot.text()).toBe(201);
    const keratinSlotId = (await keratinSlot.json()).slot.id;
    const proteinSlotId = (await proteinSlot.json()).slot.id;

    try {
      const booked = await request.post("/api/admin/bookings/manual", {
        headers: adminAuth,
        data: { categoryId: chem.id, serviceId: keratin.id, date, time: keratinTime, reason: "تست" },
      });
      expect(booked.status(), await booked.text()).toBe(201);

      // keratin's own time is now taken
      const afterKeratin = await request.get(`/api/availability?categoryKey=chem&serviceKey=keratin&date=${date}`);
      const keratinAfter = (await afterKeratin.json()).slots.find((s: { time: string }) => s.time === keratinTime);
      expect(keratinAfter.available).toBe(false);

      // protein_therapy's own, separate exclusive time is completely untouched
      const afterProtein = await request.get(`/api/availability?categoryKey=chem&serviceKey=protein_therapy&date=${date}`);
      const proteinAfter = (await afterProtein.json()).slots.find((s: { time: string }) => s.time === proteinTime);
      expect(proteinAfter.available).toBe(true);
    } finally {
      const bookingsRes = await request.get(`/api/admin/bookings?date=${date}`, { headers: adminAuth });
      const rows = (await bookingsRes.json()).bookings.filter((b: { categoryId: string }) => b.categoryId === chem.id);
      for (const b of rows) {
        await request.patch(`/api/admin/bookings/${b.id}/status`, { headers: adminAuth, data: { status: "CANCELLED" } });
      }
      await request.delete(`/api/admin/time-slots/${keratinSlotId}`, { headers: adminAuth });
      await request.delete(`/api/admin/time-slots/${proteinSlotId}`, { headers: adminAuth });
    }
  });

  test("creating or patching a slot with a serviceId from a different category is rejected", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const chem = categories.find((c: { key: string }) => c.key === "chem");
    const haircut = categories.find((c: { key: string }) => c.key === "h");
    const haircutService = haircut.services.find((s: { key: string }) => s.key === "haircut");

    const mismatched = await request.post("/api/admin/time-slots", {
      headers: adminAuth,
      data: { categoryId: chem.id, dayOfWeek: 1, time: "11:58", serviceId: haircutService.id },
    });
    expect(mismatched.status(), await mismatched.text()).toBe(400);

    // a legitimately-created slot, then try to PATCH it to a mismatched service
    const created = await request.post("/api/admin/time-slots", {
      headers: adminAuth,
      data: { categoryId: chem.id, dayOfWeek: 1, time: "11:59" },
    });
    expect(created.status(), await created.text()).toBe(201);
    const slotId = (await created.json()).slot.id;

    try {
      const patchMismatch = await request.patch(`/api/admin/time-slots/${slotId}`, {
        headers: adminAuth,
        data: { serviceId: haircutService.id },
      });
      expect(patchMismatch.status(), await patchMismatch.text()).toBe(400);
    } finally {
      await request.delete(`/api/admin/time-slots/${slotId}`, { headers: adminAuth });
    }
  });

  test("PATCH can reassign a slot's owner, including clearing it back to shared with serviceId:null", async ({ request }) => {
    const adminAuth = { Authorization: `Bearer ${testPool().adminToken}` };
    const categories = (await (await request.get("/api/admin/categories", { headers: adminAuth })).json()).categories;
    const chem = categories.find((c: { key: string }) => c.key === "chem");
    const keratin = chem.services.find((s: { key: string }) => s.key === "keratin");
    const botox = chem.services.find((s: { key: string }) => s.key === "botox");

    const created = await request.post("/api/admin/time-slots", {
      headers: adminAuth,
      data: { categoryId: chem.id, dayOfWeek: 2, time: "12:03", serviceId: keratin.id },
    });
    expect(created.status(), await created.text()).toBe(201);
    const slotId = (await created.json()).slot.id;

    try {
      const reassign = await request.patch(`/api/admin/time-slots/${slotId}`, {
        headers: adminAuth,
        data: { serviceId: botox.id },
      });
      expect(reassign.status(), await reassign.text()).toBe(200);
      expect((await reassign.json()).slot.serviceId).toBe(botox.id);

      const clear = await request.patch(`/api/admin/time-slots/${slotId}`, {
        headers: adminAuth,
        data: { serviceId: null },
      });
      expect(clear.status(), await clear.text()).toBe(200);
      expect((await clear.json()).slot.serviceId).toBeNull();
    } finally {
      await request.delete(`/api/admin/time-slots/${slotId}`, { headers: adminAuth });
    }
  });
});
