import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { Prisma } from "@prisma/client";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  // a phone-camera photo over the 8MB upload limit is a routine user error,
  // not a server failure — give it the same clean localized-message treatment
  // every other validation error in the app already gets, instead of falling
  // through to the generic 500 below
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "حجم فایل بیشتر از حد مجاز (۸ مگابایت) است." });
  }

  // routes that delete/update by id (categories, services, day-exceptions,
  // reviews, …) don't all pre-check existence or referencing rows — without
  // this, a stale id or a "delete a category that still has services/
  // bookings on it" click surfaces as an opaque 500 instead of a clean,
  // actionable message
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "مورد مورد نظر یافت نشد یا قبلاً حذف شده است." });
    }
    if (err.code === "P2003" || err.code === "P2014") {
      return res.status(409).json({ error: "این مورد چون جای دیگری استفاده شده، قابل حذف نیست." });
    }
  }

  // full error (including internal messages/stack) goes to server logs only —
  // never to the client, which could otherwise leak schema/implementation details
  console.error(err);
  res.status(500).json({ error: "خطای سرور. لطفاً دوباره تلاش کنید." });
}
