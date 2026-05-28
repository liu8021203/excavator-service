import { contentJson, OpenAPIRoute, fromHono } from "chanfana";
import { AppContext } from "../types";
import { z } from "zod";
import { Hono } from "hono";
import { generateUUID } from "../utils/id";
import { getLLMProvider } from "../llm";

export const analysesRouter = fromHono(new Hono<{ Bindings: Env }>());

// 1. 创建分析任务（支持后台运行）
export class CreateAnalysis extends OpenAPIRoute {
  schema = {
    tags: ["Analyses"],
    summary: "Create a new review analysis task (runs asynchronously in background)",
    request: {
      body: contentJson(
        z.object({
          competitor_id: z.string(),
          rating_filter: z.enum(["negative", "positive"]),
          batch_size: z.number().int().optional().default(500),
        })
      ),
    },
    responses: {
      "200": {
        description: "Analysis task initialized and running in background",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.object({
              id: z.string(),
              status: z.string(),
            }),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const { competitor_id, rating_filter, batch_size } = data.body;

    const competitor = await db
      .prepare("SELECT name FROM competitors WHERE id = ?")
      .bind(competitor_id)
      .first<{ name: string }>();
    if (!competitor) {
      return c.json({ code: 404, message: "竞品不存在", data: null }, 404);
    }

    const ratingCondition = rating_filter === "negative" ? "rating <= 3" : "rating >= 4";
    const { results: rawReviews } = await db
      .prepare(`SELECT user_name, rating, text, thumbs_up, review_date FROM reviews WHERE competitor_id = ? AND ${ratingCondition}`)
      .bind(competitor_id)
      .all<{ user_name: string; rating: number; text: string; thumbs_up: number; review_date: string }>();

    const totalReviews = rawReviews.length;
    if (totalReviews === 0) {
      return c.json({ code: 400, message: `该评分分组暂无评论，无法分析 (rating_filter: ${rating_filter})`, data: null }, 400);
    }

    const analysisId = generateUUID();

    const providerRow = await db.prepare("SELECT value FROM settings WHERE key = ?").bind("llm_provider").first<{ value: string }>();
    const currentProvider = providerRow?.value || "deepseek";
    const modelRow = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(`llm_model_${currentProvider}`).first<{ value: string }>();
    const currentModel = modelRow?.value || (currentProvider === "deepseek" ? "deepseek-chat" : "google/gemini-3.1-pro");

    await db.prepare(
      `INSERT INTO analyses (id, competitor_id, rating_filter, total_reviews, batch_size, status, llm_provider, llm_model, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, datetime('now'), datetime('now'))`
    ).bind(
      analysisId,
      competitor_id,
      rating_filter,
      totalReviews,
      batch_size,
      currentProvider,
      currentModel
    ).run();

    c.executionCtx.waitUntil(
      (async () => {
        try {
          const provider = await getLLMProvider(db, c.env);
          const batchesCount = Math.ceil(totalReviews / batch_size);
          const batchResults: any[] = [];

          for (let i = 0; i < batchesCount; i++) {
            const start = i * batch_size;
            const end = Math.min(start + batch_size, totalReviews);
            const batchReviews = rawReviews.slice(start, end);

            const batchId = generateUUID();
            await db.prepare(
              `INSERT INTO analysis_batches (id, analysis_id, batch_index, review_count, status, created_at) 
               VALUES (?, ?, ?, ?, 'processing', datetime('now'))`
            ).bind(batchId, analysisId, i, batchReviews.length).run();

            const reviewsText = batchReviews
              .map((r, idx) => `[Review #${idx + 1}] Date: ${r.review_date} | Rating: ${r.rating}* | Likes: ${r.thumbs_up}\nUser: ${r.user_name || "Anonymous"}\nContent: ${r.text || ""}`)
              .join("\n---\n");

            const systemPrompt = `You are a brilliant market researcher and product manager.
Your task is to analyze a batch of user reviews for the competitor app "${competitor.name}" and extract structured insights.
Output the results in JSON format matching this schema:
{
  "pain_points": [
    {
      "title": "A concise title of the pain point",
      "frequency": 12,
      "quotes": ["Representative user quote 1", "Representative user quote 2"]
    }
  ],
  "feature_requests": [
    {
      "title": "A concise title of the requested feature or improvement",
      "frequency": 8,
      "quotes": ["Representative user quote"]
    }
  ],
  "sentiment_summary": "A brief summary of user emotions (frustrated, angry, loving the UI but hating bugs, etc.)",
  "opportunities": [
    {
      "title": "Opportunity title",
      "description": "How we can leverage this pain point or feature request to make our own app superior."
    }
  ]
}
Return ONLY valid JSON. Do not include markdown code block backticks like \`\`\`json.`;

            const userPrompt = `Here is a batch of ${batchReviews.length} user reviews:\n\n${reviewsText}`;

            let responseStr = "";
            try {
              responseStr = await provider.chat([
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
              ], { response_format: "json" });
            } catch (err: any) {
              await db.prepare("UPDATE analysis_batches SET status = 'failed' WHERE id = ?").bind(batchId).run();
              throw err;
            }

            let cleanResponse = responseStr.trim();
            if (cleanResponse.startsWith("```")) {
              cleanResponse = cleanResponse.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
            }

            let parsedResult: any;
            try {
              parsedResult = JSON.parse(cleanResponse);
            } catch {
              console.error("Batch parse failed. Raw response:", responseStr);
              parsedResult = { pain_points: [], feature_requests: [], sentiment_summary: "Parsing error", opportunities: [] };
            }

            await db.prepare(
              "UPDATE analysis_batches SET status = 'completed', result = ? WHERE id = ?"
            ).bind(JSON.stringify(parsedResult), batchId).run();

            batchResults.push(parsedResult);
          }

          let finalConsolidatedResult: any;

          if (batchResults.length === 1) {
            finalConsolidatedResult = batchResults[0];
          } else {
            const systemConsolidatePrompt = `You are a brilliant market researcher and product manager.
You have analyzed multiple batches of user reviews for the competitor app "${competitor.name}".
Now, combine these batch analysis results into a single, unified, high-quality final report.
Combine similar pain points and feature requests, sum up or estimate their overall frequencies, select the best representative quotes, and generate cohesive overall sentiment and product opportunity summaries.
Output the final consolidated report in JSON format matching this schema:
{
  "pain_points": [
    {
      "title": "Consolidated pain point title",
      "frequency": 24,
      "quotes": ["Quote 1", "Quote 2"]
    }
  ],
  "feature_requests": [
    {
      "title": "Consolidated feature request title",
      "frequency": 16,
      "quotes": ["Quote"]
    }
  ],
  "sentiment_summary": "A cohesive final summary of user emotions.",
  "opportunities": [
    {
      "title": "Cohesive opportunity title",
      "description": "Consolidated action item for our app."
    }
  ]
}
Return ONLY valid JSON. Do not include markdown code block backticks like \`\`\`json.`;

            const userConsolidatePrompt = `Here are the batch results from ${batchResults.length} batches:\n\n${JSON.stringify(batchResults, null, 2)}`;

            let reduceResponseStr = await provider.chat([
              { role: "system", content: systemConsolidatePrompt },
              { role: "user", content: userConsolidatePrompt }
            ], { response_format: "json" });

            let cleanReduce = reduceResponseStr.trim();
            if (cleanReduce.startsWith("```")) {
              cleanReduce = cleanReduce.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
            }

            try {
              finalConsolidatedResult = JSON.parse(cleanReduce);
            } catch {
              console.error("Consolidated parse failed. Raw response:", reduceResponseStr);
              finalConsolidatedResult = {
                pain_points: batchResults.flatMap(b => b.pain_points || []),
                feature_requests: batchResults.flatMap(b => b.feature_requests || []),
                sentiment_summary: "Consolidation failed. Showing raw flattened results.",
                opportunities: batchResults.flatMap(b => b.opportunities || []),
              };
            }
          }

          await db.prepare(
            `UPDATE analyses 
             SET status = 'completed', 
                 pain_points = ?, 
                 feature_requests = ?, 
                 sentiment_summary = ?, 
                 opportunities = ?, 
                 updated_at = datetime('now') 
             WHERE id = ?`
          ).bind(
            JSON.stringify(finalConsolidatedResult.pain_points || []),
            JSON.stringify(finalConsolidatedResult.feature_requests || []),
            finalConsolidatedResult.sentiment_summary || "",
            JSON.stringify(finalConsolidatedResult.opportunities || []),
            analysisId
          ).run();

        } catch (err: any) {
          console.error("Background analysis failed:", err);
          await db.prepare(
            "UPDATE analyses SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?"
          ).bind(err.message, analysisId).run();
        }
      })()
    );

    return {
      code: 200,
      message: "AI 分析任务已提交并在后台运行",
      data: {
        id: analysisId,
        status: "processing",
      },
    };
  }
}

// 2. 获取分析详情
export class ReadAnalysis extends OpenAPIRoute {
  schema = {
    tags: ["Analyses"],
    summary: "Get single competitor analysis results by ID",
    request: {
      params: z.object({
        id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Returns analysis results and metadata",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.any(),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const analysisId = data.params.id;

    const analysis = await db.prepare("SELECT * FROM analyses WHERE id = ?").bind(analysisId).first();
    if (!analysis) {
      return c.json({ code: 404, message: "分析任务未找到", data: null }, 404);
    }

    const parsedResult = {
      ...analysis,
      pain_points: analysis.pain_points ? JSON.parse(analysis.pain_points as string) : [],
      feature_requests: analysis.feature_requests ? JSON.parse(analysis.feature_requests as string) : [],
      opportunities: analysis.opportunities ? JSON.parse(analysis.opportunities as string) : [],
    };

    return {
      code: 200,
      message: "获取分析报告详情成功",
      data: parsedResult,
    };
  }
}

// 3. 获取竞品关联的所有分析任务列表
export class ListAnalyses extends OpenAPIRoute {
  schema = {
    tags: ["Analyses"],
    summary: "List all analysis tasks for a competitor",
    request: {
      query: z.object({
        competitor_id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Returns analysis task list",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.array(z.any()),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const { competitor_id } = data.query;

    const { results } = await db
      .prepare("SELECT id, rating_filter, total_reviews, status, llm_provider, llm_model, created_at, updated_at FROM analyses WHERE competitor_id = ? ORDER BY created_at DESC")
      .bind(competitor_id)
      .all();

    return {
      code: 200,
      message: "获取分析任务列表成功",
      data: results,
    };
  }
}

analysesRouter.post("/", CreateAnalysis);
analysesRouter.get("/:id", ReadAnalysis);
analysesRouter.get("/", ListAnalyses);
