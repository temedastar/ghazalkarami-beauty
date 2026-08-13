import { test, expect } from "@playwright/test";
import { testPool } from "./helpers";

// several admin delete-by-id routes never pre-check existence before
// calling prisma.<model>.delete() — a stale id (e.g. the admin double-clicks,
// or two admin tabs are open) used to fall straight through to the generic
// 500 handler as an opaque Prisma P2025 error instead of a clean 404.
test.describe("errorHandler maps Prisma P2025 (record not found) to a clean 404", () => {
  test("deleting a day-exception that doesn't exist returns 404, not a raw 500", async ({ request }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const res = await request.delete("/api/admin/day-exceptions/does-not-exist-at-all", { headers: auth });
    expect(res.status(), await res.text()).toBe(404);
    expect((await res.json()).error).toBeTruthy();
  });

  test("deleting a gallery image that doesn't exist returns 404, not a raw 500", async ({ request }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const res = await request.delete("/api/admin/gallery/does-not-exist-at-all", { headers: auth });
    expect(res.status(), await res.text()).toBe(404);
  });

  test("deleting a social link that doesn't exist returns 404, not a raw 500", async ({ request }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const res = await request.delete("/api/admin/social-links/does-not-exist-at-all", { headers: auth });
    expect(res.status(), await res.text()).toBe(404);
  });
});
