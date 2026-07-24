import { test, expect } from "@playwright/test";
import { testPool, randomPhone, nextWeekday } from "./helpers";

// the admin panel's own service dropdown only ever offers services from the
// currently-selected category, so a mismatch can't happen through normal UI
// use — this exercises the direct-API path a normal admin session never
// takes, to confirm the server itself now rejects it rather than silently
// locking the wrong shared-line group.
test("manual booking is rejected when serviceId belongs to a different category than categoryId", async ({
  request,
}) => {
  const adminToken = testPool().adminToken;
  const auth = { Authorization: `Bearer ${adminToken}` };

  const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
  const services = (await (await request.get("/api/admin/services", { headers: auth })).json()).services;

  const haircutCategory = categories.find((c: { key: string }) => c.key === "h");
  const keratinService = services.find((s: { key: string }) => s.key === "keratin"); // belongs to "chem", not "h"

  const mismatched = await request.post("/api/admin/bookings/manual", {
    headers: auth,
    data: {
      categoryId: haircutCategory.id,
      serviceId: keratinService.id,
      date: nextWeekday(35),
      time: "11:00",
      customerName: "تست ناهماهنگی",
      customerPhone: randomPhone(),
    },
  });
  expect(mismatched.status()).toBe(400);

  // and the matching category+service still works, proving the check is
  // about the mismatch specifically, not a blanket rejection of serviceId
  const matched = await request.post("/api/admin/bookings/manual", {
    headers: auth,
    data: {
      categoryId: haircutCategory.id,
      serviceId: services.find((s: { key: string }) => s.key === "haircut").id,
      date: nextWeekday(35),
      time: "11:00",
      customerName: "تست هماهنگ",
      customerPhone: randomPhone(),
    },
  });
  expect(matched.status(), await matched.text()).toBe(201);
});
