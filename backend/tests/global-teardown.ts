import { connectToTestDatabase } from "./dbSafety";

/**
 * Runs once after the whole suite finishes — Playwright guarantees this
 * fires whether the run passed, failed, or a test threw outside a
 * try/finally, which is exactly the case per-test cleanup can't cover on
 * its own. Wipes every table a test could plausibly have written to;
 * leaves seed/reference data (services, categories, working hours, price
 * list, the admin account, contact info, site content) untouched since
 * global-setup.ts and every spec file depend on that existing already.
 */
export default async function globalTeardown() {
  const prisma = await connectToTestDatabase();
  try {
    await prisma.payment.deleteMany();
    await prisma.slotHold.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.review.deleteMany();
    await prisma.classRequest.deleteMany();
    await prisma.otpCode.deleteMany();
    await prisma.smsLog.deleteMany();
    await prisma.user.deleteMany({ where: { role: { not: "ADMIN" } } });
  } finally {
    await prisma.$disconnect();
  }
}
