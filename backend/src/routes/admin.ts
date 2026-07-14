import { Router } from "express";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { normalizePhone } from "../lib/phone";
import { parseDateOnly } from "../lib/dates";
import { sendThankYouReviewSms } from "../services/kavenegar";
import { env } from "../lib/env";

const router = Router();
router.use(requireAuth, requireAdmin);

/* ---------- image upload (gallery photos) ---------- */

const uploadDir = path.join(__dirname, "..", "..", "..", "public", "uploads");
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp"];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "فایل تصویر معتبر ارسال نشد." });
  res.status(201).json({ url: `/uploads/${req.file.filename}` });
});

/* ---------- working days (default weekly pattern) ---------- */

router.get("/working-days", async (_req, res) => {
  const days = await prisma.workingDay.findMany({ orderBy: { dayOfWeek: "asc" } });
  res.json({ days });
});

const workingDaySchema = z.object({
  isOpen: z.boolean().optional(),
  openTime: z.string().nullable().optional(),
  closeTime: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

router.patch("/working-days/:dayOfWeek", async (req, res) => {
  const dayOfWeek = Number(req.params.dayOfWeek);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    return res.status(400).json({ error: "روز هفته نامعتبر است." });
  }
  const parsed = workingDaySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const day = await prisma.workingDay.upsert({
    where: { dayOfWeek },
    create: { dayOfWeek, isOpen: parsed.data.isOpen ?? true, ...parsed.data },
    update: parsed.data,
  });
  res.json({ day });
});

/* ---------- day exceptions (specific-date overrides + temporary closures) ---------- */

router.get("/day-exceptions", async (_req, res) => {
  const exceptions = await prisma.dayException.findMany({
    where: { date: { gte: new Date(new Date().toISOString().slice(0, 10)) } },
    orderBy: { date: "asc" },
  });
  res.json({ exceptions });
});

const dayExceptionSchema = z.object({
  date: z.string(),
  isOpen: z.boolean(),
  openTime: z.string().nullable().optional(),
  closeTime: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});

router.post("/day-exceptions", async (req, res) => {
  const parsed = dayExceptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const date = parseDateOnly(parsed.data.date);
  if (!date) return res.status(400).json({ error: "تاریخ نامعتبر است." });

  const exception = await prisma.dayException.upsert({
    where: { date },
    create: { ...parsed.data, date },
    update: { isOpen: parsed.data.isOpen, openTime: parsed.data.openTime, closeTime: parsed.data.closeTime, reason: parsed.data.reason },
  });
  res.status(201).json({ exception });
});

router.delete("/day-exceptions/:id", async (req, res) => {
  await prisma.dayException.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

const closureRangeSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  reason: z.string().nullable().optional(),
});

router.post("/day-exceptions/closure-range", async (req, res) => {
  const parsed = closureRangeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const start = parseDateOnly(parsed.data.startDate);
  const end = parseDateOnly(parsed.data.endDate);
  if (!start || !end || end < start) return res.status(400).json({ error: "بازه‌ی تاریخ نامعتبر است." });

  const dates: Date[] = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(new Date(d));
  }
  if (dates.length > 90) return res.status(400).json({ error: "بازه‌ی بسته‌شدن نباید بیشتر از ۹۰ روز باشد." });

  const created = await prisma.$transaction(
    dates.map((date) =>
      prisma.dayException.upsert({
        where: { date },
        create: { date, isOpen: false, reason: parsed.data.reason },
        update: { isOpen: false, reason: parsed.data.reason },
      })
    )
  );
  res.status(201).json({ exceptions: created });
});

/* ---------- categories & time slots ---------- */

router.get("/categories", async (_req, res) => {
  const categories = await prisma.serviceCategory.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      timeSlots: { orderBy: [{ dayOfWeek: "asc" }, { time: "asc" }] },
      services: { orderBy: { sortOrder: "asc" } },
    },
  });
  res.json({ categories });
});

