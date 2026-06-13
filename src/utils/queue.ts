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

      const systemPrompt = `You are a brilliant market researcher and product manager.
Your task is to analyze a batch of user reviews for the competitor app "${competitor.name}" and extract structured insights.
Output the results in JSON format matching this schema:
{
  "pain_points": [
    {
      "title": "A concise title of the pain point",
      "frequency": 12,
      "quotes": ["Representative user quote 1", "Representative user quote 2"]
    }
  ],
  "feature_requests": [
    {
      "title": "A concise title of the requested feature or improvement",
      "frequency": 8,
      "quotes": ["Representative user quote"]
    }
  ],
  "sentiment_summary": "A brief summary of user emotions (frustrated, angry, loving the UI but hating bugs, etc.)",
  "opportunities": [
    {
      "title": "Opportunity title",
      "description": "How we can leverage this pain point or feature request to make our own app superior."
    }
  ]
}
Return ONLY valid JSON. Do not include markdown code block backticks like \`\`\`json.`;

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
      const systemConsolidatePrompt = `You are a brilliant market researcher and product manager.
You have analyzed multiple batches of user reviews for the competitor app "${competitor.name}".
Now, combine these batch analysis results into a single, unified, high-quality final report.
Combine similar pain points and feature requests, sum up or estimate their overall frequencies, select the best representative quotes, and generate cohesive overall sentiment and product opportunity summaries.
Output the final consolidated report in JSON format matching this schema:
{
  "pain_points": [
    {
      "title": "Consolidated pain point title",
      "frequency": 24,
      "quotes": ["Quote 1", "Quote 2"]
    }
  ],
  "feature_requests": [
    {
      "title": "Consolidated feature request title",
      "frequency": 16,
      "quotes": ["Quote"]
    }
  ],
  "sentiment_summary": "A cohesive final summary of user emotions.",
  "opportunities": [
    {
      "title": "Cohesive opportunity title",
      "description": "Consolidated action item for our app."
    }
  ]
}
Return ONLY valid JSON. Do not include markdown code block backticks like \`\`\`json.`;

      const userConsolidatePrompt = `Here are the batch results from ${batchResults.length} batches:\n\n${JSON.stringify(
        batchResults,
        null,
        2
      )}`;

      let reduceResponseStr = await provider.chat(
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
