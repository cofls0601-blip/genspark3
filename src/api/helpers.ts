/** API 공용 헬퍼 */
import type { Context } from 'hono'
import {
  cleanAssets,
  getState,
  initDb,
  loadSpecs,
  normalizeConfigs,
  type AssetRow,
  type Bindings,
  type StrategyConfig,
} from '../lib/store'
import { orderedSpecs } from '../lib/engine'
import type { Spec } from '../lib/specs'

export type AppEnv = { Bindings: Bindings }

export function ok<T>(c: Context, data: T, status = 200) {
  return c.json({ ok: true, data }, status as any)
}

export function fail(c: Context, message: string, status = 400, extra?: any) {
  return c.json({ ok: false, error: message, ...(extra || {}) }, status as any)
}

/** 안전한 JSON body 파싱 */
export async function readJson<T = any>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T
  } catch {
    return null
  }
}

export type Ctx = {
  env: Bindings
  specs: Record<string, Spec>
  cfgs: StrategyConfig[]
  assets: AssetRow[]
  settings: { price_policy: string; price_mode: string }
}

/** 앱 전체 상태 로딩 (스펙 → 설정 → 자산 순서로 정규화) */
export async function loadAll(c: Context): Promise<Ctx> {
  const env = c.env as Bindings
  await initDb(env)
  const specs = await loadSpecs(env)
  const rawCfgs = await getState<any[]>(env, 'strategies', specs)
  const cfgs = normalizeConfigs(rawCfgs, specs)
  const rawAssets = await getState<any[]>(env, 'assets', specs)
  const assets = cleanAssets(rawAssets)
  const price_policy = (await getState<string>(env, 'price_policy', specs)) || 'strict'
  const price_mode = (await getState<string>(env, 'price_mode', specs)) || 'close'
  return { env, specs, cfgs, assets, settings: { price_policy, price_mode } }
}

/** 스펙에 정의됐지만 kv assets 에 없는 종목을 자동 보강 (누락 방지) */
export function reconcileAssets(assets: AssetRow[], specs: Record<string, Spec>, cfgs: StrategyConfig[]): AssetRow[] {
  const out = assets.map((a) => ({ ...a }))
  let nextId = out.reduce((m, a) => Math.max(m, Number(a.id) || 0), -1) + 1
  for (const spec of Object.values(specs)) {
    for (const sa of spec.assets || []) {
      const exists = out.some((a) => a.strategy === spec.code && a.ticker === (sa.ticker || '') && a.role === (sa.role || ''))
      if (exists) continue
      const ticker = sa.ticker || ''
      out.push({
        id: String(nextId++),
        strategy: spec.code,
        ticker,
        name: sa.name || '',
        market: sa.market === 'US' ? 'US' : 'KR',
        role: sa.role || '',
        target_pct: Number(sa.target_pct) || 0,
        shares: 0,
        close: ticker === 'CASH' ? 1 : 0,
        prices: [],
        signal_ticker: sa.signal_ticker || ticker,
        category: sa.category || '기타',
      })
    }
  }
  // 스펙에서 사라진 전략의 자산 정리
  const codes = new Set(cfgs.map((c) => c.code))
  return out.filter((a) => codes.has(a.strategy))
}

export { orderedSpecs }
