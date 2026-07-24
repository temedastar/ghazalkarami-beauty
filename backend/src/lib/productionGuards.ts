import { env } from "./env";

const PLACEHOLDER_JWT_SECRET = "change-this-to-a-long-random-string";
const PLACEHOLDER_ADMIN_PASSWORD = "change-me-strong-password";

/**
 * A handful of env vars degrade to a "dev/testing convenience" mode when
 * unset — fake ZarinPal payments always succeed, Kavenegar logs the OTP
 * code instead of sending it, JWT_SECRET falls back to whatever's in the
 * repo's own .env.example. All three are safe and deliberate in
 * development, but if any of them slipped into production unset it would
 * be a severe, silent failure mode: free/unpaid bookings confirming as
 * paid, real OTP codes sitting in plaintext server logs, or auth tokens
 * forgeable by anyone who's ever read the public repo.
 *
 * Called once at server startup, AFTER env.ts's own `required()` checks
 * (JWT_SECRET etc. already throw if literally unset) — this catches the
 * "set, but still the placeholder / still empty for an optional-looking
 * var" case those don't.
 *
 * Two different severities, not one blanket refusal:
 *   - JWT_SECRET/ADMIN_SEED_PASSWORD still being the literal .env.example
 *     placeholder has no legitimate reason to ever be true in a real
 *     deployment — auth itself is broken, not just one feature, so this
 *     still refuses to start.
 *   - ZarinPal/Kavenegar credentials being unset is a real, temporary
 *     business state (a salon that hasn't finished onboarding a payment
 *     gateway or SMS provider yet) — refusing to start over this took the
 *     entire public site down, including pages that need neither. This
 *     degrades to a loud startup warning instead: the specific dev-mode
 *     fallback it enables stays confined to payments/OTP, and everything
 *     else (browsing, admin panel, bookings minus their deposit step)
 *     keeps working while that gets sorted out.
 */
export function assertProductionSafety(): void {
  if (env.nodeEnv !== "production") return;

  const fatal: string[] = [];
  const warnings: string[] = [];

  if (env.jwtSecret === PLACEHOLDER_JWT_SECRET) {
    fatal.push("JWT_SECRET is still the placeholder value from .env.example — auth tokens would be forgeable.");
  }
  if (env.jwtSecret.length < 32) {
    fatal.push(`JWT_SECRET is only ${env.jwtSecret.length} characters — use at least 32 random characters.`);
  }
  if (env.adminSeedPassword === PLACEHOLDER_ADMIN_PASSWORD) {
    fatal.push("ADMIN_SEED_PASSWORD is still the placeholder value from .env.example.");
  }

  if (!env.zarinpal.merchantId) {
    warnings.push(
      "ZARINPAL_MERCHANT_ID is not set — every deposit payment will silently auto-succeed without charging anything (see services/zarinpal.ts dev-mode fallback). Set this as soon as the real ZarinPal merchant ID is available."
    );
  }
  if (!env.kavenegar.apiKey) {
    warnings.push(
      "KAVENEGAR_API_KEY is not set — OTP codes will be written to server logs instead of sent as SMS, and no customer can actually log in. Set this as soon as the real Kavenegar API key is available."
    );
  }

  // logged one problem per line (not folded into a single multi-line Error
  // message) so a log viewer that only surfaces the first line of a long
  // entry — which is exactly what hid the actual reason the first time
  // this fired in production — can't hide which check(s) failed
  warnings.forEach((w) => console.warn(`[production-safety] WARNING: ${w}`));

  if (fatal.length) {
    fatal.forEach((f) => console.error(`[production-safety] FATAL: ${f}`));
    throw new Error(
      `Refusing to start in production with unsafe configuration (${fatal.length} fatal problem${fatal.length > 1 ? "s" : ""} — see the [production-safety] FATAL lines above).`
    );
  }
}
