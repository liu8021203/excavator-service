import { getLLMProvider } from "../llm";
import { generateUUID } from "./id";

/**
 * 队列消费者处理函数：后台执行大模型分析与结果汇总
 */
export async function processAnalysisTask(analysisId: string, env: Env, ctx: ExecutionContext): Promise<void> {
  const db = env.DB;

  // 1. 读取分析任务记录
  const analysis = await db
    .prepare("SELECT * FROM analyses WHERE id = ?")
    .bind(analysisId)
    .first<{
      id: string;
      competitor_id: string;
      rating_filter: string;
      total_reviews: number;
      batch_size: number;
      status: string;
    }>();

  if (!analysis) {
    console.error(`[Queue] Analysis task ${analysisId} not found in DB.`);
    return;
  }

  // 如果状态已经是 completed，跳过处理避免重复消费
  if (analysis.status === "completed") {
    return;
  }

  // 2. 将状态标记为 processing，防止并发争抢
  await db
    .prepare("UPDATE analyses SET status = 'processing', updated_at = datetime('now') WHERE id = ?")
    .bind(analysisId)
    .run();

  const { competitor_id, rating_filter, batch_size } = analysis;

  try {
    // 3. 获取竞品信息
    const competitor = await db
      .prepare("SELECT name FROM competitors WHERE id = ?")
      .bind(competitor_id)
      .first<{ name: string }>();
    if (!competitor) {
      throw new Error("竞品不存在");
    }

    // 4. 查询对应的评论数据
    const ratingCondition = rating_filter === "negative" ? "rating <= 3" : "rating >= 4";
    const { results: rawReviews } = await db
      .prepare(
        `SELECT user_name, rating, text, thumbs_up, review_date FROM reviews WHERE competitor_id = ? AND ${ratingCondition}`
      )
      .bind(competitor_id)
      .all<{ user_name: string; rating: number; text: string; thumbs_up: number; review_date: string }>();

    const totalReviews = rawReviews.length;
    if (totalReviews === 0) {
      throw new Error(`该评分分组暂无评论，无法分析 (rating_filter: ${rating_filter})`);
    }

    // 5. 初始化大模型 Provider
    const provider = await getLLMProvider(db, env);
    const batchesCount = Math.ceil(totalReviews / batch_size);
    const batchResults: any[] = [];

    // 6. 分批次进行 Map 分析
    for (let i = 0; i < batchesCount; i++) {
      const start = i * batch_size;
      const end = Math.min(start + batch_size, totalReviews);
      const batchReviews = rawReviews.slice(start, end);

      const batchId = generateUUID();
      await db
        .prepare(
          `INSERT INTO analysis_batches (id, analysis_id, batch_index, review_count, status, created_at) 
           VALUES (?, ?, ?, ?, 'processing', datetime('now'))`
        )
        .bind(batchId, analysisId, i, batchReviews.length)
        .run();

      const reviewsText = batchReviews
        .map(
          (r, idx) =>
            `[Review #${idx + 1}] Date: ${r.review_date} | Rating: ${r.rating}* | Likes: ${r.thumbs_up}\nUser: ${
              r.user_name || "Anonymous"
            }\nContent: ${r.text || ""}`
        )
        .join("\n---\n");      const systemPrompt = rating_filter === "negative"
        ? `你是一位资深的市场研究专家和产品经理。
你的任务是分析竞品应用「${competitor.name}」的一批用户差评（1-3星），挖掘出核心的产品缺陷与痛点。

## 语言要求（最高优先级）
- **所有输出内容必须使用简体中文**，包括 title、quotes、sentiment_summary、description 等所有字段。
- 用户原始评论（quotes）如果是英文或其他语言，你必须翻译为简体中文后再填入。
- **严禁输出任何英文内容**。

## 输出格式
请分析用户差评，严格按照以下 JSON 格式输出痛点、功能诉求与我们产品的切入机会：
{
  "pain_points": [
    {
      "title": "高频痛点/缺陷（如：应用频繁闪退崩溃）",
      "frequency": 12,
      "quotes": ["每次打开就闪退，太烦了", "更新后完全无法使用"]
    }
  ],
  "feature_requests": [
    {
      "title": "功能改善/新增诉求（如：希望增加离线模式）",
      "frequency": 8,
      "quotes": ["没有网络就没法用，希望能离线"]
    }
  ],
  "sentiment_summary": "用户负面情绪总结（如：用户普遍对频繁闪退感到烦躁和沮丧，甚至威胁要卸载）",
  "opportunities": [
    {
      "title": "我们的切入/改善机会（如：以极高的稳定性切入市场）",
      "description": "竞品崩溃问题严重，我们可通过卓越的应用稳定性赢得用户信任。"
    }
  ]
}
仅返回合法的 JSON，不要包含 markdown 代码块标记如 \`\`\`json。`
        : `你是一位资深的市场研究专家和产品经理。
你的任务是分析竞品应用「${competitor.name}」的一批用户好评（4-5星），提炼出其核心的产品优势与亮点。

## 语言要求（最高优先级）
- **所有输出内容必须使用简体中文**，包括 title、quotes、sentiment_summary、description 等所有字段.
- 用户原始评论（quotes）如果是英文或其他语言，你必须翻译为简体中文后再填入。
- **严禁输出任何英文内容**。

## 输出格式
请分析用户好评，严格按照以下 JSON 格式输出亮点、喜爱功能与我们产品的防御/借鉴建议（注意：为了兼容数据库，请保持相同的 JSON 键名）：
{
  "pain_points": [
    {
      "title": "产品优势/亮点（如：界面设计美观现代，交互流畅）",
      "frequency": 15,
      "quotes": ["设计超级好看！", "滑动非常丝滑"]
    }
  ],
  "feature_requests": [
    {
      "title": "最受喜爱的功能（如：每日精美卡片分享功能）",
      "frequency": 10,
      "quotes": ["每天分享的精美卡片很温馨"]
    }
  ],
  "sentiment_summary": "用户正面情绪总结（如：用户对界面表现出强烈的喜爱与自豪感，整体感到愉悦和满足）",
  "opportunities": [
    {
      "title": "我们产品的防御/借鉴建议（如：借鉴并升级其分享卡片设计）",
      "description": "其卡片分享功能好评率极高，我们应设计更具个性化的分享卡片以进行竞争防御。"
    }
  ]
}
仅返回合法的 JSON，不要包含 markdown 代码块标记如 \`\`\`json。`;
      const userPrompt = `Here is a batch of ${batchReviews.length} user reviews:\n\n${reviewsText}`;

      let responseStr = "";
      try {
        responseStr = await provider.chat(
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          { response_format: "json" }
        );
      } catch (err: any) {
        await db
          .prepare("UPDATE analysis_batches SET status = 'failed' WHERE id = ?")
          .bind(batchId)
          .run();
        throw err;
      }

      let cleanResponse = responseStr.trim();
      if (cleanResponse.startsWith("```")) {
        cleanResponse = cleanResponse.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
      }

      let parsedResult: any;
      try {
        parsedResult = JSON.parse(cleanResponse);
      } catch {
        console.error("Batch parse failed. Raw response:", responseStr);
        parsedResult = {
          pain_points: [],
          feature_requests: [],
          sentiment_summary: "Parsing error",
          opportunities: [],
        };
      }

      await db
        .prepare("UPDATE analysis_batches SET status = 'completed', result = ? WHERE id = ?")
        .bind(JSON.stringify(parsedResult), batchId)
        .run();

      batchResults.push(parsedResult);
    }

    // 7. 汇总 Reduce 阶段
    let finalConsolidatedResult: any;

    if (batchResults.length === 1) {
      finalConsolidatedResult = batchResults[0];
    } else {
      const systemConsolidatePrompt = rating_filter === "negative"
        ? `你是一位资深的市场研究专家和产品经理。
你已经完成了对竞品应用「${competitor.name}」多个批次用户差评的分析。
现在，请将这些分批分析结果合并为一份统一的、高质量的最终痛点报告。

## 合并规则
- 合并相似的痛点和功能诉求，累加或估算总频次。
- 精选最具代表性的用户差评原声（quotes）。
- 生成连贯的整体用户负面情绪总结和产品切入机会建议。

## 语言要求（最高优先级）
- **所有输出内容必须使用简体中文**，包括 title、quotes、sentiment_summary、description 等所有字段。
- 如果输入中的 quotes 是英文或其他语言，你必须翻译为简体中文后再填入。
- **严禁输出任何英文内容**。

## 输出格式
严格按照以下 JSON 格式输出最终合并报告：
{
  "pain_points": [
    {
      "title": "合并后的痛点标题（如：部分机型闪退严重）",
      "frequency": 24,
      "quotes": ["差评原声1", "差评原声2"]
    }
  ],
  "feature_requests": [
    {
      "title": "合并后的功能改善/新增需求标题",
      "frequency": 16,
      "quotes": ["诉求原声"]
    }
  ],
  "sentiment_summary": "对用户负面情绪的连贯总结。",
  "opportunities": [
    {
      "title": "合并后的产品改进/切入机会标题",
      "description": "基于竞品缺陷的具体行动建议。"
    }
  ]
}
仅返回合法的 JSON，不要包含 markdown 代码块标记如 \`\`\`json。`
        : `你是一位资深的市场研究专家和产品经理。
你已经完成了对竞品应用「${competitor.name}」多个批次用户好评的分析。
现在，请将这些分批分析结果合并为一份统一的、高质量的最终亮点报告。

## 合并规则
- 合并相似的优势和亮点，累加或估算总频次。
- 精选最具代表性的用户好评原声（quotes）。
- 生成连贯的整体用户正面情绪总结和产品借鉴/防御建议。

## 语言要求（最高优先级）
- **所有输出内容必须使用简体中文**，包括 title、quotes、sentiment_summary、description 等所有字段。
- 如果输入中的 quotes 是英文或其他语言，你必须翻译为简体中文后再填入。
- **严禁输出任何英文内容**。

## 输出格式
严格按照以下 JSON 格式输出最终合并报告（注意：保持相同的 JSON 键名以兼容存储）：
{
  "pain_points": [
    {
      "title": "合并后的亮点优势标题（如：极致简洁的界面交互）",
      "frequency": 30,
      "quotes": ["好评原声1", "好评原声2"]
    }
  ],
  "feature_requests": [
    {
      "title": "合并后的好评功能/模块标题",
      "frequency": 20,
      "quotes": ["好评原声"]
    }
  ],
  "sentiment_summary": "对用户正面情绪的连贯总结。",
  "opportunities": [
    {
      "title": "合并后的借鉴与防御建议标题",
      "description": "基于竞品优势的具体跟进/防御策略描述。"
    }
  ]
}
仅返回合法的 JSON，不要包含 markdown 代码块标记如 \`\`\`json。`;

      const userConsolidatePrompt = `Here are the batch results from ${batchResults.length} batches:\n\n${JSON.stringify(
        batchResults,
        null,
        2
      )}`;

      const consolidateProvider = await getLLMProvider(db, env, 'reduce');

      let reduceResponseStr = await consolidateProvider.chat(
        [
          { role: "system", content: systemConsolidatePrompt },
          { role: "user", content: userConsolidatePrompt },
        ],
        { response_format: "json" }
      );

      let cleanReduce = reduceResponseStr.trim();
      if (cleanReduce.startsWith("```")) {
        cleanReduce = cleanReduce.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
      }

      try {
        finalConsolidatedResult = JSON.parse(cleanReduce);
      } catch {
        console.error("Consolidated parse failed. Raw response:", reduceResponseStr);
        finalConsolidatedResult = {
          pain_points: batchResults.flatMap((b) => b.pain_points || []),
          feature_requests: batchResults.flatMap((b) => b.feature_requests || []),
          sentiment_summary: "Consolidation failed. Showing raw flattened results.",
          opportunities: batchResults.flatMap((b) => b.opportunities || []),
        };
      }
    }

    // 8. 更新 analyses 任务表为已完成状态
    await db
      .prepare(
        `UPDATE analyses 
         SET status = 'completed', 
             pain_points = ?, 
             feature_requests = ?, 
             sentiment_summary = ?, 
             opportunities = ?, 
             updated_at = datetime('now') 
         WHERE id = ?`
      )
      .bind(
        JSON.stringify(finalConsolidatedResult.pain_points || []),
        JSON.stringify(finalConsolidatedResult.feature_requests || []),
        finalConsolidatedResult.sentiment_summary || "",
        JSON.stringify(finalConsolidatedResult.opportunities || []),
        analysisId
      )
      .run();

  } catch (err: any) {
    console.error(`[Queue Processor] Background analysis failed for ID ${analysisId}:`, err);
    
    // 更新任务状态为 failed 并记录错误信息
    await db
      .prepare(
        "UPDATE analyses SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(err.message, analysisId)
      .run();

    // 重新抛出错误以便队列管理重试
    throw err;
  }
}

/**
 * 队列消费者处理函数：项目级跨竞品汇总分析
 */
export async function processProjectAnalysisTask(synthesisId: string, env: Env, ctx: ExecutionContext): Promise<void> {
  const db = env.DB;

  // 1. 获取汇总分析任务
  const report = await db
    .prepare("SELECT * FROM project_analyses WHERE id = ?")
    .bind(synthesisId)
    .first<{
      id: string;
      project_id: string;
      status: string;
    }>();

  if (!report) {
    console.error(`[Queue] Project analysis ${synthesisId} not found.`);
    return;
  }

  // 已经完成则跳过
  if (report.status === "completed") {
    return;
  }

  // 2. 将状态标记为 processing
  await db
    .prepare("UPDATE project_analyses SET status = 'processing', updated_at = datetime('now') WHERE id = ?")
    .bind(synthesisId)
    .run();

  const project_id = report.project_id;

  try {
    // 3. 查出该项目下所有已完成的单竞品分析
    const { results: analysesList } = await db.prepare(
      `SELECT a.*, c.name as competitor_name 
       FROM analyses a
       JOIN competitors c ON a.competitor_id = c.id
       WHERE c.project_id = ? AND a.status = 'completed'`
    ).bind(project_id).all<any>();

    if (analysesList.length === 0) {
      throw new Error("该项目下暂无已完成的单竞品分析，无法进行交叉对比。");
    }

    const provider = await getLLMProvider(db, env, 'project');

    // 整理各竞品的分析报告作为大模型上下文
    const competitorReports = analysesList.map(a => {
      return {
        competitor_name: a.competitor_name,
        rating_filter: a.rating_filter,
        pain_points: a.pain_points ? JSON.parse(a.pain_points) : [],
        feature_requests: a.feature_requests ? JSON.parse(a.feature_requests) : [],
        opportunities: a.opportunities ? JSON.parse(a.opportunities) : [],
        sentiment_summary: a.sentiment_summary || ""
      };
    });

    // 核心战略分析 Prompt
    const systemPrompt = `You are a master product strategist and venture capitalist.
You are given the review analysis reports of multiple competitor apps in the same industry.
Your task is to conduct a cross-competitor synthesis and construct an exhaustive product strategy report.

You MUST structure the JSON output exactly according to this schema:
{
  "common_pain_points": [
    {
      "title": "Consolidated industry pain point",
      "severity": "high" | "medium" | "low",
      "competitors": ["App A Name", "App B Name"],
      "frequency_desc": "Brief details of this pain point across the market."
    }
  ],
  "differentiation": [
    {
      "feature": "A unique differentiator we can build",
      "only_in_competitor": "Competitor App A Name", // Leave null if completely missing in all competitors
      "missing_in": ["Competitor App B Name", "Competitor App C Name"],
      "description": "How this feature can be our secret weapon."
    }
  ],
  "feature_matrix": [
    {
      "feature": "Core Feature Name (e.g. Calorie Scanner, Sleep Track)",
      "competitors": {
        "Competitor App A Name": true,
        "Competitor App B Name": false
      }
    }
  ],
  "priority_suggestions": [
    {
      "title": "Recommended Product Action",
      "reason": "Detailed logic based on competitor findings.",
      "priority": "P0" | "P1" | "P2"
    }
  ]
}
Return ONLY valid JSON. Do not include markdown code block backticks like \`\`\`json.`;

    const userPrompt = `Competitor Reports:\n${JSON.stringify(competitorReports, null, 2)}`;

    let responseStr = "";
    try {
      responseStr = await provider.chat([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ], { response_format: "json" });
    } catch (err: any) {
      throw err;
    }

    // 过滤与解析 JSON
    let cleanResponse = responseStr.trim();
    if (cleanResponse.startsWith("```")) {
      cleanResponse = cleanResponse.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    }

    let parsedResult: any;
    try {
      parsedResult = JSON.parse(cleanResponse);
    } catch {
      console.error("Project synthesis parse failed. Raw response:", responseStr);
      throw new Error("AI returned invalid JSON for project synthesis.");
    }

    // 写入 D1
    await db.prepare(
      `UPDATE project_analyses 
       SET status = 'completed', 
           common_pain_points = ?, 
           differentiation = ?, 
           feature_matrix = ?, 
           priority_suggestions = ?, 
           updated_at = datetime('now') 
       WHERE id = ?`
    ).bind(
      JSON.stringify(parsedResult.common_pain_points || []),
      JSON.stringify(parsedResult.differentiation || []),
      JSON.stringify(parsedResult.feature_matrix || []),
      JSON.stringify(parsedResult.priority_suggestions || []),
      synthesisId
    ).run();

  } catch (err: any) {
    console.error("Cross-competitor synthesis failed:", err);
    await db.prepare(
      "UPDATE project_analyses SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(err.message, synthesisId).run();
    throw err;
  }
}

