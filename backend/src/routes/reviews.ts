import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma";
import { optionalAuth } from "../middleware/auth";

const router = Router();

router.get("/", async (req, res) => {
  const sort = req.query.sort === "new" ? "new" : "top";
  const reviews = await prisma.review.findMany({
    where: { status: "APPROVED" },
    orderBy:
      sort === "new"
        ? { createdAt: "desc" }
        : [{ rating: "desc" }, { createdAt: "desc" }],
  });
  res.json({ reviews });
});

const createLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "تعداد ثبت نظر زیاد بوده، کمی بعد دوباره تلاش کنید." },
});

const createSchema = z.object({
  name: z.string().min(1).max(60),
  rating: z.number().int().min(1).max(5),
  text: z.string().min(1).max(300),
});

router.post("/", createLimiter, optionalAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const review = await prisma.review.create({
    data: {
      name: parsed.data.name,
      rating: parsed.data.rating,
      text: parsed.data.text,
      userId: req.auth?.userId,
      status: "PENDING",
    },
  });
  res.status(201).json({
    review,
    message: "نظر شما ثبت شد و پس از تایید، نمایش داده می‌شود.",
  });
});

export default router;
