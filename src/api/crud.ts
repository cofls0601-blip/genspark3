/**
 * 상태 변경 API — 전략 스펙 / 보유자산 / 규칙 / 설정
 */
import { Hono } from 'hono'
import { fail, loadAll, ok, readJson, reconcileAssets, type AppEnv } from './helpers'
import {
  cleanAssets,
  getState,
  loadSpecs,
  putState,
  saveSpecs,
  type AssetRow,
  type StrategyConfig,
} from '../lib/store'
import { CATEGORY_OPTIONS, RULE_REGISTRY, specsToConfigs, type Spec } from '../lib/specs'
import { DEFAULT_VISUAL_PARAMS, type VisualRuleParams } from '../lib/conditions'
import { RULE_VISUAL } from '../lib/engine'

export const crud = new Hono<AppEnv>()

async function persist(c: any, assets: AssetRow[], cfgs: StrategyConfig[], specs: Record<string, Spec>) {
  const { env } = await loadAll(c)
  await putState(env, 'assets', assets)
  await putState(env, 'strategies', cfgs)
  await saveSpecs(env, specs)
}

/* ---------------- 전략 추가 / 삭제 / 수정 ---------------- */
crud.post('/strategies', async (c) => {
  const body = await readJson<{ code?: string; account?: string; description?: string; dynamic?: boolean }>(c)
  const code = String(body?.code || '').trim().toUpperCase()
  if (!code) return fail(c, '전략 코드를 입력하세요.')
  const { env, cfgs, specs, assets } = await loadAll(c)
  if (cfgs.some((x) => x.code === code) || specs[code]) return fail(c, '이미 존재하는 전략 코드입니다.')

  const maxOrder = Math.max(-1, ...Object.values(specs).map((s) => s.display_order ?? 0))
  specs[code] = {
    code,
    account: body?.account?.trim() || code,
    display_order: maxOrder + 1,
    description: body?.description?.trim() || '',
    dynamic: !!body?.dynamic,
    active: true,
    annual_limit: 0,
    rule: 'visual',
    params: { ...DEFAULT_VISUAL_PARAMS },
    assets: [{ ticker: 'CASH', name: '현금', market: 'KR', role: '대기현금', target_pct: 100, category: '현금' }],
  }
  const nextCfgs = [...cfgs, { code, account: body?.account?.trim() || code, description: body?.description?.trim() || '', dynamic: !!body?.dynamic, active: true, annual_limit: 0 }]
  const nextAssets = reconcileAssets(assets, specs, nextCfgs)
  await persist(c, nextAssets, nextCfgs, specs)
  return ok(c, { code, strategies: nextCfgs, specs, assets: nextAssets })
})

crud.patch('/strategies/:code', async (c) => {
  const code = c.req.param('code')
  const body = await readJson<Partial<StrategyConfig>>(c)
  const { cfgs, specs, assets } = await loadAll(c)
  if (!cfgs.some((x) => x.code === code)) return fail(c, '전략을 찾을 수 없습니다.', 404)
  const nextCfgs = cfgs.map((x) =>
    x.code === code
      ? {
          ...x,
          account: body?.account?.trim() || x.account,
          description: body?.description ?? x.description,
          dynamic: body?.dynamic ?? x.dynamic,
          active: body?.active ?? x.active,
          annual_limit: body?.annual_limit ?? x.annual_limit,
        }
      : x,
  )
  if (specs[code]) {
    specs[code].account = body?.account?.trim() || specs[code].account
    specs[code].description = body?.description ?? specs[code].description
    specs[code].dynamic = body?.dynamic ?? specs[code].dynamic
    specs[code].active = body?.active ?? specs[code].active
    specs[code].annual_limit = body?.annual_limit ?? specs[code].annual_limit
  }
  await persist(c, assets, nextCfgs, specs)
  return ok(c, { strategies: nextCfgs, specs })
})

crud.delete('/strategies/:code', async (c) => {
  const code = c.req.param('code')
  const { cfgs, specs, assets } = await loadAll(c)
  const nextCfgs = cfgs.filter((x) => x.code !== code)
  delete specs[code]
  const nextAssets = assets.filter((a) => a.strategy !== code)
  await persist(c, nextAssets, nextCfgs, specs)
  return ok(c, { strategies: nextCfgs, specs, assets: nextAssets })
})

