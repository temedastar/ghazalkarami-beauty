import { NextFunction, Request, Response } from "express";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  console.error(err);
  const message = err instanceof Error ? err.message : "خطای غیرمنتظره‌ای رخ داد.";
  res.status(500).json({ error: "خطای سرور. لطفاً دوباره تلاش کنید.", detail: message });
}
