ALTER TABLE proxies ADD COLUMN geo_base_country_code TEXT;
ALTER TABLE proxies ADD COLUMN geo_base_region TEXT;
ALTER TABLE proxies ADD COLUMN geo_base_at TEXT;
ALTER TABLE proxies ADD COLUMN geo_guard_status TEXT;
ALTER TABLE proxies ADD COLUMN geo_guard_checked_at TEXT;
ALTER TABLE proxies ADD COLUMN geo_guard_reason TEXT;

CREATE TABLE proxy_geo_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proxy_id TEXT,
  proxy_label TEXT,
  checked_at TEXT,
  ok INTEGER,
  ip TEXT,
  country_code TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  isp TEXT,
  timezone TEXT,
  latency_ms INTEGER,
  result TEXT,
  base_country_code TEXT,
  base_region TEXT,
  action TEXT,
  error TEXT
);
CREATE INDEX idx_proxy_geo_checks_proxy_time ON proxy_geo_checks(proxy_id, checked_at);
CREATE INDEX idx_proxy_geo_checks_time ON proxy_geo_checks(checked_at);
