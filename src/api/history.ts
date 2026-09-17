/**
 * 기록 · 성과 · 입출금 · 실행 체크리스트 · 벤치마크 · 백업 API
 */
import { Hono } from 'hono'
import { fail, loadAll, ok, readJson, type AppEnv } from './helpers'
import { getState, putState, ALL_KV_KEYS, PRICE_FIELDS_EXCLUDED_FROM_BACKUP, BACKUP_SCHEMA_VERSION } from '../lib/store'
import {
  buildCategoryRow,
  calcTwr,
  calcXirr,
  benchmarkAttributedXirr,
  computeCategoryBreakdown,
  computePortfolioSnapshot,
  betaAlpha,
  mddDetails,
  n,
  portfolioPerf,
  sortinoRatio,
} from '../lib/compute'
import { fetchDay, getUsdKrw, searchUsSymbols, searchKrDict, cachePut, ymdToIso } from '../lib/prices'

export const history = new Hono<AppEnv>()

export const BENCH_SYMBOLS: Record<string, string> = {
  QQQ: 'QQQ',
  SPY: 'SPY',
  KOSPI200: '^KS200',
}

async function benchSymbols(c: any) {
  const { env, specs } = await loadAll(c)
  const custom = await getState<Record<string, string>>(env, 'custom_benchmarks', specs)
  return { ...BENCH_SYMBOLS, ...(custom || {}) }
}

/* ---------------- 히스토리 스냅샷 ---------------- */
history.post('/history/snapshot', async (c) => {
  const body = await readJson<{ date?: string; plan?: string }>(c)
  const { env, specs, cfgs, assets, settings } = await loadAll(c)
  const date = body?.date || new Date().toISOString().slice(0, 10)

  let fxRate: number | null = null
  if (assets.some((a) => a.market === 'US')) {
    fxRate = await getUsdKrw(env, date, false)
  }
  const { grand, rows } = computePortfolioSnapshot(assets, cfgs, fxRate, true)
  const cat = computeCategoryBreakdown(assets, cfgs, fxRate)

  const prev = await getState<any[]>(env, 'history', specs)
  const existing = (prev || []).find((x) => x.date === date)
  const byStrategy: Record<string, number> = {}
  for (const r of rows) byStrategy[r.전략] = (byStrategy[r.전략] || 0) + r.현재금액
  const byCategory: Record<string, number> = {}
  for (const r of cat) byCategory[r.분류] = r.금액

  const rec = {
    date,
    total: grand,
    by_strategy: byStrategy,
    by_category: byCategory,
    composition: rows,
    plan: body?.plan !== undefined ? body.plan : (existing?.plan ?? null),
    saved_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
  }
  const nextHistory = [rec, ...(prev || []).filter((x) => x.date !== date)].sort((a, b) => b.date.localeCompare(a.date))
  await putState(env, 'history', nextHistory)

  const eq = await getState<any[]>(env, 'equity', specs)
  const nextEq = [...(eq || []).filter((x) => x.date !== date), { date, value: grand }].sort((a, b) => a.date.localeCompare(b.date))
  await putState(env, 'equity', nextEq)

  // 벤치마크도 함께 백필 (실패는 무시)
  const symbols = await benchSymbols(c)
  const allBench = await getState<any[]>(env, 'benchmarks', specs)
  for (const [name, sym] of Object.entries(symbols)) {
    if ((allBench || []).some((x) => x.name === name && x.date === date)) continue
    try {
      const market = sym.includes('.KS') ? 'KR' : 'US'
      const row = await fetchDay(env, market, sym.replace('.KS', ''), date, false)
      if (row) {
        allBench.push({ name, date, value: row.close, ...(row.adjclose ? { adjclose: row.adjclose } : {}) })
      }
    } catch {
      /* ignore */
    }
  }
  await putState(env, 'benchmarks', allBench)

  // 자동 보조 백업 — 코드 업데이트/실수 초기화 전에 되돌릴 수 있게 최근 30개를 남긴다
  // (원본 Streamlit 앱의 write_auto_backup() 대응. 실패해도 스냅샷 저장은 막지 않는다)
  try {
    const snapshot: Record<string, any> = {}
    for (const k of ALL_KV_KEYS) snapshot[k] = await getState(env, k, specs)
    snapshot.specs = await getState(env, 'specs', specs)
    snapshot.assets = (snapshot.assets || []).map((a: any) => {
      const copy: Record<string, any> = { ...a }
      for (const f of PRICE_FIELDS_EXCLUDED_FROM_BACKUP) delete copy[f]
      return copy
    })
    await env.DB.prepare(`INSERT OR REPLACE INTO auto_backup(date, created_at, data) VALUES(?,?,?)`)
      .bind(date, new Date().toISOString().slice(0, 19).replace('T', ' '), JSON.stringify(snapshot))
      .run()
    await env.DB.prepare(
      `DELETE FROM auto_backup WHERE date NOT IN (SELECT date FROM auto_backup ORDER BY date DESC LIMIT 30)`,
    ).run()
  } catch {
    /* 자동 백업 실패는 무시 */
  }

  return ok(c, { record: rec, history: nextHistory, equity: nextEq, settings })
})

