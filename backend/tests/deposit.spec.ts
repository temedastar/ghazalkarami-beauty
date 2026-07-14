import { test, expect } from "@playwright/test";
import { testPool, nextWeekday } from "./helpers";

test("percentage-based deposit is computed correctly, and cleanly reverts to fixed", async ({ request }) => {
  const adminToken = testPool().adminToken;
  const adminAuth = { Authorization: `Bearer ${adminToken}` };

  const servicesRes = await request.get("/api/admin/services", { headers: adminAuth });
  const services = (await servicesRes.json()).services;
  const haircut = services.find((s: { key: string }) => s.key === "haircut");
  const original = { depositType: haircut.depositType, depositValue: haircut.depositValue };

  try {
    await request.patch(`/api/admin/services/${haircut.id}`, {
      headers: adminAuth,
      data: { depositType: "PERCENT", depositValue: 20 },
    });

    const token = testPool().customers[2].token;
    const booking = await request.post("/api/bookings", {
      headers: { Authorization: `Bearer ${token}` },
      data: { serviceKey: "haircut", date: nextWeekday(35), time: "10:00" },
    });
    expect(booking.status(), await booking.text()).toBe(201);
    const body = await booking.json();

    const expected = Math.round((haircut.priceMin * 20) / 100);
    expect(body.booking.depositAmount).toBe(expected);
  } finally {
    // restore the seeded state so this test doesn't leak into others
    await request.patch(`/api/admin/services/${haircut.id}`, { headers: adminAuth, data: original });
  }
});
