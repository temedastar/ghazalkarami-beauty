import fs from "fs";
import path from "path";
import { request as playwrightRequest } from "@playwright/test";
import { lastOtpCodeForPhone, randomPhone } from "./helpers";

export const POOL_PATH = path.join(__dirname, ".test-pool.json");
const POOL_SIZE = 8;

/**
 * Runs ONCE before the whole suite (after the dev server is already up) and
 * registers everything the individual tests need: one admin session plus a
 * small pool of real customer accounts. Every spec file reuses these tokens
 * instead of hitting /api/auth/otp/request or /api/auth/login itself — those
 * endpoints are deliberately rate-limited (anti brute-force / anti SMS-bombing),
 * and re-registering a fresh customer per test would blow through that budget
 * and produce false failures that have nothing to do with a real bug. The
 * rate limiters themselves are exercised on purpose in tests/zz-rate-limit.spec.ts,
 * which runs last for exactly this reason.
 */
export default async function globalSetup() {
  const ctx = await playwrightRequest.newContext({ baseURL: "http://localhost:4000" });

  const adminRes = await ctx.post("/api/auth/login", {
    data: {
      phone: process.env.ADMIN_SEED_PHONE || "09120000000",
      password: process.env.ADMIN_SEED_PASSWORD || "change-me-strong-password",
    },
  });
  if (!adminRes.ok()) {
    throw new Error(`global-setup: admin login failed (${adminRes.status()}): ${await adminRes.text()}`);
  }
  const adminToken = (await adminRes.json()).token as string;

  const customers: { phone: string; token: string }[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const phone = randomPhone();
    const otpRes = await ctx.post("/api/auth/otp/request", { data: { phone, purpose: "REGISTER" } });
    if (!otpRes.ok()) {
      throw new Error(`global-setup: otp/request failed (${otpRes.status()}) for pool customer ${i}`);
    }
    const code = await lastOtpCodeForPhone(phone);
    const verifyRes = await ctx.post("/api/auth/otp/verify", {
      data: { phone, code, purpose: "REGISTER", name: `مشتری تست ${i + 1}` },
    });
    if (!verifyRes.ok()) {
      throw new Error(`global-setup: otp/verify failed (${verifyRes.status()}) for pool customer ${i}`);
    }
    const token = (await verifyRes.json()).token as string;
    customers.push({ phone, token });
  }

  fs.writeFileSync(POOL_PATH, JSON.stringify({ adminToken, customers }, null, 2));
  await ctx.dispose();
}
