import { LLMProvider, Message, LLMOptions } from "./adapter";

export class WorkersAIProvider implements LLMProvider {
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

    const isGemini = this.model.toLowerCase().includes("gemini");

    let payload: any;

    if (isGemini) {
      // 提取 system 消息
      const systemMessages = messages.filter((m) => m.role === "system");
      const otherMessages = messages.filter((m) => m.role !== "system");

      // 合并 system 消息并前置
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

      payload = {
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
    } else {
      // 针对 Llama, Qwen 等标准 Workers AI 文本生成模型采用标准格式
      const formattedMessages = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      payload = {
        messages: formattedMessages,
        temperature: options?.temperature ?? 0.3,
      };

      if (options?.max_tokens !== undefined) {
        payload.max_tokens = options.max_tokens;
      }
      
      // 注意：部分 Workers AI 模型对 response_format 的支持不同，这里做兼容配置
      if (options?.response_format === "json") {
        // 部分模型支持 response_format: { type: "json_object" }
        payload.response_format = { type: "json_object" };
      }
    }

    console.log(`[Workers AI] Running model "${this.model}" with payload:`, JSON.stringify(payload, null, 2));

    // 运行 Cloudflare AI 绑定
    let response: any;
    try {
      response = await this.ai.run(this.model, payload);
    } catch (err: any) {
      throw new Error(
        `Cloudflare Workers AI run failed for model "${this.model}": ${err.message}`,
      );
    }

    // 提取结果
    if (typeof response === "string") {
      return response;
    }

    // 优先提取原生 Gemini 结构
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

export { WorkersAIProvider as GeminiProvider };