const timeSlotSchema = z.object({
  categoryId: z.string(),
  dayOfWeek: z.number().int().min(0).max(6),
  time: z.string().min(1),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

router.post("/time-slots", async (req, res) => {
  const parsed = timeSlotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const slot = await prisma.timeSlot.create({ data: parsed.data });
  res.status(201).json({ slot });
});

const timeSlotPatchSchema = z.object({
  isActive: z.boolean().optional(),
  time: z.string().optional(),
  sortOrder: z.number().int().optional(),
});

router.patch("/time-slots/:id", async (req, res) => {
  const parsed = timeSlotPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const slot = await prisma.timeSlot.update({ where: { id: req.params.id }, data: parsed.data });
  res.json({ slot });
});

router.delete("/time-slots/:id", async (req, res) => {
  await prisma.timeSlot.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

function timesBetween(startTime: string, endTime: string, durationMin: number, gapMin: number): string[] {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  const step = durationMin + gapMin;
  const times: string[] = [];
  for (let t = startMinutes; t + durationMin <= endMinutes; t += step) {
    const h = Math.floor(t / 60)
      .toString()
      .padStart(2, "0");
    const m = (t % 60).toString().padStart(2, "0");
    times.push(`${h}:${m}`);
  }
  return times;
}

const generateSlotsSchema = z.object({
  categoryId: z.string(),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string(),
  endTime: z.string(),
  durationMin: z.number().int().min(5).max(600),
  gapMin: z.number().int().min(0).max(240).default(0),
});

router.post("/time-slots/generate", async (req, res) => {
  const parsed = generateSlotsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const times = timesBetween(parsed.data.startTime, parsed.data.endTime, parsed.data.durationMin, parsed.data.gapMin);
  if (!times.length) return res.status(400).json({ error: "با این تنظیمات هیچ اسلاتی ساخته نمی‌شود." });

  const created = await prisma.$transaction(
    times.map((time, i) =>
      prisma.timeSlot.upsert({
        where: {
          categoryId_dayOfWeek_time: { categoryId: parsed.data.categoryId, dayOfWeek: parsed.data.dayOfWeek, time },
        },
        create: { categoryId: parsed.data.categoryId, dayOfWeek: parsed.data.dayOfWeek, time, sortOrder: i },
        update: { isActive: true, sortOrder: i },
      })
    )
  );
  res.status(201).json({ slots: created });
});

/* ---------- services / pricing ---------- */

router.get("/services", async (_req, res) => {
  const services = await prisma.service.findMany({
    orderBy: { sortOrder: "asc" },
    include: { category: true },
  });
  res.json({ services });
});

const servicePatchSchema = z.object({
  name: z.string().min(1).optional(),
  priceMin: z.number().int().nullable().optional(),
  priceMax: z.number().int().nullable().optional(),
  priceLabel: z.string().nullable().optional(),
  priceNote: z.string().max(400).nullable().optional(),
  durationMin: z.number().int().nullable().optional(),
  allowOnlineBooking: z.boolean().optional(),
  depositType: z.enum(["FIXED", "PERCENT"]).optional(),
  depositValue: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

router.patch("/services/:id", async (req, res) => {
  const parsed = servicePatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const service = await prisma.service.update({ where: { id: req.params.id }, data: parsed.data });
  res.json({ service });
});

const serviceCreateSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  categoryId: z.string(),
  priceMin: z.number().int().nullable().optional(),
  priceMax: z.number().int().nullable().optional(),
  priceLabel: z.string().nullable().optional(),
  durationMin: z.number().int().nullable().optional(),
  allowOnlineBooking: z.boolean().optional(),
  depositType: z.enum(["FIXED", "PERCENT"]).optional(),
  depositValue: z.number().int().min(0).optional(),
});

router.post("/services", async (req, res) => {
  const parsed = serviceCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  try {
    const service = await prisma.service.create({ data: parsed.data });
    res.status(201).json({ service });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "سرویسی با این شناسه (key) از قبل وجود دارد." });
    }
    throw err;
  }
});

/* ---------- price list (display-only pricing table) ---------- */

router.get("/price-list", async (_req, res) => {
  const items = await prisma.priceListItem.findMany({
    orderBy: [{ groupTitle: "asc" }, { sortOrder: "asc" }],
  });
  res.json({ items });
});

const priceListPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  priceMin: z.number().int().nullable().optional(),
  priceMax: z.number().int().nullable().optional(),
  priceLabel: z.string().nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

router.patch("/price-list/:id", async (req, res) => {
  const parsed = priceListPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const item = await prisma.priceListItem.update({ where: { id: req.params.id }, data: parsed.data });
  res.json({ item });
});

/* ---------- gallery ---------- */

router.get("/gallery", async (_req, res) => {
  const images = await prisma.galleryImage.findMany({ orderBy: { sortOrder: "asc" } });
  res.json({ images });
});

const gallerySchema = z.object({
  url: z.string().min(1),
  category: z.enum(["haircut", "color", "treat"]),
  sortOrder: z.number().int().optional(),
});

router.post("/gallery", async (req, res) => {
  const parsed = gallerySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const image = await prisma.galleryImage.create({ data: parsed.data });
  res.status(201).json({ image });
});

const galleryPatchSchema = z.object({
  category: z.enum(["haircut", "color", "treat"]).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

router.patch("/gallery/:id", async (req, res) => {
  const parsed = galleryPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const image = await prisma.galleryImage.update({ where: { id: req.params.id }, data: parsed.data });
  res.json({ image });
});

router.delete("/gallery/:id", async (req, res) => {
  await prisma.galleryImage.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/* ---------- reviews moderation ---------- */

router.get("/reviews", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
  const reviews = await prisma.review.findMany({
    where: status ? { status: status as "PENDING" | "APPROVED" | "REJECTED" } : undefined,
    orderBy: { createdAt: "desc" },
  });
  res.json({ reviews });
});

const reviewPatchSchema = z.object({ status: z.enum(["APPROVED", "REJECTED", "PENDING"]) });

router.patch("/reviews/:id", async (req, res) => {
  const parsed = reviewPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const review = await prisma.review.update({ where: { id: req.params.id }, data: parsed.data });
  res.json({ review });
});

router.delete("/reviews/:id", async (req, res) => {
  await prisma.review.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

const reviewCreateSchema = z.object({
  name: z.string().min(1).max(60),
  rating: z.number().int().min(1).max(5),
  text: z.string().min(1).max(300),
  createdAt: z.string().optional(), // for backfilling old Instagram/TikTok reviews with their real date
});

router.post("/reviews", async (req, res) => {
  const parsed = reviewCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const review = await prisma.review.create({
    data: {
      name: parsed.data.name,
      rating: parsed.data.rating,
      text: parsed.data.text,
      status: "APPROVED",
      ...(parsed.data.createdAt ? { createdAt: new Date(parsed.data.createdAt) } : {}),
    },
  });
  res.status(201).json({ review });
});

/* ---------- bookings: overview, manual entry, status changes ---------- */

router.get("/bookings", async (req, res) => {
  const dateStr = typeof req.query.date === "string" ? req.query.date : undefined;
  const upcoming = req.query.upcoming === "1";
  const date = dateStr ? parseDateOnly(dateStr) : undefined;
  const bookings = await prisma.booking.findMany({
    where: {
      ...(date ? { date } : {}),
      ...(upcoming ? { date: { gte: new Date(new Date().toISOString().slice(0, 10)) } } : {}),
    },
    include: { service: true, category: true, user: true, payment: true },
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });
  res.json({ bookings });
});

const manualBookingSchema = z.object({
  categoryId: z.string(),
  date: z.string(),
  time: z.string(),
  serviceId: z.string().nullable().optional(),
  customerName: z.string().nullable().optional(),
  customerPhone: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  depositAmount: z.number().int().min(0).optional(),
});

router.post("/bookings/manual", async (req, res) => {
  const parsed = manualBookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const date = parseDateOnly(parsed.data.date);
  if (!date) return res.status(400).json({ error: "تاریخ نامعتبر است." });

  let userId: string | null = null;
  if (parsed.data.customerPhone) {
    const phone = normalizePhone(parsed.data.customerPhone);
    if (!phone) return res.status(400).json({ error: "شماره موبایل مشتری معتبر نیست." });
    const user = await prisma.user.upsert({
      where: { phone },
      create: { phone, name: parsed.data.customerName || null },
      update: parsed.data.customerName ? { name: parsed.data.customerName } : {},
    });
    userId = user.id;
  }

  const source = parsed.data.serviceId || userId ? "ADMIN_MANUAL" : "ADMIN_BLOCK";

  try {
    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          categoryId: parsed.data.categoryId,
          date,
          time: parsed.data.time,
          serviceId: parsed.data.serviceId || null,
          userId,
          status: "CONFIRMED",
          source,
          depositAmount: parsed.data.depositAmount ?? 0,
          blockReason: parsed.data.reason || null,
        },
      });
      await tx.slotHold.create({
        data: { categoryId: parsed.data.categoryId, date, time: parsed.data.time, bookingId: created.id },
      });
      return created;
    });
    res.status(201).json({ booking });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "این تایم از قبل رزرو یا بسته شده است." });
    }
    throw err;
  }
});

