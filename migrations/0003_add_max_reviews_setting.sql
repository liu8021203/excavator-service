-- 新增智能采样配置：单竞品最大采样评论数
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('max_reviews_per_competitor', '8000');
