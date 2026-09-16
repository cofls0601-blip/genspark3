/**
 * 가격 조회 계층 — Yahoo Finance 단일 소스.
 *
 * 원본 앱은 한국 ETF 를 KRX Open API / 공공데이터포털(둘 다 시크릿 키 필요)에서,
 * 미국 종목을 Yahoo 에서 가져왔다. 이 버전은 Yahoo 하나로 통일한다:
 *   - 한국 상장 ETF/주식 → `<ticker>.KS` (예: 360750.KS)
 *   - 미국 상장 종목     → 티커 그대로 (QQQ, VOO …)
 *   - 환율               → `KRW=X`
 * Yahoo chart 응답의 adjclose(배당재투자 수정주가)를 함께 캐시한다.
 *
 * D1(price_cache / fx_cache)에 일자별로 캐시하고, 캐시에 있으면 재사용한다.
 */
import type { Bindings } from './store'

const YAHOO_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
}
const YAHOO_TIMEOUT_MS = 12_000

export type PriceRow = { ticker: string; date: string; close: number; adjclose?: number }

/** 한국 6자리 코드 정규화 — 앞자리 0 이 사라지는 사고를 막는다 (069500 → 069500) */
export function kr6(x: any): string {
  const d = String(x ?? '').replace(/\D/g, '')
  return d ? d.padStart(6, '0') : String(x ?? '')
}

/** Yahoo 심볼 변환: 시장별 접미사 규칙 */
export function toYahooSymbol(market: string, ticker: string): string {
  const t = String(ticker || '').trim()
  if (!t) return ''
  if (/[-=.]/.test(t)) return t // ^KS200, KRW=X 등 원본 형식 유지
  if (market === 'US') return t.toUpperCase()
  return `${kr6(t)}.KS`
}

/** DB 캐시 정규화 키 (시장별로 티커 표기를 통일) */
export function cacheKey(market: string, ticker: string): { market: string; ticker: string } {
  const m = market === 'US' ? 'US' : 'KR'
  const t = String(ticker || '').trim()
  return { market: m, ticker: m === 'KR' ? kr6(t) : t.toUpperCase() }
}

