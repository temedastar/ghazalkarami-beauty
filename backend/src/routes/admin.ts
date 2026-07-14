import { Router } from "express";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireAdmin } from "../middleware/auth";

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

/* ---------- working days ---------- */

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

/* ---------- categories & time slots ---------- */

router.get("/categories", async (_req, res) => {
  const categories = await prisma.serviceCategory.findMany({
    orderBy: { sortOrder: "asc" },
    include: { timeSlots: { orderBy: [{ dayOfWeek: "asc" }, { time: "asc" }] } },
  });
  res.json({ categories });
});

const categoryPatchSchema = z.object({
  allowOnlineBooking: z.boolean().optional(),
  fridayAvailable: z.boolean().optional(),
});

router.patch("/categories/:id", async (req, res) => {
  const parsed = categoryPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const category = await prisma.serviceCategory.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  res.json({ category });
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
  priceNote: z.string().nullable().optional(),
  depositAmount: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

router.patch("/services/:id", async (req, res) => {
  const parsed = servicePatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });
  const service = await prisma.service.update({ where: { id: req.params.id }, data: parsed.data });
  res.json({ service });
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

/* ---------- bookings overview ---------- */

router.get("/bookings", async (req, res) => {
  const dateStr = typeof req.query.date === "string" ? req.query.date : undefined;
  const bookings = await prisma.booking.findMany({
    where: dateStr ? { date: new Date(dateStr) } : undefined,
    include: { service: true, category: true, user: true, payment: true },
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });
  res.json({ bookings });
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
