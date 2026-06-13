import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { AppVariables } from "./types";
import { requireAuth } from "./middleware/auth";


// 导入业务路由
import { authRouter } from "./routes/auth";
import { projectsRouter } from "./routes/projects";
import { competitorsRouter } from "./routes/competitors";
import { reviewsRouter } from "./routes/reviews";
import { analysesRouter } from "./routes/analyses";
import { projectAnalysesRouter } from "./routes/project-analyses";
import { settingsRouter } from "./routes/settings";

// Start a Hono app
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// 开启全局跨域 CORS 允许，确保前端能顺利对接 API
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
  credentials: true,
}));

// ============================================================
// JWT 鉴权中间件精细化策略挂载
// ============================================================
app.use("/api/auth/me", requireAuth);
app.use("/api/projects/*", requireAuth);
app.use("/api/analyses/*", requireAuth);
app.use("/api/project-analyses/*", requireAuth);
app.use("/api/settings/*", requireAuth);

// 竞品管理：GET（爬虫免签读取）和 PUT（爬虫更新 scrape_status）放行，POST/DELETE（手动添加/删除）强制 JWT 鉴权
app.use("/api/competitors/*", async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'PUT') {
    return next();
  }
  return requireAuth(c, next);
});


// 评论管理（ reviews ）：全部放行，爬虫 CLI 上传回传与查询零门槛免签
// （默认已全部放行，不设拦截即为免签）

// ============================================================
// 全局异常捕捉
// ============================================================
app.onError((err, c) => {
  let status = 500;
  let message = err.message || "Internal Server Error";

  if (err instanceof ApiException) {
    status = err.status || 400;
    message = JSON.stringify(err.buildResponse());
  } else if (err instanceof HTTPException) {
    status = err.status;
    message = err.message;
  }

  // 针对 JWT 校验失败给出友好提示
  if (
    status === 401 ||
    err.name === "JwtTokenInvalid" ||
    err.name === "JwtTokenExpired" ||
    err.message?.includes("jwt") ||
    err.message?.includes("authorization")
  ) {
    status = 401;
    message = "鉴权失败，请重新登录管理系统";
  }

  console.error("Global error handler caught:", err);

  return c.json(
    {
      code: status,
      message: message,
      data: null
    },
    status as ContentfulStatusCode,
  );
});

// Setup OpenAPI registry
const openapi = fromHono(app, {
  docs_url: "/docs",
  schema: {
    info: {
      title: "Excavator API",
      version: "1.1.0",
      description: "APP Requirement Mining System Backend API (Hono + Chanfana + D1)",
    },
  },
});

// 注册业务 API 路由
openapi.route("/api/auth", authRouter);
openapi.route("/api/projects", projectsRouter);
openapi.route("/api/competitors", competitorsRouter);
openapi.route("/api/reviews", reviewsRouter);
openapi.route("/api/analyses", analysesRouter);
openapi.route("/api/project-analyses", projectAnalysesRouter);
openapi.route("/api/settings", settingsRouter);

// 默认根路径跳转到文档页
app.get("/", (c) => c.redirect("/docs"));

import { processAnalysisTask } from "./utils/queue";

// Export the Worker handlers
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<{ analysisId: string }>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      const { analysisId } = message.body;
      console.log(`[Queue Consumer] Received analysis task: ${analysisId}`);
      try {
        await processAnalysisTask(analysisId, env, ctx);
        message.ack();
      } catch (err) {
        console.error(`[Queue Consumer] Process failed for analysis ${analysisId}:`, err);
        message.retry();
      }
    }
  }
};