history.delete('/history/:date', async (c) => {
  const date = c.req.param('date')
  const { env, specs } = await loadAll(c)
  const h = await getState<any[]>(env, 'history', specs)
  const eq = await getState<any[]>(env, 'equity', specs)
  const nextH = (h || []).filter((x) => x.date !== date)
  const nextEq = (eq || []).filter((x) => x.date !== date)
  await putState(env, 'history', nextH)
  await putState(env, 'equity', nextEq)
  return ok(c, { history: nextH, equity: nextEq })
})

/* ---------------- 성과 분석 ---------------- */
history.get('/performance', async (c) => {
  const range = c.req.query('range') || 'all'
  const { env, specs } = await loadAll(c)
  const equity = (await getState<any[]>(env, 'equity', specs)) || []
  const cashflows = (await getState<any[]>(env, 'cashflows', specs)) || []
  const hist = (await getState<any[]>(env, 'history', specs)) || []

  const sorted = [...equity].sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const last = sorted.length ? sorted[sorted.length - 1].date : null
  let cut: string | null = null
  if (last) {
    const d = new Date(`${last}T00:00:00Z`)
    const back = (days: number) => new Date(d.getTime() - days * 86_400_000).toISOString().slice(0, 10)
    if (range === '1y') cut = back(365)
    else if (range === '6m') cut = back(182)
    else if (range === '3m') cut = back(91)
    else if (range === '1m') cut = back(31)
    else if (range === 'ytd') cut = `${d.getUTCFullYear()}-01-01`
  }
  const slice = cut ? sorted.filter((r) => String(r.date) >= cut!) : sorted

  const perf = portfolioPerf(slice)
  const irr = calcXirr(slice, cashflows)
  const twr = calcTwr(slice, cashflows)
  const dd = mddDetails(slice)
  const sor = sortinoRatio(slice)

  // 전략별 시계열
  const byStratSeries: Record<string, { date: string; value: number }[]> = {}
  for (const rec of [...hist].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    for (const [code, v] of Object.entries(rec.by_strategy || {})) {
      ;(byStratSeries[code] ||= []).push({ date: rec.date, value: n(v) })
    }
  }
  const stratPerf = Object.entries(byStratSeries).map(([code, series]) => {
    const sl = cut ? series.filter((r) => r.date >= cut!) : series
    const p = portfolioPerf(sl)
    const sCf = cashflows.filter((x) => x.strategy === code)
    const dd = mddDetails(sl)
    const sor = sortinoRatio(sl)
    return {
      code,
      cagr: p ? p[0] : null,
      mdd: p ? p[1] : null,
      vol: p ? p[2] : null,
      sharpe: p ? p[3] : null,
      irr: sCf.length ? calcXirr(sl, sCf) : null,
      twr: calcTwr(sl, sCf),
      sortino: sor,
      mddDetail: dd,
      periodReturn: sl.length > 1 && sl[0].value > 0 ? sl[sl.length - 1].value / sl[0].value - 1 : null,
    }
  })

  // 전략 비교 차트용 — 전략별로 시작=100 정규화한 시계열
  const strategySeries: Record<string, { date: string; value: number }[]> = {}
  for (const [code, series] of Object.entries(byStratSeries)) {
    const sl = (cut ? series.filter((r) => r.date >= cut!) : series).slice().sort((a, b) => a.date.localeCompare(b.date))
    if (!sl.length || !(sl[0].value > 0)) continue
    const base = sl[0].value
    strategySeries[code] = sl.map((r) => ({ date: r.date, value: (r.value / base) * 100 }))
  }

  // 벤치마크 시계열 (첫 기록 = 100 정규화)
  const benchAll = (await getState<any[]>(env, 'benchmarks', specs)) || []
  const symbols = await benchSymbols(c)
  const first = sorted.length ? sorted[0].date : null
  const benchSeries: Record<string, { date: string; value: number }[]> = {}
  if (first) {
    for (const name of Object.keys(symbols)) {
      const z = benchAll.filter((x) => x.name === name && x.date >= first).sort((a, b) => String(a.date).localeCompare(String(b.date)))
      const raw = z.map((x) => ({ date: x.date, val: n(x.adjclose) > 0 ? n(x.adjclose) : n(x.value) })).filter((x) => x.val > 0)
      if (!raw.length) continue
      const base = raw[0].val
      benchSeries[name] = raw.map((x) => ({ date: x.date, value: (x.val / base) * 100 }))
    }
  }

  const portfolioSeries =
    sorted.length && sorted[0].value > 0
      ? (cut ? sorted.filter((r) => String(r.date) >= cut!) : sorted).map((x) => ({ date: x.date, value: (n(x.value) / sorted[0].value) * 100 }))
      : []

  const betaName = Object.keys(benchSeries)[0]
  const ba = betaName ? betaAlpha(portfolioSeries, benchSeries[betaName]) : { beta: null, alpha: null }

  // '이 돈을 벤치마크에 넣었다면' XIRR (공정 비교용)
  const attributed: Record<string, number | null> = {}
  if (irr !== null && last) {
    for (const [name] of Object.entries(symbols)) {
      const recs = benchAll.filter((x) => x.name === name).map((x) => ({ date: x.date, value: n(x.value) }))
      attributed[name] = benchmarkAttributedXirr(recs, cashflows, last)
    }
  }

  return ok(c, {
    range,
    last,
    equity: sorted,
    metrics: {
      cagr: perf?.[0] ?? null,
      mdd: perf?.[1] ?? null,
      vol: perf?.[2] ?? null,
      sharpe: perf?.[3] ?? null,
      irr,
      twr,
      sortino: sor,
      mddDetail: dd,
      beta: ba.beta,
      alpha: ba.alpha,
      betaAgainst: betaName || null,
    },
    attributed,
    strategies: stratPerf,
    strategySeries,
    benchmarks: benchSeries,
    portfolioSeries,
    history: hist,
  })
})

