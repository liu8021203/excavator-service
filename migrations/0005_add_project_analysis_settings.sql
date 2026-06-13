-- 新增跨竞品对比需求分析阶段大模型配置及默认值
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('llm_provider_project', 'same'),
    ('llm_model_project_gemini', 'google/gemini-3.1-pro'),
    ('llm_model_project_deepseek', 'deepseek-chat');
