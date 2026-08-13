import { test, expect } from "@playwright/test";
import { testPool, nextWeekday } from "./helpers";

// POST/DELETE /admin/bookings/block-range generalizes the existing
// ADMIN_BLOCK manual-booking mechanism into "close this date+time range —
// one category or every category" without any DayException/schema change,
// so Ghazal can answer "امروز رنگ نمی‌زنم ولی هیرکات انجام می‌دهم" (one
// category) as well as "فردا ۱۴ تا ۱۶ نیستم" (all categories) from the
// same tool.
test.describe("admin bookings block-range: category-scoped close/reopen", () => {
  test("blocking one category leaves the other category's slots open on the same day", async ({ request }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");
    const scalp = categories.find((c: { key: string }) => c.key === "s");

    const date = nextWeekday(100);

    const blocked = await request.post("/api/admin/bookings/block-range", {
      headers: auth,
      data: { startDate: date, endDate: date, categoryId: haircut.id, reason: "تست بستن یک دسته" },
    });
    expect(blocked.status(), await blocked.text()).toBe(201);
    const blockedBody = await blocked.json();
    expect(blockedBody.blocked).toBeGreaterThan(0);
    expect(blockedBody.skipped).toBe(0);

    try {
      const haircutBookings = await request.get(`/api/admin/bookings?date=${date}`, { headers: auth });
      const rows = (await haircutBookings.json()).bookings;
      const haircutRows = rows.filter((b: { categoryId: string }) => b.categoryId === haircut.id);
      const scalpRows = rows.filter((b: { categoryId: string }) => b.categoryId === scalp.id);
      expect(haircutRows.length).toBe(blockedBody.blocked);
      expect(haircutRows.every((b: { source: string }) => b.source === "ADMIN_BLOCK")).toBe(true);
      expect(scalpRows.length).toBe(0);
    } finally {
      const reopened = await request.delete(
        `/api/admin/bookings/block-range?startDate=${date}&endDate=${date}&categoryId=${haircut.id}`,
        { headers: auth }
      );
      expect(reopened.status(), await reopened.text()).toBe(200);
      expect((await reopened.json()).count).toBe(blockedBody.blocked);
    }
  });

  test("blocking with no categoryId closes every category at once, and reopening with no categoryId undoes all of them", async ({
    request,
  }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
    const date = nextWeekday(103);

    const blocked = await request.post("/api/admin/bookings/block-range", {
      headers: auth,
      data: { startDate: date, endDate: date, time: "10:00", categoryId: null, reason: "تست همه‌ی سرویس‌ها" },
    });
    expect(blocked.status(), await blocked.text()).toBe(201);
    const blockedBody = await blocked.json();
    expect(blockedBody.blocked).toBe(categories.length);

    try {
      const dayBookings = await request.get(`/api/admin/bookings?date=${date}`, { headers: auth });
      const rows = (await dayBookings.json()).bookings.filter((b: { time: string }) => b.time === "10:00");
      expect(rows.length).toBe(categories.length);
      const coveredCategoryIds = new Set(rows.map((b: { categoryId: string }) => b.categoryId));
      expect(coveredCategoryIds.size).toBe(categories.length);
    } finally {
      const reopened = await request.delete(
        `/api/admin/bookings/block-range?startDate=${date}&endDate=${date}&time=10:00`,
        { headers: auth }
      );
      expect(reopened.status(), await reopened.text()).toBe(200);
      expect((await reopened.json()).count).toBe(categories.length);
    }
  });

  test("blocking an already-blocked slot is skipped, not a batch failure", async ({ request }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
    const haircut = categories.find((c: { key: string }) => c.key === "h");
    const date = nextWeekday(106);

    const first = await request.post("/api/admin/bookings/block-range", {
      headers: auth,
      data: { startDate: date, endDate: date, time: "10:00", categoryId: haircut.id },
    });
    expect(first.status(), await first.text()).toBe(201);
    expect((await first.json()).blocked).toBe(1);

    try {
      const second = await request.post("/api/admin/bookings/block-range", {
        headers: auth,
        data: { startDate: date, endDate: date, categoryId: haircut.id },
      });
      expect(second.status(), await second.text()).toBe(201);
      const secondBody = await second.json();
      expect(secondBody.skipped).toBeGreaterThanOrEqual(1);
    } finally {
      await request.delete(`/api/admin/bookings/block-range?startDate=${date}&endDate=${date}&categoryId=${haircut.id}`, {
        headers: auth,
      });
    }
  });

  test("rejects an end time before/equal to the start time and a range over 90 days", async ({ request }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };
    const date = nextWeekday(110);

    const badTime = await request.post("/api/admin/bookings/block-range", {
      headers: auth,
      data: { startDate: date, endDate: date, startTime: "14:00", endTime: "13:00" },
    });
    expect(badTime.status()).toBe(400);

    const tooLong = await request.post("/api/admin/bookings/block-range", {
      headers: auth,
      data: { startDate: "2018-01-01", endDate: "2018-12-31" },
    });
    expect(tooLong.status()).toBe(400);
  });

  test("a non-admin cannot block or unblock a range", async ({ request }) => {
    const customerToken = testPool().customers[0].token;
    const auth = { Authorization: `Bearer ${customerToken}` };
    const date = nextWeekday(112);

    const blocked = await request.post("/api/admin/bookings/block-range", {
      headers: auth,
      data: { startDate: date, endDate: date },
    });
    expect(blocked.status()).toBe(403);

    const reopened = await request.delete(`/api/admin/bookings/block-range?startDate=${date}&endDate=${date}`, {
      headers: auth,
    });
    expect(reopened.status()).toBe(403);
  });
});
