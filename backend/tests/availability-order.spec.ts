import { test, expect } from "@playwright/test";
import { testPool, nextWeekday } from "./helpers";

// GET /api/availability used to order slots by sortOrder first, time second.
// sortOrder is assigned sequentially by the bulk generator, but defaults to 0
// for anything created individually (POST /admin/time-slots — the admin
// panel's "+ افزودن اسلات" button) — mixing the two scrambled the customer-
// facing order instead of showing it chronologically. Reproduces that exact
// mix: a chronological batch from the generator, plus two out-of-band single
// adds that land on sortOrder 0, and checks the public endpoint's response
// order directly (the frontend does zero re-sorting of its own — it renders
// slots.forEach in whatever order the API returns).
test("customer-facing availability list is always in chronological order, even mixing generated and individually-added slots", async ({
  request,
}) => {
  const adminToken = testPool().adminToken;
  const auth = { Authorization: `Bearer ${adminToken}` };

  const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
  const scalp = categories.find((c: { key: string }) => c.key === "s"); // scalp_scrub — untouched by other tests' seeded slots

  const date = nextWeekday(60);
  const dow = new Date(date).getUTCDay();

  const createdIds: string[] = [];
  try {
    // a chronological batch via the generator — gets sequential sortOrder 0,1,2
    const generated = await request.post("/api/admin/time-slots/generate", {
      headers: auth,
      data: { categoryId: scalp.id, dayOfWeek: dow, startTime: "10:00", endTime: "13:00", durationMin: 60, gapMin: 0 },
    });
    expect(generated.status(), await generated.text()).toBe(201);
    createdIds.push(...(await generated.json()).slots.map((s: { id: string }) => s.id));

    // two individually-added slots that land BEFORE and BETWEEN the
    // generated ones chronologically, both defaulting to sortOrder 0 — under
    // the old ordering this is exactly what put them in the wrong place
    for (const time of ["09:15", "11:30"]) {
      const created = await request.post("/api/admin/time-slots", {
        headers: auth,
        data: { categoryId: scalp.id, dayOfWeek: dow, time },
      });
      expect(created.status(), await created.text()).toBe(201);
      createdIds.push((await created.json()).slot.id);
    }

    const availability = await request.get(`/api/availability?categoryKey=s&date=${date}`);
    expect(availability.status()).toBe(200);
    const body = await availability.json();
    const times: string[] = body.slots.map((s: { time: string }) => s.time);

    // the general claim: the whole list is non-decreasing by time, not just
    // "these five happen to be in order" — checked independently of whatever
    // else this category/weekday's slots (seeded or from other tests) contain
    const sorted = [...times].sort((a, b) => a.localeCompare(b));
    expect(times).toEqual(sorted);

    // and specifically: the mix that used to scramble (generated 10:00/11:00/
    // 12:00 plus individually-added 09:15/11:30, sharing sortOrder=0 with the
    // first generated slot) lands in the correct relative order
    const ourTimes = times.filter((t) => ["09:15", "10:00", "11:00", "11:30", "12:00"].includes(t));
    expect(ourTimes).toEqual(["09:15", "10:00", "11:00", "11:30", "12:00"]);
  } finally {
    await Promise.all(createdIds.map((id) => request.delete(`/api/admin/time-slots/${id}`, { headers: auth })));
  }
});
