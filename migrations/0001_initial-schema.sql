-- Migration number: 0001 	 2026-05-28T00:00:00.000Z

-- ============================================================
-- 1. 项目表：存储用户创建的需求挖掘项目
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,               -- UUID
    name        TEXT NOT NULL,                   -- 项目名称（LLM 自动生成或用户输入）
    description TEXT NOT NULL,                   -- 用户输入的大方向描述
    market_analysis TEXT,                        -- LLM 市场分析原文（JSON）
    llm_provider TEXT NOT NULL DEFAULT 'deepseek', -- 当前使用的 LLM：'deepseek' | 'gemini'
    status      TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'analyzed' | 'active'
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 2. 竞品表：LLM 推荐的竞品 APP，用户补全包名
-- ============================================================
CREATE TABLE IF NOT EXISTS competitors (
    id              TEXT PRIMARY KEY,            -- UUID
    project_id      TEXT NOT NULL,               -- 所属项目
    name            TEXT NOT NULL,               -- 竞品名称（LLM 给出）
    description     TEXT,                        -- 竞品简介（LLM 给出）
    package_name    TEXT,                        -- Google Play 包名（用户手动填入）
    icon_url        TEXT,                        -- APP 图标 URL
    rating          REAL,                        -- Google Play 评分
    estimated_reviews INTEGER,                   -- Google Play 显示的评论总数（预估值，用于进度展示）
    review_count    INTEGER NOT NULL DEFAULT 0,  -- 已爬取评论数
    scrape_status   TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'scraping' | 'completed' | 'failed'
    last_scraped_at TEXT,                        -- 最后一次爬取时间
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_competitors_project ON competitors(project_id);
CREATE INDEX IF NOT EXISTS idx_competitors_status ON competitors(project_id, scrape_status);

-- ============================================================
-- 3. 评论表：Google Play 用户评论（本地爬虫回传）
-- ============================================================
CREATE TABLE IF NOT EXISTS reviews (
    id              TEXT PRIMARY KEY,            -- UUID
    competitor_id   TEXT NOT NULL,               -- 所属竞品
    review_id       TEXT NOT NULL,               -- Google Play 原始评论 ID
    user_name       TEXT,                        -- 评论者用户名
    rating          INTEGER NOT NULL,            -- 评分 1-5
    text            TEXT,                        -- 评论正文
    thumbs_up       INTEGER NOT NULL DEFAULT 0,  -- 点赞数
    reply_text      TEXT,                        -- 开发者回复
    review_date     TEXT,                        -- 评论日期
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE,
    UNIQUE(competitor_id, review_id)             -- 去重：同一竞品下评论 ID 唯一
);

CREATE INDEX IF NOT EXISTS idx_reviews_competitor ON reviews(competitor_id);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(competitor_id, rating);

-- ============================================================
-- 4. 分析任务表：每次 LLM 分析的最终汇总结果
-- ============================================================
CREATE TABLE IF NOT EXISTS analyses (
    id                TEXT PRIMARY KEY,           -- UUID
    competitor_id     TEXT NOT NULL,              -- 分析的竞品
    rating_filter     TEXT NOT NULL,              -- 'negative'(rating<=3) | 'positive'(rating>=4)
    total_reviews     INTEGER NOT NULL DEFAULT 0, -- 本次分析涉及的评论总数
    batch_size        INTEGER NOT NULL DEFAULT 500, -- 每批大小
    status            TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'processing' | 'completed' | 'failed'
    -- 分析产出（JSON 格式）
    pain_points       TEXT,                       -- [{title, frequency, quotes[]}]
    feature_requests  TEXT,                       -- [{title, frequency, quotes[]}]
    sentiment_summary TEXT,                       -- 情感倾向总结文本
    opportunities     TEXT,                       -- [{title, description}]
    -- 元信息
    llm_provider      TEXT,                       -- 使用的 LLM 提供商
    llm_model         TEXT,                       -- 使用的模型名称
    error_message     TEXT,                       -- 失败原因（如果 status='failed'）
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_analyses_competitor ON analyses(competitor_id);
CREATE INDEX IF NOT EXISTS idx_analyses_filter ON analyses(competitor_id, rating_filter);

-- ============================================================
-- 5. 分析批次表：每批独立调用 LLM 的中间结果
-- ============================================================
CREATE TABLE IF NOT EXISTS analysis_batches (
    id              TEXT PRIMARY KEY,             -- UUID
    analysis_id     TEXT NOT NULL,                -- 所属分析任务
    batch_index     INTEGER NOT NULL,             -- 批次序号（从 0 开始）
    review_count    INTEGER NOT NULL DEFAULT 0,   -- 本批评论数
    result          TEXT,                         -- LLM 返回的原始分析结果（JSON）
    status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'processing' | 'completed' | 'failed'
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_batches_analysis ON analysis_batches(analysis_id);

-- ============================================================
-- 6. 跨竞品汇总分析表：项目级交叉对比结果（第 2 层分析）
-- ============================================================
CREATE TABLE IF NOT EXISTS project_analyses (
    id                    TEXT PRIMARY KEY,            -- UUID
    project_id            TEXT NOT NULL,               -- 所属项目
    status                TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'processing' | 'completed' | 'failed'
    competitors_count     INTEGER NOT NULL DEFAULT 0,  -- 参与汇总的竞品数
    -- 汇总产出（JSON 格式）
    common_pain_points    TEXT,                        -- 行业共性痛点 [{title, frequency, competitors[], severity}]
    differentiation       TEXT,                        -- 差异化机会 [{feature, only_in_competitor, missing_in[]}]
    feature_matrix        TEXT,                        -- 功能矩阵 [{feature, competitors: {name: has_it}}]
    priority_suggestions  TEXT,                        -- 产品优先级建议 [{title, reason, priority}]
    -- 元信息
    llm_provider          TEXT,
    llm_model             TEXT,
    error_message         TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_analyses_project ON project_analyses(project_id);

-- ============================================================
-- 7. 系统设置表：全局配置（LLM 选择、批量大小等）
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,                 -- 配置键名
    value       TEXT NOT NULL,                    -- 配置值（JSON 或纯文本）
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初始化默认设置
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('llm_provider', 'deepseek'),
    ('llm_model_deepseek', 'deepseek-chat'),
    ('llm_model_gemini', 'google/gemini-3.1-pro'),
    ('batch_size', '500');
