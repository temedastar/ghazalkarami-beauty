import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import type { SmsType } from "@prisma/client";

const KAVENEGAR_BASE = "https://api.kavenegar.com/v1";

function isConfigured(): boolean {
  return Boolean(env.kavenegar.apiKey);
}

async function logSms(
  phone: string,
  type: SmsType,
  status: "SUCCESS" | "FAILED" | "DEV",
  errorMessage?: string
): Promise<void> {
  await prisma.smsLog
    .create({ data: { phone, type, status, errorMessage } })
    .catch((e) => console.error("Failed to write SmsLog:", e));
}

interface LookupParams {
  phone: string;
  type: SmsType;
  template: string;
  token?: string;
  token2?: string;
  token3?: string;
}

/**
 * Sends via Kavenegar's Lookup/Verify pattern API — required for transactional
 * messages like these (plain free-text SMS isn't allowed for them). Each
 * `template` name must already exist as an approved pattern in the Kavenegar
 * panel; until KAVENEGAR_API_KEY and the template env vars are set, this logs
 * the intended send instead of failing, so the rest of the app is testable.
 */
async function sendLookup({ phone, type, template, token, token2, token3 }: LookupParams): Promise<void> {
  if (!isConfigured() || !template) {
    console.warn(
      `[kavenegar:DEV] would send ${type} to ${phone} via template "${template || "(not configured)"}" — tokens: ${[token, token2, token3].filter(Boolean).join(" | ")}`
    );
    await logSms(phone, type, "DEV");
    return;
  }

  const params = new URLSearchParams({ receptor: phone, template, type: "sms" });
  if (token) params.set("token", token);
  if (token2) params.set("token2", token2);
  if (token3) params.set("token3", token3);

  const url = `${KAVENEGAR_BASE}/${env.kavenegar.apiKey}/verify/lookup.json?${params.toString()}`;
  try {
    const res = await fetch(url);
    const body = await res.text();
    if (!res.ok) {
      await logSms(phone, type, "FAILED", `HTTP ${res.status}: ${body.slice(0, 300)}`);
      throw new Error(`Kavenegar lookup failed: ${res.status} ${body}`);
    }
    await logSms(phone, type, "SUCCESS");
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith("Kavenegar lookup failed"))) {
      await logSms(phone, type, "FAILED", err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

export async function sendOtpSms(phone: string, code: string): Promise<void> {
  await sendLookup({ phone, type: "OTP", template: env.kavenegar.templates.otp, token: code });
}

export async function sendBookingConfirmationSms(
  phone: string,
  opts: { serviceName: string; dateLabel: string; time: string }
): Promise<void> {
  await sendLookup({
    phone,
    type: "BOOKING_CONFIRM",
    template: env.kavenegar.templates.bookingConfirm,
    token: opts.serviceName,
    token2: opts.dateLabel,
    token3: opts.time,
  });
}

export async function sendBookingReminderSms(
  phone: string,
  opts: { serviceName: string; dateLabel: string; time: string }
): Promise<void> {
  await sendLookup({
    phone,
    type: "REMINDER",
    template: env.kavenegar.templates.reminder,
    token: opts.serviceName,
    token2: opts.dateLabel,
    token3: opts.time,
  });
}

export async function sendThankYouReviewSms(
  phone: string,
  opts: { serviceName: string; reviewUrl: string }
): Promise<void> {
  await sendLookup({
    phone,
    type: "THANK_YOU_REVIEW",
    template: env.kavenegar.templates.thankYouReview,
    token: opts.serviceName,
    token2: opts.reviewUrl,
  });
}
