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
import { isObjectStorageConfigured, uploadBuffer, deleteObject, headBucket, describeStorageError } from "../lib/objectStorage";
import { env } from "../lib/env";
import { cancelBookingAndMaybeRefund } from "../services/bookingCancellation";

const router = Router();
router.use(requireAuth, requireAdmin);

// Prisma's `include: { user: true }` (or a plain `prisma.user.findMany()`
// with no `select`) returns every column, including passwordHash — a bcrypt
// hash, but still not something that should ever leave the server, admin
// panel or not. Every place this route file reads a User for an API
// response goes through this instead.
const SAFE_USER_SELECT = {
  id: true,
  phone: true,
  firstName: true,
  lastName: true,
  role: true,
  createdAt: true,
} as const;

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
      include: { service: true, user: { select: SAFE_USER_SELECT } },
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
// full-bleed hero/profile shot), height caps portrait-orientation uploads.
// Output is always WebP regardless of what was uploaded: none of these
// images (salon/gallery photos) need PNG transparency, and WebP runs
// 25-35% smaller than JPEG/PNG at equivalent visual quality — direct win
// for LCP on the hero/profile photos and for gallery load time.
async function optimizeImage(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate() // auto-orient from EXIF, then the orientation tag is dropped
    .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "فایل تصویر معتبر ارسال نشد." });
  // still real-format-checked via magic bytes before any processing — only
  // the STORED extension is now always .webp, not what got uploaded
  if (!detectImageExtension(req.file.buffer)) return res.status(400).json({ error: "فایل تصویر معتبر نیست." });
  const key = `${crypto.randomUUID()}.webp`;

  let optimized: Buffer;
  try {
    optimized = await optimizeImage(req.file.buffer);
  } catch (err) {
    console.error("Image optimization failed:", err);
    return res.status(400).json({ error: "پردازش تصویر ناموفق بود." });
  }

  if (isObjectStorageConfigured()) {
    try {
      const url = await uploadBuffer(optimized, key, "image/webp");
      // upload itself succeeding says nothing about whether the CALLER then
      // successfully saves this url anywhere (gallery row, site-content
      // key) — logging it here gives a fixed reference point: if a photo
      // never shows up, checking whether ITS url appears in this log at all
      // tells you immediately whether the break is before or after this line
      console.log(`Upload OK: key=${key} originalBytes=${req.file.size} url=${url}`);
      return res.status(201).json({ url });
    } catch (err) {
      // uploadBuffer() already logs the full structured error server-side;
      // the exact provider error code is included here too (not just the
      // generic message) since this response only ever reaches an
      // authenticated admin, and it saves a trip to the server log for the
      // common case — see GET /admin/object-storage/test for the full
      // diagnostic picture (config values, connectivity stage, etc.)
      const detail = describeStorageError(err);
      return res.status(502).json({
        error: "آپلود به فضای ذخیره‌سازی ابری ناموفق بود.",
        detail: detail.code || detail.name || detail.causeCode || detail.message || null,
      });
    }
  }

  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, key), optimized);
  res.status(201).json({ url: `/uploads/${key}` });
});

// every place that removes or replaces an uploaded image (gallery delete,
// site-content logo/portrait delete or re-upload) needs to clean up the
// actual file too, not just the DB row/value pointing at it — otherwise the
// old file sits in the bucket forever, taking up paid storage, orphaned and
// unreachable from any admin UI. Best-effort by design: the key naming
// scheme (a bare UUID + extension, see /upload above) means a stored URL's
// last path segment IS the key regardless of which base (publicUrlBase or
// endpoint/bucket) built it, so this works without touching the DB schema.
async function deleteUploadedFile(url: string | null | undefined): Promise<void> {
  if (!url) return;
  if (isObjectStorageConfigured()) {
    const key = url.split("/").filter(Boolean).pop();
    if (!key) return;
    await deleteObject(key).catch(() => {});
  } else if (url.startsWith("/uploads/")) {
    const key = url.slice("/uploads/".length);
    if (!key || key.includes("/")) return; // defensive: never touch anything outside uploadDir
    fs.promises.unlink(path.join(uploadDir, key)).catch(() => {});
  }
}

