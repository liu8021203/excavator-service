import { contentJson, OpenAPIRoute, fromHono } from "chanfana";
import { AppContext, AppVariables } from "../types";
import { z } from "zod";
import { Hono } from "hono";

export const settingsRouter = fromHono(new Hono<{ Bindings: Env; Variables: AppVariables }>());

// 1. 获取全部设置
export class GetSettings extends OpenAPIRoute {
  schema = {
    tags: ["Settings"],
    summary: "Get all settings",
    responses: {
      "200": {
        description: "Returns all settings in key-value map",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.record(z.string(), z.any()),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const db = c.env.DB;
    const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
    
    const settingsMap: Record<string, any> = {};
    for (const row of results) {
      try {
        // 如果是数字型字符串，不尝试 parse 成数字，只有 JSON object 或 array 才 parse
        if ((row.value.startsWith('{') && row.value.endsWith('}')) || (row.value.startsWith('[') && row.value.endsWith(']'))) {
          settingsMap[row.key] = JSON.parse(row.value);
        } else {
          settingsMap[row.key] = row.value;
        }
      } catch {
        settingsMap[row.key] = row.value;
      }
    }

    return {
      code: 200,
      message: "获取设置成功",
      data: settingsMap,
    };
  }
}

// 2. 更新设置
export class UpdateSettings extends OpenAPIRoute {
  schema = {
    tags: ["Settings"],
    summary: "Update settings",
    request: {
      body: contentJson(
        z.object({
          settings: z.record(z.string(), z.any()),
        })
      ),
    },
    responses: {
      "200": {
        description: "Settings updated successfully",
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
    
    const settings = data.body.settings;
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");
    
    const batch = [];
    for (const [key, val] of Object.entries(settings)) {
      const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
      batch.push(stmt.bind(key, valStr));
    }

    if (batch.length > 0) {
      await db.batch(batch);
    }

    return {
      code: 200,
      message: "更新设置成功",
      data: null,
    };
  }
}

settingsRouter.get("/", GetSettings);
settingsRouter.put("/", UpdateSettings);
