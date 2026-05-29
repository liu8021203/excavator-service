import { describe, it, expect } from "vitest";
import { GeminiProvider } from "../src/llm/gemini";
import { Message, LLMOptions } from "../src/llm/adapter";

describe("GeminiProvider Parameters Format", () => {
  it("should generate correct native payload for Cloudflare Workers AI", async () => {
    let capturedModel: string = "";
    let capturedPayload: any = null;

    const mockAi = {
      run: async (model: string, payload: any) => {
        capturedModel = model;
        capturedPayload = payload;
        return { response: "Mocked AI response" };
      },
    };

    const provider = new GeminiProvider(mockAi);

    const messages: Message[] = [
      { role: "system", content: "You are a specialized business analyzer." },
      { role: "user", content: "Analyze company X." },
      { role: "assistant", content: "Company X is a retail store." },
      { role: "user", content: "What are its key pain points?" },
    ];

    const options: LLMOptions = {
      temperature: 0.25,
      max_tokens: 1500,
      response_format: "json",
    };

    const response = await provider.chat(messages, options);

    console.log("\n=================== CAPTURED PAYLOAD START ===================");
    console.log("Model ID:", capturedModel);
    console.log("Payload structure:\n", JSON.stringify(capturedPayload, null, 2));
    console.log("==================== CAPTURED PAYLOAD END ====================\n");

    expect(response).toBe("Mocked AI response");
    expect(capturedModel).toBe("google/gemini-3.1-pro");
    expect(capturedPayload).toHaveProperty("contents");
    expect(capturedPayload.contents).toHaveLength(3); // 3 non-system messages
    expect(capturedPayload.contents[0].role).toBe("user");
    expect(capturedPayload.contents[0].parts[0].text).toBe("Analyze company X.");
    expect(capturedPayload.contents[1].role).toBe("model"); // assistant mapped to model
    expect(capturedPayload.contents[1].parts[0].text).toBe("Company X is a retail store.");
    expect(capturedPayload.contents[2].role).toBe("user");
    expect(capturedPayload.contents[2].parts[0].text).toBe("What are its key pain points?");
    
    // Validate system instruction
    expect(capturedPayload).toHaveProperty("systemInstruction");
    expect(capturedPayload.systemInstruction.parts[0].text).toBe("You are a specialized business analyzer.");
    
    // Validate generation config
    expect(capturedPayload).toHaveProperty("generationConfig");
    expect(capturedPayload.generationConfig.temperature).toBe(0.25);
    expect(capturedPayload.generationConfig.maxOutputTokens).toBe(1500);
    expect(capturedPayload.generationConfig.responseMimeType).toBe("application/json");
  });

  it("should correctly extract response text from native Gemini candidates format", async () => {
    const mockNativeResponse = {
      candidates: [
        {
          avgLogprobs: -0.24408692330364393,
          content: {
            parts: [
              {
                text: "The laws of thermodynamics are the fundamental principles...",
                thoughtSignature: "CukdAY89a1/JNlElaHLRqgJBgLD..."
              }
            ],
            role: "model"
          },
          finishReason: "STOP"
        }
      ]
    };

    const mockAi = {
      run: async () => {
        return mockNativeResponse;
      },
    };

    const provider = new GeminiProvider(mockAi);
    const messages = [{ role: "user", content: "What are the three laws of thermodynamics?" }];

    const result = await provider.chat(messages);
    
    expect(result).toBe("The laws of thermodynamics are the fundamental principles...");
  });
});
