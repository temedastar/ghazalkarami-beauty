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
  // "chem" is the shared timeline: protein-therapy, keratin, botox, crabotox,
  // color/highlight and pixie-bleach all draw from the SAME slot grid, so
  // booking any one of them (online or entered by Ghazal) blocks the rest.
  // Haircut and scalp scrub each keep their own independent grid.
  const categories = await Promise.all(
    [
      { key: "h", name: "هیرکات", sortOrder: 1 },
      { key: "chem", name: "پروتئین‌تراپی، کراتینه، بوتاکس، کرابوتاکس، رنگ و لایت، دکلره و رنگ پیکسی (خط زمانی مشترک)", sortOrder: 2 },
      { key: "s", name: "اسکراب اسکالپ", sortOrder: 3 },
    ].map((c) =>
      prisma.serviceCategory.upsert({ where: { key: c.key }, create: c, update: c })
    )
  );
  const catByKey = Object.fromEntries(categories.map((c) => [c.key, c]));

  console.log("Seeding bookable services...");
  const services = [
    { key: "haircut", name: "هیرکات", categoryKey: "h", priceMin: 1650000, priceMax: 2800000, durationMin: 45, allowOnlineBooking: true, depositValue: 300000, sortOrder: 1 },
    { key: "protein_therapy", name: "پروتئین‌تراپی", categoryKey: "chem", priceMin: 6500000, priceMax: 12000000, durationMin: 180, allowOnlineBooking: true, depositValue: 1000000, sortOrder: 2 },
    { key: "keratin", name: "کراتینه", categoryKey: "chem", priceMin: 7500000, priceMax: 14000000, durationMin: 180, allowOnlineBooking: true, depositValue: 1000000, sortOrder: 3 },
    { key: "botox", name: "بوتاکس مو", categoryKey: "chem", priceMin: 7500000, priceMax: 14000000, durationMin: 180, allowOnlineBooking: true, depositValue: 1000000, sortOrder: 4 },
    { key: "crabotox", name: "کرابوتاکس", categoryKey: "chem", priceMin: 8000000, priceMax: 15000000, durationMin: 180, allowOnlineBooking: true, depositValue: 1000000, sortOrder: 5 },
    { key: "color_highlight", name: "رنگ و لایت", categoryKey: "chem", priceLabel: "با مشاوره", durationMin: 180, allowOnlineBooking: false, depositValue: 0, sortOrder: 6 },
    { key: "pixie_bleach", name: "دکلره و رنگ موی پیکسی", categoryKey: "chem", priceMin: 7000000, priceMax: 10500000, durationMin: 150, allowOnlineBooking: true, depositValue: 700000, sortOrder: 7 },
    { key: "scalp_scrub", name: "اسکراب اسکالپ", categoryKey: "s", priceMin: 2800000, priceMax: 4000000, durationMin: 40, allowOnlineBooking: true, depositValue: 300000, sortOrder: 8 },
  ];
  for (const s of services) {
    const { categoryKey, ...data } = s;
    await prisma.service.upsert({
      where: { key: s.key },
      create: { ...data, depositType: "FIXED", categoryId: catByKey[categoryKey].id },
      update: { ...data, depositType: "FIXED", categoryId: catByKey[categoryKey].id },
    });
  }

  console.log("Seeding time slots...");
  const slotPlan: Record<string, { reg: string[]; fri: string[] }> = {
    h: { reg: ["10:00", "11:20", "12:45", "14:30", "15:45", "17:00", "18:30"], fri: ["12:00", "13:30", "15:00", "16:30"] },
    chem: { reg: ["10:00", "12:30", "14:30", "16:30"], fri: ["12:00", "14:30"] },
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
    if (plan.fri.length) {
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
    // sortOrder is a single global sequence (not per-group) — it's what
    // decides both the group display order (A: هیرکات، B: صافی و احیا، C: رنگ
    // و دکلره) and the row order within each group, since the API now orders
    // by sortOrder alone (see catalog.ts/admin.ts) and the frontend groups
    // rows by first appearance in that order.
    { groupTitle: "هیرکات (کوتاهی مو)", name: "قد کوتاه", description: "پیکسی، اسپایکی، بازکات، فید تخصصی و…", priceMin: 1650000, priceMax: 2000000, sortOrder: 1 },
    { groupTitle: "هیرکات (کوتاهی مو)", name: "قد تا فک / سرشانه", description: "باب‌ها و لیرهای کوتاه", priceMin: 1900000, priceMax: 2200000, sortOrder: 2 },
    { groupTitle: "هیرکات (کوتاهی مو)", name: "قد بلند (لانگ)", description: "خانواده‌ی لیرها", priceMin: 2200000, priceMax: 2800000, sortOrder: 3 },
    { groupTitle: "هیرکات (کوتاهی مو)", name: "مدل‌های آوانگارد و ترکیبی", description: "ولف‌کات، شگ مالت، شگی و…", priceMin: 2000000, priceMax: 2400000, sortOrder: 4 },
    { groupTitle: "صافی و احیای مو", name: "پروتئین‌تراپی مو", description: "بسته به حجم و قد موهای شما", priceMin: 6500000, priceMax: 12000000, sortOrder: 5 },
    { groupTitle: "صافی و احیای مو", name: "کراتینه", description: "بسته به حجم و قد موهای شما", priceMin: 7500000, priceMax: 14000000, sortOrder: 6 },
    { groupTitle: "صافی و احیای مو", name: "بوتاکس مو", description: "بسته به حجم و قد موهای شما", priceMin: 7500000, priceMax: 14000000, sortOrder: 7 },
    { groupTitle: "صافی و احیای مو", name: "کرابوتاکس مو", description: "بسته به حجم و قد موهای شما", priceMin: 8000000, priceMax: 15000000, sortOrder: 8 },
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

  console.log("Seeding settings...");
  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", reminderHoursBefore: 24, defaultDepositType: "FIXED", defaultDepositValue: 300000 },
    update: {},
  });

  console.log("Seeding contact info...");
  await prisma.contactInfo.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      phone: "02188776655",
      whatsapp: "09121234567",
      address: "تهران، خیابان ولیعصر، نرسیده به میدان ونک",
    },
    update: {},
  });

  console.log("Seeding social links...");
  const socialSeeds: { platform: "INSTAGRAM" | "TELEGRAM" | "WHATSAPP" | "BALEH"; label: string; value: string }[] = [
    { platform: "INSTAGRAM", label: "سالن غزل کرمی", value: "ghazalkarami.salon" },
    { platform: "TELEGRAM", label: "سالن غزل کرمی", value: "ghazalkarami_salon" },
    { platform: "WHATSAPP", label: "سالن غزل کرمی", value: "09121234567" },
    { platform: "BALEH", label: "سالن غزل کرمی", value: "ghazalkarami_salon" },
  ];
  for (const s of socialSeeds) {
    const existing = await prisma.socialLink.findFirst({ where: { platform: s.platform, label: s.label } });
    if (!existing) await prisma.socialLink.create({ data: s });
  }

  console.log("Seeding editable site text...");
  const siteContent: Record<string, string> = {
    marquee_text: "ممنون از اینکه ما را انتخاب کردید",
    hero_tagline: "اینجا خانه‌ای امن برای زیبایی‌ست",
    hero_description: "هر سرویس متناسب با بافت، حجم و نیاز موی شما طراحی می‌شود؛ از هیرکات مدرن تا درمان و بازسازی کامل موها با تکنیک‌های روز.",
    tagline_band: "از دل، برای موهای شما",
    ghazal_bio_1: "غزل کرمی را می‌توان جایی در میانه‌ی دقت تکنیکی و نگاه هنری پیدا کرد؛ کسی که هر سرویس را نه یک الگوی ثابت برای همه، بلکه طرحی متناسب با فرم چهره، بافت مو و شخصیت هر مشتری می‌بیند.",
    ghazal_bio_2: "در کنار فعالیت در سالن، غزل به‌عنوان مدرس هیرکات نیز فعالیت می‌کند و همین نگاه را به هنرجویانش منتقل می‌کند.",
    ghazal_signature: "زیبایی یعنی حسِ امنیت و آرامش",
    donia_bio: "دنیا سلیمانی با بیش از دو دهه تجربه، از چهره‌های باسابقه‌ی حرفه‌ی رنگ، لایت و احیای مو است. تسلط او بر تکنیک‌های ترکیب رنگ، فرمولاسیون و ترمیم موهای آسیب‌دیده، حاصل سال‌ها کار مداوم و به‌روز نگه‌داشتن دانش این حرفه است.",
  };
  for (const [key, value] of Object.entries(siteContent)) {
    await prisma.siteContent.upsert({ where: { key }, create: { key, value }, update: {} });
  }

  const adminPhone = process.env.ADMIN_SEED_PHONE;
  const adminPassword = process.env.ADMIN_SEED_PASSWORD;
  if (adminPhone && adminPassword) {
    console.log(`Seeding admin user (${adminPhone})...`);
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await prisma.user.upsert({
      where: { phone: adminPhone },
      create: { phone: adminPhone, firstName: "غزل", lastName: "کرمی", role: "ADMIN", passwordHash },
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