const bookingStatusSchema = z.object({
  status: z.enum(["CONFIRMED", "CANCELLED", "COMPLETED", "NO_SHOW"]),
});

router.patch("/bookings/:id/status", async (req, res) => {
  const parsed = bookingStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { service: true, user: true },
  });
  if (!booking) return res.status(404).json({ error: "رزرو یافت نشد." });

  if (parsed.data.status === "CANCELLED") {
    await prisma.$transaction([
      prisma.slotHold.deleteMany({ where: { bookingId: booking.id } }),
      prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } }),
    ]);
  } else {
    await prisma.booking.update({ where: { id: booking.id }, data: { status: parsed.data.status } });
  }

  if (parsed.data.status === "COMPLETED" && booking.user && booking.service) {
    sendThankYouReviewSms(booking.user.phone, {
      serviceName: booking.service.name,
      reviewUrl: `${env.frontendBaseUrl}/#reviews`,
    }).catch((err) => console.error("Failed to send thank-you/review SMS:", err));
  }

  const updated = await prisma.booking.findUnique({
    where: { id: booking.id },
    include: { service: true, category: true, user: true, payment: true },
  });
  res.json({ booking: updated });
});

/* ---------- customers ---------- */

router.get("/customers", async (_req, res) => {
  const customers = await prisma.user.findMany({
    where: { role: "CUSTOMER" },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { bookings: true } } },
  });
  res.json({ customers });
});

