import "dotenv/config";
import { defineConfig } from "@playwright/test";
import path from "path";

// tests read OTP codes back out of the dev server's console output (the
// Kavenegar client logs "would send OTP to X" instead of actually sending
// one when KAVENEGAR_API_KEY is unset) — see tests/helpers.ts
export const SERVER_LOG_PATH = path.join(__dirname, "tests", ".server-test.log");

// the suite creates and deletes real users/bookings/payments/reviews — it
// must run against its own database, never DATABASE_URL (dev data) and
// definitely never production. Fail loudly at config-load time rather than
// silently falling back to DATABASE_URL if this isn't set — see
// tests/dbSafety.ts for the second, independent check this pairs with
// (this one stops the server from ever starting against the wrong DB; that
// one is a runtime assertion in case something upstream of this file, e.g.
// an ambient shell DATABASE_URL, ever bypasses it).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL is not set. The test suite must run against its own database — " +
      "see .env.example for how to provision one. Refusing to start rather than risk " +
      "running against DATABASE_URL (dev data)."
  );
}
if (TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL is identical to DATABASE_URL — this must be a separate database.");
}

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false, // tests share one Postgres DB; avoid cross-test races
  workers: 1,
  reporter: [["list"]],
  globalSetup: require.resolve("./tests/global-setup"),
  // runs after the whole suite, pass or fail, and wipes everything the
  // suite could have created — a backstop for any test (present or future)
  // that forgets its own cleanup, not a replacement for per-test cleanup
  // where that's straightforward
  globalTeardown: require.resolve("./tests/global-teardown"),
  use: {
    baseURL: "http://localhost:4000",
  },
  webServer: {
    // OTP_RATE_LIMIT_MAX is only bumped here, for the test server process —
    // it lets global-setup register its account pool in one burst without
    // tripping the OTP limiter it isn't trying to test. LOGIN_RATE_LIMIT_MAX
    // is deliberately left at its production default (10/15min) so
    // tests/zz-rate-limit.spec.ts exercises the real limit. DATABASE_URL is
    // force-overridden to the test database here — this is what actually
    // makes every route in the spawned server process read/write the
    // isolated DB, regardless of what's in the shell environment or .env.
    command: `OTP_RATE_LIMIT_MAX=100 DATABASE_URL="${TEST_DATABASE_URL}" npx tsx src/server.ts > ${SERVER_LOG_PATH} 2>&1`,
    url: "http://localhost:4000/api/health",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
