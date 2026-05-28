import { contentJson, OpenAPIRoute, fromHono } from "chanfana";
import { AppContext } from "../types";
import { z } from "zod";
import { Hono } from "hono";
import { generateUUID } from "../utils/id";

export const reviewsRouter = fromHono(new Hono<{ Bindings: Env }>());

// 评论的 Zod 校验 Schema，供批量上传用
const singleReviewUploadSchema = z.object({
  review_id: z.string(),
  user_name: z.string().nullable().optional(),
  rating: z.number().int().min(1).max(5),
  text: z.string().nullable().optional(),
  thumbs_up: z.number().int().optional().default(0),
  reply_text: z.string().nullable().optional(),
  review_date: z.string().nullable().optional(),
});

// 1. 批量上传评论
export class UploadReviews extends OpenAPIRoute {
  schema = {
    tags: ["Reviews"],
    summary: "Upload reviews in batch for a competitor with de-duplication",
    request: {
      body: contentJson(
        z.object({
          competitor_id: z.string(),
          reviews: z.array(singleReviewUploadSchema),
          is_completed: z.boolean().optional().default(false), // 爬虫标记是否已全部完成
        })
      ),
    },
    responses: {
      "200": {
        description: "Reviews processed successfully",
        ...contentJson(
          z.object({
            success: z.boolean(),
            result: z.object({
              uploaded: z.number().int(),
              total: z.number().int(),
            }),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const { competitor_id, reviews, is_completed } = data.body;

    // 检查竞品是否存在
    const comp = await db.prepare("SELECT id FROM competitors WHERE id = ?").bind(competitor_id).first();
    if (!comp) {
      return c.json({ success: false, error: "Competitor not found" }, 404);
    }

    // 批量插入 D1 reviews Table
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO reviews (id, competitor_id, review_id, user_name, rating, text, thumbs_up, reply_text, review_date, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );

    const batch = [];
    for (const r of reviews) {
      const id = generateUUID();
      batch.push(
        insertStmt.bind(
          id,
          competitor_id,
          r.review_id,
          r.user_name || null,
          r.rating,
          r.text || null,
          r.thumbs_up || 0,
          r.reply_text || null,
          r.review_date || null
        )
      );
    }

    if (batch.length > 0) {
      await db.batch(batch);
    }

    // 统计目前竞品已存的去重后评论总数
    const countRow = await db
      .prepare("SELECT COUNT(*) as total FROM reviews WHERE competitor_id = ?")
      .bind(competitor_id)
      .first<{ total: number }>();
    const totalCount = countRow?.total || 0;

    // 更新 competitors 的已爬取数量和爬取状态
    let scrapeStatus = "scraping";
    if (is_completed) {
      scrapeStatus = "completed";
    }

    await db.prepare(
      `UPDATE competitors 
       SET review_count = ?, 
           scrape_status = ?, 
           last_scraped_at = datetime('now'), 
           updated_at = datetime('now') 
       WHERE id = ?`
    ).bind(totalCount, scrapeStatus, competitor_id).run();

    return {
      success: true,
      result: {
        uploaded: reviews.length,
        total: totalCount,
      },
    };
  }
}

// 2. 查询评论列表
export class ListReviews extends OpenAPIRoute {
  schema = {
    tags: ["Reviews"],
    summary: "Query reviews for a competitor with filters and pagination",
    request: {
      query: z.object({
        competitor_id: z.string(),
        min_rating: z.string().optional(), // 字符串类型以支持 Query 传参转换
        max_rating: z.string().optional(),
        page: z.string().optional().default("1"),
        limit: z.string().optional().default("20"),
      }),
    },
    responses: {
      "200": {
        description: "Returns a paginated list of reviews",
        ...contentJson(
          z.object({
            success: z.boolean(),
            result: z.object({
              list: z.array(z.any()),
              total: z.number().int(),
              page: z.number().int(),
              limit: z.number().int(),
            }),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const { competitor_id, min_rating, max_rating, page, limit } = data.query;

    const pageInt = parseInt(page) || 1;
    const limitInt = parseInt(limit) || 20;
    const offset = (pageInt - 1) * limitInt;

    let baseSql = "FROM reviews WHERE competitor_id = ?";
    const params: any[] = [competitor_id];

    if (min_rating) {
      baseSql += " AND rating >= ?";
      params.push(parseInt(min_rating));
    }
    if (max_rating) {
      baseSql += " AND rating <= ?";
      params.push(parseInt(max_rating));
    }

    // 查总数
    const countSql = `SELECT COUNT(*) as total ${baseSql}`;
    const totalRow = await db.prepare(countSql).bind(...params).first<{ total: number }>();
    const total = totalRow?.total || 0;

    // 查列表
    const listSql = `SELECT * ${baseSql} ORDER BY review_date DESC, created_at DESC LIMIT ? OFFSET ?`;
    const { results } = await db.prepare(listSql).bind(...params, limitInt, offset).all();

    return {
      success: true,
      result: {
        list: results,
        total,
        page: pageInt,
        limit: limitInt,
      },
    };
  }
}

// 3. 评论统计数据接口
export class GetReviewsStats extends OpenAPIRoute {
  schema = {
    tags: ["Reviews"],
    summary: "Get review stats (rating distribution) for a competitor",
    request: {
      query: z.object({
        competitor_id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Returns review counts and distributions",
        ...contentJson(
          z.object({
            success: z.boolean(),
            result: z.object({
              total: z.number().int(),
              negative: z.number().int(), // ⭐1-3
              positive: z.number().int(), // ⭐4-5
              distribution: z.record(z.string(), z.number().int()), // 各评分分布如 {"1": 10, "2": 5, ...}
            }),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const { competitor_id } = data.query;

    const { results } = await db.prepare(
      `SELECT rating, COUNT(*) as count 
       FROM reviews 
       WHERE competitor_id = ? 
       GROUP BY rating`
    ).bind(competitor_id).all<{ rating: number; count: number }>();

    let total = 0;
    let negative = 0;
    let positive = 0;
    const distribution: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };

    for (const row of results) {
      const r = row.rating;
      const count = row.count;
      total += count;
      distribution[String(r)] = count;

      if (r <= 3) {
        negative += count;
      } else {
        positive += count;
      }
    }

    return {
      success: true,
      result: {
        total,
        negative,
        positive,
        distribution,
      },
    };
  }
}

reviewsRouter.post("/upload", UploadReviews);
reviewsRouter.get("/", ListReviews);
reviewsRouter.get("/stats", GetReviewsStats);
