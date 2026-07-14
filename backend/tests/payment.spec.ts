import { test, expect } from "@playwright/test";
import { testPool, nextWeekday } from "./helpers";

test("cancelling at the payment gateway frees the slot immediately (not after any delay)", async ({ request }) => {
  const token = testPool().customers[3].token;
  const auth = { Authorization: `Bearer ${token}` };
  const date = nextWeekday(40);

  const booking = await request.post("/api/bookings", {
    headers: auth,
    data: { serviceKey: "haircut", date, time: "10:00" },
  });
  const bookingId = (await booking.json()).booking.id;

  await request.post("/api/payments/zarinpal/request", { headers: auth, data: { bookingId } });

  // simulate the customer clicking "cancel" on the ZarinPal page — Status=NOK
  const callback = await request.get(
    `/api/payments/zarinpal/callback?bookingId=${bookingId}&Authority=TEST&Status=NOK`,
    { maxRedirects: 0 }
  );
  expect(callback.status()).toBe(302);

  // the slot must be bookable again right away — no waiting on the hold timer
  const availability = await request.get(`/api/availability?categoryKey=h&date=${date}`);
  const slot = (await availability.json()).slots.find((s: { time: string }) => s.time === "10:00");
  expect(slot.available).toBe(true);

  const secondToken = testPool().customers[4].token;
  const rebooked = await request.post("/api/bookings", {
    headers: { Authorization: `Bearer ${secondToken}` },
    data: { serviceKey: "haircut", date, time: "10:00" },
  });
  expect(rebooked.status(), await rebooked.text()).toBe(201);
});

test("an abandoned (never-paid) booking's hold is set to expire exactly 15 minutes after creation", async ({
  request,
}) => {
  const token = testPool().customers[5].token;
  const date = nextWeekday(41);

  const booking = await request.post("/api/bookings", {
    headers: { Authorization: `Bearer ${token}` },
    data: { serviceKey: "scalp_scrub", date, time: "10:00" },
  });
  const body = await booking.json();
  const holdExpiresAt = new Date(body.booking.holdExpiresAt).getTime();
  const createdAt = new Date(body.booking.createdAt).getTime();
  expect(Math.round((holdExpiresAt - createdAt) / 60000)).toBe(15);

  // rather than actually waiting 15 minutes in CI, this confirms the exact
  // constant is what's wired into the response — the real end-to-end expiry
  // timing (cron firing ~every 60s and freeing a backdated hold) was verified
  // manually against a live server; see the audit notes for that evidence.
});
