CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS price_cache (
  market TEXT,
  ticker TEXT,
  date TEXT,
  close REAL,
  adjclose REAL,
  source TEXT,
  PRIMARY KEY (market, ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_price_cache_lookup ON price_cache (market, ticker, date);
CREATE TABLE IF NOT EXISTS fx_cache (date TEXT PRIMARY KEY, rate REAL, source TEXT);
CREATE TABLE IF NOT EXISTS kv_quarantine (
  k TEXT,
  raw TEXT,
  reason TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cache_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS auto_backup (
  date TEXT PRIMARY KEY,
  created_at TEXT,
  data TEXT
);
