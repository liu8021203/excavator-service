import { LLMProvider } from "./adapter";
import { DeepSeekProvider } from "./deepseek";
import { GeminiProvider } from "./gemini";

/**
 * 根据数据库中的配置和环境变量，返回实例化好的 LLMProvider
 */
export async function getLLMProvider(db: D1Database, env: Env): Promise<LLMProvider> {
  // 1. 从 settings 表查询当前激活的 provider，默认为 deepseek
  const providerRow = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind("llm_provider")
    .first<{ value: string }>();
  const provider = providerRow?.value || "deepseek";

  if (provider === "deepseek") {
    // 查询 deepseek 的模型配置
    const modelRow = await db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind("llm_model_deepseek")
      .first<{ value: string }>();
    const model = modelRow?.value || "deepseek-chat";

    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error("DEEPSEEK_API_KEY is not configured in environment variables (secrets)");
    }
    return new DeepSeekProvider(apiKey, model);
  } else if (provider === "gemini") {
    // 查询 gemini 的模型配置
    const modelRow = await db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind("llm_model_gemini")
      .first<{ value: string }>();
    const model = modelRow?.value || "google/gemini-3.1-pro";

    if (!env.AI) {
      throw new Error("Cloudflare Workers AI binding 'AI' is missing in environment variables. Make sure wrangler.jsonc has the AI binding configured.");
    }
    return new GeminiProvider(env.AI, model);
  } else {
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}