/** 전략 순서 변경 (드래그앤드롭) */
crud.post('/strategies/reorder', async (c) => {
  const body = await readJson<{ order?: string[] }>(c)
  if (!Array.isArray(body?.order)) return fail(c, 'order 배열이 필요합니다.')
  const { cfgs, specs, assets } = await loadAll(c)
  body.order.forEach((code, i) => {
    if (specs[code]) specs[code].display_order = i
  })
  const nextCfgs = [...cfgs].sort((a, b) => body.order!.indexOf(a.code) - body.order!.indexOf(b.code))
  await persist(c, assets, nextCfgs, specs)
  return ok(c, { strategies: nextCfgs, specs })
})

/* ---------------- 전략 규칙(스펙) 저장 — 노코드 빌더의 저장 경로 ---------------- */
crud.put('/specs/:code', async (c) => {
  const code = c.req.param('code')
  const body = await readJson<{ rule?: string; params?: any; description?: string; assets?: any[] }>(c)
  const { cfgs, specs, assets } = await loadAll(c)

  const spec: Spec = specs[code] || {
    code,
    account: cfgs.find((x) => x.code === code)?.account || code,
    display_order: Object.keys(specs).length,
    description: '',
    dynamic: false,
    active: true,
    annual_limit: 0,
    rule: 'visual',
    params: {},
    assets: [],
  }

  if (body?.rule) {
    if (!RULE_REGISTRY[body.rule] && body.rule !== RULE_VISUAL) return fail(c, `알 수 없는 규칙입니다: ${body.rule}`)
    spec.rule = body.rule
  }
  if (body?.params) spec.params = sanitizeParams(body.params)
  if (body?.description !== undefined) spec.description = body.description
  if (Array.isArray(body?.assets)) {
    spec.assets = body.assets
      .filter((a: any) => a && (a.ticker || a.name))
      .map((a: any) => ({
        ticker: String(a.ticker || ''),
        name: String(a.name || ''),
        market: a.market === 'US' ? 'US' : 'KR',
        role: String(a.role || ''),
        target_pct: Number(a.target_pct) || 0,
        category: CATEGORY_OPTIONS.includes(a.category) ? a.category : '기타',
        ...(a.signal_ticker ? { signal_ticker: String(a.signal_ticker) } : {}),
      }))
  }
  specs[code] = spec

  const nextCfgs = cfgs.map((x) => (x.code === code ? { ...x, description: spec.description } : x))
  const nextAssets = reconcileAssets(assets, specs, nextCfgs)
  await persist(c, nextAssets, nextCfgs, specs)
  return ok(c, { spec, specs, assets: nextAssets })
})

/** params 정규화 — 숫자/불리언/배열 타입을 강제해 평가 오류를 막는다 */
function sanitizeParams(params: any): any {
  const out: any = {}
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined) continue
    if (Array.isArray(v)) out[k] = v
    else if (typeof v === 'object') out[k] = sanitizeParams(v)
    else out[k] = v
  }
  return out
}

/* ---------------- 보유자산 ---------------- */
crud.put('/assets', async (c) => {
  const body = await readJson<{ assets?: any[] }>(c)
  if (!Array.isArray(body?.assets)) return fail(c, 'assets 배열이 필요합니다.')
  const { cfgs, specs } = await loadAll(c)
  const next = cleanAssets(body.assets)
  await persist(c, next, cfgs, specs)
  return ok(c, { assets: next })
})

crud.post('/assets', async (c) => {
  const body = await readJson<Partial<AssetRow>>(c)
  if (!body?.strategy) return fail(c, 'strategy 가 필요합니다.')
  const { cfgs, specs, assets } = await loadAll(c)
  if (!cfgs.some((x) => x.code === body.strategy)) return fail(c, '존재하지 않는 전략입니다.')
  const nextId = String(assets.reduce((m, a) => Math.max(m, Number(a.id) || 0), -1) + 1)
  const row: AssetRow = {
    id: nextId,
    strategy: body.strategy,
    ticker: String(body.ticker || ''),
    name: String(body.name || ''),
    market: body.market === 'US' ? 'US' : 'KR',
    role: String(body.role || '사용자 추가'),
    target_pct: Number(body.target_pct) || 0,
    shares: Number(body.shares) || 0,
    close: Number(body.close) || 0,
    prices: [],
    signal_ticker: String(body.signal_ticker || body.ticker || ''),
    category: CATEGORY_OPTIONS.includes(body.category as string) ? (body.category as string) : '기타',
  }
  const next = [...assets, row]
  // 스펙 자산 목록에도 반영해 다음 reconcile 에서 사라지지 않게 한다
  if (specs[row.strategy]) {
    specs[row.strategy].assets = [
      ...(specs[row.strategy].assets || []),
      { ticker: row.ticker, name: row.name, market: row.market, role: row.role, target_pct: row.target_pct, category: row.category },
    ]
  }
  await persist(c, next, cfgs, specs)
  return ok(c, { assets: next, specs })
})

