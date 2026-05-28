-- Migration number: 0002 	 2026-05-29T00:00:00.000Z

-- ============================================================
-- 1. 用户表：极简核心登录账户数据
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,               -- UUID
    username    TEXT NOT NULL UNIQUE,            -- 唯一登录用户名
    password    TEXT NOT NULL,                   -- SHA-256 密码哈希值
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 2. 改造项目表：加入多用户归属隔离 (向后兼容)
-- ============================================================
ALTER TABLE projects ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
