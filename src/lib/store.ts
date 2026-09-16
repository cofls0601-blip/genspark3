/**
 * D1 기반 상태 저장 계층.
 * 원본의 SQLite kv 테이블 + get_state/put_state 패턴을 D1 비동기 API 로 옮긴 것.
 */
import {
  CATEGORY_OPTIONS,
  DEFAULT_STRATEGIES,
  specsToConfigs,
  type Spec,
  type StrategyConfig,
  type Asset,
} from './specs'

export type Bindings = {
  DB: D1Database
}

/** 가격 이력을 제외한 보유자산 행 (백업 저장용) */
export type AssetRow = {
  id: string
  strategy: string
  ticker: string
  name: string
  market: 'KR' | 'US'
  role: string
  target_pct: number
  shares: number
  close: number
  prices: number[]
  adjclose?: number
  signal_ticker: string
  category: string
  last_fetch_date?: string
  price_source?: string
}

export const ALL_KV_KEYS = [
  'assets',
  'history',
  'equity',
  'cashflows',
  'benchmarks',
  'strategies',
  'category_targets',
  'executions',
  'custom_benchmarks',
  'price_policy',
  'price_mode',
] as const

export type KvKey = (typeof ALL_KV_KEYS)[number]

export type HistoryRecord = {
  date: string
  total: number
  by_strategy: Record<string, number>
  by_category: Record<string, number>
  composition: any[]
  plan: string | null
  saved_at?: string
}

export type EquityRecord = { date: string; value: number }
export type Cashflow = { date: string; amount: number; memo: string; strategy: string }
export type BenchmarkRec = { name: string; date: string; value: number; adjclose?: number }
export type ExecutionRec = {
  date: string
  strategy: string
  ticker: string
  ETF: string
  planned: number
  done: boolean
  actual: number
  planned_shares?: number
  actual_shares?: number
}

export const PRICE_CACHE_SCHEMA_VERSION = '6'
export const BACKUP_SCHEMA_VERSION = 3
export const PRICE_FIELDS_EXCLUDED_FROM_BACKUP = ['close', 'prices', 'last_fetch_date', 'price_source']

/* ---------------------------------------------------------------------------
 * 스키마 초기화 — 최초 호출 시 테이블 생성 및 기본 상태 시드
 * ------------------------------------------------------------------------- */
export async function initDb(env: Bindings): Promise<void> {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cache_meta (k TEXT PRIMARY KEY, v TEXT)`,
    `CREATE TABLE IF NOT EXISTS price_cache (market TEXT, ticker TEXT, date TEXT, close REAL, adjclose REAL, source TEXT, PRIMARY KEY(market, ticker, date))`,
    `CREATE INDEX IF NOT EXISTS idx_price_cache_lookup ON price_cache (market, ticker, date)`,
    `CREATE TABLE IF NOT EXISTS fx_cache (date TEXT PRIMARY KEY, rate REAL, source TEXT)`,
    `CREATE TABLE IF NOT EXISTS kv_quarantine (k TEXT, raw TEXT, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  ]
  for (const sql of stmts) {
    try {
      await env.DB.prepare(sql).run()
    } catch {
      /* 이미 존재하면 무시 */
    }
  }

  // 스키마 버전 확인 — 다르면 가격 캐시를 비운다 (원본과 동일한 방어 로직)
  try {
    const row = await env.DB.prepare(`SELECT v FROM cache_meta WHERE k='schema_version'`).first<{ v: string }>()
    if (!row || row.v !== PRICE_CACHE_SCHEMA_VERSION) {
      await env.DB.prepare(`DELETE FROM price_cache`).run()
      await env.DB.prepare(`DELETE FROM fx_cache`).run()
      await env.DB.prepare(`INSERT OR REPLACE INTO cache_meta(k,v) VALUES('schema_version', ?)`)
        .bind(PRICE_CACHE_SCHEMA_VERSION)
        .run()
    }
  } catch {
    /* ignore */
  }

  // 기본 상태 시드
  const defaults = defaultState()
  for (const [k, v] of Object.entries(defaults)) {
    try {
      await env.DB.prepare(`INSERT OR IGNORE INTO kv(k,v) VALUES(?,?)`)
        .bind(k, JSON.stringify(v))
        .run()
    } catch {
      /* ignore */
    }
  }
}

export function specSeed(): Record<string, Spec> {
  const out: Record<string, Spec> = {}
  for (const s of DEFAULT_STRATEGIES) out[s.code] = s
  return out
}

export function defaultAssets(specs: Record<string, Spec>): AssetRow[] {
  const rows: AssetRow[] = []
  let i = 0
  const ordered = Object.values(specs).sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99))
  for (const spec of ordered) {
    for (const a of spec.assets || []) {
      const ticker = a.ticker || ''
      rows.push({
        id: String(i++),
        strategy: spec.code,
        ticker,
        name: a.name || '',
        market: (a.market === 'US' ? 'US' : 'KR') as 'KR' | 'US',
        role: a.role || '',
        target_pct: Number(a.target_pct) || 0,
        shares: 0,
        close: ticker === 'CASH' ? 1 : 0,
        prices: [],
        signal_ticker: a.signal_ticker || ticker,
        category: CATEGORY_OPTIONS.includes(a.category) ? a.category : '기타',
      })
    }
  }
  return rows
}

