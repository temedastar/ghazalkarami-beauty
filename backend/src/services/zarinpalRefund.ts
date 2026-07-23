import { env } from "../lib/env";

export interface RefundResult {
  success: boolean;
  refundRefId?: string;
  note: string;
}

const NOT_CONFIGURED_NOTE =
  "امکان استرداد خودکار وجود ندارد: کلید API استرداد زرین‌پال (client_id/client_secret) هنوز تنظیم نشده است.";

function isConfigured(): boolean {
  return Boolean(env.zarinpal.refund.clientId && env.zarinpal.refund.clientSecret);
}

/**
 * Requests a refund through ZarinPal's Refund API
 * (https://www.zarinpal.com/docs/apiDocs/query/refund). This is a SEPARATE
 * credential system from the classic Merchant ID payment gateway used
 * elsewhere in services/zarinpal.ts — the refund API sits on ZarinPal's
 * OAuth2 platform (https://www.zarinpal.com/docs/apiDocs/auth) and needs a
 * client_id/client_secret that ZarinPal support issues on request, not
 * something available self-service from the merchant panel.
 *
 * We don't have those credentials yet, so this always returns a
 * "needs manual follow-up" result — callers must record that and Ghazal
 * issues the refund herself outside the app, then marks it resolved via
 * PATCH /api/admin/payments/:id/refund-status.
 *
 * Once ZARINPAL_REFUND_CLIENT_ID / ZARINPAL_REFUND_CLIENT_SECRET (+
 * ZARINPAL_REFUND_USERNAME / ZARINPAL_REFUND_PASSWORD) are set, the real
 * flow goes here:
 *   1. POST https://next.zarinpal.com/api/oauth/token
 *      { grant_type: "password", client_id, client_secret, username, password, scope }
 *      -> { access_token, refresh_token, expires_in, token_type }
 *      (cache in memory until expiry, refresh with refresh_token afterward —
 *      there is no token caching here yet since it's never reached)
 *   2. POST the refund endpoint from the docs above with
 *      Authorization: Bearer <access_token> and { authority, ... }
 *   3. Map a successful response to { success: true, refundRefId }
 *   4. Map any error/non-2xx response to { success: false, note: <message> }
 */
export async function requestZarinpalRefund(authority: string, amountToman: number): Promise<RefundResult> {
  if (!isConfigured()) {
    console.warn(
      `[zarinpal-refund:DEV] refund credentials not set — authority ${authority}, amount ${amountToman} تومان needs manual follow-up`
    );
    return { success: false, note: NOT_CONFIGURED_NOTE };
  }

  // unreachable until the credentials above are set — see the docstring
  return { success: false, note: NOT_CONFIGURED_NOTE };
}
