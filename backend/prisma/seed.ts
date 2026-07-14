import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// dayOfWeek convention: 0=Sunday .. 6=Saturday (matches JS Date#getDay / the frontend)
const REG_DAYS = [0, 1, 2, 3, 4]; // Sunday..Thursday
const FRIDAY = 5;
const SATURDAY = 6;

async function main() {
  console.log("Seeding working days...");
  for (let dow = 0; dow <= 6; dow++) {
    const isSaturday = dow === SATURDAY;
    await prisma.workingDay.upsert({
      where: { dayOfWeek: dow },
      create: {
        dayOfWeek: dow,
        isOpen: !isSaturday,
        openTime: isSaturday ? null : dow === FRIDAY ? "12:00" : "10:00",
        closeTime: isSaturday ? null : "19:00",
      },
      update: {},
    });
  }

  console.log("Seeding service categories...");
  const categories = await Promise.all(
    [
      { key: "h", name: "هیرکات", allowOnlineBooking: true, fridayAvailable: true, sortOrder: 1 },
      { key: "t", name: "صافی و احیای مو", allowOnlineBooking: true, fridayAvailable: true, sortOrder: 2 },
      { key: "c", name: "رنگ و لایت", allowOnlineBooking: false, fridayAvailable: false, sortOrder: 3 },
      { key: "p", name: "دکلره و رنگ موی پیکسی", allowOnlineBooking: true, fridayAvailable: true, sortOrder: 4 },
      { key: "s", name: "اسکراب اسکالپ", allowOnlineBooking: true, fridayAvailable: false, sortOrder: 5 },
    ].map((c) =>
      prisma.serviceCategory.upsert({ where: { key: c.key }, create: c, update: c })
    )
  );
  const catByKey = Object.fromEntries(categories.map((c) => [c.key, c]));

  console.log("Seeding bookable services...");
  const services = [
    { key: "haircut", name: "هیرکات", categoryKey: "h", priceMin: 1650000, priceMax: 2800000, depositAmount: 300000, sortOrder: 1 },
    { key: "protein_therapy", name: "پروتئین‌تراپی", categoryKey: "t", priceMin: 6500000, priceMax: 12000000, depositAmount: 1000000, sortOrder: 2 },
    { key: "keratin", name: "کراتینه", categoryKey: "t", priceMin: 7500000, priceMax: 14000000, depositAmount: 1000000, sortOrder: 3 },
    { key: "botox", name: "بوتاکس مو", categoryKey: "t", priceMin: 7500000, priceMax: 14000000, depositAmount: 1000000, sortOrder: 4 },
    { key: "crabotox", name: "کرابوتاکس", categoryKey: "t", priceMin: 8000000, priceMax: 15000000, depositAmount: 1000000, sortOrder: 5 },
    { key: "color_highlight", name: "رنگ و لایت", categoryKey: "c", priceLabel: "با مشاوره", depositAmount: 0, sortOrder: 6 },
    { key: "pixie_bleach", name: "دکلره و رنگ موی پیکسی", categoryKey: "p", priceMin: 7000000, priceMax: 10500000, depositAmount: 700000, sortOrder: 7 },
    { key: "scalp_scrub", name: "اسکراب اسکالپ", categoryKey: "s", priceMin: 2800000, priceMax: 4000000, depositAmount: 300000, sortOrder: 8 },
  ];
  for (const s of services) {
    const { categoryKey, ...data } = s;
    await prisma.service.upsert({
      where: { key: s.key },
      create: { ...data, categoryId: catByKey[categoryKey].id },
      update: { ...data, categoryId: catByKey[categoryKey].id },
    });
  }

  console.log("Seeding time slots...");
  const slotPlan: Record<string, { reg: string[]; fri: string[] }> = {
    h: { reg: ["10:00", "11:20", "12:45", "14:30", "15:45", "17:00", "18:30"], fri: ["12:00", "13:30", "15:00", "16:30"] },
    t: { reg: ["10:00", "12:30", "14:30", "16:30"], fri: ["12:00", "14:30"] },
    p: { reg: ["11:00", "15:30"], fri: ["12:00", "15:00"] },
    s: { reg: ["10:00", "12:00", "14:00", "16:00"], fri: [] },
  };
  for (const [key, plan] of Object.entries(slotPlan)) {
    const category = catByKey[key];
    for (const dow of REG_DAYS) {
      for (const [i, time] of plan.reg.entries()) {
        await prisma.timeSlot.upsert({
          where: { categoryId_dayOfWeek_time: { categoryId: category.id, dayOfWeek: dow, time } },
          create: { categoryId: category.id, dayOfWeek: dow, time, sortOrder: i },
          update: {},
        });
      }
    }
    if (plan.fri.length && category.fridayAvailable) {
      for (const [i, time] of plan.fri.entries()) {
        await prisma.timeSlot.upsert({
          where: { categoryId_dayOfWeek_time: { categoryId: category.id, dayOfWeek: FRIDAY, time } },
          create: { categoryId: category.id, dayOfWeek: FRIDAY, time, sortOrder: i },
          update: {},
        });
      }
    }
  }

  console.log("Seeding price list...");
  const priceList: Array<{
    groupTitle: string;
    name: string;
    description?: string;
    priceMin?: number;
    priceMax?: number;
    priceLabel?: string;
    sortOrder: number;
  }> = [
    { groupTitle: "هیرکات (کوتاهی مو)", name: "قد کوتاه", description: "پیکسی، اسپایکی، بازکات، فید تخصصی و…", priceMin: 1650000, priceMax: 2000000, sortOrder: 1 },
    { groupTitle: "هیرکات (کوتاهی مو)", name: "قد تا فک / سرشانه", description: "باب‌ها و لیرهای کوتاه", priceMin: 1900000, priceMax: 2200000, sortOrder: 2 },
    { groupTitle: "هیرکات (کوتاهی مو)", name: "قد بلند (لانگ)", description: "خانواده‌ی لیرها", priceMin: 2200000, priceMax: 2800000, sortOrder: 3 },
    { groupTitle: "هیرکات (کوتاهی مو)", name: "مدل‌های آوانگارد و ترکیبی", description: "ولف‌کات، شگ مالت، شگی و…", priceMin: 2000000, priceMax: 2400000, sortOrder: 4 },
    { groupTitle: "صافی و احیای مو", name: "پروتئین‌تراپی مو", description: "بسته به حجم و قد موهای شما", priceMin: 6500000, priceMax: 12000000, sortOrder: 5 },
    { groupTitle: "صافی و احیای مو", name: "بوتاکس مو", description: "بسته به حجم و قد موهای شما", priceMin: 7500000, priceMax: 14000000, sortOrder: 6 },
    { groupTitle: "صافی و احیای مو", name: "کرابوتاکس مو", description: "بسته به حجم و قد موهای شما", priceMin: 8000000, priceMax: 15000000, sortOrder: 7 },
    { groupTitle: "صافی و احیای مو", name: "کراتینه", description: "بسته به حجم و قد موهای شما", priceMin: 7500000, priceMax: 14000000, sortOrder: 8 },
    { groupTitle: "صافی و احیای مو", name: "اسکراب اسکالپ", description: "پاک‌سازی کف سر، بسته به نیاز", priceMin: 2800000, priceMax: 4000000, sortOrder: 9 },
    { groupTitle: "رنگ و دکلره", name: "دکلره و رنگ موی پیکسی", description: "خانواده‌ی پیکسی — با بهترین متریال، بدون آسیب به کف سر و مو", priceMin: 7000000, priceMax: 10500000, sortOrder: 10 },
    { groupTitle: "رنگ و دکلره", name: "رنگ ریشه (رشد یک ماه)", description: "تثبیت رنگ ریشه‌ی تازه رشد کرده", priceMin: 1700000, sortOrder: 11 },
    { groupTitle: "رنگ و دکلره", name: "رنگ کامل مو", description: "بسته به قد و حجم موهای شما", priceMin: 2500000, priceMax: 4000000, sortOrder: 12 },
    { groupTitle: "رنگ و دکلره", name: "رنگ و لایت موی بلند", description: "نیازمند مشاوره‌ی تخصصی پیش از رزرو", priceLabel: "با مشاوره", sortOrder: 13 },
  ];
  for (const item of priceList) {
    const existing = await prisma.priceListItem.findFirst({
      where: { groupTitle: item.groupTitle, name: item.name },
    });
    if (existing) {
      await prisma.priceListItem.update({ where: { id: existing.id }, data: item });
    } else {
      await prisma.priceListItem.create({ data: item });
    }
  }

  const adminPhone = process.env.ADMIN_SEED_PHONE;
  const adminPassword = process.env.ADMIN_SEED_PASSWORD;
  if (adminPhone && adminPassword) {
    console.log(`Seeding admin user (${adminPhone})...`);
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await prisma.user.upsert({
      where: { phone: adminPhone },
      create: { phone: adminPhone, name: "غزل کرمی", role: "ADMIN", passwordHash },
      update: { role: "ADMIN", passwordHash },
    });
  } else {
    console.warn("ADMIN_SEED_PHONE/ADMIN_SEED_PASSWORD not set — skipping admin user seed.");
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
