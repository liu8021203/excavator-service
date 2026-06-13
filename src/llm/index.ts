import { LLMProvider } from "./adapter";
import { DeepSeekProvider } from "./deepseek";
import { WorkersAIProvider } from "./gemini";
import { OpenAIProvider } from "./openai";

/**
 * 根据数据库中的配置和环境变量，返回实例化好的 LLMProvider
 * 支持传入 isConsolidate 参数以获取汇总阶段的模型提供商与模型名称
 */
export async function getLLMProvider(
  db: D1Database,
  env: Env,
  stage: 'map' | 'reduce' | 'project' = 'map',
): Promise<LLMProvider> {
  let provider = "deepseek";

  if (stage === 'project') {
    // 1. 获取跨竞品对比阶段的提供商设置
    const projectProviderRow = await db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind("llm_provider_project")
      .first<{ value: string }>();
    const projectProvider = projectProviderRow?.value || "same";

    if (projectProvider && projectProvider !== "same") {
      provider = projectProvider;
    } else {
      // 回退到主提供商
      const providerRow = await db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .bind("llm_provider")
        .first<{ value: string }>();
      provider = providerRow?.value || "deepseek";
    }
  } else if (stage === 'reduce') {
    // 2. 获取汇总阶段的提供商设置
    const consolidateProviderRow = await db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind("llm_provider_consolidate")
      .first<{ value: string }>();
    const consolidateProvider = consolidateProviderRow?.value || "same";

    if (consolidateProvider && consolidateProvider !== "same") {
      provider = consolidateProvider;
    } else {
      // 回退到主提供商
      const providerRow = await db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .bind("llm_provider")
        .first<{ value: string }>();
      provider = providerRow?.value || "deepseek";
    }
  } else {
    const providerRow = await db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind("llm_provider")
      .first<{ value: string }>();
    provider = providerRow?.value || "deepseek";
  }

  if (provider === "deepseek") {
    // 查询 deepseek 的模型配置
    let modelKey = "llm_model_deepseek";
    if (stage === 'project') {
      modelKey = "llm_model_project_deepseek";
    } else if (stage === 'reduce') {
      modelKey = "llm_model_consolidate_deepseek";
    }

    let modelRow = await db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind(modelKey)
      .first<{ value: string }>();

    // 如果配置的模型为空，回退到主模型
    if (stage !== 'map' && (!modelRow || !modelRow.value)) {
      modelRow = await db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .bind("llm_model_deepseek")
        .first<{ value: string }>();
    }

    const model = modelRow?.value || "deepseek-chat";
    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY is not configured in environment variables (secrets)",
      );
    }
    return new DeepSeekProvider(apiKey, model);
  } else if (provider === "gemini") {
    // 查询 gemini (Workers AI) 的模型配置
    let modelKey = "llm_model_gemini";
    if (stage === 'project') {
      modelKey = "llm_model_project_gemini";
    } else if (stage === 'reduce') {
      modelKey = "llm_model_consolidate_gemini";
    }

    let modelRow = await db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind(modelKey)
      .first<{ value: string }>();

    // 如果配置的模型为空，回退到主模型
    if (stage !== 'map' && (!modelRow || !modelRow.value)) {
      modelRow = await db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .bind("llm_model_gemini")
        .first<{ value: string }>();
    }

    const model = modelRow?.value || "google/gemini-3.1-pro";

    if (!env.AI) {
      throw new Error(
        "Cloudflare Workers AI binding 'AI' is missing in environment variables. Make sure wrangler.jsonc has the AI binding configured.",
      );
    }

    if (model.toLowerCase().includes("openai")) {
      return new OpenAIProvider(env.AI, model);
    }

    return new WorkersAIProvider(env.AI, model);
  } else {
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

