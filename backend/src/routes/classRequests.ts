import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

const router = Router();

const createLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "تعداد درخواست زیاد بوده، کمی بعد دوباره تلاش کنید." },
});

const createSchema = z.object({
  classType: z.string().min(1).max(60),
  timePref: z.string().min(1).max(60),
});

router.post("/", createLimiter, requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ورودی نامعتبر است." });

  const request = await prisma.classRequest.create({
    data: {
      classType: parsed.data.classType,
      timePref: parsed.data.timePref,
      userId: req.auth!.userId,
    },
  });
  res.status(201).json({ request });
});

export default router;
