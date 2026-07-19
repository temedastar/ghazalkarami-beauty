import { NextFunction, Request, Response } from "express";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  // full error (including internal messages/stack) goes to server logs only —
  // never to the client, which could otherwise leak schema/implementation details
  console.error(err);
  res.status(500).json({ error: "خطای سرور. لطفاً دوباره تلاش کنید." });
}
