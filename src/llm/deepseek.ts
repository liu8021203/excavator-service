import { LLMProvider, Message, LLMOptions } from "./adapter";

export class DeepSeekProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model: string = 'deepseek-chat', baseUrl: string = 'https://api.deepseek.com') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    if (!this.apiKey) {
      throw new Error("DeepSeek API Key is missing");
    }

    const payload: any = {
      model: this.model,
      messages: messages,
      temperature: options?.temperature ?? 0.3,
    };

    if (options?.max_tokens) {
      payload.max_tokens = options.max_tokens;
    }

    if (options?.response_format === 'json') {
      payload.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DeepSeek API request failed: Status ${response.status}, Details: ${errText}`);
    }

    const data: any = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }
}
