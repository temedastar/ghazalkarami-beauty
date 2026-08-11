import { test, expect } from "@playwright/test";
import { testPool } from "./helpers";

// Ghazal wants a second phone number manageable the exact same way she
// already adds/removes Instagram/Telegram/WhatsApp/Baleh entries — this
// reuses the SocialLink model verbatim, just with a new "PHONE" platform
// value (migration 20260811185704_social_platform_phone), rather than a
// bolt-on field. Confirms the enum extension actually round-trips through
// the admin CRUD endpoints and shows up on the public contact-info feed
// the site's footer reads from.
test("a PHONE social link can be added via the admin API and is returned by both the admin list and the public contact-info feed", async ({
  request,
}) => {
  const adminToken = testPool().adminToken;
  const auth = { Authorization: `Bearer ${adminToken}` };

  const created = await request.post("/api/admin/social-links", {
    headers: auth,
    data: { platform: "PHONE", label: "خط دوم سالن", value: "02188990011" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const link = (await created.json()).link;
  expect(link.platform).toBe("PHONE");

  try {
    const adminList = await request.get("/api/admin/social-links", { headers: auth });
    const adminLinks = (await adminList.json()).links;
    expect(adminLinks.some((l: { id: string }) => l.id === link.id)).toBe(true);

    const publicFeed = await request.get("/api/contact-info");
    expect(publicFeed.status()).toBe(200);
    const publicLinks = (await publicFeed.json()).socialLinks;
    const publicMatch = publicLinks.find((l: { id: string }) => l.id === link.id);
    expect(publicMatch, "the public contact-info feed (no auth) must expose it too — it's what the site footer reads").toBeTruthy();
    expect(publicMatch.value).toBe("02188990011");
  } finally {
    await request.delete(`/api/admin/social-links/${link.id}`, { headers: auth });
  }
});
