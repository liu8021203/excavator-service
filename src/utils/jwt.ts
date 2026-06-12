import { sign } from "hono/jwt";
import type { JWTPayload } from "../types";

export const JWT_FALLBACK_SECRET = "excavator-jwt-secret-key-fallback";
export const JWT_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * 获取 JWT 密钥，如果有环境变量则使用环境变量，否则使用 fallback 默认值
 */
export function getJwtSecret(env: Env): string {
  return env.JWT_SECRET || JWT_FALLBACK_SECRET;
}

/**
 * 签名生成新的 JWT Token
 */
export async function signToken(
  user: { id: string; username: string },
  env: Env
): Promise<string> {
  const secret = getJwtSecret(env);
  const payload: JWTPayload = {
    id: user.id,
    username: user.username,
    exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS,
  };
  return await sign(payload, secret);
}
