/**
 * 실행 원장 (Execution Ledger) API
 *
 * 사용자의 실제 운용 방식:
 *   1) 매월 말 종가로 자산별 비중을 확인한다.
 *   2) 목표비중과 비교해 매매 수량을 정한다.
 *   3) 그 결과 '종목별 보유수량'이 바뀌고, 그 수량이 **다음 달 말 계산의 기준**이 된다.
 *
 * 그래서 필요한 것은 "계획"이 아니라 **"반영한 기록"** 이다.
 * 어떤 기준일의 어떤 종가를 써서, 각 종목의 수량이 얼마에서 얼마로 바뀌었는지를 남긴다.
 *
 *  - POST   /api/rebalance/apply   : 계획을 실제 보유수량에 반영하고 원장에 기록
 *  - GET    /api/rebalances        : 원장 목록 (최신순)
 *  - GET    /api/rebalances/:id    : 원장 상세 (종목별 변동)
 *  - DELETE /api/rebalances/:id    : 기록만 삭제 (수량은 되돌리지 않음 — 되돌리려면 POST /api/rebalance/revert)
 *  - POST   /api/rebalance/revert  : 특정 기록을 되돌린다 (수량 복원)
 *  - GET    /api/month-end         : ?date=YYYY-MM-DD → 그 달 마지막 날 (기준일 선택 도우미)
 */
import { Hono } from 'hono'
import { fail, loadAll, ok, readJson, type AppEnv } from './helpers'
import { getState, putState, type AssetRow } from '../lib/store'
import { n } from '../lib/compute'
import { getUsdKrw } from '../lib/prices'
export const rebalance = new Hono<AppEnv>()

export type LedgerItem = {
  strategy: string
  ticker: string
  name: string
  market: string
  role: string
  /** 적용에 쓴 가격 (CASH 는 1) */
  price: number
  /** 매매 금액 (+매수 / -매도) */
  amount: number
  /** 수량 변동 (+매수 / -매도) */
  shares_delta: number
  shares_before: number
  shares_after: number
  /** 반영 전/후 평가액 */
  value_before: number
  value_after: number
  /** 계획상 목표 평가액 */
  target_value: number
  note: string
}

export type LedgerRecord = {
  id: string
  date: string
  created_at: string
  note: string
  fx_rate: number | null
  total_before: number
  total_after: number
  /** 원장을 만들 때 쓴 종가 스냅샷 (다음 달 비교 기준) */
  closes: Record<string, number>
  items: LedgerItem[]
  by_strategy: Record<string, { buy: number; sell: number; count: number }>
  /** 항목 수 / 매수·매도 합계 */
  summary: { items: number; buy: number; sell: number }
}

/** 그 달의 마지막 날 (YYYY-MM-DD) */
function monthEnd(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  return last.toISOString().slice(0, 10)
}

const round2 = (x: number) => Math.round(n(x) * 100) / 100

