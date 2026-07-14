import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma";
import { normalizePhone } from "../lib/phone";
import { signAuthToken } from "../lib/jwt";
import { requestOtp, verifyOtp, OtpError } from "../services/otp";
import { requireAuth } from "../middleware/auth";
import { env } from "../lib/env";

const router = Router();

const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "درخواست‌های زیاد. کمی صبر کنید." },
});

const COOKIE_NAME = "token";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function setAuthCookie(res: import("express").Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.nodeEnv === "production",
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

const requestOtpSchema = z.object({
  phone: z.string(),
  purpose: z.enum(["REGISTER", "LOGIN"]),
});

router.post("/otp/request", otpLimiter, async (req, res) => {
  const parsed = requestOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "شماره موبایل معتبر نیست." });

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
  name: z.string().min(2).max(80).optional(),
});

router.post("/otp/verify", otpLimiter, async (req, res) => {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "شماره موبایل معتبر نیست." });

  let valid: boolean;
  try {
    valid = await verifyOtp(phone, parsed.data.purpose, parsed.data.code);
  } catch (err) {
    if (err instanceof OtpError) return res.status(400).json({ error: err.message });
    throw err;
  }
  if (!valid) return res.status(400).json({ error: "کد وارد شده صحیح نیست." });

  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    user = await prisma.user.create({
      data: { phone, name: parsed.data.name ?? null },
    });
  }

  const token = signAuthToken({ userId: user.id, role: user.role });
  setAuthCookie(res, token);
  res.json({
    token,
    user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
  });
});

const loginSchema = z.object({
  phone: z.string(),
  password: z.string().min(6),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "شماره موبایل معتبر نیست." });

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user?.passwordHash) {
    return res.status(401).json({ error: "شماره موبایل یا رمز عبور اشتباه است." });
  }

  const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "شماره موبایل یا رمز عبور اشتباه است." });

  const token = signAuthToken({ userId: user.id, role: user.role });
  setAuthCookie(res, token);
  res.json({
    token,
    user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
  });
});

const setPasswordSchema = z.object({ password: z.string().min(6).max(72) });

router.post("/set-password", requireAuth, async (req, res) => {
  const parsed = setPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "رمز عبور باید حداقل ۶ کاراکتر باشد." });
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
      name: user.name,
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
  newPassword: z.string().min(6).max(72),
});

router.post("/password/reset/verify", otpLimiter, async (req, res) => {
  const parsed = resetVerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

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
  setAuthCookie(res, token);
  res.json({
    token,
    user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
  });
});

router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

export default router;
