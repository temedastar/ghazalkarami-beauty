import { test, expect } from "@playwright/test";
import { testPool, randomPhone, nextWeekday } from "./helpers";

// protein-therapy / keratin / botox / crabotox / color_highlight / pixie_bleach
// all share ONE timeline (the "chem" category) — booking any one of them,
// online or entered manually by the owner, must block the same slot for the
// rest of the group, while leaving haircut/scalp_scrub (independent lines)
// completely unaffected.
test.describe("shared-line booking conflicts", () => {
  const date = nextWeekday(30);

  test("booking keratin blocks botox and protein_therapy at the same slot, but not haircut", async ({ request }) => {
    const token = testPool().customers[0].token;
    const auth = { Authorization: `Bearer ${token}` };

    const first = await request.post("/api/bookings", {
      headers: auth,
      data: { serviceKey: "keratin", date, time: "10:00" },
    });
    expect(first.status(), await first.text()).toBe(201);

    const second = await request.post("/api/bookings", {
      headers: auth,
      data: { serviceKey: "botox", date, time: "10:00" },
    });
    expect(second.status()).toBe(409);

    const third = await request.post("/api/bookings", {
      headers: auth,
      data: { serviceKey: "protein_therapy", date, time: "10:00" },
    });
    expect(third.status()).toBe(409);

    // control: haircut is an independent line and must still be bookable
    const control = await request.post("/api/bookings", {
      headers: auth,
      data: { serviceKey: "haircut", date, time: "10:00" },
    });
    expect(control.status(), await control.text()).toBe(201);
  });

  test("a manual booking entered by the admin blocks the shared line for online customers", async ({ request }) => {
    const manualDate = nextWeekday(31);
    const adminToken = testPool().adminToken;

    const categories = await (await request.get("/api/admin/categories", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })).json();
    const chem = categories.categories.find((c: { key: string }) => c.key === "chem");
    const services = await (await request.get("/api/admin/services", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })).json();
    const colorHighlight = services.services.find((s: { key: string }) => s.key === "color_highlight");

    const manual = await request.post("/api/admin/bookings/manual", {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        categoryId: chem.id,
        date: manualDate,
        time: "14:30",
        serviceId: colorHighlight.id,
        customerName: "مشتری دایرکت اینستاگرام",
        customerPhone: randomPhone(),
      },
    });
    expect(manual.status(), await manual.text()).toBe(201);

    // an online customer should now see it as unavailable via the SAME
    // availability endpoint the booking widget calls — before even trying
    const availability = await request.get(`/api/availability?categoryKey=chem&date=${manualDate}`);
    const body = await availability.json();
    const slot = body.slots.find((s: { time: string }) => s.time === "14:30");
    expect(slot.available).toBe(false);

    // and an actual booking attempt for a different chem-line service is rejected
    const token = testPool().customers[1].token;
    const attempt = await request.post("/api/bookings", {
      headers: { Authorization: `Bearer ${token}` },
      data: { serviceKey: "keratin", date: manualDate, time: "14:30" },
    });
    expect(attempt.status()).toBe(409);
  });
});