crud.delete('/assets/:id', async (c) => {
  const id = c.req.param('id')
  const { cfgs, specs, assets } = await loadAll(c)
  const target = assets.find((a) => a.id === id)
  if (!target) return fail(c, '종목을 찾을 수 없습니다.', 404)
  const next = assets.filter((a) => a.id !== id)
  if (specs[target.strategy]) {
    specs[target.strategy].assets = (specs[target.strategy].assets || []).filter(
      (a) => !(a.ticker === target.ticker && a.role === target.role),
    )
  }
  await persist(c, next, cfgs, specs)
  return ok(c, { assets: next, specs })
})

/* ---------------- 설정 (휴장일 정책 · 가격 기준) ---------------- */
crud.put('/settings', async (c) => {
  const body = await readJson<{ price_policy?: string; price_mode?: string }>(c)
  const { env } = await loadAll(c)
  if (body?.price_policy && ['strict', 'prev'].includes(body.price_policy)) {
    await putState(env, 'price_policy', body.price_policy)
  }
  if (body?.price_mode && ['close', 'adjclose'].includes(body.price_mode)) {
    await putState(env, 'price_mode', body.price_mode)
  }
  const settings = {
    price_policy: await getState<string>(env, 'price_policy', {}),
    price_mode: await getState<string>(env, 'price_mode', {}),
  }
  return ok(c, { settings })
})

/* ---------------- 자산군 목표비중 ---------------- */
crud.put('/category-targets', async (c) => {
  const body = await readJson<Record<string, number>>(c)
  const { env, specs } = await loadAll(c)
  const targets: Record<string, number> = {}
  for (const cat of CATEGORY_OPTIONS) targets[cat] = Number(body?.[cat]) || 0
  await putState(env, 'category_targets', targets)
  void specs
  return ok(c, { category_targets: targets })
})

/* ---------------- 사용자 정의 벤치마크 ---------------- */
crud.put('/custom-benchmarks', async (c) => {
  const body = await readJson<Record<string, string>>(c)
  const { env, specs } = await loadAll(c)
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(body || {})) {
    const kk = String(k).trim()
    const vv = String(v).trim()
    if (kk && vv) clean[kk] = vv
  }
  await putState(env, 'custom_benchmarks', clean)
  void specs
  return ok(c, { custom_benchmarks: clean })
})

/** 전략 이름 변경 — 전용 규칙(static 이외)이 스펙에 정의된 전략은 코드 변경을 막는다 */
crud.post('/strategies/:code/rename', async (c) => {
  const oldCode = c.req.param('code')
  const body = await readJson<{ new_code?: string }>(c)
  const newCode = String(body?.new_code || '').trim().toUpperCase()
  const { env, cfgs, specs, assets } = await loadAll(c)
  if (!newCode || newCode === oldCode) return fail(c, '변경할 이름을 입력하세요.')
  const spOld = specs[oldCode]
  if (spOld && (spOld.rule || 'static') !== 'static') {
    return fail(c, `${oldCode}는 전용 리밸런싱 규칙(${spOld.rule})이 스펙에 정의되어 있어 이름을 바꿀 수 없습니다. 계좌 별명만 바꿔주세요.`)
  }
  if (cfgs.some((x) => x.code === newCode) || specs[newCode]) return fail(c, '이미 존재하는 전략 코드입니다.')

  const nextCfgs = cfgs.map((x) => (x.code === oldCode ? { ...x, code: newCode } : x))
  if (spOld) {
    specs[newCode] = { ...spOld, code: newCode }
    delete specs[oldCode]
  }
  const nextAssets = assets.map((a) => (a.strategy === oldCode ? { ...a, strategy: newCode } : a))
  await persist(c, nextAssets, nextCfgs, specs)
  return ok(c, { code: newCode, strategies: nextCfgs, specs, assets: nextAssets })
})