async function fetchJson(url: string): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), YAHOO_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: YAHOO_HEADERS, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Yahoo chart API — query1 장애 시 query2 로 자동 재시도 */
export async function fetchYahooRange(
  symbol: string,
  period1: number,
  period2: number,
  interval = '1d',
): Promise<PriceRow[]> {
  const params = new URLSearchParams({
    period1: String(Math.floor(period1)),
    period2: String(Math.floor(period2)),
    interval,
    events: 'history',
    includeAdjustedClose: 'true',
  })
  let lastErr: any = null
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const json = await fetchJson(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`)
      const chart = json?.chart || {}
      const result = chart?.result
      if (!result || !result.length) {
        const desc = chart?.error?.description || 'Yahoo 응답 없음'
        throw new Error(`${symbol}: ${desc}`)
      }
      const r = result[0]
      const ts: number[] = r.timestamp || []
      const quote = (r.indicators?.quote || [{}])[0] || {}
      const closes: any[] = quote.close || []
      const adjArr: any[] = (r.indicators?.adjclose || [{}])[0]?.adjclose || []
      const rows: PriceRow[] = []
      for (let i = 0; i < ts.length; i++) {
        const close = Number(closes[i])
        if (!Number.isFinite(close) || close <= 0) continue
        let adj: number | undefined
        const av = Number(adjArr[i])
        if (Number.isFinite(av) && av > 0) adj = av
        rows.push({ ticker: symbol, date: ymd(ts[i] * 1000), close, adjclose: adj })
      }
      if (!rows.length) throw new Error(`${symbol}: 유효한 종가가 없습니다.`)
      // 날짜 오름차순 + 중복 제거
      const map = new Map<string, PriceRow>()
      for (const row of rows) map.set(row.date, row)
      return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error(`${symbol}: Yahoo 조회 실패`)
}

export function ymd(ms: number): string {
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
}

export function isoToYmd(iso: string): string {
  return String(iso || '').replace(/-/g, '').slice(0, 8)
}

export function ymdToIso(y: string): string {
  const s = String(y || '')
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s
}

/* ---------------------------------------------------------------------------
 * D1 캐시
 * ------------------------------------------------------------------------- */
export async function cacheGet(
  env: Bindings,
  market: string,
  ticker: string,
  fromYmd?: string,
  toYmd?: string,
): Promise<PriceRow[]> {
  const { market: m, ticker: t } = cacheKey(market, ticker)
  let sql = `SELECT date, close, adjclose FROM price_cache WHERE market=? AND ticker=?`
  const binds: any[] = [m, t]
  if (fromYmd) {
    sql += ` AND date >= ?`
    binds.push(fromYmd)
  }
  if (toYmd) {
    sql += ` AND date <= ?`
    binds.push(toYmd)
  }
  sql += ` ORDER BY date`
  try {
    const res = await env.DB.prepare(sql).bind(...binds).all<{ date: string; close: number; adjclose: number | null }>()
    return (res.results || [])
      .map((r) => ({
        ticker: t,
        date: String(r.date),
        close: Number(r.close),
        adjclose: r.adjclose != null && Number(r.adjclose) > 0 ? Number(r.adjclose) : undefined,
      }))
      .filter((r) => r.close > 0)
  } catch {
    return []
  }
}

export async function cachePut(
  env: Bindings,
  market: string,
  ticker: string,
  rows: PriceRow[],
  source = '',
): Promise<number> {
  const { market: m, ticker: t } = cacheKey(market, ticker)
  const clean: any[] = []
  for (const r of rows || []) {
    const d = String(r.date || '').replace(/-/g, '')
    const close = Number(r.close)
    if (d.length !== 8 || !Number.isFinite(close) || close <= 0) continue
    const adj = Number(r.adjclose)
    clean.push([m, t, d, close, Number.isFinite(adj) && adj > 0 ? adj : null, source])
  }
  if (!clean.length) return 0
  // D1 은 한 번에 다수의 바인딩을 지원하지 않으므로 배치로 나눠 실행
  const chunkSize = 40
  for (let i = 0; i < clean.length; i += chunkSize) {
    const chunk = clean.slice(i, i + chunkSize)
    const stmts = chunk.map((row) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO price_cache(market,ticker,date,close,adjclose,source) VALUES(?,?,?,?,?,?)`,
      ).bind(...row),
    )
    try {
      await env.DB.batch(stmts)
    } catch {
      /* 개별 실패는 무시 (캐시는 best-effort) */
    }
  }
  return clean.length
}

export async function cacheLatestInfo(
  env: Bindings,
  market: string,
  ticker: string,
): Promise<{ date: string | null; source: string | null }> {
  const { market: m, ticker: t } = cacheKey(market, ticker)
  try {
    const row = await env.DB.prepare(
      `SELECT date, source FROM price_cache WHERE market=? AND ticker=? ORDER BY date DESC LIMIT 1`,
    )
      .bind(m, t)
      .first<{ date: string; source: string }>()
    if (!row) return { date: null, source: null }
    return { date: ymdToIso(String(row.date)), source: row.source || '' }
  } catch {
    return { date: null, source: null }
  }
}

/* ---------------------------------------------------------------------------
 * 고수준 조회 — 일봉 / 월말 / 지정일 / 환율
 * ------------------------------------------------------------------------- */
const DAY_MS = 86_400_000

/** 지정일 하루치 종가. 휴장일 대체 여부는 호출부가 결정한다. */
export async function fetchDay(
  env: Bindings,
  market: string,
  ticker: string,
  isoDay: string,
  force = false,
): Promise<PriceRow | null> {
  const target = isoToYmd(isoDay)
  if (!force) {
    const cached = await cacheGet(env, market, ticker, target, target)
    if (cached.length) return cached[cached.length - 1]
  }
  const center = new Date(`${isoDay}T00:00:00Z`).getTime()
  const rows = await fetchYahooRange(
    toYahooSymbol(market, ticker),
    (center - 7 * DAY_MS) / 1000,
    (center + 2 * DAY_MS) / 1000,
  )
  await cachePut(env, market, ticker, rows, 'Yahoo')
  const hit = rows.filter((r) => r.date === target)
  return hit.length ? hit[hit.length - 1] : null
}