/* ---------------- 입출금 원장 ---------------- */
history.get('/cashflows', async (c) => {
  const { env, specs } = await loadAll(c)
  const cf = (await getState<any[]>(env, 'cashflows', specs)) || []
  return ok(c, { cashflows: cf })
})

history.put('/cashflows', async (c) => {
  const body = await readJson<{ cashflows?: any[] }>(c)
  if (!Array.isArray(body?.cashflows)) return fail(c, 'cashflows 배열이 필요합니다.')
  const { env, specs } = await loadAll(c)
  const clean = body.cashflows
    .filter((x: any) => x && x.date)
    .map((x: any) => ({
      date: String(x.date),
      amount: n(x.amount),
      memo: String(x.memo || ''),
      strategy: String(x.strategy || ''),
    }))
    .sort((a: any, b: any) => a.date.localeCompare(b.date))
  await putState(env, 'cashflows', clean)
  return ok(c, { cashflows: clean })
})

/* ---------------- 실행 체크리스트 (계획 대비 실제) ---------------- */
history.put('/executions', async (c) => {
  const body = await readJson<{ execution?: any }>(c)
  const e = body?.execution
  if (!e?.date || !e?.strategy || !e?.ticker) return fail(c, 'date/strategy/ticker 가 필요합니다.')
  const { env, specs } = await loadAll(c)
  const all = (await getState<any[]>(env, 'executions', specs)) || []
  const next = all.filter((x) => !(x.date === e.date && x.strategy === e.strategy && x.ticker === e.ticker))
  next.push({
    date: String(e.date),
    strategy: String(e.strategy),
    ticker: String(e.ticker),
    ETF: String(e.ETF || ''),
    planned: n(e.planned),
    done: !!e.done,
    actual: n(e.actual),
    planned_shares: n(e.planned_shares),
    actual_shares: n(e.actual_shares),
  })
  await putState(env, 'executions', next)
  return ok(c, { executions: next })
})

history.get('/executions', async (c) => {
  const { env, specs } = await loadAll(c)
  return ok(c, { executions: (await getState<any[]>(env, 'executions', specs)) || [] })
})

/* ---------------- 벤치마크 백필 ---------------- */
history.post('/benchmarks/backfill', async (c) => {
  const { env, specs } = await loadAll(c)
  const equity = (await getState<any[]>(env, 'equity', specs)) || []
  const existing = (await getState<any[]>(env, 'benchmarks', specs)) || []
  const symbols = await benchSymbols(c)
  let added = 0
  const errors: string[] = []
  for (const rec of equity) {
    for (const [name, sym] of Object.entries(symbols)) {
      if (existing.some((x) => x.name === name && x.date === rec.date)) continue
      try {
        const market = sym.includes('.KS') ? 'KR' : 'US'
        const row = await fetchDay(env, market, sym.replace('.KS', ''), rec.date, false)
        if (row) {
          existing.push({ name, date: rec.date, value: row.close, ...(row.adjclose ? { adjclose: row.adjclose } : {}) })
          added++
        }
      } catch (e: any) {
        errors.push(`${name} ${rec.date}: ${String(e?.message || e).slice(0, 80)}`)
      }
    }
  }
  await putState(env, 'benchmarks', existing)
  return ok(c, { added, errors: errors.slice(0, 10) })
})

