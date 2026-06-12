import { contentJson, OpenAPIRoute, fromHono } from "chanfana";
import { AppContext, AppVariables } from "../types";
import { z } from "zod";
import { Hono } from "hono";
import { generateUUID } from "../utils/id";

export const competitorsRouter = fromHono(new Hono<{ Bindings: Env; Variables: AppVariables }>());

// 1. 获取竞品列表
export class ListCompetitors extends OpenAPIRoute {
  schema = {
    tags: ["Competitors"],
    summary: "List competitors, optionally filtered by project_id",
    request: {
      query: z.object({
        project_id: z.string().optional(),
      }),
    },
    responses: {
      "200": {
        description: "Returns a list of competitors",
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

    let sql = "SELECT * FROM competitors";
    const params: any[] = [];

    if (project_id) {
      sql += " WHERE project_id = ?";
      params.push(project_id);
    }

    sql += " ORDER BY rating DESC";

    const { results } = await db.prepare(sql).bind(...params).all();
    return {
      code: 200,
      message: "获取竞品列表成功",
      data: results,
    };
  }
}

// 2. 更新竞品信息（包名、状态等）
export class UpdateCompetitor extends OpenAPIRoute {
  schema = {
    tags: ["Competitors"],
    summary: "Update competitor details (like package_name or estimated_reviews)",
    request: {
      params: z.object({
        id: z.string(),
      }),
      body: contentJson(
        z.object({
          package_name: z.string().optional(),
          name: z.string().optional(),
          description: z.string().optional(),
          estimated_reviews: z.number().int().optional(),
          scrape_status: z.string().optional(),
          rating: z.number().optional(),
        })
      ),
    },
    responses: {
      "200": {
        description: "Competitor updated successfully",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.any().nullable().optional(),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const competitorId = data.params.id;
    const { package_name, name, description, estimated_reviews, scrape_status, rating } = data.body;

    const competitor = await db.prepare("SELECT id FROM competitors WHERE id = ?").bind(competitorId).first();
    if (!competitor) {
      return c.json({ code: 404, message: "竞品不存在", data: null }, 404);
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (package_name !== undefined) {
      updates.push("package_name = ?");
      params.push(package_name);
    }
    if (name !== undefined) {
      updates.push("name = ?");
      params.push(name);
    }
    if (description !== undefined) {
      updates.push("description = ?");
      params.push(description);
    }
    if (estimated_reviews !== undefined) {
      updates.push("estimated_reviews = ?");
      params.push(estimated_reviews);
    }
    if (scrape_status !== undefined) {
      updates.push("scrape_status = ?");
      params.push(scrape_status);
    }
    if (rating !== undefined) {
      updates.push("rating = ?");
      params.push(rating);
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(competitorId);
      const sql = `UPDATE competitors SET ${updates.join(", ")} WHERE id = ?`;
      await db.prepare(sql).bind(...params).run();
    }

    return {
      code: 200,
      message: "修改竞品信息成功",
      data: null,
    };
  }
}

// 3. 手动添加竞品
export class CreateCompetitor extends OpenAPIRoute {
  schema = {
    tags: ["Competitors"],
    summary: "Add a competitor manually to a project",
    request: {
      body: contentJson(
        z.object({
          project_id: z.string(),
          name: z.string(),
          description: z.string().optional(),
          package_name: z.string().optional(),
          rating: z.number().optional().default(0),
          estimated_reviews: z.number().int().optional().default(0),
        })
      ),
    },
    responses: {
      "200": {
        description: "Competitor manually added successfully",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.object({
              id: z.string(),
            }),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const { project_id, name, description, package_name, rating, estimated_reviews } = data.body;

    const project = await db.prepare("SELECT id FROM projects WHERE id = ?").bind(project_id).first();
    if (!project) {
      return c.json({ code: 404, message: "所属项目不存在", data: null }, 404);
    }

    const competitorId = generateUUID();
    await db.prepare(
      `INSERT INTO competitors (id, project_id, name, description, package_name, rating, estimated_reviews, review_count, scrape_status, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', datetime('now'), datetime('now'))`
    ).bind(
      competitorId,
      project_id,
      name,
      description || null,
      package_name || null,
      rating,
      estimated_reviews
    ).run();

    return {
      code: 200,
      message: "手动添加竞品成功",
      data: {
        id: competitorId,
      },
    };
  }
}

// 4. 删除竞品
export class DeleteCompetitor extends OpenAPIRoute {
  schema = {
    tags: ["Competitors"],
    summary: "Delete a competitor and its associated data",
    request: {
      params: z.object({
        id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Competitor deleted successfully",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.any().nullable().optional(),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const competitorId = data.params.id;

    await db.prepare("DELETE FROM competitors WHERE id = ?").bind(competitorId).run();

    return {
      code: 200,
      message: "竞品删除成功",
      data: null,
    };
  }
}

competitorsRouter.get("/", ListCompetitors);
competitorsRouter.put("/:id", UpdateCompetitor);
competitorsRouter.post("/", CreateCompetitor);
competitorsRouter.delete("/:id", DeleteCompetitor);
