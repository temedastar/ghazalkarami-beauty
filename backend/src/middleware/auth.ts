import { NextFunction, Request, Response } from "express";
import { verifyAuthToken, AuthTokenPayload } from "../lib/jwt";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthTokenPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  // Bearer header only — the frontend never relies on cookies for auth, and a
  // cookie fallback here would open a CSRF surface for no functional benefit.
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: "ورود لازم است." });
  }
  try {
    req.auth = verifyAuthToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "نشست شما نامعتبر یا منقضی شده است." });
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (token) {
    try {
      req.auth = verifyAuthToken(token);
    } catch {
      // ignore invalid token for optional auth
    }
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth || req.auth.role !== "ADMIN") {
    return res.status(403).json({ error: "دسترسی غیرمجاز." });
  }
  next();
}
