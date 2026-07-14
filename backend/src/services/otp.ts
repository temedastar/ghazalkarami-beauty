import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { sendOtpSms } from "./kavenegar";
import type { OtpPurpose } from "@prisma/client";

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

function generateCode(): string {
  return crypto.randomInt(100000, 999999).toString();
}

export async function requestOtp(phone: string, purpose: OtpPurpose): Promise<void> {
  const recent = await prisma.otpCode.findFirst({
    where: { phone, purpose, consumed: false },
    orderBy: { createdAt: "desc" },
  });
  if (recent) {
    const secondsSinceCreated = (Date.now() - recent.createdAt.getTime()) / 1000;
    if (secondsSinceCreated < RESEND_COOLDOWN_SECONDS) {
      const wait = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceCreated);
      throw new OtpError(`لطفاً ${wait} ثانیه دیگر دوباره تلاش کنید.`);
    }
  }

  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await prisma.otpCode.create({
    data: { phone, purpose, codeHash, expiresAt },
  });

  await sendOtpSms(phone, code);
}

export async function verifyOtp(
  phone: string,
  purpose: OtpPurpose,
  code: string
): Promise<boolean> {
  const otp = await prisma.otpCode.findFirst({
    where: { phone, purpose, consumed: false },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) throw new OtpError("کدی برای این شماره یافت نشد. دوباره درخواست دهید.");
  if (otp.expiresAt < new Date()) throw new OtpError("کد منقضی شده است. دوباره درخواست دهید.");
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    throw new OtpError("تعداد تلاش‌های مجاز تمام شده. دوباره درخواست دهید.");
  }

  const valid = await bcrypt.compare(code, otp.codeHash);
  if (!valid) {
    await prisma.otpCode.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    return false;
  }

  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumed: true } });
  return true;
}

export class OtpError extends Error {}
