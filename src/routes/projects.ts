import { contentJson, OpenAPIRoute, fromHono } from "chanfana";
import { AppContext } from "../types";
import { z } from "zod";
import { Hono } from "hono";
import { generateUUID } from "../utils/id";
import { getLLMProvider } from "../llm";

export const projectsRouter = fromHono(new Hono<{ Bindings: Env }>());

// 1. 创建项目（触发 LLM 市场分析与竞品推荐，归属当前登录用户）
export class CreateProject extends OpenAPIRoute {
  schema = {
    tags: ["Projects"],
    summary:
      "Create a new project, trigger AI market analysis and link to logged-in user",
    request: {
      body: contentJson(
        z.object({
          description: z
            .string()
            .min(5, "Description must be at least 5 characters long"),
          name: z.string().optional(),
        }),
      ),
    },
    responses: {
      "200": {
        description: "Project created and analyzed successfully",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.object({
              id: z.string(),
              name: z.string(),
              description: z.string(),
              market_analysis: z.string(),
              competitors: z.array(z.any()),
            }),
          }),
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const { description, name } = data.body;

    const jwtPayload = c.get("jwtPayload");
    const userId = jwtPayload?.id || null;

    // 1. 获取 LLM Provider
    const provider = await getLLMProvider(db, c.env);

    // 2. 构造 Prompt
    const systemPrompt = `You are a senior market research analyst.
Analyze the user's proposed app idea and output a structured market analysis report in JSON format.
All text values in the JSON (including "project_name", "market_overview", and the competitor's "description") MUST be written in Chinese (简体中文).
The JSON must adhere to the following schema:
{
  "project_name": "A concise and catchy name for the project (in Chinese)",
  "market_overview": "A brief overview of the market trend, target audience, and main barriers (in Chinese).",
  "competitors": [
    {
      "name": "Competitor App Name",
      "description": "Brief description of their core features, strengths, and weaknesses (in Chinese).",
      "rating": 4.2,
      "estimated_reviews": 50000
    }
  ]
}
Return ONLY valid JSON. Do not include markdown code block backticks like \`\`\`json.`;

    const userPrompt = `App Idea Description: "${description}"
Analyze the market and suggest 5 to 10 top direct/indirect competitors on Google Play.`;

    let llmResultStr = "";
    try {
      llmResultStr = await provider.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { response_format: "json" },
      );
    } catch (err: any) {
      throw new Error(`AI market analysis failed: ${err.message}`);
    }
    console.log("ai result : ", llmResultStr);
    // 3. 解析 LLM 返回的 JSON
    let analysisData: any;
    try {
      let cleanStr = llmResultStr.trim();
      if (cleanStr.startsWith("```")) {
        cleanStr = cleanStr
          .replace(/^```json\s*/i, "")
          .replace(/```$/, "")
          .trim();
      }
      analysisData = JSON.parse(cleanStr);
    } catch (err) {
      console.error(
        "Failed to parse LLM response as JSON. Raw response:",
        llmResultStr,
      );
      throw new Error("AI returned invalid JSON structure.");
    }

    const projectId = generateUUID();
    const finalProjectName =
      name || analysisData.project_name || "New Mining Project";

    // 查询当前使用的 llm_provider
    const providerRow = await db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind("llm_provider")
      .first<{ value: string }>();
    const currentProvider = providerRow?.value || "deepseek";

    // 4. 将项目存入数据库 (写入 user_id 外键进行项目权限归属)
    await db
      .prepare(
        `INSERT INTO projects (id, name, description, market_analysis, llm_provider, status, user_id, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .bind(
        projectId,
        finalProjectName,
        description,
        JSON.stringify({ market_overview: analysisData.market_overview }),
        currentProvider,
        "analyzed",
        userId,
      )
      .run();

    // 5. 写入推荐的竞品
    const competitorsList = analysisData.competitors || [];
    const competitorInsertStmt = db.prepare(
      `INSERT INTO competitors (id, project_id, name, description, package_name, icon_url, rating, estimated_reviews, review_count, scrape_status, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', datetime('now'), datetime('now'))`,
    );

    const batch = [];
    const insertedCompetitors = [];
    for (const comp of competitorsList) {
      const compId = generateUUID();
      const compName = comp.name || "Unknown App";
      const compDesc = comp.description || "";
      const compRating = comp.rating || 0;
      const estReviews = comp.estimated_reviews || 0;

      batch.push(
        competitorInsertStmt.bind(
          compId,
          projectId,
          compName,
          compDesc,
          null,
          null,
          compRating,
          estReviews,
        ),
      );

      insertedCompetitors.push({
        id: compId,
        name: compName,
        description: compDesc,
        rating: compRating,
        estimated_reviews: estReviews,
      });
    }

    if (batch.length > 0) {
      await db.batch(batch);
    }

    return {
      code: 200,
      message: "项目创建成功并已初始化推荐竞品",
      data: {
        id: projectId,
        name: finalProjectName,
        description: description,
        market_analysis: JSON.stringify({
          market_overview: analysisData.market_overview,
        }),
        competitors: insertedCompetitors,
      },
    };
  }
}

