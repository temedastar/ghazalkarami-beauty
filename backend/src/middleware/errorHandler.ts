import { NextFunction, Request, Response } from "express";
import multer from "multer";

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

  // full error (including internal messages/stack) goes to server logs only —
  // never to the client, which could otherwise leak schema/implementation details
  console.error(err);
  res.status(500).json({ error: "خطای سرور. لطفاً دوباره تلاش کنید." });
}
