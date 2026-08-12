import { test, expect } from "@playwright/test";
import { testPool } from "./helpers";

// The bulk-close tool (POST /admin/day-exceptions/closure-range) already
// existed; what was missing was an undo — Ghazal needs to bulk-close two
// months at once (already booked in person, before the site goes public)
// but also needs a way to walk that back in one action if she picks the
// wrong dates, without deleting 60+ exceptions one at a time from the list.
test.describe("bulk close/reopen a date range", () => {
  test("DELETE closure-range removes only the isOpen:false rows it created, leaving a deliberate open-with-custom-hours exception in the same range untouched", async ({
    request,
  }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    // fixed past dates — deterministic, no collision risk with other specs'
    // relative-to-today date math, and day-exceptions allow past dates
    const startDate = "2019-03-01";
    const endDate = "2019-03-10"; // 10 days inclusive

    const closed = await request.post("/api/admin/day-exceptions/closure-range", {
      headers: auth,
      data: { startDate, endDate, reason: "تست بازه" },
    });
    expect(closed.status(), await closed.text()).toBe(201);
    expect((await closed.json()).exceptions).toHaveLength(10);

    // a deliberate "open with special hours" exception on a day inside the
    // range — must survive the bulk reopen below untouched
    const specialDate = "2019-03-05";
    const special = await request.post("/api/admin/day-exceptions", {
      headers: auth,
      data: { date: specialDate, isOpen: true, openTime: "12:00", closeTime: "16:00", reason: "باز ویژه" },
    });
    expect(special.status(), await special.text()).toBe(201);

    const reopened = await request.delete(
      `/api/admin/day-exceptions/closure-range?startDate=${startDate}&endDate=${endDate}`,
      { headers: auth }
    );
    expect(reopened.status(), await reopened.text()).toBe(200);
    // 10 closed days minus the 1 deliberately-open day = 9 removed
    expect((await reopened.json()).count).toBe(9);

    const remaining = await request.get(`/api/admin/day-exceptions?from=${startDate}&to=${endDate}`, { headers: auth });
    const remainingRows = (await remaining.json()).exceptions;
    expect(remainingRows).toHaveLength(1);
    expect(remainingRows[0].date.slice(0, 10)).toBe(specialDate);
    expect(remainingRows[0].isOpen).toBe(true);

    // clean up the one row the test itself deliberately left behind
    await request.delete(`/api/admin/day-exceptions/${remainingRows[0].id}`, { headers: auth });
  });

  test("closure-range still respects the 90-day cap for both close and reopen", async ({ request }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const tooLong = await request.post("/api/admin/day-exceptions/closure-range", {
      headers: auth,
      data: { startDate: "2018-01-01", endDate: "2018-12-31", reason: "خیلی طولانی" },
    });
    expect(tooLong.status()).toBe(400);

    const tooLongReopen = await request.delete(
      "/api/admin/day-exceptions/closure-range?startDate=2018-01-01&endDate=2018-12-31",
      { headers: auth }
    );
    expect(tooLongReopen.status()).toBe(400);
  });

  test("a non-admin cannot bulk-close or bulk-reopen a date range", async ({ request }) => {
    const customerToken = testPool().customers[0].token;
    const auth = { Authorization: `Bearer ${customerToken}` };

    const close = await request.post("/api/admin/day-exceptions/closure-range", {
      headers: auth,
      data: { startDate: "2019-04-01", endDate: "2019-04-05" },
    });
    expect(close.status()).toBe(403);

    const reopen = await request.delete(
      "/api/admin/day-exceptions/closure-range?startDate=2019-04-01&endDate=2019-04-05",
      { headers: auth }
    );
    expect(reopen.status()).toBe(403);
  });
});
