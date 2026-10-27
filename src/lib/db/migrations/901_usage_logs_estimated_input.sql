-- 042_usage_logs_estimated_input — pre-flight prompt size estimate (context-limit gate).
-- Filled for every Messages request from the character-based estimator, so a request
-- that never reached upstream (405 context_length_exceeded, pool errors) still shows
-- how large its context was. Real size stays input + cache_read + cache_creation.
-- Historical rows stay NULL.

ALTER TABLE usage_logs ADD COLUMN estimated_input_tokens INTEGER;