// diagnostic-only: lets Ghazal (or whoever's troubleshooting) confirm the
// object storage connection actually works — and see the REAL error if it
// doesn't — without needing to upload a real photo or read server logs.
// Tries two stages so a failure points at the right thing: HeadBucket first
// (pure connectivity/credentials/bucket-exists check, no write), then a
// tiny real PutObject+DeleteObject round-trip (confirms write permission
// too, then cleans up after itself).
router.get("/object-storage/test", async (_req, res) => {
  const config = {
    endpointConfigured: Boolean(env.objectStorage.endpoint),
    endpoint: env.objectStorage.endpoint || null,
    bucketConfigured: Boolean(env.objectStorage.bucket),
    bucket: env.objectStorage.bucket || null,
    region: env.objectStorage.region,
    accessKeyConfigured: Boolean(env.objectStorage.accessKeyId),
    secretKeyConfigured: Boolean(env.objectStorage.secretAccessKey),
    publicUrlBase: env.objectStorage.publicUrlBase || null,
  };
  if (!isObjectStorageConfigured()) {
    return res.json({
      ok: false,
      stage: "config",
      config,
      error: "یکی از متغیرهای ضروری (OBJECT_STORAGE_ENDPOINT / OBJECT_STORAGE_BUCKET / OBJECT_STORAGE_ACCESS_KEY) تنظیم نشده — آپلود روی دیسک محلی سرور انجام می‌شود که در پروداکشن با هر ری‌استارت پاک می‌شود.",
    });
  }

  try {
    await headBucket();
  } catch (err) {
    return res.json({ ok: false, stage: "connect", config, error: describeStorageError(err) });
  }

  const testKey = `_diagnostic-test-${Date.now()}.txt`;
  let publicUrl: string;
  try {
    publicUrl = await uploadBuffer(Buffer.from("ok"), testKey, "text/plain");
  } catch (err) {
    return res.json({ ok: false, stage: "upload", config, error: describeStorageError(err) });
  }

  // uploading (an authenticated, signed request) succeeding says nothing
  // about whether an ANONYMOUS visitor's browser can load the same file —
  // that depends entirely on the bucket's public/private access level, a
  // console setting this code can't see or change. A plain unauthenticated
  // fetch of the exact URL galleries/site-content images will be served at
  // is the only way to actually answer that, using Ghazal's real bucket
  // instead of guessing from documentation.
  let publicAccess: { reachable: boolean; httpStatus: number | null; error: string | null };
  try {
    const probe = await fetch(publicUrl);
    publicAccess = { reachable: probe.ok, httpStatus: probe.status, error: null };
  } catch (err) {
    publicAccess = { reachable: false, httpStatus: null, error: describeStorageError(err).causeMessage || String(err) };
  }

  // deleteObject() already logs its own failure server-side — a cleanup
  // failure here shouldn't hide the actual test result the admin is waiting on
  await deleteObject(testKey).catch(() => {});

  return res.json({ ok: publicAccess.reachable, stage: "upload", config, publicUrl, publicAccess });
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

router.get("/day-exceptions", async (req, res) => {
  // the "زمان‌بندی سالن" tab wants future exceptions only (its default, no
  // params) — the calendar view needs to see exceptions for whatever week
  // it's currently showing, including past ones when navigating backward,
  // so it passes an explicit range instead
  const fromStr = typeof req.query.from === "string" ? req.query.from : undefined;
  const toStr = typeof req.query.to === "string" ? req.query.to : undefined;
  const from = fromStr ? parseDateOnly(fromStr) : undefined;
  const to = toStr ? parseDateOnly(toStr) : undefined;
  const exceptions = await prisma.dayException.findMany({
    where:
      from && to ? { date: { gte: from, lte: to } } : { date: { gte: new Date(new Date().toISOString().slice(0, 10)) } },
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

// the undo counterpart to the bulk close above — a mistaken 90-day close
// shouldn't require deleting exceptions one at a time from the list below.
// Only touches isOpen:false rows in the range, not every exception in it:
// a deliberately-added "extra hours" or "custom schedule" exception that
// happens to fall inside the same date range is a different admin decision
// and must survive an "undo my bulk close" click untouched.
router.delete("/day-exceptions/closure-range", async (req, res) => {
  const parsed = z.object({ startDate: z.string(), endDate: z.string() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const start = parseDateOnly(parsed.data.startDate);
  const end = parseDateOnly(parsed.data.endDate);
  if (!start || !end || end < start) return res.status(400).json({ error: "بازه‌ی تاریخ نامعتبر است." });

  const dayCount = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  if (dayCount > 90) return res.status(400).json({ error: "بازه‌ی بازکردن نباید بیشتر از ۹۰ روز باشد." });

  const { count } = await prisma.dayException.deleteMany({
    where: { date: { gte: start, lte: end }, isOpen: false },
  });
  res.json({ count });
});

// registered AFTER /day-exceptions/closure-range on purpose — Express
// matches routes in registration order, and this :id wildcard would
// otherwise swallow "closure-range" as if it were an id, throwing a
// confusing "record not found" instead of ever reaching that route
router.delete("/day-exceptions/:id", async (req, res) => {
  await prisma.dayException.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
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
  try {
    const slot = await prisma.timeSlot.create({ data: parsed.data });
    res.status(201).json({ slot });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "این ساعت از قبل برای این دسته‌بندی و روز ثبت شده است." });
    }
    throw err;
  }
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

const priceListCreateSchema = z.object({
  groupTitle: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  description: z.string().max(400).nullable().optional(),
  priceMin: z.number().int().nullable().optional(),
  priceMax: z.number().int().nullable().optional(),
  priceLabel: z.string().max(120).nullable().optional(),
});

router.post("/price-list", async (req, res) => {
  const parsed = priceListCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  // places the new row at the end of its own group: the highest sortOrder
  // among rows sharing the same groupTitle, plus one — a brand-new group
  // (no existing rows) falls back to the end of the whole list instead, so
  // it still appears after every group already on the page
  const siblingMax = await prisma.priceListItem.aggregate({
    where: { groupTitle: parsed.data.groupTitle },
    _max: { sortOrder: true },
  });
  const overallMax = await prisma.priceListItem.aggregate({ _max: { sortOrder: true } });
  const sortOrder = (siblingMax._max.sortOrder ?? overallMax._max.sortOrder ?? -1) + 1;
  const item = await prisma.priceListItem.create({ data: { ...parsed.data, sortOrder } });
  res.status(201).json({ item });
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

router.delete("/price-list/:id", async (req, res) => {
  await prisma.priceListItem.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
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
  console.log(`POST gallery: created id=${image.id} url=${image.url}`);
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
  const image = await prisma.galleryImage.delete({ where: { id: req.params.id } });
  await deleteUploadedFile(image.url);
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
  // date-range mode — used by the admin calendar view to fetch a whole
  // visible week in one request instead of one per day. Independent of
  // (and lower-priority than) the single-date/upcoming modes above, which
  // existing callers still use unchanged.
  const fromStr = typeof req.query.from === "string" ? req.query.from : undefined;
  const toStr = typeof req.query.to === "string" ? req.query.to : undefined;
  const date = dateStr ? parseDateOnly(dateStr) : undefined;
  const from = fromStr ? parseDateOnly(fromStr) : undefined;
  const to = toStr ? parseDateOnly(toStr) : undefined;
  const bookings = await prisma.booking.findMany({
    where: {
      ...(date ? { date } : {}),
      ...(upcoming ? { date: { gte: new Date(new Date().toISOString().slice(0, 10)) } } : {}),
      ...(from && to ? { date: { gte: from, lte: to } } : {}),
    },
    include: { service: true, category: true, user: { select: SAFE_USER_SELECT }, payment: true },
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

  // the admin panel's own service dropdown is populated from the selected
  // category, so this mismatch can't happen through normal UI use — but
  // nothing stops a direct API call from sending them out of sync, which
  // would silently lock the wrong shared-line group (SlotHold keys off
  // categoryId, not serviceId) for the requested time
  if (parsed.data.serviceId) {
    const service = await prisma.service.findUnique({ where: { id: parsed.data.serviceId } });
    if (!service || service.categoryId !== parsed.data.categoryId) {
      return res.status(400).json({ error: "سرویس انتخاب‌شده متعلق به این دسته‌بندی نیست." });
    }
  }

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
    include: { service: true, user: { select: SAFE_USER_SELECT }, payment: true },
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
    include: { service: true, category: true, user: { select: SAFE_USER_SELECT }, payment: true },
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
    select: { ...SAFE_USER_SELECT, _count: { select: { bookings: true } } },
  });
  res.json({ customers });
});

router.get("/customers/:id", async (req, res) => {
  const customer = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      ...SAFE_USER_SELECT,
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

// logo_url / ghazal_photo_url / donia_photo_url are SiteContent rows just
// like any text field (value = the image URL) — but replacing or clearing
// one of these specifically needs the OLD file cleaned up from storage too,
// unlike every other key here which is plain text with nothing to delete
const SITE_IMAGE_KEYS = new Set(["logo_url", "ghazal_photo_url", "donia_photo_url"]);

router.patch("/site-content/:key", async (req, res) => {
  const maxLength = SITE_CONTENT_MAX_LENGTHS[req.params.key] ?? DEFAULT_SITE_CONTENT_MAX_LENGTH;
  const parsed = z.object({ value: z.string().max(maxLength) }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `متن نباید بیشتر از ${maxLength} کاراکتر باشد.` });
  }
  const isImageKey = SITE_IMAGE_KEYS.has(req.params.key);
  const previous = isImageKey ? await prisma.siteContent.findUnique({ where: { key: req.params.key } }) : null;
  if (isImageKey) console.log(`PATCH site-content ${req.params.key}: saving value="${parsed.data.value}"`);
  const row = await prisma.siteContent.upsert({
    where: { key: req.params.key },
    create: { key: req.params.key, value: parsed.data.value },
    update: { value: parsed.data.value },
  });
  if (isImageKey) console.log(`PATCH site-content ${req.params.key}: DB now has value="${row.value}"`);
  if (previous && previous.value && previous.value !== parsed.data.value) {
    await deleteUploadedFile(previous.value);
  }
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
  platform: z.enum(["INSTAGRAM", "TELEGRAM", "WHATSAPP", "BALEH", "PHONE"]),
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
    include: { user: { select: SAFE_USER_SELECT } },
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
