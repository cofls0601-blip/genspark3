/**
 * 부트스트랩 API — 앱 최초 로딩에 필요한 모든 상태를 한 번에 반환한다.
 */
import { Hono } from 'hono'
import { loadAll, ok, reconcileAssets, type AppEnv } from './helpers'
import { getState, putState } from '../lib/store'
import { CATEGORY_OPTIONS, RULE_DESC, RULE_FRIENDLY_NAME, RULE_UI_SCHEMA, migrateLegacyRoleParams } from '../lib/specs'
import { ALLOC_LABEL, INDICATOR_LABEL, DEFAULT_VISUAL_PARAMS, describeCondition } from '../lib/conditions'

export const bootstrap = new Hono<AppEnv>()

bootstrap.get('/bootstrap', async (c) => {
  const { env, specs, cfgs, assets, settings } = await loadAll(c)
  const merged = reconcileAssets(assets, specs, cfgs)
  // 자동 보강이 있었다면 저장해 다음 로딩부터 일관되게 유지
  if (merged.length !== assets.length) await putState(env, 'assets', merged)

  const history = (await getState<any[]>(env, 'history', specs)) || []
  const equity = (await getState<any[]>(env, 'equity', specs)) || []
  const cashflows = (await getState<any[]>(env, 'cashflows', specs)) || []
  const executions = (await getState<any[]>(env, 'executions', specs)) || []
  const categoryTargets = (await getState<Record<string, number>>(env, 'category_targets', specs)) || {}
  const customBenchmarks = (await getState<Record<string, string>>(env, 'custom_benchmarks', specs)) || {}
  const recentTickers = (await getState<any[]>(env, 'recent_tickers', specs)) || []
  const favoriteTickers = (await getState<any[]>(env, 'favorite_tickers', specs)) || []

  // 구버전 역할명 기반 파라미터는 화면 표시용으로 실제 티커를 역참조해 미리 채워준다
  // (엔진은 구버전 키도 계속 읽으므로 저장하지 않아도 동작은 그대로 유지된다).
  const specsForUi: Record<string, any> = {}
  for (const [code, sp] of Object.entries(specs)) {
    specsForUi[code] = { ...sp, params: migrateLegacyRoleParams(sp.rule, sp.params || {}, merged, code) }
  }

  // 히스토리는 목록 표시용으로 가볍게 (composition 은 상세 조회 시 사용)
  const historyLite = history.map((h: any) => ({
    date: h.date,
    total: h.total,
    by_strategy: h.by_strategy || {},
    by_category: h.by_category || {},
    plan: h.plan ?? null,
    saved_at: h.saved_at || '',
    hasComposition: Array.isArray(h.composition) && h.composition.length > 0,
  }))

  return ok(c, {
    specs: specsForUi,
    strategies: cfgs,
    assets: merged,
    settings,
    history: historyLite,
    equity,
    cashflows,
    executions,
    categoryTargets,
    customBenchmarks,
    recentTickers,
    favoriteTickers,
    categories: CATEGORY_OPTIONS,
    ruleMeta: { desc: RULE_DESC, friendly: RULE_FRIENDLY_NAME, uiSchema: RULE_UI_SCHEMA },
    visualMeta: {
      indicators: INDICATOR_LABEL,
      allocModes: ALLOC_LABEL,
      defaults: DEFAULT_VISUAL_PARAMS,
      sample: describeCondition(DEFAULT_VISUAL_PARAMS.conditions[0]),
    },
    today: new Date().toISOString().slice(0, 10),
  })
})
