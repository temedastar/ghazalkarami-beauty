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

// Kavenegar's Lookup/Verify token values reject a raw space (confirmed in
// production: multi-word tokens like a service name "کوتاهی مو" or a Jalali
// date label "۱۴ مرداد ۱۴۰۵" came back as return.status 431 — "ساختار کد
// صحیح نمی‌باشد" — while the single-digit-only OTP token always worked).
// Collapsing whitespace to a hyphen keeps the token itself space-free for
// Kavenegar while staying readable if it ends up literally in the delivered
// text — unlike "_", a hyphen reads as a normal Persian word separator
// rather than a code artifact.
function sanitizeToken(value: string): string {
  return value.trim().replace(/\s+/g, "-");
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
  if (token) params.set("token", sanitizeToken(token));
  if (token2) params.set("token2", sanitizeToken(token2));
  if (token3) params.set("token3", sanitizeToken(token3));

  const url = `${KAVENEGAR_BASE}/${env.kavenegar.apiKey}/verify/lookup.json?${params.toString()}`;
  try {
    const res = await fetch(url);
    const body = await res.text();

    // Kavenegar can report a real failure (an unapproved template, a
    // template name that doesn't match what's registered in their panel, an
    // invalid receptor, ...) inside the JSON body's return.status field
    // while still answering with plain HTTP 200 — checking only res.ok let
    // those through as a logged "SUCCESS" even though no SMS was ever sent.
    let kavenegarStatus: number | undefined;
    let kavenegarMessage: string | undefined;
    try {
      const parsed = JSON.parse(body);
      kavenegarStatus = parsed?.return?.status;
      kavenegarMessage = parsed?.return?.message;
    } catch {
      // non-JSON body — the res.ok check below still catches this
    }

    if (!res.ok || (kavenegarStatus !== undefined && kavenegarStatus !== 200)) {
      const detail =
        kavenegarStatus !== undefined
          ? `Kavenegar status ${kavenegarStatus}: ${kavenegarMessage || "(no message)"}`
          : `HTTP ${res.status}: ${body.slice(0, 300)}`;
      await logSms(phone, type, "FAILED", detail);
      throw new Error(`Kavenegar lookup failed: ${detail}`);
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

export async function sendRefundSms(
  phone: string,
  opts: { serviceName: string; amountToman: number }
): Promise<void> {
  await sendLookup({
    phone,
    type: "REFUND",
    template: env.kavenegar.templates.refund,
    token: opts.serviceName,
    token2: String(opts.amountToman),
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
