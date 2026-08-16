import { prisma } from "./prisma";

/**
 * Writes one "تاریخچه‌ی اقدامات" entry — see the AuditLog model comment in
 * schema.prisma. `description` must already be a complete Persian sentence;
 * this never throws (a logging failure must not break the real action it's
 * describing), it only logs to the server console if the write itself fails.
 */
export async function logAction(action: string, description: string, actorLabel: string): Promise<void> {
  await prisma.auditLog.create({ data: { action, description, actorLabel } }).catch((err) => {
    console.error(`[auditLog] failed to write "${action}":`, err);
  });
}

/** "غزل کرمی" for the one admin account this app has; falls back to the
 * literal role name if an admin's own name is ever missing. */
export function adminActorLabel(admin: { firstName?: string | null; lastName?: string | null } | null | undefined): string {
  if (admin?.firstName) return `${admin.firstName} ${admin.lastName ?? ""}`.trim();
  return "ادمین";
}

/** Looks up the acting admin's own name from their auth token's userId —
 * every admin.ts route already has req.auth.userId, just not the name. */
export async function getAdminActorLabel(userId: string): Promise<string> {
  const admin = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  return adminActorLabel(admin);
}

export function customerActorLabel(user: { firstName: string; lastName: string; phone: string } | null | undefined): string {
  if (!user) return "مشتری";
  return `${user.firstName} ${user.lastName} (${user.phone})`;
}
