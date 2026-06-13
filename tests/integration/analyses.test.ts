import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";

describe("Analyses & Queue Integration Tests", () => {
  const testUser = {
    username: `analysistest_${Date.now()}`,
    password: "testpassword123",
  };

  it("should successfully run the full queue analysis cycle", async () => {
    // Mock env.ANALYSIS_QUEUE.send to prevent background queue execution in Miniflare/Vitest
    const queueSendSpy = vi.spyOn(env.ANALYSIS_QUEUE, "send").mockImplementation(async (message) => {
      console.log("[Mock Queue] Intercepted queue send message:", message);
      return;
    });

    // Ensure DEEPSEEK_API_KEY is set to prevent validation errors
    if (!env.DEEPSEEK_API_KEY) {
      (env as any).DEEPSEEK_API_KEY = "mocked-deepseek-api-key-for-testing";
    }

    // Mock global fetch to intercept DeepSeek completions API call
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("api.deepseek.com")) {
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  pain_points: [
                    {
                      title: "App crashed on launch",
                      frequency: 10,
                      quotes: ["It crashed immediately!", "Cannot open app."]
                    }
                  ],
                  feature_requests: [
                    {
                      title: "Dark mode",
                      frequency: 5,
                      quotes: ["We need dark mode."]
                    }
                  ],
                  sentiment_summary: "Negative and frustrated",
                  opportunities: [
                    {
                      title: "Implement stable startup",
                      description: "Our app should not crash on startup."
                    }
                  ]
                })
              }
            }
          ]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return originalFetch(input, init);
    });

    // 1. Register & Login to get JWT Token
    await SELF.fetch("http://local.test/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testUser),
    });

    const loginRes = await SELF.fetch("http://local.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testUser),
    });
    const loginBody = await loginRes.json<any>();
    const token = loginBody.data.token;
    const userId = loginBody.data.user.id;

    // 2. Insert Project & Competitor directly into D1 to bypass LLM market analysis call
    const db = env.DB;
    const projectId = "test-project-id-123";
    const competitorId = "test-competitor-id-123";

    await db.prepare(
      `INSERT INTO projects (id, name, description, market_analysis, status, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(projectId, "Fitness Tracker", "A fitness tracking app.", "{}", "analyzed", userId).run();

    await db.prepare(
      `INSERT INTO competitors (id, project_id, name, description, scrape_status, rating, estimated_reviews, review_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
    ).bind(competitorId, projectId, "FitApp", "Desc", "pending", 4.5, 1000).run();

    // 3. Upload Reviews
    const uploadRes = await SELF.fetch("http://local.test/api/reviews/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        competitor_id: competitorId,
        is_completed: true,
        reviews: [
          {
            review_id: "rev1",
            user_name: "John",
            rating: 1,
            text: "It crashed immediately!",
            thumbs_up: 2,
            review_date: "2026-06-01"
          },
          {
            review_id: "rev2",
            user_name: "Jane",
            rating: 2,
            text: "Cannot open app. Black screen.",
            thumbs_up: 5,
            review_date: "2026-06-02"
          }
        ]
      })
    });
    expect(uploadRes.status).toBe(200);

    // 4. Create Analysis Task (should set to pending and send to queue)
    const analysisRes = await SELF.fetch("http://local.test/api/analyses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        competitor_id: competitorId,
        rating_filter: "negative",
        batch_size: 10
      })
    });
    expect(analysisRes.status).toBe(200);
    const analysisBody = await analysisRes.json<any>();
    expect(analysisBody.code).toBe(200);
    expect(analysisBody.data.status).toBe("pending");
    const analysisId = analysisBody.data.id;

    // Verify status is pending in D1
    const initAnalysis = await db.prepare("SELECT status FROM analyses WHERE id = ?").bind(analysisId).first<{ status: string }>();
    expect(initAnalysis?.status).toBe("pending");

    // 5. Trigger Queue worker manually
    let ackCalled = false;
    const mockBatch = {
      messages: [
        {
          body: { analysisId },
          ack: () => { ackCalled = true; },
          retry: () => {}
        }
      ]
    };
    const mockCtx = {
      waitUntil: (p: Promise<any>) => ctxPromises.push(p)
    };
    const ctxPromises: Promise<any>[] = [];

    await worker.queue(mockBatch as any, env, mockCtx as any);
    await Promise.all(ctxPromises);

    expect(ackCalled).toBe(true);

    // 6. Verify final status is completed in D1 and contains AI results
    const finalAnalysis = await db.prepare("SELECT * FROM analyses WHERE id = ?").bind(analysisId).first<any>();
    expect(finalAnalysis?.status).toBe("completed");
    
    const painPoints = JSON.parse(finalAnalysis.pain_points);
    expect(painPoints).toHaveLength(1);
    expect(painPoints[0].title).toBe("App crashed on launch");
    expect(finalAnalysis.sentiment_summary).toBe("Negative and frustrated");
  });
});
