/**
 * 전략 실행 엔진 — 가격 동기화 + 신호 계산 + 규칙 디스패치.
 * 노코드(visual) 규칙을 RULE_REGISTRY 에 등록하고, 전체 파이프라인을 제공한다.
 */
import {
  RULE_REGISTRY,
  applyStrategy,
  type PlanRow,
  type SignalRow,
  type Spec,
  type StrategyConfig,
} from './specs'
import { applyVisualRule, type VisualRuleParams } from './conditions'
import {
  cacheGet,
  cachePut,
  fetchDailyHistory,
  fetchDay,
  fetchMonthly,
  getUsdKrw,
  priceValues,
  toYahooSymbol,
  detectAnomaly,
  ymdToIso,
  isoToYmd,
  type PriceRow,
} from './prices'
import { assetValue, buildSignalRows, n } from './compute'
import type { AssetRow, Bindings } from './store'

// 노코드 규칙 등록 — 사용자가 UI 에서 조립한 조건을 평가한다.
RULE_REGISTRY['visual'] = (spec, vdf, ctx) => {
  const resolver = ctx.series || (() => ({ monthly: [], daily: [] }))
  return applyVisualRule(spec, vdf, { quarter_end: ctx.quarter_end }, resolver)
}

export const RULE_VISUAL = 'visual'

/** 시계열 접근자 생성 — D1 캐시에서 읽고, 없으면 Yahoo 에서 받아 채운다 */
export async function buildSeries(
  env: Bindings,
  pairs: { market: string; ticker: string }[],
  isoDay: string,
): Promise<Map<string, { monthly: number[]; daily: number[] }>> {
  const map = new Map<string, { monthly: number[]; daily: number[] }>()
  const endYmd = isoToYmd(isoDay)
  const start = new Date(new Date(`${isoDay}T00:00:00Z`).getTime() - 18 * 31 * 86_400_000)
  const startYmd = isoToYmd(start.toISOString().slice(0, 10))
  for (const p of pairs) {
    if (!p.ticker || p.ticker === 'CASH') continue
    const key = `${p.market}:${p.ticker}`
    if (map.has(key)) continue
    let rows = await cacheGet(env, p.market, p.ticker, startYmd, endYmd)
    // 캐시 미스 — 사용자가 규칙의 기준 티커로 보유하지 않은 종목을 지정한 경우
    // (예: 포트폴리오에 없는 SPY 를 모멘텀 기준으로 쓸 때) 여기서 받아온다.
    if (!rows.length) {
      try {
        await fetchDailyHistory(env, p.market, p.ticker, isoDay, 550, false)
        rows = await cacheGet(env, p.market, p.ticker, startYmd, endYmd)
      } catch {
        /* 실패 시 빈 시계열 유지 → 조건은 "데이터 부족"으로 판정된다 */
      }
    }
    const byMonth = new Map<string, number>()
    for (const r of rows) byMonth.set(r.date.slice(0, 6), r.close)
    map.set(key, {
      monthly: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v),
      daily: rows.map((r) => r.close),
    })
  }
  return map
}

export function makeResolver(seriesMap: Map<string, { monthly: number[]; daily: number[] }>) {
  return (market: string, ticker: string) => {
    if (!ticker || ticker === 'CASH') return { monthly: [], daily: [] }
    const direct = seriesMap.get(`${market}:${ticker}`)
    if (direct) return direct
    // 다른 시장으로도 시도 (사용자가 시장을 잘못 지정한 경우 보정)
    for (const m of ['KR', 'US']) {
      const hit = seriesMap.get(`${m}:${ticker}`)
      if (hit) return hit
    }
    return { monthly: [], daily: [] }
  }
}

/* ---------------------------------------------------------------------------
 * 가격 동기화 — 종목별 현재가 + 월별 이력 + 신호 티커 낙폭을 갱신한다.
 * ------------------------------------------------------------------------- */
export type SyncWarning = { ticker: string; message: string }