router.get("/customers/:id", async (req, res) => {
  const customer = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: {
      bookings: {
        include: { service: true, category: true, payment: true },
        orderBy: { date: "desc" },
      },
    },
  });
  if (!customer) return res.status(404).json({ error: "مشتری یافت نشد." });
  res.json({ customer });
});

/* ---------- sms delivery log ---------- */

router.get("/sms-logs", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const logs = await prisma.smsLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  res.json({ logs });
});

/* ---------- settings ---------- */

router.get("/settings", async (_req, res) => {
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
  res.json({ settings });
});

const settingsPatchSchema = z.object({
  reminderHoursBefore: z.number().int().min(1).max(168).optional(),
  defaultDepositType: z.enum(["FIXED", "PERCENT"]).optional(),
  defaultDepositValue: z.number().int().min(0).optional(),
});

router.patch("/settings", async (req, res) => {
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...parsed.data },
    update: parsed.data,
  });
  res.json({ settings });
});

/* ---------- editable site text ---------- */

router.get("/site-content", async (_req, res) => {
  const rows = await prisma.siteContent.findMany();
  res.json({ content: rows });
});

// short headline-style keys get a tight cap so they can't visually break the
// hero/marquee layout; paragraph-style bios get more room. Unknown keys
// (shouldn't happen from the admin UI, but PATCH is by arbitrary :key) fall
// back to a conservative default rather than the old blanket 2000.
const SITE_CONTENT_MAX_LENGTHS: Record<string, number> = {
  marquee_text: 200,
  hero_tagline: 80,
  hero_description: 300,
  tagline_band: 100,
  ghazal_bio_1: 600,
  ghazal_bio_2: 600,
  ghazal_signature: 100,
  donia_bio: 600,
};
const DEFAULT_SITE_CONTENT_MAX_LENGTH = 500;

