import { contentJson, OpenAPIRoute, fromHono } from "chanfana";
import { AppContext } from "../types";
import { z } from "zod";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { generateUUID } from "../utils/id";

export const authRouter = fromHono(new Hono<{ Bindings: Env }>());

// 1. 用户注册接口
export class RegisterEndpoint extends OpenAPIRoute {
  schema = {
    tags: ["Auth"],
    summary: "Register a new user (Plain-text password)",
    request: {
      body: contentJson(
        z.object({
          username: z.string().min(3, "Username must be at least 3 characters").max(50),
          password: z.string().min(6, "Password must be at least 6 characters"),
        })
      ),
    },
    responses: {
      "200": {
        description: "User registered successfully",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.object({
              id: z.string(),
              username: z.string(),
            }),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const { username, password } = data.body;

    const existing = await db
      .prepare("SELECT id FROM users WHERE username = ?")
      .bind(username)
      .first();

    if (existing) {
      return c.json({ code: 400, message: "用户名已被占用", data: null }, 400);
    }

    const userId = generateUUID();

    // 直接存储明文密码！
    await db.prepare(
      `INSERT INTO users (id, username, password, created_at, updated_at) 
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(userId, username, password).run();

    return {
      code: 200,
      message: "注册成功",
      data: {
        id: userId,
        username,
      },
    };
  }
}

// 2. 用户登录接口
export class LoginEndpoint extends OpenAPIRoute {
  schema = {
    tags: ["Auth"],
    summary: "User login (Plain-text comparison)",
    request: {
      body: contentJson(
        z.object({
          username: z.string(),
          password: z.string(),
        })
      ),
    },
    responses: {
      "200": {
        description: "Logged in successfully",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.object({
              token: z.string(),
              user: z.object({
                id: z.string(),
                username: z.string(),
              }),
            }),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const db = c.env.DB;
    const { username, password } = data.body;

    const user = await db
      .prepare("SELECT * FROM users WHERE username = ?")
      .bind(username)
      .first<{ id: string; username: string; password: string }>();

    if (!user) {
      return c.json({ code: 401, message: "用户名或密码错误", data: null }, 401);
    }

    // 直接进行明文密码比对！
    if (user.password !== password) {
      return c.json({ code: 401, message: "用户名或密码错误", data: null }, 401);
    }

    const jwtSecret = c.env.JWT_SECRET || "excavator-jwt-secret-key-fallback";
    const payload = {
      id: user.id,
      username: user.username,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    };

    const token = await sign(payload, jwtSecret);

    return {
      code: 200,
      message: "登录成功",
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
        },
      },
    };
  }
}

// 3. 获取当前用户信息接口
export class ReadMeEndpoint extends OpenAPIRoute {
  schema = {
    tags: ["Auth"],
    summary: "Get current user profile (Requires Authorization header)",
    responses: {
      "200": {
        description: "User details retrieved successfully",
        ...contentJson(
          z.object({
            code: z.number().int(),
            message: z.string(),
            data: z.object({
              id: z.string(),
              username: z.string(),
              roles: z.array(z.string()),
              realName: z.string(),
            }),
          })
        ),
      },
    },
  };

  async handle(c: AppContext) {
    const db = c.env.DB;
    const jwtPayload = c.get("jwtPayload");
    const userId = jwtPayload?.id || null;

    const user = await db
      .prepare("SELECT id, username FROM users WHERE id = ?")
      .bind(userId)
      .first<{ id: string; username: string }>();

    if (!user) {
      return c.json({ code: 404, message: "账户不存在", data: null }, 404);
    }

    return {
      code: 200,
      message: "获取个人信息成功",
      data: {
        id: user.id,
        username: user.username,
        roles: ["admin"], // 提供 Vben 所需的角色
        realName: user.username,
      },
    };
  }
}

authRouter.post("/register", RegisterEndpoint);
authRouter.post("/login", LoginEndpoint);
authRouter.get("/me", ReadMeEndpoint);
