import { z } from "zod";

// applies to every place a user SETS a new password (registration,
// change-password, forgot-password reset) — not to /login, which only
// verifies an existing hash and must keep accepting passwords created
// under whatever rule was in force when they were set
export const PASSWORD_POLICY_MESSAGE = "رمز عبور باید حداقل ۸ کاراکتر و شامل حروف و عدد باشد.";

export const strongPasswordSchema = z
  .string()
  .min(8, PASSWORD_POLICY_MESSAGE)
  .max(72, PASSWORD_POLICY_MESSAGE)
  .refine((pw) => /[A-Za-z]/.test(pw) && /[0-9]/.test(pw), { message: PASSWORD_POLICY_MESSAGE });
