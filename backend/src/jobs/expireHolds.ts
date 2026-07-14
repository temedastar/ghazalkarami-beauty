import cron from "node-cron";
import { prisma } from "../lib/prisma";

async function expireStaleHolds() {
  const stale = await prisma.booking.findMany({
    where: { status: "PENDING_PAYMENT", holdExpiresAt: { lt: new Date() } },
    select: { id: true },
  });
  if (stale.length === 0) return;

  await prisma.$transaction([
    prisma.slotHold.deleteMany({ where: { bookingId: { in: stale.map((b) => b.id) } } }),
    prisma.booking.updateMany({
      where: { id: { in: stale.map((b) => b.id) } },
      data: { status: "EXPIRED" },
    }),
  ]);
  console.log(`[jobs] expired ${stale.length} stale booking hold(s)`);
}

export function startExpireHoldsJob() {
  cron.schedule("* * * * *", () => {
    expireStaleHolds().catch((err) => console.error("[jobs] expireStaleHolds failed:", err));
  });
}
