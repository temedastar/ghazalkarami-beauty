import { test, expect } from "@playwright/test";
import { randomPhone } from "./helpers";

// Named "zz-" so it's the LAST spec file to run alphabetically. It
// deliberately exhausts the (IP-keyed) login rate limiter, which would
// otherwise 429 every other test in the suite that still needs to log in
// after this one runs. See tests/global-setup.ts for the pool pattern every
// other spec file uses instead of calling /api/auth/login itself.
test("login endpoint has brute-force rate limiting", async ({ request }) => {
  const phone = randomPhone(); // unregistered — every attempt 404s ("not registered"), which is fine, we're testing volume
  let sawBlock = false;
  for (let i = 0; i < 15; i++) {
    const res = await request.post("/api/auth/login", { data: { phone, password: "guess-attempt-x" } });
    if (res.status() === 429) {
      sawBlock = true;
      break;
    }
    expect(res.status()).toBe(404);
  }
  expect(sawBlock, "expected the rate limiter to return 429 within 15 attempts").toBe(true);
});