export function defaultState(): Record<string, any> {
  const specs = specSeed()
  return {
    assets: defaultAssets(specs),
    history: [],
    equity: [],
    cashflows: [],
    benchmarks: [],
    strategies: specsToConfigs(specs),
    category_targets: Object.fromEntries(CATEGORY_OPTIONS.map((c) => [c, 0])),
    executions: [],
    custom_benchmarks: {},
    price_policy: 'strict',
    price_mode: 'close',
    specs: specsToSpecJson(),
  }
}

/** 스펙은 별도 키(kv: 'specs')에 JSON 문자열로 저장한다. */
export function specsToSpecJson(): string {
  return JSON.stringify({ strategies: DEFAULT_STRATEGIES }, null, 2)
}

export const SPEC_KEY = 'specs'

/* ---------------------------------------------------------------------------
 * kv 읽기/쓰기
 * ------------------------------------------------------------------------- */
const DEFAULT_MAP: Record<string, any> = {
  history: [],
  equity: [],
  cashflows: [],
  benchmarks: [],
  executions: [],
  custom_benchmarks: {},
  category_targets: Object.fromEntries(CATEGORY_OPTIONS.map((c) => [c, 0])),
  price_policy: 'strict',
  price_mode: 'close',
}

function fallbackFor(k: string, specs: Record<string, Spec>): any {
  if (k === 'assets') return defaultAssets(specs)
  if (k === 'strategies') return specsToConfigs(specs)
  return DEFAULT_MAP[k] ?? null
}

/** kv 값을 읽는다. 없으면 기본값을 시드해 반환. 손상된 JSON 은 quarantine 에 보존. */
export async function getState<T = any>(env: Bindings, k: string, specs: Record<string, Spec>): Promise<T> {
  await initDb(env)
  const row = await env.DB.prepare(`SELECT v FROM kv WHERE k=?`).bind(k).first<{ v: string }>()
  if (!row) {
    const value = fallbackFor(k, specs)
    await env.DB.prepare(`INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)`)
      .bind(k, JSON.stringify(value))
      .run()
    return value as T
  }
  try {
    return JSON.parse(row.v) as T
  } catch (e: any) {
    try {
      await env.DB.prepare(`INSERT INTO kv_quarantine(k,raw,reason) VALUES(?,?,?)`)
        .bind(k, String(row.v), `JSON decode error: ${e?.message || e}`)
        .run()
    } catch {
      /* ignore */
    }
    const value = fallbackFor(k, specs)
    await env.DB.prepare(`INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)`)
      .bind(k, JSON.stringify(value))
      .run()
    return value as T
  }
}

export async function putState(env: Bindings, k: string, v: any): Promise<void> {
  await initDb(env)
  await env.DB.prepare(`INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)`)
    .bind(k, JSON.stringify(v))
    .run()
}

export async function loadSpecs(env: Bindings): Promise<Record<string, Spec>> {
  await initDb(env)
  const row = await env.DB.prepare(`SELECT v FROM kv WHERE k=?`).bind(SPEC_KEY).first<{ v: string }>()
  if (!row) {
    const seed = specSeed()
    await env.DB.prepare(`INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)`).bind(SPEC_KEY, specsToSpecJson()).run()
    return seed
  }
  try {
    const data = JSON.parse(row.v)
    const out: Record<string, Spec> = {}
    for (const s of data.strategies || []) out[s.code] = s
    return out
  } catch {
    return specSeed()
  }
}

export async function saveSpecs(env: Bindings, specs: Record<string, Spec>): Promise<void> {
  const ordered = Object.values(specs).sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99))
  await putStateRaw(env, SPEC_KEY, JSON.stringify({ strategies: ordered }))
}

async function putStateRaw(env: Bindings, k: string, raw: string): Promise<void> {
  await initDb(env)
  await env.DB.prepare(`INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)`).bind(k, raw).run()
}

/* ---------------------------------------------------------------------------
 * 전략 설정 정규화 (구버전 데이터 호환)
 * ------------------------------------------------------------------------- */
export function normalizeConfigs(cfgs: StrategyConfig[] | null, specs: Record<string, Spec>): StrategyConfig[] {
  const base = cfgs && cfgs.length ? cfgs : specsToConfigs(specs)
  return base.map((c) => ({
    code: c.code,
    account: c.account || c.code,
    description: c.description || '',
    dynamic: !!c.dynamic,
    active: c.active !== false,
    annual_limit: Number(c.annual_limit) || 0,
  }))
}

/* ---------------------------------------------------------------------------
 * 보유자산 정규화
 * ------------------------------------------------------------------------- */
export function cleanAssets(rows: any[]): AssetRow[] {
  const out: AssetRow[] = []
  for (const r of rows || []) {
    if (!r) continue
    const market = r.market === 'US' ? 'US' : 'KR'
    const ticker = String(r.ticker ?? '')
    out.push({
      id: String(r.id ?? out.length),
      strategy: String(r.strategy ?? ''),
      ticker,
      name: String(r.name ?? ''),
      market,
      role: String(r.role ?? ''),
      target_pct: Number(r.target_pct) || 0,
      shares: Number(r.shares) || 0,
      close: Number(r.close) || 0,
      prices: Array.isArray(r.prices) ? r.prices.map((x: any) => Number(x)).filter((x: number) => Number.isFinite(x)) : [],
      adjclose: r.adjclose != null ? Number(r.adjclose) : undefined,
      signal_ticker: String(r.signal_ticker || ticker),
      category: CATEGORY_OPTIONS.includes(r.category) ? r.category : '기타',
      last_fetch_date: String(r.last_fetch_date || ''),
      price_source: String(r.price_source || ''),
    })
  }
  return out
}
