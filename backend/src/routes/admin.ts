import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import sharp from "sharp";
import { z } from "zod";
import { Prisma, BookingStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { normalizePhone } from "../lib/phone";
import { parseDateOnly, toDateOnlyString, dayOfWeekUTC } from "../lib/dates";
import { sendThankYouReviewSms } from "../services/kavenegar";
import { isObjectStorageConfigured, uploadBuffer } from "../lib/objectStorage";
import { env } from "../lib/env";
import { cancelBookingAndMaybeRefund } from "../services/bookingCancellation";

const router = Router();
router.use(requireAuth, requireAdmin);

/* ---------- dashboard (real aggregates only — no placeholder/fake numbers) ---------- */

router.get("/dashboard", async (_req, res) => {
  const todayStr = toDateOnlyString(new Date());
  const today = parseDateOnly(todayStr)!;

  // Persian week starts Saturday — dayOfWeekUTC follows 0=Sunday..6=Saturday
  // (see schema.prisma), so Saturday(6)->0 days back, Sunday(0)->1, ... Friday(5)->6
  const daysSinceSaturday = (dayOfWeekUTC(today) + 1) % 7;
  const weekStart = new Date(today);
  weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceSaturday);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);

  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

  // a booking someone cancelled (or that expired unpaid) never actually
  // happened — counting it would overstate real salon activity
  const NOT_CANCELLED: BookingStatus[] = ["CANCELLED", "EXPIRED"];

  // "revenue" here only counts deposits actually confirmed paid through
  // ZarinPal (Payment.status="PAID", scoped by verifiedAt — when the money
  // actually arrived, not the booking's appointment date). Manual/in-person
  // bookings never get a Payment row at all, so they're deliberately excluded
  // — we have no real confirmation that cash changed hands for those, and
  // counting an unconfirmed amount as "income" would be a made-up number.
  // exclusive upper bound (`lt`, not `lte`) — verifiedAt carries a real
  // time-of-day, unlike the date-only Booking.date field used elsewhere here
  const revenueWhere = (from: Date, to: Date) => ({
    status: "PAID" as const,
    verifiedAt: { gte: from, lt: to },
  });
  const endOfToday = new Date(today);
  endOfToday.setUTCDate(endOfToday.getUTCDate() + 1);
  const endOfWeek = new Date(weekEnd);
  endOfWeek.setUTCDate(endOfWeek.getUTCDate() + 1);
  // the month's revenue window runs from monthStart through "right now", which
  // is the same exclusive upper bound as today's — no need to compute it twice
  const endOfMonth = endOfToday;

  const [
    todayCount,
    weekCount,
    monthCount,
    todayRevenue,
    weekRevenue,
    monthRevenue,
    last7Days,
    topServiceGroups,
    recentBookings,
  ] = await Promise.all([
    prisma.booking.count({ where: { date: today, status: { notIn: NOT_CANCELLED } } }),
    prisma.booking.count({ where: { date: { gte: weekStart, lte: weekEnd }, status: { notIn: NOT_CANCELLED } } }),
    prisma.booking.count({ where: { date: { gte: monthStart, lte: today }, status: { notIn: NOT_CANCELLED } } }),
    prisma.payment.aggregate({ _sum: { amount: true }, where: revenueWhere(today, endOfToday) }),
    prisma.payment.aggregate({ _sum: { amount: true }, where: revenueWhere(weekStart, endOfWeek) }),
    prisma.payment.aggregate({ _sum: { amount: true }, where: revenueWhere(monthStart, endOfMonth) }),
    Promise.all(
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - (6 - i));
        return prisma.booking
          .count({ where: { date: d, status: { notIn: NOT_CANCELLED } } })
          .then((count) => ({ date: toDateOnlyString(d), dayOfWeek: dayOfWeekUTC(d), count }));
      })
    ),
    prisma.booking.groupBy({
      by: ["serviceId"],
      where: { serviceId: { not: null }, status: { notIn: NOT_CANCELLED } },
      _count: { serviceId: true },
    }),
    prisma.booking.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { service: true, user: true },
    }),
  ]);

  // sorted here instead of via groupBy's `orderBy: { _count: ... }` — Prisma's
  // TS overloads for that get ambiguous once both `_count` and an
  // aggregate-based `orderBy` are present in the same call
  const topServices = topServiceGroups
    .slice()
    .sort((a, b) => b._count.serviceId - a._count.serviceId)
    .slice(0, 5);

  const serviceIds = topServices.map((g) => g.serviceId).filter((id): id is string => Boolean(id));
  const services = serviceIds.length
    ? await prisma.service.findMany({ where: { id: { in: serviceIds } } })
    : [];
  const serviceNameById = Object.fromEntries(services.map((s) => [s.id, s.name]));
  const popularServices = topServices.map((g) => ({
    serviceId: g.serviceId,
    name: (g.serviceId && serviceNameById[g.serviceId]) || "—",
    count: g._count.serviceId,
  }));

  res.json({
    today: { count: todayCount, date: todayStr, revenue: todayRevenue._sum.amount ?? 0 },
    week: { count: weekCount, revenue: weekRevenue._sum.amount ?? 0 },
    month: { count: monthCount, revenue: monthRevenue._sum.amount ?? 0 },
    last7Days,
    popularServices,
    recentBookings: recentBookings.map((b) => ({
      id: b.id,
      date: b.date,
      time: b.time,
      status: b.status,
      customerName: (b.user ? `${b.user.firstName} ${b.user.lastName}` : null) || b.blockReason || "بدون مشتری",
      serviceName: b.service?.name || b.blockReason || "بدون سرویس",
      createdAt: b.createdAt,
    })),
  });
});

