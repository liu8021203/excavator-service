import { contentJson, OpenAPIRoute, fromHono } from "chanfana";
import { AppContext, AppVariables } from "../types";
import { z } from "zod";
import { Hono } from "hono";
import { generateUUID } from "../utils/id";
import { getLLMProvider } from "../llm";

export const analysesRouter = fromHono(new Hono<{ Bindings: Env; Variables: AppVariables }>());

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
          batch_size: z.number().int().optional().default(300),
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
    console.log("currentProvider : ", currentProvider);
    const modelRow = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(`llm_model_${currentProvider}`).first<{ value: string }>();
    const currentModel = modelRow?.value || (currentProvider === "deepseek" ? "deepseek-chat" : "google/gemini-3.1-pro");

    await db.prepare(
      `INSERT INTO analyses (id, competitor_id, rating_filter, total_reviews, batch_size, status, llm_provider, llm_model, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), datetime('now'))`
    ).bind(
      analysisId,
      competitor_id,
      rating_filter,
      totalReviews,
      batch_size,
      currentProvider,
      currentModel
    ).run();

    // 发送任务到消息队列进行后台串行处理
    await c.env.ANALYSIS_QUEUE.send({ analysisId });

    return {
      code: 200,
      message: "AI 分析任务已提交并在后台队列排队处理中",
      data: {
        id: analysisId,
        status: "pending",
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