export async function syncPrices(
  env: Bindings,
  assets: AssetRow[],
  cfgCodes: string[],
  isoDay: string,
  specs: Record<string, Spec>,
  force: boolean,
  useAdj: boolean,
): Promise<{ assets: AssetRow[]; warnings: SyncWarning[]; fxRate: number | null; triggerDd: Record<string, number | null> }> {
  const warnings: SyncWarning[] = []
  const use = assets.filter((a) => cfgCodes.includes(a.strategy))
  const out = assets.map((a) => ({ ...a }))

  let fxRate: number | null = null
  if (use.some((a) => a.market === 'US')) {
    fxRate = await getUsdKrw(env, isoDay, force)
    if (fxRate == null) warnings.push({ ticker: 'KRW=X', message: 'USD/KRW 환율을 가져오지 못했습니다. 미국 종목 평가액이 0으로 계산될 수 있습니다.' })
  }

  // 동시 실행 수를 제한해 Yahoo 를 과도하게 두드리지 않는다
  const targets = use.filter((a) => a.ticker && a.ticker !== 'CASH')
  const CONCURRENCY = 4
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const slice = targets.slice(i, i + CONCURRENCY)
    await Promise.all(
      slice.map(async (a) => {
        const idx = out.findIndex((x) => x.id === a.id)
        if (idx < 0) return
        // 1) 지정일 종가 — 휴장일이면 직전 거래일로 대체하고 그 사실을 기록
        try {
          let row = await fetchDay(env, a.market, a.ticker, isoDay, force)
          let usedIso = isoDay
          if (!row) {
            const hist = await fetchDailyHistory(env, a.market, a.ticker, isoDay, 30, force)
            const upto = hist.filter((r) => r.date <= isoToYmd(isoDay))
            if (upto.length) {
              row = upto[upto.length - 1]
              usedIso = ymdToIso(row.date)
            }
          }
          if (!row) throw new Error('해당 일자 및 직전 거래일 종가 없음')
          out[idx].close = row.close
          if (row.adjclose) out[idx].adjclose = row.adjclose
          out[idx].last_fetch_date = usedIso === isoDay ? usedIso : `${usedIso} (대체)`

          const info = await cacheGet(env, a.market, a.ticker, isoToYmd(isoDay), isoToYmd(isoDay))
          out[idx].price_source = info.length ? 'cache' : 'Yahoo'

          // 2) 월별 이력 — SMA/모멘텀 계산용
          const monthly = await fetchMonthly(env, a.market, a.ticker, isoDay, force)
          const prices = priceValues(monthly, a.market, useAdj)
          out[idx].prices = prices

          if (prices.length < 10) {
            warnings.push({ ticker: a.ticker, message: `월별 데이터가 ${prices.length}개뿐이라 SMA10 계산이 어렵습니다.` })
          }
          const { flagged, change } = detectAnomaly(prices)
          if (flagged) {
            warnings.push({
              ticker: a.ticker,
              message: `최근 월간 변동률 ${(n(change) * 100).toFixed(2)}% — 분할/배당락/입력 오류 가능성을 확인하세요.`,
            })
          }
        } catch (e: any) {
          warnings.push({ ticker: a.ticker, message: String(e?.message || e).slice(0, 160) })
        }
      }),
    )
  }

  // 3) 낙폭 트리거 — signal 파라미터에서 신호 티커·룩백을 읽어 판정
  const triggerDd: Record<string, number | null> = {}
  for (const [code, spec] of Object.entries(specs)) {
    const sig = (spec.params as any)?.signal
    if (!['drawdown_buy', 'drawdown_shift'].includes(spec.rule) || !sig?.ticker) continue
    const market = sig.market === 'US' ? 'US' : 'KR'
    const lookback = Math.max(20, n(sig.lookback_days, 120))
    try {
      const hist = await fetchDailyHistory(env, market, sig.ticker, isoDay, 550, force)
      const upto = hist.filter((r) => r.date <= isoToYmd(isoDay))
      const closes = priceValues(upto, market, useAdj).slice(-Math.round(lookback))
      if (closes.length < 20) throw new Error(`기준일 이전 데이터가 ${closes.length}개뿐입니다.`)
      const peak = Math.max(...closes)
      triggerDd[code] = peak > 0 ? closes[closes.length - 1] / peak - 1 : null
    } catch (e: any) {
      triggerDd[code] = null
      warnings.push({ ticker: `${sig.ticker}(트리거)`, message: String(e?.message || e).slice(0, 160) })
    }
  }

  return { assets: out, warnings, fxRate, triggerDd }
}

/* ---------------------------------------------------------------------------
 * 계획 수립 — 신호 행 생성 + 규칙 디스패치
 * ------------------------------------------------------------------------- */