/* ---------- image upload (gallery photos, logo, profile photos) ---------- */

// local disk is only a dev fallback for when OBJECT_STORAGE_* isn't
// configured — a PaaS app container's local disk isn't guaranteed to survive
// a plan resize or redeploy, so production must use object storage
const uploadDir = path.join(__dirname, "..", "..", "..", "public", "uploads");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp"];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// the client-supplied filename/extension is trivially spoofable, so the
// actual stored extension and Content-Type are derived from the file's real
// magic bytes, not from what the uploader claims it is
function detectImageExtension(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return ".png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP")
    return ".webp";
  return null;
}

// caps dimensions and re-encodes at a reasonable quality so a multi-megabyte
// phone-camera photo doesn't get served as-is to every site visitor — width
// is what the public design actually needs (largest image on the page is a
// full-bleed hero/profile shot), height caps portrait-orientation uploads
async function optimizeImage(buffer: Buffer, ext: string): Promise<Buffer> {
  const resized = sharp(buffer)
    .rotate() // auto-orient from EXIF, then the orientation tag is dropped
    .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true });
  if (ext === ".png") return resized.png({ quality: 82, compressionLevel: 9 }).toBuffer();
  if (ext === ".webp") return resized.webp({ quality: 82 }).toBuffer();
  return resized.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "فایل تصویر معتبر ارسال نشد." });
  const ext = detectImageExtension(req.file.buffer);
  if (!ext) return res.status(400).json({ error: "فایل تصویر معتبر نیست." });
  const key = `${crypto.randomUUID()}${ext}`;

  let optimized: Buffer;
  try {
    optimized = await optimizeImage(req.file.buffer, ext);
  } catch (err) {
    console.error("Image optimization failed:", err);
    return res.status(400).json({ error: "پردازش تصویر ناموفق بود." });
  }

  if (isObjectStorageConfigured()) {
    try {
      const url = await uploadBuffer(optimized, key, IMAGE_CONTENT_TYPES[ext]);
      return res.status(201).json({ url });
    } catch (err) {
      console.error("Object storage upload failed:", err);
      return res.status(502).json({ error: "آپلود به فضای ذخیره‌سازی ابری ناموفق بود." });
    }
  }

  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, key), optimized);
  res.status(201).json({ url: `/uploads/${key}` });
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
  note: z.string().max(300).nullable().optional(),
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
  openTime: z.string().max(10).nullable().optional(),
  closeTime: z.string().max(10).nullable().optional(),
  reason: z.string().max(300).nullable().optional(),
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
  reason: z.string().max(300).nullable().optional(),
});

