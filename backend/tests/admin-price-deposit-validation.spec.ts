import { test, expect } from "@playwright/test";
import { testPool } from "./helpers";

// PERCENT-type deposits are applied as (priceMin * depositValue) / 100 (see
// lib/schedule.ts) — a typo like 500 instead of 50 used to sail straight
// through with no upper bound, charging a multiple of the service's own
// price as the deposit. priceMin/priceMax also had no non-negative or
// min<=max checks. These now get validated at the services, price-list, and
// settings routes. Uses the seeded "haircut" service (PATCHed and restored)
// rather than creating new services — there's no DELETE /admin/services
// route, so a freshly-created test service would be permanent test-DB junk.
test.describe("service/price-list/settings validation: deposit percent cap and price bounds", () => {
  test("a PERCENT deposit over 100 is rejected on service create, service patch, and default settings", async ({
    request,
  }) => {
    const auth = { Authorization: `Bearer ${testPool().adminToken}` };

    const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
    const scalp = categories.find((c: { key: string }) => c.key === "s");

    const createBad = await request.post("/api/admin/services", {
      headers: auth,
      data: { key: `test-percent-${Date.now()}`, name: "تست درصد نامعتبر", categoryId: scalp.id, depositType: "PERCENT", depositValue: 150 },
    });
    expect(createBad.status(), await createBad.text()).toBe(400);

    const servicesRes = await request.get("/api/admin/services", { headers: auth });
    const haircut = (await servicesRes.json()).services.find((s: { key: string }) => s.key === "haircut");
    const original = { depositType: haircut.depositType, depositValue: haircut.depositValue };

    try {
      const patchBad = await request.patch(`/api/admin/services/${haircut.id}`, {
        headers: auth,
        data: { depositType: "PERCENT", depositValue: 150 },
      });
      expect(patchBad.status(), await patchBad.text()).toBe(400);
    } finally {
      await request.patch(`/api/admin/services/${haircut.id}`, { headers: auth, data: original });
    }

    const settingsRes = await request.get("/api/admin/settings", { headers: auth });
    const originalSettings = await settingsRes.json();
    try {
      const settingsBad = await request.patch("/api/admin/settings", {
        headers: auth,
        data: { defaultDepositType: "PERCENT", defaultDepositValue: 150 },
      });
      expect(settingsBad.status(), await settingsBad.text()).toBe(400);
    } finally {
      await request.patch("/api/admin/settings", {
        headers: auth,
        data: {
          defaultDepositType: originalSettings.settings.defaultDepositType,
          defaultDepositValue: originalSettings.settings.defaultDepositValue,
        },
      });
    }
  });

  test("priceMin greater than priceMax, and a negative price, are rejected on service patch and price-list create", async ({
    request,
  }) => {
    const auth = { Authorization: `Bearer ${testPool().adminToken}` };

    const servicesRes = await request.get("/api/admin/services", { headers: auth });
    const haircut = (await servicesRes.json()).services.find((s: { key: string }) => s.key === "haircut");

    // rejected before ever touching the row — nothing to restore afterward
    const patchBadRange = await request.patch(`/api/admin/services/${haircut.id}`, {
      headers: auth,
      data: { priceMin: 5000000, priceMax: 1000000 },
    });
    expect(patchBadRange.status(), await patchBadRange.text()).toBe(400);

    const patchNegative = await request.patch(`/api/admin/services/${haircut.id}`, {
      headers: auth,
      data: { priceMin: -1000 },
    });
    expect(patchNegative.status(), await patchNegative.text()).toBe(400);

    const createPriceListRow = await request.post("/api/admin/price-list", {
      headers: auth,
      data: { groupTitle: "تست", name: "ردیف تست بازه نامعتبر", priceMin: 500000, priceMax: 100000 },
    });
    expect(createPriceListRow.status(), await createPriceListRow.text()).toBe(400);

    const negativePrice = await request.post("/api/admin/price-list", {
      headers: auth,
      data: { groupTitle: "تست", name: "ردیف تست منفی", priceMin: -1000 },
    });
    expect(negativePrice.status(), await negativePrice.text()).toBe(400);
  });

  test("a PATCH that only changes depositValue is validated against the service's existing (unchanged) depositType", async ({
    request,
  }) => {
    const auth = { Authorization: `Bearer ${testPool().adminToken}` };

    const servicesRes = await request.get("/api/admin/services", { headers: auth });
    const haircut = (await servicesRes.json()).services.find((s: { key: string }) => s.key === "haircut");
    const original = { depositType: haircut.depositType, depositValue: haircut.depositValue };

    try {
      const toPercent = await request.patch(`/api/admin/services/${haircut.id}`, {
        headers: auth,
        data: { depositType: "PERCENT", depositValue: 40 },
      });
      expect(toPercent.status(), await toPercent.text()).toBe(200);

      // depositType isn't in this payload at all — must still be validated
      // against the row's now-PERCENT type, not silently treated as FIXED
      const patchOverCap = await request.patch(`/api/admin/services/${haircut.id}`, {
        headers: auth,
        data: { depositValue: 200 },
      });
      expect(patchOverCap.status(), await patchOverCap.text()).toBe(400);

      const patchWithinCap = await request.patch(`/api/admin/services/${haircut.id}`, {
        headers: auth,
        data: { depositValue: 60 },
      });
      expect(patchWithinCap.status(), await patchWithinCap.text()).toBe(200);
    } finally {
      await request.patch(`/api/admin/services/${haircut.id}`, { headers: auth, data: original });
    }
  });
});