/* ---------------- 스프레드시트 한 줄 / CSV ---------------- */
history.get('/history/:date/row', async (c) => {
  const date = c.req.param('date')
  const { env, specs } = await loadAll(c)
  const hist = (await getState<any[]>(env, 'history', specs)) || []
  const rec = hist.find((x) => x.date === date)
  if (!rec) return fail(c, '해당 날짜 기록이 없습니다.', 404)
  return ok(c, buildCategoryRow(date, rec.by_category || {}))
})

/* ---------------- 백업 / 복원 ---------------- */
history.get('/backup', async (c) => {
  const { env, specs, cfgs, assets, settings } = await loadAll(c)
  void cfgs
  void settings
  const data: Record<string, any> = {}
  for (const k of ALL_KV_KEYS) data[k] = await getState(env, k, specs)
  data.specs = await getState(env, 'specs', specs)
  data.assets = (data.assets || []).map((a: any) => {
    const copy: Record<string, any> = { ...a }
    for (const f of PRICE_FIELDS_EXCLUDED_FROM_BACKUP) delete copy[f]
    return copy
  })
  data._backup_meta = {
    schema_version: BACKUP_SCHEMA_VERSION,
    asset_price_data_included: false,
    excluded_asset_fields: [...PRICE_FIELDS_EXCLUDED_FROM_BACKUP],
    created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  }
  void assets
  return ok(c, data)
})

history.post('/restore', async (c) => {
  const body = await readJson<Record<string, any>>(c)
  if (!body || typeof body !== 'object') return fail(c, 'JSON 객체가 필요합니다.')
  const { env, specs } = await loadAll(c)
  const restored: string[] = []
  const skipped: string[] = []
  const keys = [...ALL_KV_KEYS, 'specs']
  for (const k of keys) {
    if (k in body) {
      let value = body[k]
      if (k === 'assets' && Array.isArray(value)) {
        value = value.map((a: any) => {
          const copy: Record<string, any> = { ...a }
          for (const f of PRICE_FIELDS_EXCLUDED_FROM_BACKUP) delete copy[f]
          return copy
        })
      }
      await putState(env, k, value)
      restored.push(k)
    } else {
      skipped.push(k)
    }
  }
  const fresh = await loadAll(c)
  void specs
  return ok(c, {
    restored,
    skipped,
    counts: {
      strategies: Object.keys(fresh.specs).length,
      assets: fresh.assets.length,
      history: ((await getState<any[]>(env, 'history', fresh.specs)) || []).length,
    },
  })
})

/* ---------------- 종목 검색 ---------------- */
history.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim()
  const market = c.req.query('market') === 'US' ? 'US' : 'KR'
  if (!q) return ok(c, { results: [] })
  if (market === 'US') {
    return ok(c, { results: await searchUsSymbols(q) })
  }

  // 한국: 1) 내장 사전(한글 지원) → 2) Yahoo(코드 입력) 순으로 시도해 병합
  const dict = searchKrDict(q)
  let remote: { ticker: string; name: string; exchange: string }[] = []
  if (!dict.length) {
    const raw = await searchUsSymbols(q)
    remote = raw
      .filter((r) => r.ticker.endsWith('.KS') || r.ticker.endsWith('.KQ'))
      .map((r) => ({ ticker: r.ticker.replace(/\.K[QS]$/, ''), name: r.name, exchange: r.exchange }))
  }
  const seen = new Set(dict.map((r) => r.ticker))
  const results = [...dict, ...remote.filter((r) => !seen.has(r.ticker))]
  return ok(c, { results })
})

/* ---------------- 종목 이름 조회 (수동 입력 보조) ---------------- */
history.post('/resolve-symbol', async (c) => {
  const body = await readJson<{ ticker?: string; market?: string }>(c)
  const ticker = String(body?.ticker || '').trim()
  if (!ticker) return fail(c, 'ticker 가 필요합니다.')
  const market = body?.market === 'US' ? 'US' : 'KR'
  const iso = new Date().toISOString().slice(0, 10)
  try {
    const row = await fetchDay(c.env as any, market, ticker, iso, true)
    if (!row) return fail(c, '해당 티커의 데이터를 찾을 수 없습니다.', 404)
    return ok(c, { ticker, market, close: row.close, date: ymdToIso(row.date) })
  } catch (e: any) {
    return fail(c, `조회 실패: ${String(e?.message || e).slice(0, 120)}`)
  }
})

export { cachePut }
