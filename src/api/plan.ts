/**
 * 계획 실행 API — 가격 동기화 후 리밸런싱 계획을 계산한다.
 * GET  /api/plan/quick   : 캐시 우선 (일상 사용)
 * POST /api/plan/refresh : 강제 새로고침
 */
import { Hono } from 'hono'
import { fail, loadAll, ok, readJson, type AppEnv } from './helpers'
import { buildPlan, buildSeries, syncPrices } from '../lib/engine'
import { loadSpecs, putState } from '../lib/store'

export const plan = new Hono<AppEnv>()

async function runPlan(c: any, force: boolean, isoDay?: string) {
  const { env, specs, cfgs, assets, settings } = await loadAll(c)
  const day = isoDay || new Date().toISOString().slice(0, 10)
  const activeCodes = cfgs.filter((x) => x.active !== false).map((x) => x.code)
  const useAdj = settings.price_mode === 'adjclose'

  const sync = await syncPrices(env, assets, activeCodes, day, specs, force, useAdj)
  await putState(env, 'assets', sync.assets)

  // 조건 판정에 필요한 시계열 모음 (자산 + 신호 티커 + 조건 기준 티커)
  const targets = new Map<string, { market: string; ticker: string }>()
  for (const a of sync.assets) {
    if (activeCodes.includes(a.strategy) && a.ticker && a.ticker !== 'CASH') {
      targets.set(`${a.market}:${a.ticker}`, { market: a.market, ticker: a.ticker })
    }
  }
  for (const spec of Object.values(specs)) {
    for (const cond of ((spec.params as any)?.conditions || []) as any[]) {
      const t = String(cond.source_ticker || '').trim()
      if (!t || t === 'CASH') continue
      const mk = cond.source_market === 'US' ? 'US' : 'KR'
      targets.set(`${mk}:${t}`, { market: mk, ticker: t })
    }
    const sig = (spec.params as any)?.signal
    if (sig?.ticker) {
      const mk = sig.market === 'US' ? 'US' : 'KR'
      targets.set(`${mk}:${sig.ticker}`, { market: mk, ticker: sig.ticker })
    }
  }
  const seriesMap = await buildSeries(env, [...targets.values()], day)

  const result = buildPlan(sync.assets, cfgs, specs, day, sync.fxRate, sync.triggerDd, seriesMap, sync.warnings)
  return ok(c, { ...result, assets: sync.assets, strategies: cfgs, specs })
}

plan.get('/plan/quick', async (c) => runPlan(c, false))

plan.post('/plan/refresh', async (c) => {
  const body = await readJson<{ date?: string }>(c)
  return runPlan(c, true, body?.date)
})

/** 조건 미리보기 — 규칙 빌더에서 "지금 이 조건이 참인가?" 를 즉시 확인 */
plan.post('/plan/preview-conditions', async (c) => {
  const body = await readJson<{ params?: any; targets?: { market: string; ticker: string }[]; date?: string }>(c)
  if (!body?.params) return fail(c, 'params 가 필요합니다.')
  const { env, assets } = await loadAll(c)
  const day = body.date || new Date().toISOString().slice(0, 10)
  const targets = body.targets?.length
    ? body.targets
    : assets
        .filter((a) => a.ticker && a.ticker !== 'CASH')
        .map((a) => ({ market: a.market, ticker: a.ticker }))
  const { previewConditions } = await import('../lib/engine')
  try {
    const results = await previewConditions(env, body.params, targets, day)
    return ok(c, { date: day, results })
  } catch (e: any) {
    return fail(c, `조건 평가 실패: ${e?.message || e}`)
  }
})

/** 스펙 다시 읽기 (설정 저장 후 화면 갱신용) */
plan.get('/specs', async (c) => {
  const { env } = await loadAll(c)
  const specs = await loadSpecs(env)
  return ok(c, { specs })
})
