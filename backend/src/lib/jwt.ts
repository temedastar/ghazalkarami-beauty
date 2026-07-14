import jwt from "jsonwebtoken";
import { env } from "./env";

export interface AuthTokenPayload {
  userId: string;
  role: "CUSTOMER" | "ADMIN";
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, env.jwtSecret) as AuthTokenPayload;
}
