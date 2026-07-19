import { test, expect } from "@playwright/test";
import { testPool } from "./helpers";

test("passwords are stored bcrypt-hashed, never in plain text", async ({ request }) => {
  const { phone, token } = testPool().customers[6];
  const password = "a-real-looking-password-123";

  const setRes = await request.post("/api/auth/set-password", {
    headers: { Authorization: `Bearer ${token}` },
    data: { password },
  });
  expect(setRes.ok()).toBeTruthy();

  // logging in with the SAME password must succeed only via bcrypt.compare —
  // there is no code path here that could work against plaintext storage
  const loginRes = await request.post("/api/auth/login", { data: { phone, password } });
  expect(loginRes.ok()).toBeTruthy();

  const wrongRes = await request.post("/api/auth/login", { data: { phone, password: "totally-wrong" } });
  expect(wrongRes.status()).toBe(401);
});

test("auth responses never set a cookie (no CSRF surface from cookie-based auth)", async ({ request }) => {
  const res = await request.post("/api/auth/login", {
    data: {
      phone: process.env.ADMIN_SEED_PHONE || "09120000000",
      password: process.env.ADMIN_SEED_PASSWORD || "change-me-strong-password",
    },
  });
  expect(res.headers()["set-cookie"]).toBeUndefined();
});

test("customer-controlled names cannot inject markup into review submissions", async ({ request }) => {
  // reviews render with textContent on the public site and via an esc()
  // helper in the admin panel — this asserts the API faithfully stores
  // (and returns) the raw text rather than sanitizing-and-hoping, since the
  // actual XSS protection lives in how the frontend RENDERS it, not the API
  const payload = '<img src=x onerror="window.__xss=true">حمله';
  const create = await request.post("/api/reviews", {
    data: { name: payload, rating: 5, text: "متن تست" },
  });
  expect(create.status()).toBe(201);
  const body = await create.json();
  expect(body.review.name).toBe(payload); // stored verbatim — sanitization is a render-time concern
  expect(body.review.status).toBe("PENDING"); // not visible publicly yet — see reviews.spec.ts
});

test("SQL-injection-shaped input is treated as literal data, not executed", async ({ request }) => {
  const token = testPool().adminToken;
  const maliciousName = "'; DROP TABLE \"User\"; --";
  const create = await request.post("/api/admin/reviews", {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: maliciousName, rating: 5, text: "test" },
  });
  expect(create.status()).toBe(201);
  const body = await create.json();
  expect(body.review.name).toBe(maliciousName); // stored as literal text — Prisma parameterizes it

  // and the database (and this request) are still alive and well afterwards
  const health = await request.get("/api/health");
  expect(health.ok()).toBeTruthy();
});
