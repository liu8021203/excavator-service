import type { Context } from "hono";

export interface JWTPayload {
  id: string;
  username: string;
  exp: number;
  [key: string]: any;
}

export interface AppVariables {
  jwtPayload?: JWTPayload;
}

export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;
export type HandleArgs = [AppContext];

// 扩展 Env 接口以增加运行时环境变量类型
declare global {
  interface Env {
    DEEPSEEK_API_KEY?: string;
    GEMINI_API_KEY?: string;
    JWT_SECRET?: string;
  }
}

