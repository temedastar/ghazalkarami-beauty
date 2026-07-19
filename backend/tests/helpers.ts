import fs from "fs";
import { SERVER_LOG_PATH } from "../playwright.config";
import { POOL_PATH } from "./global-setup";

interface TestPool {
  adminToken: string;
  customers: { phone: string; token: string }[];
}

let cachedPool: TestPool | null = null;

/** Pre-registered admin session + customer accounts from global-setup.ts —
 * use this instead of calling /api/auth/login or /api/auth/otp/* directly
 * in individual tests, so the suite doesn't trip its own rate limiters. */
export function testPool(): TestPool {
  if (!cachedPool) {
    cachedPool = JSON.parse(fs.readFileSync(POOL_PATH, "utf8"));
  }
  return cachedPool!;
}

export function randomPhone(): string {
  const rest = Math.floor(1000000 + Math.random() * 8999999);
  return `09${Math.floor(10 + Math.random() * 89)}${rest}`.slice(0, 11);
}

/** Reads the most recent OTP code the dev-mode Kavenegar stub logged for a
 * given phone number, polling briefly since the write can lag the HTTP
 * response by a beat. */
export async function lastOtpCodeForPhone(phone: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (fs.existsSync(SERVER_LOG_PATH)) {
      const log = fs.readFileSync(SERVER_LOG_PATH, "utf8");
      const lines = log.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes(`would send OTP to ${phone}`)) {
          const m = lines[i].match(/tokens: (\d{6})/);
          if (m) return m[1];
        }
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No OTP code found in server log for ${phone}`);
}

/** A near-term weekday (Sun–Thu, i.e. safely bookable across every category
 * in the seed data) so tests don't need to reason about the Jalali calendar
 * or worry about landing on Friday/Saturday. */
export function nextWeekday(daysAhead: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  while (d.getUTCDay() === 5 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}
