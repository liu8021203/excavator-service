import { LLMProvider, Message, LLMOptions } from "./adapter";

export class GeminiProvider implements LLMProvider {
  private ai: any;
  private model: string;

  constructor(ai: any, model: string = "google/gemini-3.1-pro") {
    this.ai = ai;
    this.model = model;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    if (!this.ai) {
      throw new Error(
        "Cloudflare Workers AI binding 'AI' is missing in environment (not configured in wrangler.jsonc)",
      );
    }

    // 提取 system 消息
    const systemMessages = messages.filter((m) => m.role === "system");
    const otherMessages = messages.filter((m) => m.role !== "system");

    // 合并 system 消息并前置，确保在 Cloudflare Workers AI 各种运行时环境下稳定生效
    let systemInstruction = "";
    if (systemMessages.length > 0) {
      systemInstruction =
        systemMessages.map((m) => m.content).join("\n") + "\n\n";
    }

    const contents = otherMessages.map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      return {
        role,
        parts: [{ text: m.content }],
      };
    });

    const payload: any = {
      contents,
    };

    if (systemInstruction) {
      payload.systemInstruction = {
        parts: [{ text: systemInstruction.trim() }],
      };
    }

    if (options) {
      const generationConfig: any = {};
      if (options.temperature !== undefined) {
        generationConfig.temperature = options.temperature;
      }
      if (options.max_tokens !== undefined) {
        generationConfig.maxOutputTokens = options.max_tokens;
      }
      if (options.response_format === "json") {
        generationConfig.responseMimeType = "application/json";
      }
      if (Object.keys(generationConfig).length > 0) {
        payload.generationConfig = generationConfig;
      }
    }

    console.log("prompt : ", JSON.stringify(payload, null, 2));
    // 运行 Cloudflare AI 绑定
    let response: any;
    try {
      response = await this.ai.run(this.model, payload);
    } catch (err: any) {
      throw new Error(
        `Cloudflare Workers AI Gemini run failed: ${err.message}`,
      );
    }

    // 提取结果：Cloudflare 代理的原生 Gemini 接口、普通 AI 接口或纯文本的兼容提取
    if (typeof response === "string") {
      return response;
    }

    // 优先提取原生 Gemini/Google API 的结构
    const nativeText = response?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof nativeText === "string") {
      return nativeText;
    }

    return (
      response?.response ||
      response?.text ||
      response?.result?.response ||
      response?.result?.text ||
      JSON.stringify(response) ||
      ""
    );
  }
}
