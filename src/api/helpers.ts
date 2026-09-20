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

/**
 * 스펙(spec.assets)을 기준으로 보유자산 목록을 재구성한다.
 *
 *  - 스펙이 '어떤 종목이 있고 목표%가 얼마인지'의 원본이고,
 *    kv assets 는 '실제 보유수량·가격'을 들고 있다. 둘을 합쳐 하나의 목록으로 만든다.
 *  - 따라서 설정 화면에서 종목을 삭제하거나 목표%·티커를 고치면 그대로 반영되고,
 *    보유수량(shares)·가격(close/prices)은 기존 행에서 그대로 이어받아 유실되지 않는다.
 *    (예전 구현은 '없는 것만 추가'해서 삭제·수정이 반영되지 않았다.)
 */
export function reconcileAssets(assets: AssetRow[], specs: Record<string, Spec>, cfgs: StrategyConfig[]): AssetRow[] {
  const codes = new Set(cfgs.map((c) => c.code))
  const prev = assets.filter((a) => codes.has(a.strategy)).map((a) => ({ ...a }))
  const claimed = new Set<AssetRow>()
  const out: AssetRow[] = []
  let nextId = prev.reduce((m, a) => Math.max(m, Number(a.id) || 0), -1) + 1

  const ordered = Object.values(specs).sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99))
  for (const spec of ordered) {
    if (!codes.has(spec.code)) continue
    for (const sa of spec.assets || []) {
      const ticker = String(sa.ticker || '')
      const role = String(sa.role || '')
      // 1) 티커+역할 일치 → 2) 티커 일치(역할 변경 추적) → 3) 역할 일치(티커 신규 입력)
      let hit = prev.find((a) => !claimed.has(a) && a.strategy === spec.code && a.ticker === ticker && a.role === role)
      if (!hit && ticker) hit = prev.find((a) => !claimed.has(a) && a.strategy === spec.code && a.ticker === ticker)
      if (!hit && !ticker && role) hit = prev.find((a) => !claimed.has(a) && a.strategy === spec.code && a.role === role)
      const keep = hit ?? null
      if (keep) claimed.add(keep)
      out.push({
        id: keep ? keep.id : String(nextId++),
        strategy: spec.code,
        ticker,
        name: sa.name || keep?.name || '',
        market: sa.market === 'US' ? 'US' : 'KR',
        role,
        target_pct: Number(sa.target_pct) || 0,
        // 보유수량·가격은 스펙이 아니라 실제 보유 상태를 이어받는다
        shares: keep ? keep.shares : 0,
        close: keep ? keep.close : ticker === 'CASH' ? 1 : 0,
        prices: keep?.prices ?? [],
        adjclose: keep?.adjclose,
        signal_ticker: sa.signal_ticker || keep?.signal_ticker || ticker,
        category: sa.category || keep?.category || '기타',
        last_fetch_date: keep?.last_fetch_date || '',
        price_source: keep?.price_source || '',
      })
    }
  }

  // 스펙이 없는 전략(아직 규칙을 만들지 않은 상태)은 기존 행을 그대로 보존한다.
  // 스펙이 있는데 스펙 목록에 없는 행은 삭제된 것으로 보고 버린다.
  for (const a of prev) {
    if (claimed.has(a)) continue
    if (specs[a.strategy]) continue
    out.push(a)
  }
  return out
}

export { orderedSpecs }
