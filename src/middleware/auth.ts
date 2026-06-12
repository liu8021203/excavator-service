import { jwt } from "hono/jwt";
import type { MiddlewareHandler } from "hono";
import { getJwtSecret } from "../utils/jwt";
import type { AppVariables } from "../types";

/**
 * 强制 JWT 鉴权中间件
 */
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (c, next) => {
  const secret = getJwtSecret(c.env);
  return await jwt({ secret })(c, next);
};