export type PlanResult = {
  date: string
  quarterEnd: boolean
  fxRate: number | null
  triggerDd: Record<string, number | null>
  signalRows: SignalRow[]
  plan: PlanRow[]
  totals: { buy: number; sell: number; net: number; grand: number }
  warnings: SyncWarning[]
}

export function buildPlan(
  assets: AssetRow[],
  cfgs: StrategyConfig[],
  specs: Record<string, Spec>,
  isoDay: string,
  fxRate: number | null,
  triggerDd: Record<string, number | null>,
  seriesMap: Map<string, { monthly: number[]; daily: number[] }>,
  warnings: SyncWarning[],
): PlanResult {
  const activeCodes = cfgs.filter((c) => c.active !== false).map((c) => c.code)
  const signalRows = buildSignalRows(
    assets.filter((a) => activeCodes.includes(a.strategy)),
    cfgs,
    fxRate,
    [],
  )
  const month = Number(isoDay.slice(5, 7))
  const quarterEnd = [3, 6, 9, 12].includes(month)
  const ctx = {
    quarter_end: quarterEnd,
    trigger_dd: triggerDd,
    series: makeResolver(seriesMap),
  }

  const ordered = orderedSpecs(cfgs, specs)
  const plan: PlanRow[] = []
  for (const code of ordered) {
    const spec = specs[code]
    if (!spec) continue
    if (!signalRows.some((r) => r.전략 === code)) continue
    try {
      plan.push(...applyStrategy(spec, signalRows, ctx))
    } catch (e: any) {
      warnings.push({ ticker: code, message: `규칙 실행 실패: ${e?.message || e}` })
    }
  }

  const buy = plan.filter((r) => n(r['매매액(+매수/-매도)']) > 1000).reduce((a, r) => a + n(r['매매액(+매수/-매도)']), 0)
  const sell = plan.filter((r) => n(r['매매액(+매수/-매도)']) < -1000).reduce((a, r) => a + n(r['매매액(+매수/-매도)']), 0)
  const grand = signalRows.reduce((a, r) => a + n(r.현재금액), 0)

  return {
    date: isoDay,
    quarterEnd,
    fxRate,
    triggerDd,
    signalRows,
    plan,
    totals: { buy, sell, net: buy + sell, grand },
    warnings,
  }
}

export function orderedSpecs(cfgs: StrategyConfig[], specs: Record<string, Spec>): string[] {
  const codes = cfgs.map((c) => c.code)
  const known = Object.values(specs)
    .sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99))
    .filter((s) => codes.includes(s.code))
    .map((s) => s.code)
  const rest = codes.filter((c) => !specs[c])
  return [...known, ...rest]
}

/** 조건 미리보기 — 규칙 빌더에서 현재 데이터로 판정 결과를 즉시 확인한다 */
export async function previewConditions(
  env: Bindings,
  params: VisualRuleParams,
  targets: { market: string; ticker: string }[],
  isoDay: string,
): Promise<{ label: string; value: number | null; passed: boolean | null; error?: string }[]> {
  // 조건이 참조하는 기준 티커는 보유 종목이 아니어도 반드시 포함시킨다
  // (예: 포트폴리오에 없는 SPY 를 모멘텀 기준으로 지정한 경우)
  const all: { market: string; ticker: string }[] = [...targets]
  const seen = new Set(all.map((t) => `${t.market}:${t.ticker}`))
  for (const c of params.conditions || []) {
    const t = String(c.source_ticker || '').trim()
    if (!t || t === 'CASH') continue
    const mk = c.source_market === 'US' ? 'US' : c.source_market === 'KR' ? 'KR' : 'KR'
    const key = `${mk}:${t}`
    if (seen.has(key)) continue
    seen.add(key)
    all.push({ market: mk, ticker: t })
  }
  const map = await buildSeries(env, all, isoDay)
  const resolver = makeResolver(map)
  const { evaluateConditions, describeCondition } = await import('./conditions')
  const anchor = all[0] || { market: 'KR', ticker: '' }
  const ev = evaluateConditions(params, resolver, anchor.ticker, anchor.market)
  return ev.results.map((r, i) => {
    const cond = params.conditions[i]
    return {
      label: cond ? describeCondition(cond) : r.label,
      value: r.value,
      passed: r.passed,
      error: r.error,
    }
  })
}

export { toYahooSymbol, cachePut, fetchDay }