router.patch("/site-content/:key", async (req, res) => {
  const maxLength = SITE_CONTENT_MAX_LENGTHS[req.params.key] ?? DEFAULT_SITE_CONTENT_MAX_LENGTH;
  const parsed = z.object({ value: z.string().max(maxLength) }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `متن نباید بیشتر از ${maxLength} کاراکتر باشد.` });
  }
  const row = await prisma.siteContent.upsert({
    where: { key: req.params.key },
    create: { key: req.params.key, value: parsed.data.value },
    update: { value: parsed.data.value },
  });
  res.json({ content: row });
});

/* ---------- contact info & social links ---------- */

router.get("/contact-info", async (_req, res) => {
  const info = await prisma.contactInfo.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
  res.json({ contact: info });
});

const contactInfoPatchSchema = z.object({
  phone: z.string().max(40).nullable().optional(),
  whatsapp: z.string().max(40).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
});

router.patch("/contact-info", async (req, res) => {
  const parsed = contactInfoPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const info = await prisma.contactInfo.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...parsed.data },
    update: parsed.data,
  });
  res.json({ contact: info });
});

/* ---------- social links (multiple accounts per platform) ---------- */

router.get("/social-links", async (_req, res) => {
  const links = await prisma.socialLink.findMany({ orderBy: [{ platform: "asc" }, { sortOrder: "asc" }] });
  res.json({ links });
});

const socialLinkCreateSchema = z.object({
  platform: z.enum(["INSTAGRAM", "TELEGRAM", "WHATSAPP", "BALEH"]),
  label: z.string().min(1).max(60),
  value: z.string().min(1).max(120),
  sortOrder: z.number().int().optional(),
});

router.post("/social-links", async (req, res) => {
  const parsed = socialLinkCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const link = await prisma.socialLink.create({ data: parsed.data });
  res.status(201).json({ link });
});

const socialLinkPatchSchema = z.object({
  label: z.string().min(1).max(60).optional(),
  value: z.string().min(1).max(120).optional(),
  sortOrder: z.number().int().optional(),
});

router.patch("/social-links/:id", async (req, res) => {
  const parsed = socialLinkPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const link = await prisma.socialLink.update({ where: { id: req.params.id }, data: parsed.data });
  res.json({ link });
});

router.delete("/social-links/:id", async (req, res) => {
  await prisma.socialLink.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/* ---------- class requests ---------- */

router.get("/class-requests", async (_req, res) => {
  const requests = await prisma.classRequest.findMany({
    include: { user: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ requests });
});

const classRequestPatchSchema = z.object({
  status: z.enum(["NEW", "CONTACTED", "SCHEDULED", "CLOSED"]),
});

router.patch("/class-requests/:id", async (req, res) => {
  const parsed = classRequestPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const request = await prisma.classRequest.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  res.json({ request });
});

export default router;
