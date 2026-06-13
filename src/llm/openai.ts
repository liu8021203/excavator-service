import { LLMProvider, Message, LLMOptions } from "./adapter";

export class OpenAIProvider implements LLMProvider {
  private ai: any;
  private model: string;

  constructor(ai: any, model: string) {
    this.ai = ai;
    this.model = model;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    if (!this.ai) {
      throw new Error(
        "Cloudflare Workers AI binding 'AI' is missing in environment (not configured in wrangler.jsonc)",
      );
    }

    const formattedMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const payload: any = {
      messages: formattedMessages,
      temperature: options?.temperature ?? 0.3,
    };

    if (options?.max_tokens !== undefined) {
      payload.max_tokens = options.max_tokens;
    }

    if (options?.response_format === "json") {
      payload.response_format = { type: "json_object" };
    }

    console.log(`[Workers AI OpenAI] Running model "${this.model}" with payload:`, JSON.stringify(payload, null, 2));

    let response: any;
    try {
      response = await this.ai.run(this.model, payload);
    } catch (err: any) {
      throw new Error(
        `Cloudflare Workers AI run failed for OpenAI model "${this.model}": ${err.message}`,
      );
    }

    console.log(`[Workers AI OpenAI] Response structure:`, JSON.stringify(response, null, 2));

    // Extract OpenAI-style response: response.choices[0].message.content
    if (response?.choices?.[0]?.message?.content) {
      return response.choices[0].message.content;
    }

    // Fallbacks
    if (typeof response === "string") {
      return response;
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