rebalance.get('/month-end', (c) => {
  const input = c.req.query('date') || new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return fail(c, 'date 는 YYYY-MM-DD 형식이어야 합니다.')
  const end = monthEnd(input)
  const prevMonthEnd = monthEnd(new Date(new Date(`${end}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10))
  return ok(c, { input, monthEnd: end, prevMonthEnd, today: new Date().toISOString().slice(0, 10) })
})

rebalance.get('/rebalances', async (c) => {
  const { env, specs } = await loadAll(c)
  const all = (await getState<LedgerRecord[]>(env, 'rebalances', specs)) || []
  const sorted = all.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.created_at).localeCompare(String(a.created_at)))
  // 목록은 가볍게 (항목 상세는 상세 조회에서)
  const lite = sorted.map((r) => ({
    id: r.id,
    date: r.date,
    created_at: r.created_at,
    note: r.note,
    total_before: r.total_before,
    total_after: r.total_after,
    summary: r.summary,
    by_strategy: r.by_strategy,
    itemCount: (r.items || []).length,
  }))
  return ok(c, { rebalances: lite })
})

rebalance.get('/rebalances/:id', async (c) => {
  const { env, specs } = await loadAll(c)
  const id = c.req.param('id')
  const all = (await getState<LedgerRecord[]>(env, 'rebalances', specs)) || []
  const rec = all.find((x) => x.id === id)
  if (!rec) return fail(c, '해당 실행 기록을 찾을 수 없습니다.', 404)
  return ok(c, { record: rec })
})

/**
 * 계획 반영 — 계획의 매매액을 실제 보유수량에 적용하고 원장에 남긴다.
 *
 * body: {
 *   date: 'YYYY-MM-DD',                       // 기준일(그 날 종가)
 *   note?: string,
 *   round_shares?: boolean,                   // 주식 수량을 정수로 반올림 (기본 false)
 *   items: [{ strategy, ticker, amount, target_value?, price? }]
 * }
 *
 * - amount 는 서버가 신뢰하지 않고 가격과 함께 재검증한다(가격이 없으면 자산의 종가 사용).
 * - CASH 는 '금액 = 수량' 이므로 price=1 로 처리한다.
 */
rebalance.post('/rebalance/apply', async (c) => {
  const body = await readJson<{ date?: string; note?: string; round_shares?: boolean; items?: any[] }>(c)
  const date = String(body?.date || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(c, '기준일(date)을 YYYY-MM-DD 형식으로 보내주세요.')
  const items = Array.isArray(body?.items) ? body!.items! : []
  if (!items.length) return fail(c, '반영할 항목(items)이 없습니다.')

  const { env, specs, assets, settings } = await loadAll(c)
  const next: AssetRow[] = assets.map((a) => ({ ...a }))
  const useAdj = settings.price_mode === 'adjclose'

  const fxRate = next.some((a) => a.market === 'US') ? await getUsdKrw(env, date, false) : null

  const valueOf = (a: AssetRow) => {
    if (a.ticker === 'CASH') return n(a.shares)
    const v = n(a.shares) * n(a.close)
    if (a.market === 'US') {
      const fx = fxRate != null && fxRate > 0 ? fxRate : 0
      return fx ? v * fx : 0
    }
    return v
  }

  const totalBefore = next.reduce((s, a) => s + valueOf(a), 0)
  const ledgerItems: LedgerItem[] = []
  const closes: Record<string, number> = {}
  const byStrategy: Record<string, { buy: number; sell: number; count: number }> = {}
  let buySum = 0
  let sellSum = 0

  for (const raw of items) {
    const strategy = String(raw?.strategy || '').trim()
    const ticker = String(raw?.ticker || '').trim()
    if (!strategy || !ticker) continue
    const idx = next.findIndex((a) => a.strategy === strategy && a.ticker === ticker)
    if (idx < 0) continue
    const a = next[idx]

    // 가격: 클라이언트가 보낸 값이 있으면 쓰되, 0 이하면 자산의 동기화된 종가를 쓴다.
    const isCash = a.ticker === 'CASH'
    const sentPrice = n(raw?.price)
    const price = isCash ? 1 : sentPrice > 0 ? sentPrice : n(a.close)
    if (!isCash && price <= 0) {
      return fail(c, `${ticker} 의 가격이 없습니다. 먼저 “최신 가격으로 계획 만들기”를 실행하거나 가격을 함께 보내주세요.`)
    }

    const amount = round2(n(raw?.amount))
    if (!amount) continue

    let delta = amount / price
    if (!isCash && body?.round_shares) delta = Math.round(delta)

    const sharesBefore = n(a.shares)
    const sharesAfter = isCash ? sharesBefore + amount : sharesBefore + delta
    const valueBefore = valueOf(a)

    // 반영
    next[idx] = { ...a, shares: round2(sharesAfter) }
    const valueAfter = valueOf(next[idx])

    closes[`${strategy}/${ticker}`] = price

    const st = (byStrategy[strategy] = byStrategy[strategy] || { buy: 0, sell: 0, count: 0 })
    if (amount > 0) st.buy += amount
    else st.sell += amount
    st.count += 1
    if (amount > 0) buySum += amount
    else sellSum += amount

    ledgerItems.push({
      strategy,
      ticker,
      name: a.name || '',
      market: a.market,
      role: a.role || '',
      price,
      amount,
      shares_delta: round2(delta),
      shares_before: round2(sharesBefore),
      shares_after: round2(sharesAfter),
      value_before: Math.round(valueBefore),
      value_after: Math.round(valueAfter),
      target_value: Math.round(n(raw?.target_value)),
      note: String(raw?.note || ''),
    })
  }

  if (!ledgerItems.length) return fail(c, '반영할 수 있는 항목이 없습니다(티커/전략 불일치 또는 금액 0).')

  await putState(env, 'assets', next)

  const totalAfter = next.reduce((s, a) => s + valueOf(a), 0)
  const rec: LedgerRecord = {
    id: `${date}-${Date.now().toString(36)}`,
    date,
    created_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
    note: String(body?.note || ''),
    fx_rate: fxRate,
    total_before: Math.round(totalBefore),
    total_after: Math.round(totalAfter),
    closes,
    items: ledgerItems,
    by_strategy: byStrategy,
    summary: { items: ledgerItems.length, buy: Math.round(buySum), sell: Math.round(sellSum) },
  }

  const all = (await getState<LedgerRecord[]>(env, 'rebalances', specs)) || []
  await putState(env, 'rebalances', [rec, ...all])

  return ok(c, { record: rec, assets: next })
})

/**
 * 반영 되돌리기 — 원장의 수량 변동을 그대로 역적용한다.
 * (다음 달 계산 기준이 잘못 세워졌을 때 복구 경로)
 */
rebalance.post('/rebalance/revert', async (c) => {
  const body = await readJson<{ id?: string }>(c)
  const id = String(body?.id || '')
  const { env, specs, assets } = await loadAll(c)
  const all = (await getState<LedgerRecord[]>(env, 'rebalances', specs)) || []
  const rec = all.find((x) => x.id === id)
  if (!rec) return fail(c, '해당 실행 기록을 찾을 수 없습니다.', 404)

  const next: AssetRow[] = assets.map((a) => ({ ...a }))
  const warned: string[] = []
  for (const it of rec.items || []) {
    const idx = next.findIndex((a) => a.strategy === it.strategy && a.ticker === it.ticker)
    if (idx < 0) {
      warned.push(`${it.strategy}/${it.ticker} 종목이 없어 되돌리지 못했습니다.`)
      continue
    }
    next[idx] = { ...next[idx], shares: round2(n(next[idx].shares) - n(it.shares_delta)) }
  }
  await putState(env, 'assets', next)
  // 기록은 남기되 '되돌림' 표시를 해 이중 적용을 막는다
  await putState(
    env,
    'rebalances',
    all.map((x) => (x.id === id ? { ...x, reverted_at: new Date().toISOString().slice(0, 16).replace('T', ' '), note: `${x.note || ''} [되돌림]`.trim() } : x)),
  )
  return ok(c, { assets: next, reverted: rec.id, warnings: warned })
})

rebalance.delete('/rebalances/:id', async (c) => {
  const { env, specs } = await loadAll(c)
  const id = c.req.param('id')
  const all = (await getState<LedgerRecord[]>(env, 'rebalances', specs)) || []
  const next = all.filter((x) => x.id !== id)
  if (next.length === all.length) return fail(c, '해당 실행 기록을 찾을 수 없습니다.', 404)
  await putState(env, 'rebalances', next)
  return ok(c, { rebalances: next })
})
