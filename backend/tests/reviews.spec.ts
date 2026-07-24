import { test, expect } from "@playwright/test";
import { testPool } from "./helpers";

test("a new review is hidden from the public list until an admin approves it", async ({ request }) => {
  const uniqueText = `نظر تستی ${Date.now()}`;
  const adminToken = testPool().adminToken;

  const create = await request.post("/api/reviews", {
    data: { name: "مشتری بررسی", rating: 5, text: uniqueText },
  });
  expect(create.status()).toBe(201);
  const created = (await create.json()).review;

  try {
    const beforeApproval = await request.get("/api/reviews?sort=new");
    const beforeBody = await beforeApproval.json();
    expect(beforeBody.reviews.some((r: { text: string }) => r.text === uniqueText)).toBe(false);

    const approve = await request.patch(`/api/admin/reviews/${created.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { status: "APPROVED" },
    });
    expect(approve.ok()).toBeTruthy();

    const afterApproval = await request.get("/api/reviews?sort=new");
    const afterBody = await afterApproval.json();
    expect(afterBody.reviews.some((r: { text: string }) => r.text === uniqueText)).toBe(true);
  } finally {
    // this one goes APPROVED and public mid-test — leaving it behind would
    // show up as real (fake) content on the live reviews section
    await request.delete(`/api/admin/reviews/${created.id}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  }
});

test("a rejected review never appears publicly", async ({ request }) => {
  const uniqueText = `نظر ردشده ${Date.now()}`;
  const adminToken = testPool().adminToken;

  const create = await request.post("/api/reviews", {
    data: { name: "مشتری رد", rating: 1, text: uniqueText },
  });
  const created = (await create.json()).review;

  try {
    await request.patch(`/api/admin/reviews/${created.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { status: "REJECTED" },
    });

    const publicList = await request.get("/api/reviews?sort=new");
    const body = await publicList.json();
    expect(body.reviews.some((r: { text: string }) => r.text === uniqueText)).toBe(false);
  } finally {
    await request.delete(`/api/admin/reviews/${created.id}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  }
});
