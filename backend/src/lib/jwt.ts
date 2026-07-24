import jwt from "jsonwebtoken";
import { env } from "./env";

export interface AuthTokenPayload {
  userId: string;
  role: "CUSTOMER" | "ADMIN";
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
    algorithm: "HS256",
  } as jwt.SignOptions);
}

// `algorithms` is deliberately pinned rather than left to auto-detect from
// the token's own header — without it, a token forged with a different
// algorithm (e.g. "none", or HS256-with-a-different-key confusion attacks
// against libraries that support asymmetric algorithms) would be decoded
// using whatever the token itself claims instead of what the server
// actually expects.
export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as AuthTokenPayload;
}
