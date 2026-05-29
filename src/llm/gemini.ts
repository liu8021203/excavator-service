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

    const contents = otherMessages.map((m, idx) => {
      const role = m.role === "assistant" ? "model" : "user";
      let text = m.content;
      if (idx === 0 && systemInstruction) {
        text = `${systemInstruction}[User Request]\n${text}`;
      }
      return {
        role,
        parts: [{ text }],
      };
    });

    const payload: any = {
      contents,
    };
    console.log("prompt : ", payload);
    // 运行 Cloudflare AI 绑定
    let response: any;
    try {
      response = await this.ai.run(this.model, payload);
    } catch (err: any) {
      throw new Error(
        `Cloudflare Workers AI Gemini run failed: ${err.message}`,
      );
    }

    // 提取结果：Cloudflare Workers AI 的 LLM 接口通常直接返回 { response: "..." } 或者纯文本
    if (typeof response === "string") {
      return response;
    }
    return (
      response?.response || response?.text || JSON.stringify(response) || ""
    );
  }
}
