import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  appBaseUrl: required("APP_BASE_URL", "http://localhost:4000"),
  frontendBaseUrl: required("FRONTEND_BASE_URL", "http://localhost:4000"),

  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "30d",

  adminSeedPhone: process.env.ADMIN_SEED_PHONE ?? "",
  adminSeedPassword: process.env.ADMIN_SEED_PASSWORD ?? "",

  kavenegar: {
    apiKey: process.env.KAVENEGAR_API_KEY ?? "",
    sender: process.env.KAVENEGAR_SENDER ?? "",
    otpTemplate: process.env.KAVENEGAR_OTP_TEMPLATE ?? "",
  },

  zarinpal: {
    merchantId: process.env.ZARINPAL_MERCHANT_ID ?? "",
    sandbox: (process.env.ZARINPAL_SANDBOX ?? "true") === "true",
    callbackUrl: required(
      "ZARINPAL_CALLBACK_URL",
      "http://localhost:4000/api/payments/zarinpal/callback"
    ),
  },
};
