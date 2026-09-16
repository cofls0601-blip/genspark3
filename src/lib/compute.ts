/**
 * 포트폴리오 계산 계층 — 원본 앱의 순수 계산 함수들을 그대로 옮긴 것.
 * (compute_portfolio_snapshot / portfolio_perf / calc_xirr / calc_twr /
 *  mdd_details / sortino_ratio / beta_alpha / build_category_row)
 */
import { CATEGORY_OPTIONS, type SignalRow, type StrategyConfig } from './specs'
import type { AssetRow } from './store'

export const CATEGORY_ROW_ORDER = ['현금', '금', '선진국 주식', '신흥국 주식', '선진국 채권', '신흥국 채권']

export const n = (v: any, d = 0): number => {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return d
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

export const won = (x: any): string => `${Math.round(n(x)).toLocaleString('ko-KR')}원`
export const pct = (x: any): string => `${(n(x) * 100).toFixed(2)}%`
export const num0 = (x: any): string => Math.round(n(x)).toLocaleString('ko-KR')

/** 자산 1건의 현재 평가액 (미국 종목은 환율 적용) */
export function assetValue(a: AssetRow, fxRate?: number | null): number {
  if (a.ticker === 'CASH') return n(a.shares)
  const value = n(a.shares) * n(a.close)
  if (a.market === 'US') {
    const fx = fxRate != null && fxRate > 0 ? fxRate : 0
    return fx ? value * fx : 0
  }
  return value
}

export type SnapshotRow = {
  전략: string
  계좌: string
  티커: string
  ETF: string
  분류: string
  현재금액: number
  현재비중: number
  목표비중: number
  종가: number
  보유수량: number
}

export function computePortfolioSnapshot(
  assets: AssetRow[],
  cfgs: StrategyConfig[],
  fxRate?: number | null,
  activeOnly = true,
): { grand: number; rows: SnapshotRow[]; cfgs: StrategyConfig[] } {
  const use = activeOnly ? cfgs.filter((c) => c.active !== false) : cfgs
  const rows: SnapshotRow[] = []
  let grand = 0
  for (const cfg of use) {
    const sub = assets.filter((a) => a.strategy === cfg.code)
    const total = sub.reduce((s, a) => s + assetValue(a, fxRate), 0)
    grand += total
    for (const r of sub) {
      const val = assetValue(r, fxRate)
      rows.push({
        전략: cfg.code,
        계좌: cfg.account || cfg.code,
        티커: r.ticker,
        ETF: r.name || r.ticker || '-',
        분류: r.category || '기타',
        현재금액: val,
        현재비중: total > 0 ? (val / total) * 100 : 0,
        목표비중: n(r.target_pct),
        종가: n(r.close),
        보유수량: n(r.shares),
      })
    }
  }
  return { grand, rows, cfgs: use }
}

export function computeCategoryBreakdown(
  assets: AssetRow[],
  cfgs: StrategyConfig[],
  fxRate?: number | null,
): { 분류: string; 금액: number; 비중: number }[] {
  const activeCodes = cfgs.filter((c) => c.active !== false).map((c) => c.code)
  const use = assets.filter((a) => activeCodes.includes(a.strategy))
  const map = new Map<string, number>()
  for (const a of use) {
    const k = a.category || '기타'
    map.set(k, (map.get(k) || 0) + assetValue(a, fxRate))
  }
  const out = [...map.entries()].map(([분류, 금액]) => ({ 분류, 금액 }))
  out.sort((a, b) => b.금액 - a.금액)
  const total = out.reduce((s, r) => s + r.금액, 0)
  return out.map((r) => ({ ...r, 비중: total > 0 ? (r.금액 / total) * 100 : 0 }))
}

/* ---------------------------------------------------------------------------
 * 성과 지표
 * ------------------------------------------------------------------------- */
export type EquityPoint = { date: string; value: number }

export function portfolioPerf(
  rows: EquityPoint[],
): [number | null, number | null, number | null, number | null] | null {
  const x = rows
    .map((r) => ({ date: String(r.date), value: n(r.value) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (x.length < 2) return null
  if (n(x[0].value) <= 0) return null
  const ms = (d: string) => new Date(`${d}T00:00:00Z`).getTime()
  const days = Math.max(1, Math.round((ms(x[x.length - 1].date) - ms(x[0].date)) / 86_400_000))
  const years = Math.max(days / 365, 1e-9)
  const cagr = Math.pow(n(x[x.length - 1].value) / n(x[0].value), 1 / years) - 1
  let peak = 0
  let mdd = 0
  for (const r of x) {
    peak = Math.max(peak, n(r.value))
    mdd = Math.min(mdd, peak > 0 ? n(r.value) / peak - 1 : 0)
  }
  const rets: number[] = []
  for (let i = 1; i < x.length; i++) {
    const pa = n(x[i - 1].value)
    const pb = n(x[i].value)
    if (pa > 0) rets.push(pb / pa - 1)
  }
  let vol: number | null = null
  let sharpe: number | null = null
  if (rets.length >= 2) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)
    const sd = Math.sqrt(varr)
    if (sd > 0) {
      vol = sd * Math.sqrt(rets.length / years)
      sharpe = vol ? (mean * (rets.length / years)) / vol : null
    }
  }
  return [cagr, mdd, vol, sharpe]
}

export function mddDetails(rows: EquityPoint[]): { mdd: number | null; ddLen: number | null; recLen: number | null } {
  const x = rows
    .map((r) => ({ date: String(r.date), value: n(r.value) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (x.length < 2) return { mdd: null, ddLen: null, recLen: null }
  const day = (d: string) => new Date(`${d}T00:00:00Z`).getTime()
  let peak = 0
  let peakDate: string | null = null
  let maxDd = 0
  let trough: string | null = null
  for (const r of x) {
    if (r.value > peak) {
      peak = r.value
      peakDate = r.date
    }
    const dd = peak > 0 ? r.value / peak - 1 : 0
    if (dd < maxDd) {
      maxDd = dd
      trough = r.date
    }
  }
  let ddLen: number | null = null
  if (peakDate && trough) ddLen = Math.round((day(trough) - day(peakDate)) / 86_400_000)
  let recLen: number | null = null
  if (trough && peak > 0) {
    const rec = x.find((r) => r.date > trough && r.value >= peak)
    if (rec) recLen = Math.round((day(rec.date) - day(trough)) / 86_400_000)
  }
  return { mdd: maxDd, ddLen, recLen }
}

export function sortinoRatio(rows: EquityPoint[]): number | null {
  const x = rows
    .map((r) => ({ date: String(r.date), value: n(r.value) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (x.length < 3) return null
  const rets: number[] = []
  for (let i = 1; i < x.length; i++) {
    const pa = n(x[i - 1].value)
    if (pa > 0) rets.push(n(x[i].value) / pa - 1)
  }
  if (rets.length < 2) return null
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const downside = rets.filter((r) => r < 0)
  if (!downside.length) return null
  const dv = downside.reduce((a, b) => a + b * b, 0) / downside.length
  const sd = Math.sqrt(dv)
  return sd > 0 ? mean / sd : null
}

/** XIRR — 입출금 시점을 반영한 금액가중 수익률 (이분법) */
export function calcXirr(equity: EquityPoint[], cashflows: { date: string; amount: number }[]): number | null {
  if (!equity?.length || !cashflows?.length) return null
  const last = [...equity].sort((a, b) => a.date.localeCompare(b.date))[equity.length - 1]
  const lastD = last.date
  const flows = cashflows
    .filter((x) => n(x.amount) !== 0 && x.date < lastD)
    .map((x) => ({ date: x.date, amount: -n(x.amount) }))
  flows.push({ date: lastD, amount: n(last.value) })
  flows.sort((a, b) => a.date.localeCompare(b.date))
  if (flows.length < 2) return null
  const day = (d: string) => new Date(`${d}T00:00:00Z`).getTime()
  const d0 = day(flows[0].date)
  const npv = (r: number) =>
    flows.reduce((s, x) => s + x.amount / Math.pow(1 + r, (day(x.date) - d0) / 86_400_000 / 365), 0)
  const solve = (lo: number, hi: number): number | null => {
    let flo = npv(lo)
    let fhi = npv(hi)
    if ((flo > 0) === (fhi > 0) && flo !== 0 && fhi !== 0) return null
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2
      let v: number
      try {
        v = npv(mid)
      } catch {
        break
      }
      if (v > 0) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }
  const a = solve(-0.9999, 10)
  if (a !== null) return a
  return solve(-0.999999, 100)
}

/** TWR — Modified Dietz 방식으로 입출금 효과를 제거한 수익률 */
export function calcTwr(equity: EquityPoint[], cashflows: { date: string; amount: number }[]): number | null {
  const eq = equity
    .map((r) => ({ date: String(r.date), value: n(r.value) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (eq.length < 2) return null
  const cf = (cashflows || [])
    .map((x) => ({ date: String(x.date), amount: n(x.amount) }))
    .sort((a, b) => a.date.localeCompare(b.date))
  const day = (d: string) => new Date(`${d}T00:00:00Z`).getTime()
  const rets: number[] = []
  for (let i = 0; i < eq.length - 1; i++) {
    const d0 = day(eq[i].date)
    const d1 = day(eq[i + 1].date)
    const v0 = n(eq[i].value)
    const v1 = n(eq[i + 1].value)
    if (v0 <= 0) continue
    const flowsIn = cf.filter((f) => day(f.date) > d0 && day(f.date) <= d1)
    const span = Math.max(1, (d1 - d0) / 86_400_000)
    const fv = flowsIn.reduce((s, f) => s + f.amount * Math.max(0, 1 - (d1 - day(f.date)) / 86_400_000 / span), 0)
    const denom = v0 + fv
    if (denom === 0) continue
    rets.push((v1 - v0 - flowsIn.reduce((s, f) => s + f.amount, 0)) / denom)
  }
  if (!rets.length) return null
  return rets.reduce((p, r) => p * (1 + r), 1) - 1
}

/** 베타 / 구간 알파 */
export function betaAlpha(a: EquityPoint[], b: EquityPoint[]): { beta: number | null; alpha: number | null } {
  const mapB = new Map(b.map((r) => [String(r.date), n(r.value)]))
  const pairs: [number, number][] = []
  const dates = [...new Set(a.map((r) => String(r.date)))].sort()
  for (let i = 1; i < dates.length; i++) {
    const ra = a.find((r) => String(r.date) === dates[i - 1])
    const rb = a.find((r) => String(r.date) === dates[i])
    const b0 = mapB.get(dates[i - 1])
    const b1 = mapB.get(dates[i])
    if (!ra || !rb || b0 == null || b1 == null || !n(ra.value) || !n(b0)) continue
    pairs.push([n(rb.value) / n(ra.value) - 1, b1 / b0 - 1])
  }
  if (pairs.length < 3) return { beta: null, alpha: null }
  const ma = pairs.reduce((s, p) => s + p[0], 0) / pairs.length
  const mb = pairs.reduce((s, p) => s + p[1], 0) / pairs.length
  const cov = pairs.reduce((s, p) => s + (p[0] - ma) * (p[1] - mb), 0) / (pairs.length - 1)
  const varb = pairs.reduce((s, p) => s + (p[1] - mb) ** 2, 0) / (pairs.length - 1)
  if (varb <= 0) return { beta: null, alpha: null }
  const beta = cov / varb
  return { beta, alpha: ma - beta * mb }
}

/** 구글 스프레드시트에 붙여넣을 한 줄 (날짜 + 분류별 금액) */
export function buildCategoryRow(dateStr: string, byCategory: Record<string, number>): { row: string; leftover: Record<string, number> } {
  const values = [dateStr, ...CATEGORY_ROW_ORDER.map((c) => String(Math.round(n(byCategory?.[c]))))]
  const leftover: Record<string, number> = {}
  for (const [k, v] of Object.entries(byCategory || {})) {
    if (!CATEGORY_ROW_ORDER.includes(k) && n(v) !== 0) leftover[k] = n(v)
  }
  return { row: values.join('\t'), leftover }
}

/** 스펙 1건을 기준으로 신호 행을 만든다 (SMA10 · 12M · SMA 위 판정) */
export function buildSignalRows(
  assets: AssetRow[],
  cfgs: StrategyConfig[],
  fxRate: number | null,
  specAssets: { role: string; target_pct: number }[],
): SignalRow[] {
  const rows: SignalRow[] = []
  for (const a of assets) {
    if (!cfgs.some((c) => c.code === a.strategy)) continue
    if (a.ticker === 'CASH') {
      rows.push({
        전략: a.strategy,
        티커: 'CASH',
        ETF: '현금',
        role: a.role,
        market: a.market,
        종가: 1,
        SMA10: null,
        'SMA 위': '—',
        '12M': null,
        현재금액: assetValue(a, fxRate),
        '목표%': a.target_pct,
        분류: a.category,
      })
      continue
    }
    if (!a.ticker) continue
    const prices = (a.prices || []).filter((x) => Number.isFinite(x) && x > 0)
    const close = n(a.close) || (prices.length ? prices[prices.length - 1] : 0)
    const sma = prices.length >= 10 ? prices.slice(-10).reduce((s, x) => s + x, 0) / 10 : null
    const mom = prices.length >= 13 && prices[prices.length - 13] ? prices[prices.length - 1] / prices[prices.length - 13] - 1 : null
    const smaFlag = sma === null ? '데이터부족' : close > sma ? 'YES' : 'NO'
    rows.push({
      전략: a.strategy,
      티커: a.ticker,
      ETF: a.name,
      role: a.role,
      market: a.market,
      종가: close,
      SMA10: sma,
      'SMA 위': smaFlag,
      '12M': mom,
      현재금액: assetValue(a, fxRate),
      '목표%': a.target_pct,
      분류: a.category,
    })
  }
  return rows
}

export const CATEGORY_LIST = CATEGORY_OPTIONS
