-- Migration 0008: add github_repo_url to projects
-- Nullable text column — existing rows default to NULL (no repo linked).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo_url text;
