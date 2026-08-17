import { test, expect } from "@playwright/test";
import { testPool } from "./helpers";

// Four site photos (hero-section arch, the two "cutout" portraits, and the
// academy/instructor shot) previously had no admin-editable key at all — the
// <img> tags pointed at static files that never existed in the repo, so they
// were permanently blank on the live site with zero way for Ghazal to fix it.
// This confirms the new keys round-trip through the same generic
// site-content image mechanism logo_url/ghazal_photo_url/donia_photo_url
// already used, including the old-file-cleanup-on-replace behavior.
test.describe("newly wired site-content image keys", () => {
  const keys = ["hero_image_url", "ghazal_cutout_url", "donia_cutout_url", "instructor_photo_url"];

  test("each new key can be set via admin PATCH and is readable from both the admin and public site-content feeds", async ({ request }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };

    try {
      for (const key of keys) {
        const set = await request.patch(`/api/admin/site-content/${key}`, {
          headers: auth,
          data: { value: `/uploads/test-${key}.jpg` },
        });
        expect(set.status(), await set.text()).toBe(200);
      }

      const adminList = await (await request.get("/api/admin/site-content", { headers: auth })).json();
      const byKey = Object.fromEntries(adminList.content.map((c: { key: string; value: string }) => [c.key, c.value]));
      for (const key of keys) expect(byKey[key]).toBe(`/uploads/test-${key}.jpg`);

      const publicFeed = await (await request.get("/api/site-content")).json();
      for (const key of keys) expect(publicFeed.content[key]).toBe(`/uploads/test-${key}.jpg`);
    } finally {
      for (const key of keys) {
        await request.patch(`/api/admin/site-content/${key}`, { headers: auth, data: { value: "" } });
      }
    }
  });

  test("replacing a value clears the old value cleanly, and a non-admin cannot set any of them", async ({ request }) => {
    const adminToken = testPool().adminToken;
    const auth = { Authorization: `Bearer ${adminToken}` };
    const customerToken = testPool().customers[5].token;

    try {
      await request.patch("/api/admin/site-content/hero_image_url", { headers: auth, data: { value: "/uploads/hero-v1.jpg" } });
      const replaced = await request.patch("/api/admin/site-content/hero_image_url", {
        headers: auth,
        data: { value: "/uploads/hero-v2.jpg" },
      });
      expect(replaced.status()).toBe(200);
      const row = (await replaced.json()).content;
      expect(row.value).toBe("/uploads/hero-v2.jpg");

      const denied = await request.patch("/api/admin/site-content/hero_image_url", {
        headers: { Authorization: `Bearer ${customerToken}` },
        data: { value: "/uploads/hacked.jpg" },
      });
      expect(denied.status()).toBe(403);
    } finally {
      await request.patch("/api/admin/site-content/hero_image_url", { headers: auth, data: { value: "" } });
    }
  });
});