/* ---------------- 검색한 티커 기억 (최근 사용 / 즐겨찾기) ---------------- */
crud.post('/tickers/recent', async (c) => {
  const body = await readJson<{ ticker?: string; name?: string; market?: string }>(c)
  const ticker = String(body?.ticker || '').trim()
  if (!ticker) return fail(c, 'ticker 가 필요합니다.')
  const market = body?.market === 'US' ? 'US' : 'KR'
  const { env, specs } = await loadAll(c)
  const recents = ((await getState<any[]>(env, 'recent_tickers', specs)) || []).filter(
    (r) => !(r.ticker === ticker && r.market === market),
  )
  recents.unshift({ ticker, name: String(body?.name || ''), market })
  const next = recents.slice(0, 15)
  await putState(env, 'recent_tickers', next)
  return ok(c, { recent_tickers: next })
})

crud.post('/tickers/favorite', async (c) => {
  const body = await readJson<{ ticker?: string; name?: string; market?: string }>(c)
  const ticker = String(body?.ticker || '').trim()
  if (!ticker) return fail(c, 'ticker 가 필요합니다.')
  const market = body?.market === 'US' ? 'US' : 'KR'
  const { env, specs } = await loadAll(c)
  const favs = (await getState<any[]>(env, 'favorite_tickers', specs)) || []
  if (!favs.some((f) => f.ticker === ticker && f.market === market)) {
    favs.push({ ticker, name: String(body?.name || ''), market })
  }
  const next = favs.slice(0, 30)
  await putState(env, 'favorite_tickers', next)
  return ok(c, { favorite_tickers: next })
})

crud.delete('/tickers/favorite', async (c) => {
  const body = await readJson<{ items?: { ticker: string; market: string }[] }>(c)
  const pairs = new Set((body?.items || []).map((x) => `${x.market}:${x.ticker}`))
  const { env, specs } = await loadAll(c)
  const favs = (await getState<any[]>(env, 'favorite_tickers', specs)) || []
  const next = pairs.size ? favs.filter((f) => !pairs.has(`${f.market}:${f.ticker}`)) : []
  await putState(env, 'favorite_tickers', next)
  return ok(c, { favorite_tickers: next })
})

/** 가격 캐시 비우기 — 종목별 / 전체 */
crud.post('/cache/clear', async (c) => {
  const body = await readJson<{ market?: string; ticker?: string }>(c)
  const { env } = await loadAll(c)
  const market = body?.market === 'US' ? 'US' : body?.market === 'KR' ? 'KR' : ''
  const ticker = String(body?.ticker || '').trim()
  let deleted = 0
  if (market && ticker) {
    const r = await env.DB.prepare(`DELETE FROM price_cache WHERE market=? AND ticker=?`).bind(market, ticker).run()
    deleted = Number((r as any)?.meta?.changes || 0)
  } else if (ticker) {
    const r = await env.DB.prepare(`DELETE FROM price_cache WHERE ticker IN (?,?)`).bind(ticker.toUpperCase(), await kr6ish(ticker)).run()
    deleted = Number((r as any)?.meta?.changes || 0)
  } else {
    const r1 = await env.DB.prepare(`DELETE FROM price_cache`).run()
    const r2 = await env.DB.prepare(`DELETE FROM fx_cache`).run()
    deleted = Number((r1 as any)?.meta?.changes || 0) + Number((r2 as any)?.meta?.changes || 0)
  }
  return ok(c, { deleted, market: market || 'ALL', ticker: ticker || 'ALL' })
})

function kr6ish(t: string): string {
  const s = String(t ?? '').trim()
  return /^\d+$/.test(s) ? s.padStart(6, '0') : s.toUpperCase()
}

/** 규칙 메타데이터 — 프론트 규칙 빌더가 참조 */
crud.get('/rule-meta', async (c) => {
  const { specs } = await loadAll(c)
  void specs
  const { RULE_DESC, RULE_FRIENDLY_NAME, RULE_UI_SCHEMA } = await import('../lib/specs')
  return ok(c, {
    registered: Object.keys(RULE_REGISTRY),
    desc: RULE_DESC,
    friendly: RULE_FRIENDLY_NAME,
    uiSchema: RULE_UI_SCHEMA,
    visualParams: DEFAULT_VISUAL_PARAMS as VisualRuleParams,
  })
})
