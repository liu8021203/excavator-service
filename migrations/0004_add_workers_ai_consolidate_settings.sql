-- 新增汇总阶段大模型配置及默认值
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('llm_provider_consolidate', 'same'),
    ('llm_model_consolidate_gemini', 'google/gemini-3.1-pro'),
    ('llm_model_consolidate_deepseek', 'deepseek-chat');
