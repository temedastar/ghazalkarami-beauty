import { env } from "../lib/env";

const KAVENEGAR_BASE = "https://api.kavenegar.com/v1";

function isConfigured(): boolean {
  return Boolean(env.kavenegar.apiKey && env.kavenegar.sender);
}

/**
 * Sends a plain SMS via Kavenegar. When no API key is configured yet
 * (placeholder/dev setup), logs to the console instead of failing —
 * lets the rest of the booking flow be tested before real credentials exist.
 */
async function sendSms(receptor: string, message: string): Promise<void> {
  if (!isConfigured()) {
    console.warn(
      `[kavenegar:DEV] KAVENEGAR_API_KEY not set — would send to ${receptor}: ${message}`
    );
    return;
  }

  const url = `${KAVENEGAR_BASE}/${env.kavenegar.apiKey}/sms/send.json`;
  const params = new URLSearchParams({
    receptor,
    sender: env.kavenegar.sender,
    message,
  });

  const res = await fetch(`${url}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kavenegar sms/send failed: ${res.status} ${body}`);
  }
}

export async function sendOtpSms(phone: string, code: string): Promise<void> {
  const message = `کد ورود شما به سایت غزل کرمی: ${code}\nتا ۵ دقیقه معتبر است.`;
  await sendSms(phone, message);
}

export async function sendBookingConfirmationSms(
  phone: string,
  opts: { serviceName: string; dateLabel: string; time: string }
): Promise<void> {
  const message = `نوبت شما در سالن غزل کرمی تایید شد.\nخدمت: ${opts.serviceName}\nزمان: ${opts.dateLabel} ساعت ${opts.time}\nمنتظرتون هستیم!`;
  await sendSms(phone, message);
}

export async function sendBookingReminderSms(
  phone: string,
  opts: { serviceName: string; dateLabel: string; time: string }
): Promise<void> {
  const message = `یادآوری نوبت فردا در سالن غزل کرمی.\nخدمت: ${opts.serviceName}\nزمان: ${opts.dateLabel} ساعت ${opts.time}`;
  await sendSms(phone, message);
}