/** 최근 N일 일봉 (신호 계산·낙폭 트리거용) */
export async function fetchDailyHistory(
  env: Bindings,
  market: string,
  ticker: string,
  isoDay: string,
  days = 430,
  force = false,
): Promise<PriceRow[]> {
  const end = new Date(`${isoDay}T00:00:00Z`).getTime()
  const start = end - days * DAY_MS
  const a = ymd(start)
  const b = ymd(end)
  let cached = await cacheGet(env, market, ticker, a, b)
  const enough = cached.length >= Math.min(20, Math.max(1, Math.floor(days * 0.4)))
  if (force || !enough) {
    try {
      const rows = await fetchYahooRange(toYahooSymbol(market, ticker), start / 1000, (end + 2 * DAY_MS) / 1000)
      await cachePut(env, market, ticker, rows, 'Yahoo')
      cached = await cacheGet(env, market, ticker, a, b)
    } catch (e) {
      if (!cached.length) throw e
    }
  }
  return cached
}

/** 월말 종가 시퀀스 (최근 13개월) — SMA/모멘텀 계산용 */
export async function fetchMonthly(
  env: Bindings,
  market: string,
  ticker: string,
  isoDay: string,
  force = false,
  months = 13,
): Promise<PriceRow[]> {
  const daily = await fetchDailyHistory(env, market, ticker, isoDay, 18 * 31, force)
  const byMonth = new Map<string, PriceRow>()
  const end = isoToYmd(isoDay)
  for (const r of daily) {
    if (r.date > end) continue
    byMonth.set(r.date.slice(0, 6), r) // 날짜 오름차순이므로 마지막 값이 그 달의 월말
  }
  return [...byMonth.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-months)
}

/** USD/KRW 환율 (지정일 또는 직전 거래일) */
export async function getUsdKrw(env: Bindings, isoDay: string, force = false): Promise<number | null> {
  const target = isoToYmd(isoDay)
  if (!force) {
    try {
      const row = await env.DB.prepare(`SELECT date, rate FROM fx_cache WHERE date<=? ORDER BY date DESC LIMIT 1`)
        .bind(target)
        .first<{ date: string; rate: number }>()
      if (row && Number(row.rate) > 0) return Number(row.rate)
    } catch {
      /* ignore */
    }
  }
  const center = new Date(`${isoDay}T00:00:00Z`).getTime()
  try {
    const rows = await fetchYahooRange('KRW=X', (center - 10 * DAY_MS) / 1000, (center + 2 * DAY_MS) / 1000)
    if (!rows.length) return null
    const upto = rows.filter((r) => r.date <= target)
    const chosen = upto.length ? upto[upto.length - 1] : rows[rows.length - 1]
    await env.DB.prepare(`INSERT OR REPLACE INTO fx_cache(date,rate,source) VALUES(?,?,?)`)
      .bind(chosen.date, chosen.close, 'Yahoo KRW=X')
      .run()
    return chosen.close
  } catch {
    return null
  }
}

/** 신호 계산에 쓸 가격 컬럼 선택 (미국 종목 + 배당재투자 모드 → adjclose) */
export function priceValues(rows: PriceRow[], market: string, useAdj: boolean): number[] {
  const pick = rows.map((r) => (useAdj && market === 'US' && r.adjclose ? r.adjclose : r.close))
  return pick.filter((x) => Number.isFinite(x) && x > 0)
}

/** 이상 변동 감지 — 최근 월간 변동률 ±30% 초과 시 경고용 */
export function detectAnomaly(prices: number[]): { flagged: boolean; change: number | null } {
  const vals = (prices || []).map(Number).filter((x) => x > 0)
  if (vals.length < 2) return { flagged: false, change: null }
  const prev = vals[vals.length - 2]
  if (prev <= 0) return { flagged: false, change: null }
  const chg = vals[vals.length - 1] / prev - 1
  return { flagged: Math.abs(chg) >= 0.3, change: chg }
}

/** 미국 종목 검색 (Yahoo search API) */
export async function searchUsSymbols(query: string): Promise<{ ticker: string; name: string; exchange: string }[]> {
  if (!query) return []
  try {
    const params = new URLSearchParams({ q: query, quotesCount: '15', newsCount: '0' })
    const json = await fetchJson(`https://query2.finance.yahoo.com/v1/finance/search?${params}`)
    const quotes: any[] = json?.quotes || []
    return quotes
      .filter((q) => q?.symbol && (!q.quoteType || ['EQUITY', 'ETF'].includes(q.quoteType)))
      .map((q) => ({
        ticker: String(q.symbol),
        name: String(q.shortname || q.longname || q.symbol),
        exchange: String(q.exchange || ''),
      }))
  } catch {
    return []
  }
}
