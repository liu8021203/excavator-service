import { describe, it, expect } from "vitest";
import { OpenAIProvider } from "../src/llm/openai";
import { Message, LLMOptions } from "../src/llm/adapter";

describe("OpenAIProvider Parameters Format", () => {
  it("should generate correct payload for Cloudflare Workers AI with OpenAI models", async () => {
    let capturedModel: string = "";
    let capturedPayload: any = null;

    const mockAi = {
      run: async (model: string, payload: any) => {
        capturedModel = model;
        capturedPayload = payload;
        return {
          choices: [
            {
              finish_reason: "stop",
              index: 0,
              message: {
                content: "Mocked OpenAI content response",
                role: "assistant"
              }
            }
          ]
        };
      },
    };

    const provider = new OpenAIProvider(mockAi, "openai/gpt-5.4");

    const messages: Message[] = [
      { role: "system", content: "You are a specialized business analyzer." },
      { role: "user", content: "Analyze company X." },
    ];

    const options: LLMOptions = {
      temperature: 0.25,
      max_tokens: 1500,
      response_format: "json",
    };

    const response = await provider.chat(messages, options);

    expect(response).toBe("Mocked OpenAI content response");
    expect(capturedModel).toBe("openai/gpt-5.4");
    expect(capturedPayload).toHaveProperty("messages");
    expect(capturedPayload.messages).toHaveLength(2);
    expect(capturedPayload.messages[0].role).toBe("system");
    expect(capturedPayload.messages[0].content).toBe("You are a specialized business analyzer.");
    expect(capturedPayload.messages[1].role).toBe("user");
    expect(capturedPayload.messages[1].content).toBe("Analyze company X.");
    
    // Validate extra configs
    expect(capturedPayload.temperature).toBe(0.25);
    expect(capturedPayload.max_tokens).toBe(1500);
    expect(capturedPayload.response_format).toEqual({ type: "json_object" });
  });
});
