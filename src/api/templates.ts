/**
 * 자산배분 전략 템플릿 API
 *
 *  - GET  /api/templates                   : 정적/동적 템플릿 목록
 *  - GET  /api/templates/:id               : 템플릿 상세(자산 포함)
 *  - POST /api/strategies/from-template    : 템플릿으로 새 전략 생성
 *  - POST /api/strategies/:code/apply-template : 기존 전략에 템플릿 적용(자산/규칙 교체)
 *
 * 템플릿은 그대로 쓰는 완성품이 아니라 '가감해서 자기 전략으로 만드는' 출발점이다.
 * 그래서 overrides(비중 조정)와 extraAssets(자산 추가)를 받는다.
 */
import { Hono } from 'hono'
import { fail, loadAll, ok, readJson, reconcileAssets, type AppEnv } from './helpers'
import { putState, saveSpecs, type AssetRow, type StrategyConfig } from '../lib/store'
import { findTemplate, templateList, templateToSpec, type StrategyTemplate } from '../lib/templates'

export const templates = new Hono<AppEnv>()

templates.get('/templates', (c) => {
  const kind = c.req.query('kind')
  const list = templateList()
  const filtered = kind === 'static' || kind === 'dynamic' ? list.filter((t) => t.kind === kind) : list
  return ok(c, {
    templates: filtered,
    counts: {
      all: list.length,
      static: list.filter((t) => t.kind === 'static').length,
      dynamic: list.filter((t) => t.kind === 'dynamic').length,
    },
  })
})

templates.get('/templates/:id', (c) => {
  const tpl = findTemplate(c.req.param('id'))
  if (!tpl) return fail(c, '해당 템플릿을 찾을 수 없습니다.', 404)
  const found = templateList().find((t) => t.id === tpl.id)!
  return ok(c, { template: found })
})

type FromTemplateBody = {
  template_id?: string
  code?: string
  account?: string
  /** 한국 상장 ETF 근사 티커로 변환 */
  use_kr?: boolean
  /** { 원본티커: 목표% } 비중 가감 */
  overrides?: Record<string, number>
  /** 덧붙일 자산 */
  extra_assets?: any[]
  /** 기존 전략 덮어쓰기 허용 */
  overwrite?: boolean
}

function normalizeCode(v: any): string {
  return String(v || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '')
    .slice(0, 12)
}

/** 템플릿 id 를 기본 전략 코드로 (예: all-weather → ALLWEATHER) */
function defaultCode(tpl: StrategyTemplate): string {
  const base = tpl.id.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 10)
  return base || 'STRAT'
}

async function createFromTemplate(c: any, body: FromTemplateBody | null, forceCode?: string) {
  const tpl = findTemplate(String(body?.template_id || ''))
  if (!tpl) return fail(c, 'template_id 가 올바르지 않습니다.')

  const { env, cfgs, specs, assets } = await loadAll(c)
  const overwrite = !!body?.overwrite

  let code = normalizeCode(forceCode || body?.code) || defaultCode(tpl)
  const exists = cfgs.some((x) => x.code === code) || !!specs[code]

  if (exists && !overwrite && !forceCode) {
    // 자동으로 빈 코드를 찾아준다 (ALLWEATHER → ALLWEATHER2 …)
    let i = 2
    while (cfgs.some((x) => x.code === `${code}${i}`) || specs[`${code}${i}`]) i += 1
    code = `${code}${i}`
  }

  const spec = templateToSpec(tpl, code, {
    account: body?.account?.trim() || `${tpl.name}`,
    useKr: !!body?.use_kr,
    overrides: body?.overrides || {},
    extraAssets: body?.extra_assets || [],
  })

  const maxOrder = Math.max(-1, ...Object.values(specs).map((s) => s.display_order ?? 0))
  spec.display_order = overwrite && specs[code] ? specs[code].display_order ?? maxOrder + 1 : maxOrder + 1

  specs[code] = spec

  const nextCfgs: StrategyConfig[] = exists
    ? cfgs.map((x) =>
        x.code === code
          ? { ...x, account: spec.account, description: spec.description, dynamic: spec.dynamic, active: true }
          : x,
      )
    : [...cfgs, { code, account: spec.account, description: spec.description, dynamic: spec.dynamic, active: true, annual_limit: 0 }]

  const nextAssets: AssetRow[] = reconcileAssets(assets, specs, nextCfgs)

  await putState(env, 'assets', nextAssets)
  await putState(env, 'strategies', nextCfgs)
  await saveSpecs(env, specs)

  return ok(c, {
    code,
    created: !exists,
    template: { id: tpl.id, name: tpl.name, kind: tpl.kind, source: tpl.source },
    strategies: nextCfgs,
    specs,
    assets: nextAssets,
  })
}

templates.post('/strategies/from-template', async (c) => createFromTemplate(c, await readJson<FromTemplateBody>(c)))

/** 기존 전략 코드에 템플릿을 적용 — 규칙과 자산 목록을 템플릿 기준으로 교체한다 */
templates.post('/strategies/:code/apply-template', async (c) => {
  const code = c.req.param('code')
  const body = await readJson<FromTemplateBody>(c)
  const { cfgs, specs } = await loadAll(c)
  if (!cfgs.some((x) => x.code === code) && !specs[code]) return fail(c, '전략을 찾을 수 없습니다.', 404)
  return createFromTemplate(c, { ...(body || {}), code, overwrite: true }, code)
})
