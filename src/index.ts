import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ContentfulStatusCode } from "hono/utils/http-status";

// 导入业务路由
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

app.onError((err, c) => {
  if (err instanceof ApiException) {
    return c.json(
      { success: false, errors: err.buildResponse() },
      err.status as ContentfulStatusCode,
    );
  }

  console.error("Global error handler caught:", err);

  return c.json(
    {
      success: false,
      errors: [{ code: 7000, message: err.message || "Internal Server Error" }],
    },
    500,
  );
});

// Setup OpenAPI registry
const openapi = fromHono(app, {
  docs_url: "/docs",
  schema: {
    info: {
      title: "Excavator API",
      version: "1.0.0",
      description: "APP Requirement Mining System Backend API (Hono + Chanfana + D1)",
    },
  },
});

// 注册业务 API 路由
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
