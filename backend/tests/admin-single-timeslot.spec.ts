import { test, expect } from "@playwright/test";
import { testPool } from "./helpers";

// POST /admin/time-slots existed server-side with no UI wired to it until
// the admin panel got a direct "+ افزودن اسلات" button — this covers the
// endpoint the button calls: adding one specific time, and rejecting an
// exact duplicate with a clear message rather than a raw 500 (previously
// unhandled, a P2002 from the categoryId+dayOfWeek+time unique constraint
// would have bubbled up as a generic server error).
test("adding a single time slot works, and an exact duplicate is rejected with a clear message", async ({
  request,
}) => {
  const adminToken = testPool().adminToken;
  const auth = { Authorization: `Bearer ${adminToken}` };

  const categories = (await (await request.get("/api/admin/categories", { headers: auth })).json()).categories;
  const haircut = categories.find((c: { key: string }) => c.key === "h");

  // an unusual time, unlikely to collide with any seeded/generated slot
  const time = "13:07";

  let createdId: string | undefined;
  try {
    const first = await request.post("/api/admin/time-slots", {
      headers: auth,
      data: { categoryId: haircut.id, dayOfWeek: 2, time },
    });
    expect(first.status(), await first.text()).toBe(201);
    const body = await first.json();
    expect(body.slot.time).toBe(time);
    expect(body.slot.isActive).toBe(true);
    createdId = body.slot.id;

    const duplicate = await request.post("/api/admin/time-slots", {
      headers: auth,
      data: { categoryId: haircut.id, dayOfWeek: 2, time },
    });
    expect(duplicate.status()).toBe(409);
    const dupBody = await duplicate.json();
    expect(dupBody.error).toContain("قبل");

    // the same time on a DIFFERENT day is a different slot entirely, not a
    // duplicate — confirms the check is scoped correctly, not just "this time
    // already exists anywhere"
    const differentDay = await request.post("/api/admin/time-slots", {
      headers: auth,
      data: { categoryId: haircut.id, dayOfWeek: 3, time },
    });
    expect(differentDay.status(), await differentDay.text()).toBe(201);
    const differentDayBody = await differentDay.json();

    await request.delete(`/api/admin/time-slots/${differentDayBody.slot.id}`, { headers: auth });
  } finally {
    if (createdId) await request.delete(`/api/admin/time-slots/${createdId}`, { headers: auth });
  }
});
