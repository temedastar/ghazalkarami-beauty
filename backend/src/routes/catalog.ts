import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

router.get("/services", async (_req, res) => {
  const categories = await prisma.serviceCategory.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      services: {
        where: { active: true },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  res.json({ categories });
});

router.get("/working-days", async (_req, res) => {
  const days = await prisma.workingDay.findMany({ orderBy: { dayOfWeek: "asc" } });
  res.json({ days });
});

router.get("/price-list", async (_req, res) => {
  const items = await prisma.priceListItem.findMany({
    where: { active: true },
    // sortOrder is a single global sequence across all groups (not just
    // within-group) — that's what lets it control which group appears
    // before which, since the frontend groups rows by first appearance in
    // whatever order this query returns them (see loadPriceList() in
    // public/index.html)
    orderBy: { sortOrder: "asc" },
  });
  res.json({ items });
});

router.get("/gallery", async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const images = await prisma.galleryImage.findMany({
    where: { active: true, ...(category && category !== "all" ? { category } : {}) },
    orderBy: { sortOrder: "asc" },
  });
  res.json({ images });
});

router.get("/site-content", async (_req, res) => {
  const rows = await prisma.siteContent.findMany();
  const content: Record<string, string> = {};
  rows.forEach((r) => { content[r.key] = r.value; });
  res.json({ content });
});

router.get("/contact-info", async (_req, res) => {
  const [info, socialLinks] = await Promise.all([
    prisma.contactInfo.findUnique({ where: { id: "singleton" } }),
    prisma.socialLink.findMany({ orderBy: [{ platform: "asc" }, { sortOrder: "asc" }] }),
  ]);
  res.json({ contact: info, socialLinks });
});

export default router;