// 2. 获取项目列表（多用户项目隔离，只查出自己名下的项目）
export class ListProjects extends OpenAPIRoute {
  schema = {
    tags: ["Projects"],
    summary: "List projects belonging to the logged-in user",
    responses: {
      "200": {
        description: "Returns a list of user's projects",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.array(z.any()),
          }),
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const db = c.env.DB;
    const jwtPayload = c.get("jwtPayload");
    const userId = jwtPayload?.id || null;

    const { results } = await db
      .prepare(
        "SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC",
      )
      .bind(userId)
      .all();

    return {
      code: 200,
      message: "获取项目列表成功",
      data: results,
    };
  }
}

// 3. 获取项目详情（含越权校验）
export class ReadProject extends OpenAPIRoute {
  schema = {
    tags: ["Projects"],
    summary: "Get project details with tenant ownership validation",
    request: {
      params: z.object({
        id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Returns project details",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.any(),
          }),
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const projectId = data.params.id;

    const jwtPayload = c.get("jwtPayload");
    const userId = jwtPayload?.id || null;

    // 查项目并校验 user_id 权限
    const project = await db
      .prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?")
      .bind(projectId, userId)
      .first();

    if (!project) {
      return c.json(
        { code: 403, message: "项目不存在或无权访问", data: null },
        403,
      );
    }

    // 查竞品
    const { results: competitors } = await db
      .prepare(
        "SELECT * FROM competitors WHERE project_id = ? ORDER BY rating DESC",
      )
      .bind(projectId)
      .all();

    return {
      code: 200,
      message: "获取项目详情成功",
      data: {
        ...project,
        competitors,
      },
    };
  }
}

// 4. 更新项目
export class UpdateProject extends OpenAPIRoute {
  schema = {
    tags: ["Projects"],
    summary: "Update project details with ownership check",
    request: {
      params: z.object({
        id: z.string(),
      }),
      body: contentJson(
        z.object({
          name: z.string().optional(),
          description: z.string().optional(),
          status: z.string().optional(),
        }),
      ),
    },
    responses: {
      "200": {
        description: "Project updated successfully",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.any().nullable().optional(),
          }),
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const projectId = data.params.id;
    const { name, description, status } = data.body;

    const jwtPayload = c.get("jwtPayload");
    const userId = jwtPayload?.id || null;

    // 越权校验
    const project = await db
      .prepare("SELECT id FROM projects WHERE id = ? AND user_id = ?")
      .bind(projectId, userId)
      .first();

    if (!project) {
      return c.json(
        { code: 403, message: "项目不存在或无权操作", data: null },
        403,
      );
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (name !== undefined) {
      updates.push("name = ?");
      params.push(name);
    }
    if (description !== undefined) {
      updates.push("description = ?");
      params.push(description);
    }
    if (status !== undefined) {
      updates.push("status = ?");
      params.push(status);
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(projectId);
      const sql = `UPDATE projects SET ${updates.join(", ")} WHERE id = ?`;
      await db
        .prepare(sql)
        .bind(...params)
        .run();
    }

    return {
      code: 200,
      message: "修改项目成功",
      data: null,
    };
  }
}

// 5. 删除项目
export class DeleteProject extends OpenAPIRoute {
  schema = {
    tags: ["Projects"],
    summary: "Delete project and associated details with ownership check",
    request: {
      params: z.object({
        id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Project deleted successfully",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.any().nullable().optional(),
          }),
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const projectId = data.params.id;

    const jwtPayload = c.get("jwtPayload");
    const userId = jwtPayload?.id || null;

    // 越权校验
    const project = await db
      .prepare("SELECT id FROM projects WHERE id = ? AND user_id = ?")
      .bind(projectId, userId)
      .first();

    if (!project) {
      return c.json(
        { code: 403, message: "项目不存在或无权操作", data: null },
        403,
      );
    }

    await db.prepare("DELETE FROM projects WHERE id = ?").bind(projectId).run();

    return {
      code: 200,
      message: "项目删除成功",
      data: null,
    };
  }
}

projectsRouter.post("/", CreateProject);
projectsRouter.get("/", ListProjects);
projectsRouter.get("/:id", ReadProject);
projectsRouter.put("/:id", UpdateProject);
projectsRouter.delete("/:id", DeleteProject);
