import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { jwt } from "hono/jwt";
import { ContentfulStatusCode } from "hono/utils/http-status";

// 导入业务路由
import { authRouter } from "./routes/auth";
import { projectsRouter } from "./routes/projects";
import { competitorsRouter } from "./routes/competitors";
import { reviewsRouter } from "./routes/reviews";
import { analysesRouter } from "./routes/analyses";
import { projectAnalysesRouter } from "./routes/project-analyses";
import { settingsRouter } from "./routes/settings";

// Start a Hono app
const app = new Hono<{ Bindings: Env }>();

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
app.use("/api/auth/me", (c, next) => {
  const secret = c.env.JWT_SECRET || "excavator-jwt-secret-key-fallback";
  return jwt({ secret })(c, next);
});

app.use("/api/projects/*", (c, next) => {
  const secret = c.env.JWT_SECRET || "excavator-jwt-secret-key-fallback";
  return jwt({ secret })(c, next);
});

app.use("/api/analyses/*", (c, next) => {
  const secret = c.env.JWT_SECRET || "excavator-jwt-secret-key-fallback";
  return jwt({ secret })(c, next);
});

app.use("/api/project-analyses/*", (c, next) => {
  const secret = c.env.JWT_SECRET || "excavator-jwt-secret-key-fallback";
  return jwt({ secret })(c, next);
});

app.use("/api/settings/*", (c, next) => {
  const secret = c.env.JWT_SECRET || "excavator-jwt-secret-key-fallback";
  return jwt({ secret })(c, next);
});

// 竞品管理：GET 方式（爬虫免签读取）和 PUT /scrape_status 状态变更进行放行，其他写操作（手动添加、删除）强制 JWT 鉴权
app.use("/api/competitors/*", async (c, next) => {
  if (c.req.method === 'GET' || (c.req.method === 'PUT' && c.req.path.includes('/scrape_status'))) {
    return next();
  }
  const secret = c.env.JWT_SECRET || "excavator-jwt-secret-key-fallback";
  return jwt({ secret })(c, next);
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
  }

  // 针对 JWT 校验失败给出友好提示
  if (err.name === "JwtTokenInvalid" || err.name === "JwtTokenExpired" || err.message?.includes("jwt")) {
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

// Export the Hono app
export default app;
