import { PrismaClient } from "@prisma/client";

/**
 * Returns a PrismaClient hard-pinned to TEST_DATABASE_URL and verifies it's
 * actually talking to a database whose name ends in "_test" before handing
 * it back. This is the second, independent layer of the test-isolation
 * guard (the first is the config-load-time check in playwright.config.ts) —
 * global-setup.ts and global-teardown.ts both go through this rather than
 * the plain `prisma` singleton from lib/prisma.ts, specifically so neither
 * one can ever end up pointed at DATABASE_URL (dev data) by accident.
 *
 * Deliberately throws (not "logs a warning and continues") if the check
 * fails — the failure mode for a test-isolation bug must be "the suite
 * refuses to run", not "it quietly writes to the wrong database".
 */
export async function connectToTestDatabase(): Promise<PrismaClient> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set — refusing to connect to an unverified database.");
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is identical to DATABASE_URL — refusing to run against dev data.");
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  const [{ current_database }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  if (!current_database.endsWith("_test")) {
    await prisma.$disconnect();
    throw new Error(
      `Connected database "${current_database}" does not look like a test database (expected a "_test" suffix). ` +
        `Refusing to run destructive test setup/teardown against it.`
    );
  }
  return prisma;
}
