import type { Context } from "hono";

export type AppContext = Context<{ Bindings: Env }>;
export type HandleArgs = [AppContext];

// 扩展 Env 接口以增加运行时环境变量类型
declare global {
  interface Env {
    DEEPSEEK_API_KEY?: string;
    GEMINI_API_KEY?: string;
    JWT_SECRET?: string;
  }
}