router.post("/day-exceptions/closure-range", async (req, res) => {
  const parsed = closureRangeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const start = parseDateOnly(parsed.data.startDate);
  const end = parseDateOnly(parsed.data.endDate);
  if (!start || !end || end < start) return res.status(400).json({ error: "بازه‌ی تاریخ نامعتبر است." });

  // check the range size from the two timestamps directly, before building
  // any array — an admin submitting e.g. year 9999 as endDate would otherwise
  // make the server allocate millions of Date objects before ever rejecting it
  const dayCount = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  if (dayCount > 90) return res.status(400).json({ error: "بازه‌ی بسته‌شدن نباید بیشتر از ۹۰ روز باشد." });

  const dates: Date[] = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(new Date(d));
  }

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
  name: z.string().min(1).max(120).optional(),
  priceMin: z.number().int().nullable().optional(),
  priceMax: z.number().int().nullable().optional(),
  priceLabel: z.string().max(120).nullable().optional(),
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
  key: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  categoryId: z.string(),
  priceMin: z.number().int().nullable().optional(),
  priceMax: z.number().int().nullable().optional(),
  priceLabel: z.string().max(120).nullable().optional(),
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
    // sortOrder is a single global sequence across all groups (not just
    // within-group) — that's what lets it control which group appears
    // before which, since the public page groups rows by first appearance
    // in whatever order this query returns them
    orderBy: { sortOrder: "asc" },
  });
  res.json({ items });
});

const priceListPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(400).nullable().optional(),
  priceMin: z.number().int().nullable().optional(),
  priceMax: z.number().int().nullable().optional(),
  priceLabel: z.string().max(120).nullable().optional(),
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

const REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;

router.get("/reviews", async (req, res) => {
  const raw = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
  // an unrecognized value used to get cast straight into the Prisma query
  // (`as` bypasses type-checking, not validation) — Prisma rejects it with an
  // unhandled error rather than silently misbehaving, but a bad ?status=
  // value should just be a normal 400, not a request that depends on the
  // global error handler to avoid a 500
  if (raw !== undefined && !REVIEW_STATUSES.includes(raw as (typeof REVIEW_STATUSES)[number])) {
    return res.status(400).json({ error: "وضعیت نامعتبر است." });
  }
  const status = raw as (typeof REVIEW_STATUSES)[number] | undefined;
  const reviews = await prisma.review.findMany({
    where: status ? { status } : undefined,
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

// the manual-booking form has a single free-text "customer name" field (an
// admin quickly noting down a walk-in/phone customer), but User now requires
// separate firstName/lastName — split on the first space, same convention
// as the migration that backfilled existing rows.
function splitFullName(full: string | null | undefined): { firstName: string; lastName: string } {
  const trimmed = (full || "").trim();
  if (!trimmed) return { firstName: "مشتری", lastName: "-" };
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { firstName: trimmed, lastName: "-" };
  return { firstName: trimmed.slice(0, spaceIdx), lastName: trimmed.slice(spaceIdx + 1).trim() || "-" };
}

const manualBookingSchema = z.object({
  categoryId: z.string(),
  date: z.string(),
  time: z.string(),
  serviceId: z.string().nullable().optional(),
  customerName: z.string().max(120).nullable().optional(),
  customerPhone: z.string().nullable().optional(),
  reason: z.string().max(300).nullable().optional(),
  depositAmount: z.number().int().min(0).max(100_000_000).optional(),
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
    const { firstName, lastName } = splitFullName(parsed.data.customerName);
    const user = await prisma.user.upsert({
      where: { phone },
      create: { phone, firstName, lastName },
      update: parsed.data.customerName ? { firstName, lastName } : {},
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
    include: { service: true, user: true, payment: true },
  });
  if (!booking) return res.status(404).json({ error: "رزرو یافت نشد." });

  if (parsed.data.status === "CANCELLED") {
    // same 48h refund-eligibility policy as the customer's own cancel
    // button — see services/bookingCancellation.ts
    await cancelBookingAndMaybeRefund(booking);
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

// lets Ghazal close out a NEEDS_MANUAL_FOLLOWUP refund after she's issued it
// herself directly in the ZarinPal panel (automatic refunds always land in
// that state for now — see services/zarinpalRefund.ts) — otherwise the
// admin panel's cancellation view would show it as unresolved forever
const refundStatusSchema = z.object({ refundStatus: z.literal("SUCCEEDED") });

router.patch("/payments/:id/refund-status", async (req, res) => {
  const parsed = refundStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!payment) return res.status(404).json({ error: "پرداخت یافت نشد." });
  if (payment.refundStatus !== "NEEDS_MANUAL_FOLLOWUP") {
    return res.status(400).json({ error: "این پرداخت نیاز به پیگیری دستی ندارد." });
  }

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { refundStatus: "SUCCEEDED", refundedAt: new Date() },
  });
  res.json({ payment: updated });
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
  doniaPhone: z.string().max(40).nullable().optional(),
  doniaInstagram: z.string().max(60).nullable().optional(),
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
