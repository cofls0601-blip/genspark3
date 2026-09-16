-- 자산배분 리밸런싱 앱 최초 스키마
-- 로컬: npx wrangler d1 migrations apply asset-rebalance-app-production --local
-- 운영: npx wrangler d1 migrations apply asset-rebalance-app-production

-- 범용 키-값 상태 저장소 (assets, history, equity, cashflows, benchmarks,
-- strategies, category_targets, executions, custom_benchmarks, price_policy, price_mode)
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 종목별 일자 가격 캐시. 신호(SMA/모멘텀/트리거) 계산의 원천 데이터.
CREATE TABLE IF NOT EXISTS price_cache (
  market   TEXT,
  ticker   TEXT,
  date     TEXT,
  close    REAL,
  adjclose REAL,
  source   TEXT,
  PRIMARY KEY (market, ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_price_cache_lookup ON price_cache (market, ticker, date);

-- USD/KRW 환율 캐시
CREATE TABLE IF NOT EXISTS fx_cache (
  date   TEXT PRIMARY KEY,
  rate   REAL,
  source TEXT
);

-- 손상된 원문 보존(디버깅용) 및 스키마 버전 관리
CREATE TABLE IF NOT EXISTS kv_quarantine (
  k          TEXT,
  raw        TEXT,
  reason     TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cache_meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
