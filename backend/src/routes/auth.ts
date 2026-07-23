import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { normalizePhone } from "../lib/phone";
import { signAuthToken } from "../lib/jwt";
import { requestOtp, verifyOtp, OtpError } from "../services/otp";
import { requireAuth } from "../middleware/auth";
import { strongPasswordSchema, PASSWORD_POLICY_MESSAGE } from "../lib/password";

const router = Router();

const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.rateLimits.otpPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "درخواست‌های زیاد. کمی صبر کنید." },
});

// password login is a classic brute-force target — cap attempts per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.rateLimits.loginPer15Min,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "تعداد تلاش‌های ورود بیش از حد مجاز است. چند دقیقه دیگر دوباره تلاش کنید." },
});

const requestOtpSchema = z.object({
  phone: z.string(),
  purpose: z.enum(["REGISTER", "LOGIN"]),
});

router.post("/otp/request", otpLimiter, async (req, res) => {
  const parsed = requestOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "شماره موبایل معتبر نیست." });

  // fail fast for a LOGIN attempt on a number that was never registered, or
  // a REGISTER attempt on one that already has an account — no point
  // sending a real SMS (cost) for a code that can never lead anywhere;
  // /otp/verify still re-checks both independently
  if (parsed.data.purpose === "LOGIN") {
    const existing = await prisma.user.findUnique({ where: { phone } });
    if (!existing) {
      return res.status(404).json({ error: "این شماره ثبت‌نام نشده است.", notRegistered: true });
    }
  } else {
    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      return res.status(409).json({ error: "این شماره قبلاً ثبت‌نام کرده است. لطفاً وارد شوید.", alreadyRegistered: true });
    }
  }

  try {
    await requestOtp(phone, parsed.data.purpose);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof OtpError) return res.status(429).json({ error: err.message });
    throw err;
  }
});

const verifyOtpSchema = z.object({
  phone: z.string(),
  code: z.string().length(6),
  purpose: z.enum(["REGISTER", "LOGIN"]),
  firstName: z.string().min(1).max(60).optional(),
  lastName: z.string().min(1).max(60).optional(),
});

router.post("/otp/verify", otpLimiter, async (req, res) => {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "شماره موبایل معتبر نیست." });

  // checked before verifyOtp() (which consumes the one-time code) so a
  // request that's doomed to fail for an unrelated reason — wrong purpose
  // for an unregistered number, or a REGISTER call missing the now-required
  // name fields — doesn't burn the person's only code for it
  let user = await prisma.user.findUnique({ where: { phone } });

  // a REGISTER attempt on a phone that already has an account used to just
  // silently log the person into their existing account (discarding the
  // firstName/lastName they'd just entered) instead of telling them they
  // already have one — same "form quietly does something other than what
  // it says" shape as the notRegistered fix below, just the mirror case
  if (user && parsed.data.purpose === "REGISTER") {
    return res.status(409).json({ error: "این شماره قبلاً ثبت‌نام کرده است. لطفاً وارد شوید.", alreadyRegistered: true });
  }

  if (!user) {
    // logging in via the SMS-code path used to silently create an account for
    // any phone number, even one that had never registered — that's a login
    // form quietly turning into registration. Only REGISTER may create a user.
    if (parsed.data.purpose !== "REGISTER") {
      return res.status(404).json({ error: "این شماره ثبت‌نام نشده است.", notRegistered: true });
    }
    if (!parsed.data.firstName || !parsed.data.lastName) {
      return res.status(400).json({ error: "نام و نام خانوادگی الزامی است." });
    }
  }

  let valid: boolean;
  try {
    valid = await verifyOtp(phone, parsed.data.purpose, parsed.data.code);
  } catch (err) {
    if (err instanceof OtpError) return res.status(400).json({ error: err.message });
    throw err;
  }
  if (!valid) return res.status(400).json({ error: "کد وارد شده صحیح نیست." });

  if (!user) {
    user = await prisma.user.create({
      data: { phone, firstName: parsed.data.firstName!, lastName: parsed.data.lastName! },
    });
  }

  const token = signAuthToken({ userId: user.id, role: user.role });
  res.json({
    token,
    user: { id: user.id, phone: user.phone, firstName: user.firstName, lastName: user.lastName, role: user.role },
  });
});

const loginSchema = z.object({
  phone: z.string(),
  password: z.string().min(6),
});

router.post("/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "شماره موبایل معتبر نیست." });

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    return res.status(404).json({ error: "این شماره ثبت‌نام نشده است.", notRegistered: true });
  }
  if (!user.passwordHash) {
    return res.status(401).json({ error: "برای این شماره رمز عبوری تنظیم نشده است. با کد پیامکی وارد شوید." });
  }

  const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "رمز عبور وارد شده اشتباه است." });

  const token = signAuthToken({ userId: user.id, role: user.role });
  res.json({
    token,
    user: { id: user.id, phone: user.phone, firstName: user.firstName, lastName: user.lastName, role: user.role },
  });
});

const setPasswordSchema = z.object({ password: strongPasswordSchema });

router.post("/set-password", requireAuth, async (req, res) => {
  const parsed = setPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
  }
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  await prisma.user.update({
    where: { id: req.auth!.userId },
    data: { passwordHash },
  });
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) return res.status(404).json({ error: "کاربر یافت نشد." });
  res.json({
    user: {
      id: user.id,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      hasPassword: Boolean(user.passwordHash),
    },
  });
});

const resetRequestSchema = z.object({ phone: z.string() });

router.post("/password/reset/request", otpLimiter, async (req, res) => {
  const parsed = resetRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "شماره موبایل معتبر نیست." });

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) return res.status(404).json({ error: "کاربری با این شماره یافت نشد." });

  try {
    await requestOtp(phone, "RESET_PASSWORD");
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof OtpError) return res.status(429).json({ error: err.message });
    throw err;
  }
});

const resetVerifySchema = z.object({
  phone: z.string(),
  code: z.string().length(6),
  newPassword: strongPasswordSchema,
});

router.post("/password/reset/verify", otpLimiter, async (req, res) => {
  const parsed = resetVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    const weakPassword = parsed.error.issues.some((issue) => issue.path[0] === "newPassword");
    return res.status(400).json({ error: weakPassword ? PASSWORD_POLICY_MESSAGE : "ورودی نامعتبر است." });
  }

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "شماره موبایل معتبر نیست." });

  let valid: boolean;
  try {
    valid = await verifyOtp(phone, "RESET_PASSWORD", parsed.data.code);
  } catch (err) {
    if (err instanceof OtpError) return res.status(400).json({ error: err.message });
    throw err;
  }
  if (!valid) return res.status(400).json({ error: "کد وارد شده صحیح نیست." });

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) return res.status(404).json({ error: "کاربری با این شماره یافت نشد." });

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  const token = signAuthToken({ userId: user.id, role: user.role });
  res.json({
    token,
    user: { id: user.id, phone: user.phone, firstName: user.firstName, lastName: user.lastName, role: user.role },
  });
});

router.post("/logout", (_req, res) => {
  res.json({ ok: true });
});

export default router;
