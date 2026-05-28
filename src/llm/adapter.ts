export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMOptions {
  temperature?: number;
  max_tokens?: number;
  response_format?: 'json' | 'text';
}

export interface LLMProvider {
  chat(messages: Message[], options?: LLMOptions): Promise<string>;
}
