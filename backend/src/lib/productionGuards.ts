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
 * Called once at server startup — refuses to start rather than silently
 * run production traffic through a dev fallback. Called AFTER env.ts's own
 * `required()` checks (JWT_SECRET etc. already throw if literally unset);
 * this catches the "set, but still the placeholder / still empty for an
 * optional-looking var" case those don't.
 */
export function assertProductionSafety(): void {
  if (env.nodeEnv !== "production") return;

  const problems: string[] = [];

  if (!env.zarinpal.merchantId) {
    problems.push(
      "ZARINPAL_MERCHANT_ID is not set — every deposit payment would silently auto-succeed without charging anything (see services/zarinpal.ts dev-mode fallback)."
    );
  }
  if (!env.kavenegar.apiKey) {
    problems.push(
      "KAVENEGAR_API_KEY is not set — OTP codes would be written to server logs instead of sent as SMS, and no customer could actually log in."
    );
  }
  if (env.jwtSecret === PLACEHOLDER_JWT_SECRET) {
    problems.push("JWT_SECRET is still the placeholder value from .env.example — auth tokens would be forgeable.");
  }
  if (env.jwtSecret.length < 32) {
    problems.push(`JWT_SECRET is only ${env.jwtSecret.length} characters — use at least 32 random characters.`);
  }
  if (env.adminSeedPassword === PLACEHOLDER_ADMIN_PASSWORD) {
    problems.push("ADMIN_SEED_PASSWORD is still the placeholder value from .env.example.");
  }

  if (problems.length) {
    throw new Error(
      `Refusing to start in production with unsafe configuration:\n` + problems.map((p) => `  - ${p}`).join("\n")
    );
  }
}
