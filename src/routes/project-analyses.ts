import { contentJson, OpenAPIRoute, fromHono } from "chanfana";
import { AppContext, AppVariables } from "../types";
import { z } from "zod";
import { Hono } from "hono";
import { generateUUID } from "../utils/id";
import { getLLMProvider } from "../llm";

export const projectAnalysesRouter = fromHono(new Hono<{ Bindings: Env; Variables: AppVariables }>());

// 1. 创建项目级跨竞品汇总分析
export class CreateProjectAnalysis extends OpenAPIRoute {
  schema = {
    tags: ["Project Analyses"],
    summary: "Create a cross-competitor synthesis report (Level 2 analysis) in background",
    request: {
      body: contentJson(
        z.object({
          project_id: z.string(),
        })
      ),
    },
    responses: {
      "200": {
        description: "Synthesis report generation initialized",
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
    const { project_id } = data.body;

    // 1. 验证项目是否存在
    const project = await db.prepare("SELECT name FROM projects WHERE id = ?").bind(project_id).first();
    if (!project) {
      return c.json({ code: 404, message: "所属项目未找到", data: null }, 404);
    }

    // 2. 查出该项目下所有已完成的单竞品分析
    const { results: analysesList } = await db.prepare(
      `SELECT a.*, c.name as competitor_name 
       FROM analyses a
       JOIN competitors c ON a.competitor_id = c.id
       WHERE c.project_id = ? AND a.status = 'completed'`
    ).bind(project_id).all<any>();

    if (analysesList.length === 0) {
      return c.json(
        { code: 400, message: "该项目下暂无已完成的单竞品分析，请先完成竞品分析再进行汇总。", data: null },
        400
      );
    }

    const synthesisId = generateUUID();

    // 3. 查询当前使用的 llm 设置以记录元数据
    const projectProviderRow = await db.prepare("SELECT value FROM settings WHERE key = ?").bind("llm_provider_project").first<{ value: string }>();
    let currentProvider = projectProviderRow?.value || "same";
    if (currentProvider === "same") {
      const mainProviderRow = await db.prepare("SELECT value FROM settings WHERE key = ?").bind("llm_provider").first<{ value: string }>();
      currentProvider = mainProviderRow?.value || "deepseek";
    }
    const modelKey = `llm_model_project_${currentProvider}`;
    let modelRow = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(modelKey).first<{ value: string }>();
    if (!modelRow || !modelRow.value) {
      modelRow = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(`llm_model_${currentProvider}`).first<{ value: string }>();
    }
    const currentModel = modelRow?.value || (currentProvider === "deepseek" ? "deepseek-chat" : "google/gemini-3.1-pro");

    // 4. 在 D1 中创建汇总分析记录，状态设为 'processing'
    await db.prepare(
      `INSERT INTO project_analyses (id, project_id, status, competitors_count, llm_provider, llm_model, created_at, updated_at) 
       VALUES (?, ?, 'processing', ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(
      synthesisId,
      project_id,
      analysesList.length,
      currentProvider,
      currentModel
    ).run();

    // 5. 发送任务到消息队列进行后台异步对比分析
    await c.env.ANALYSIS_QUEUE.send({ analysisId: synthesisId });

    return {
      code: 200,
      message: "AI 汇总分析任务已提交并在后台运行",
      data: {
        id: synthesisId,
        status: "processing",
      },
    };
  }
}

// 2. 获取跨竞品汇总分析详情
export class ReadProjectAnalysis extends OpenAPIRoute {
  schema = {
    tags: ["Project Analyses"],
    summary: "Get project level synthesis report by ID",
    request: {
      params: z.object({
        id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Returns synthesis report results",
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
    const synthesisId = data.params.id;

    const report = await db.prepare("SELECT * FROM project_analyses WHERE id = ?").bind(synthesisId).first();
    if (!report) {
      return c.json({ code: 404, message: "汇总分析报告未找到", data: null }, 404);
    }

    const parsedResult = {
      ...report,
      common_pain_points: report.common_pain_points ? JSON.parse(report.common_pain_points as string) : [],
      differentiation: report.differentiation ? JSON.parse(report.differentiation as string) : [],
      feature_matrix: report.feature_matrix ? JSON.parse(report.feature_matrix as string) : [],
      priority_suggestions: report.priority_suggestions ? JSON.parse(report.priority_suggestions as string) : [],
    };

    return {
      code: 200,
      message: "获取汇总分析报告详情成功",
      data: parsedResult,
    };
  }
}

// 3. 获取项目的全部汇总分析报告列表
export class ListProjectAnalyses extends OpenAPIRoute {
  schema = {
    tags: ["Project Analyses"],
    summary: "List all synthesis reports for a project",
    request: {
      query: z.object({
        project_id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Returns a list of synthesis reports",
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
    const { project_id } = data.query;

    const { results } = await db
      .prepare("SELECT id, status, competitors_count, llm_provider, llm_model, created_at, updated_at FROM project_analyses WHERE project_id = ? ORDER BY created_at DESC")
      .bind(project_id)
      .all();

    return {
      code: 200,
      message: "获取项目汇总分析报告列表成功",
      data: results,
    };
  }
}

projectAnalysesRouter.post("/", CreateProjectAnalysis);
projectAnalysesRouter.get("/:id", ReadProjectAnalysis);
projectAnalysesRouter.get("/", ListProjectAnalyses);
