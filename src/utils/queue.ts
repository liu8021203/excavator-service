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
        .join("\n---\n");

      const systemPrompt = `你是一位资深的市场研究专家和产品经理。
你的任务是分析竞品应用「${competitor.name}」的一批用户评论，提取结构化的产品洞察。

## 语言要求（最高优先级）
- **所有输出内容必须使用简体中文**，包括 title、quotes、sentiment_summary、description 等所有字段。
- 用户原始评论（quotes）如果是英文或其他语言，你必须翻译为简体中文后再填入。
- **严禁输出任何英文内容**。违反此规则将被视为失败输出。

## 输出格式
严格按照以下 JSON 格式输出：
{
  "pain_points": [
    {
      "title": "功能崩溃频繁",
      "frequency": 12,
      "quotes": ["每次打开就闪退，太烦了", "更新后完全无法使用"]
    }
  ],
  "feature_requests": [
    {
      "title": "希望增加离线模式",
      "frequency": 8,
      "quotes": ["没有网络就没法用，希望能离线"]
    }
  ],
  "sentiment_summary": "用户整体情绪概述，例如：用户普遍对界面设计表示满意，但对频繁崩溃和广告过多感到强烈不满。",
  "opportunities": [
    {
      "title": "稳定性优势",
      "description": "竞品崩溃问题严重，我们可通过卓越的应用稳定性赢得用户信任。"
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
      const systemConsolidatePrompt = `你是一位资深的市场研究专家和产品经理。
你已经完成了对竞品应用「${competitor.name}」多个批次用户评论的分析。
现在，请将这些分批分析结果合并为一份统一的、高质量的最终报告。

## 合并规则
- 合并相似的痛点和功能需求，累加或估算总频次。
- 精选最具代表性的用户原声（quotes）。
- 生成连贯的整体用户情绪概述和产品机会点。

## 语言要求（最高优先级）
- **所有输出内容必须使用简体中文**，包括 title、quotes、sentiment_summary、description 等所有字段。
- 如果输入中的 quotes 是英文或其他语言，你必须翻译为简体中文后再填入。
- **严禁输出任何英文内容**。违反此规则将被视为失败输出。

## 输出格式
严格按照以下 JSON 格式输出最终合并报告：
{
  "pain_points": [
    {
      "title": "合并后的痛点标题",
      "frequency": 24,
      "quotes": ["最具代表性的用户原声1", "最具代表性的用户原声2"]
    }
  ],
  "feature_requests": [
    {
      "title": "合并后的功能需求标题",
      "frequency": 16,
      "quotes": ["最具代表性的用户原声"]
    }
  ],
  "sentiment_summary": "对用户整体情绪的连贯总结，例如：用户对核心功能总体满意，但对性能问题和缺少个性化设置感到不满。",
  "opportunities": [
    {
      "title": "产品机会点标题",
      "description": "基于竞品弱点的具体行动建议，说明我们如何利用此机会打造优势。"
    }
  ]
}
仅返回合法的 JSON，不要包含 markdown 代码块标记如 \`\`\`json。`;

      const userConsolidatePrompt = `Here are the batch results from ${batchResults.length} batches:\n\n${JSON.stringify(
        batchResults,
        null,
        2
      )}`;

      const consolidateProvider = await getLLMProvider(db, env, true);

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
