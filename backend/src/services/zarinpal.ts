import { env } from "../lib/env";

const isSandbox = env.zarinpal.sandbox;
const API_BASE = isSandbox
  ? "https://sandbox.zarinpal.com/pg/v4/payment"
  : "https://api.zarinpal.com/pg/v4/payment";
const STARTPAY_BASE = isSandbox
  ? "https://sandbox.zarinpal.com/pg/StartPay"
  : "https://www.zarinpal.com/pg/StartPay";

function isConfigured(): boolean {
  return Boolean(env.zarinpal.merchantId);
}

interface ZarinpalRequestResponse {
  data?: { code: number; authority: string; fee_type?: string; fee?: number };
  errors?: unknown;
}

interface ZarinpalVerifyResponse {
  data?: { code: number; ref_id: number | string; card_pan?: string };
  errors?: unknown;
}

export interface ZarinpalRequestResult {
  authority: string;
  paymentUrl: string;
}

/**
 * Creates a ZarinPal payment request for the deposit amount (بیعانه), in Toman.
 * ZarinPal's v4 API expects Rial, so the amount is multiplied by 10 here —
 * every caller in this codebase works in Toman to match the salon's pricing.
 */
export async function createZarinpalPayment(opts: {
  amountToman: number;
  description: string;
  mobile?: string;
  callbackUrl: string;
}): Promise<ZarinpalRequestResult> {
  if (!isConfigured()) {
    // Dev/placeholder mode: fabricate a fake authority so the booking flow
    // (create booking -> pay -> callback -> confirm) is fully testable
    // before real ZarinPal credentials are provided.
    const fakeAuthority = `SANDBOX-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.warn(
      `[zarinpal:DEV] ZARINPAL_MERCHANT_ID not set — fabricating authority ${fakeAuthority}`
    );
    const sep = opts.callbackUrl.includes("?") ? "&" : "?";
    return {
      authority: fakeAuthority,
      paymentUrl: `${opts.callbackUrl}${sep}Authority=${fakeAuthority}&Status=OK&dev=1`,
    };
  }

  const res = await fetch(`${API_BASE}/request.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      merchant_id: env.zarinpal.merchantId,
      amount: opts.amountToman * 10,
      description: opts.description,
      mobile: opts.mobile,
      callback_url: opts.callbackUrl,
    }),
  });

  const data = (await res.json()) as ZarinpalRequestResponse;
  if (data?.data?.code !== 100) {
    throw new Error(
      `ZarinPal payment request failed: ${JSON.stringify(data?.errors ?? data)}`
    );
  }

  const authority = data.data.authority as string;
  return {
    authority,
    paymentUrl: `${STARTPAY_BASE}/${authority}`,
  };
}

export interface ZarinpalVerifyResult {
  ok: boolean;
  refId?: string;
  code?: number;
}

export async function verifyZarinpalPayment(opts: {
  amountToman: number;
  authority: string;
}): Promise<ZarinpalVerifyResult> {
  if (!isConfigured()) {
    console.warn(
      `[zarinpal:DEV] ZARINPAL_MERCHANT_ID not set — auto-approving authority ${opts.authority}`
    );
    return { ok: true, refId: `DEV-${Date.now()}`, code: 100 };
  }

  const res = await fetch(`${API_BASE}/verify.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      merchant_id: env.zarinpal.merchantId,
      amount: opts.amountToman * 10,
      authority: opts.authority,
    }),
  });

  const data = (await res.json()) as ZarinpalVerifyResponse;
  const code = data?.data?.code;
  // 100 = newly verified, 101 = already verified (still a success)
  if ((code === 100 || code === 101) && data.data) {
    return { ok: true, refId: String(data.data.ref_id), code };
  }
  return { ok: false, code };
}
