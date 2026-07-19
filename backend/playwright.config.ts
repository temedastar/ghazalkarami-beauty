import { defineConfig } from "@playwright/test";
import path from "path";

// tests read OTP codes back out of the dev server's console output (the
// Kavenegar client logs "would send OTP to X" instead of actually sending
// one when KAVENEGAR_API_KEY is unset) — see tests/helpers.ts
export const SERVER_LOG_PATH = path.join(__dirname, "tests", ".server-test.log");

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false, // tests share one Postgres DB; avoid cross-test races
  workers: 1,
  reporter: [["list"]],
  globalSetup: require.resolve("./tests/global-setup"),
  use: {
    baseURL: "http://localhost:4000",
  },
  webServer: {
    // OTP_RATE_LIMIT_MAX is only bumped here, for the test server process —
    // it lets global-setup register its account pool in one burst without
    // tripping the OTP limiter it isn't trying to test. LOGIN_RATE_LIMIT_MAX
    // is deliberately left at its production default (10/15min) so
    // tests/zz-rate-limit.spec.ts exercises the real limit.
    command: `OTP_RATE_LIMIT_MAX=100 npx tsx src/server.ts > ${SERVER_LOG_PATH} 2>&1`,
    url: "http://localhost:4000/api/health",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
