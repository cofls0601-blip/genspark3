/**
 * 노코드 조건 엔진 — 사용자가 UI 에서 조립한 규칙을 그대로 평가한다.
 *
 * 설계 원칙
 *  - 모든 조건은 하나의 숫자 V 를 만들고 `V op threshold` 로 참/거짓을 판정한다.
 *      · sma      : V = 현재가 / SMA(N) - 1   (상회하면 양수)
 *      · momentum : V = N개월 수익률
 *      · drawdown : V = 현재가 / N일 최고가 - 1 (고점대비 하락률)
 *      · price    : V = 현재가 (절대값 비교)
 *  - 조건이 참일 때(on_pass)·거짓일 때(on_fail) 각각 자산 배분 동작을 지정한다.
 *  - 조건이 여러 개면 all(AND) / any(OR) 로 결합한다.
 */
import type { PlanRow, SignalRow, Spec } from './specs'

export type IndicatorType = 'sma' | 'momentum' | 'drawdown' | 'price'
export type PeriodUnit = 'months' | 'days'
export type CompareOp = '>' | '>=' | '<' | '<='

/** 자산 배분 동작 */
export type AllocMode =
  | 'target' // 목표비중 복원
  | 'hold' // 현금 유지(매매 없음)
  | 'cash' // 전량 현금화
  | 'buy_from_cash' // 현금에서 일부 매수
  | 'winner' // 모멘텀 1위 종목에 집중

export type Condition = {
  id: string
  /** 기준 티커 (비우면 자기 자신) */
  source_ticker?: string
  source_market?: 'KR' | 'US'
  /** 이 조건을 적용할 대상: role 이름 또는 티커 (비우면 전략 전체) */
  target?: string
  indicator: IndicatorType
  period: number
  period_unit: PeriodUnit
  op: CompareOp
  /** 임계값 — sma 는 괴리율(0=상회), momentum/drawdown 은 수익률, price 는 절대가 */
  threshold: number
  label?: string
}

export type VisualRuleParams = {
  conditions: Condition[]
  /** 조건 결합 방식 */
  mode: 'all' | 'any'
  /** 조건 충족 시 */
  on_pass: AllocMode
  /** 조건 미충족 시 */
  on_fail: AllocMode
  /** 목표비중 복원 시점: always | quarter_end */
  restore_timing: 'always' | 'quarter_end'
  /** 모멘텀 1위 집중 시 비중 (0~1) */
  winner_share?: number
  /** buy_from_cash 시 현금 투입 비율 (0~1) */
  buy_fraction?: number
  /** 모멘텀 1위 선정 기준 개월 */
  winner_momentum_months?: number
  /** winner 선정 시 SMA 통과 후보만 */
  winner_sma_filter?: boolean
}

export const DEFAULT_VISUAL_PARAMS: VisualRuleParams = {
  conditions: [
    {
      id: 'c1',
      source_ticker: 'QQQ',
      source_market: 'US',
      target: '',
      indicator: 'sma',
      period: 10,
      period_unit: 'months',
      op: '>',
      threshold: 0,
    },
  ],
  mode: 'all',
  on_pass: 'target',
  on_fail: 'cash',
  restore_timing: 'quarter_end',
  winner_share: 0.8,
  buy_fraction: 0.5,
  winner_momentum_months: 12,
  winner_sma_filter: true,
}

export const INDICATOR_LABEL: Record<IndicatorType, string> = {
  sma: 'SMA 대비 (이동평균 상회/하회)',
  momentum: '모멘텀 (기간 수익률)',
  drawdown: '낙폭 (고점 대비 하락률)',
  price: '현재 가격 (절대값)',
}

export const ALLOC_LABEL: Record<AllocMode, string> = {
  target: '목표비중으로 복원',
  hold: '그대로 유지 (매매 없음)',
  cash: '전량 현금화',
  buy_from_cash: '현금에서 일부 매수',
  winner: '모멘텀 1위 종목에 집중',
}

/** 지표 계산에 필요한 가격 시계열 접근자 */
export type SeriesResolver = (market: string, ticker: string) => { monthly: number[]; daily: number[] }

const n = (v: any, d = 0): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

/** 단일 조건을 숫자로 환산한다. 데이터가 없으면 null (= 판정 불가) */
export function evaluateIndicator(cond: Condition, series: SeriesResolver, selfTicker: string, selfMarket: string): number | null {
  const ticker = cond.source_ticker?.trim() || selfTicker
  const market = cond.source_market || (cond.source_ticker ? selfMarket : selfMarket)
  if (!ticker || ticker === 'CASH') return null
  const { monthly, daily } = series(market, ticker)

  if (cond.indicator === 'price') {
    const last = daily.length ? daily[daily.length - 1] : monthly.length ? monthly[monthly.length - 1] : null
    return last && last > 0 ? last : null
  }
  if (cond.indicator === 'sma') {
    const src = cond.period_unit === 'months' ? monthly : daily
    const p = cond.period
    if (src.length < p + 1) return null
    const sma = src.slice(-p).reduce((a, b) => a + b, 0) / p
    const last = src[src.length - 1]
    if (!(sma > 0) || !(last > 0)) return null
    return last / sma - 1
  }
  if (cond.indicator === 'momentum') {
    const src = cond.period_unit === 'months' ? monthly : daily
    const p = cond.period
    if (src.length < p + 1) return null
    const prev = src[src.length - 1 - p]
    const last = src[src.length - 1]
    if (!(prev > 0)) return null
    return last / prev - 1
  }
  if (cond.indicator === 'drawdown') {
    const src = cond.period_unit === 'months' ? monthly : daily
    const p = Math.min(cond.period, src.length)
    if (p < 2) return null
    const win = src.slice(-p)
    const peak = Math.max(...win)
    const last = win[win.length - 1]
    if (!(peak > 0)) return null
    return last / peak - 1
  }
  return null
}

function compare(v: number, op: CompareOp, threshold: number): boolean {
  if (op === '>') return v > threshold
  if (op === '>=') return v >= threshold
  if (op === '<') return v < threshold
  return v <= threshold
}

export type ConditionResult = {
  id: string
  label: string
  value: number | null
  threshold: number
  op: CompareOp
  passed: boolean | null
  error?: string
}

/** 조건 라벨을 사람이 읽는 문장으로 만든다 (UI 표시용) */
export function describeCondition(cond: Condition): string {
  const src = cond.source_ticker?.trim() || '자기 종목'
  const unit = cond.period_unit === 'months' ? '개월' : '일'
  const target = cond.target?.trim() ? `[${cond.target}] ` : ''
  const opTxt = { '>': '상회', '>=': '이상', '<': '하회', '<=': '이하' }[cond.op]
  if (cond.indicator === 'sma') {
    return `${target}${src} 현재가가 SMA ${cond.period}${unit} ${opTxt}${cond.threshold !== 0 ? ` (기준 ${(cond.threshold * 100).toFixed(1)}%)` : ''}`
  }
  if (cond.indicator === 'momentum') {
    return `${target}${src} ${cond.period}${unit} 수익률 ${opTxt} ${(cond.threshold * 100).toFixed(1)}%`
  }
  if (cond.indicator === 'drawdown') {
    return `${target}${src} 고점대비(${cond.period}${unit}) 낙폭 ${opTxt} ${(cond.threshold * 100).toFixed(1)}%`
  }
  return `${target}${src} 현재가 ${opTxt} ${Math.round(cond.threshold).toLocaleString('ko-KR')}`
}

/** 조건들을 평가하고 개별 결과 + 최종 판정을 반환 */
export function evaluateConditions(
  params: VisualRuleParams,
  series: SeriesResolver,
  selfTicker: string,
  selfMarket: string,
): { results: ConditionResult[]; overall: boolean | null } {
  const conds = params.conditions || []
  const results: ConditionResult[] = conds.map((c) => {
    const value = evaluateIndicator(c, series, selfTicker, selfMarket)
    return {
      id: c.id,
      label: describeCondition(c),
      value,
      threshold: c.threshold,
      op: c.op,
      passed: value === null ? null : compare(value, c.op, c.threshold),
      error: value === null ? '데이터 부족' : undefined,
    }
  })
  const known = results.filter((r) => r.passed !== null)
  let overall: boolean | null = null
  if (known.length) {
    overall = params.mode === 'any' ? known.some((r) => r.passed === true) : known.every((r) => r.passed === true)
  }
  return { results, overall }
}

/** 모멘텀 1위 종목 선정 (winner 동작용) */
function pickWinner(gsm: SignalRow[], params: VisualRuleParams): SignalRow | null {
  const months = params.winner_momentum_months || 12
  let cands = gsm.filter((r) => r['12M'] !== null)
  if (params.winner_sma_filter) cands = cands.filter((r) => r['SMA 위'] === 'YES')
  if (!cands.length) return null
  void months
  return [...cands].sort((a, b) => n(b['12M'], -Infinity) - n(a['12M'], -Infinity))[0]
}

/** 자산 1건의 목표금액을 동작 모드에 따라 계산 */
function targetFor(
  mode: AllocMode,
  row: SignalRow,
  ctx: { total: number; cash: number; winner: SignalRow | null; params: VisualRuleParams; restore: boolean },
): { tgt: number; note: string } {
  const { total, cash, winner, params, restore } = ctx
  switch (mode) {
    case 'target':
      if (!restore) return { tgt: row.현재금액, note: '유지(복원 시점 아님)' }
      return { tgt: (total * n(row['목표%'])) / 100, note: '목표비중 복원' }
    case 'hold':
      return { tgt: row.현재금액, note: '유지' }
    case 'cash':
      return { tgt: 0, note: '현금화' }
    case 'buy_from_cash':
      return {
        tgt: row.현재금액 + cash * n(params.buy_fraction, 0.5),
        note: `현금 ${Math.round(n(params.buy_fraction, 0.5) * 100)}% 매수`,
      }
    case 'winner':
      if (winner && winner.티커 === row.티커) {
        return { tgt: total * n(params.winner_share, 0.8), note: `1위 선정(${Math.round(n(params.winner_share, 0.8) * 100)}%)` }
      }
      return { tgt: 0, note: winner ? '미선정' : '선정 후보 없음' }
    default:
      return { tgt: row.현재금액, note: '유지' }
  }
}

/**
 * visual 규칙 실행 — 전략 전체에 하나의 조건 세트를 적용한다.
 * 조건이 `target` 을 지정한 경우 그 자산만 개별 판정한다.
 */
export function applyVisualRule(spec: Spec, vdf: SignalRow[], ctx: { quarter_end: boolean }, series: SeriesResolver): PlanRow[] {
  const code = spec.code
  const params = { ...DEFAULT_VISUAL_PARAMS, ...(spec.params as VisualRuleParams) }
  const subAll = vdf.filter((r) => r.전략 === code)
  if (!subAll.length) return []
  const equities = subAll.filter((r) => r.티커 !== 'CASH')
  const cashCur = subAll.filter((r) => r.티커 === 'CASH').reduce((a, r) => a + n(r.현재금액), 0)
  const total = equities.reduce((a, r) => a + n(r.현재금액), 0) + cashCur

  // 전략 전체 조건은 첫 비현금 자산을 기준으로 판정
  const anchor = equities[0] || subAll[0]
  const anchorEval = evaluateConditions(params, series, anchor?.티커 || '', anchor?.market || 'KR')
  const restore = params.restore_timing === 'always' || ctx.quarter_end || params.on_pass !== 'target' || params.on_fail !== 'target'
  const winner = pickWinner(equities, params)

  const rows: PlanRow[] = []
  let targetCashTgt = 0
  let seenCash = false

  for (const r of subAll) {
    if (r.티커 === 'CASH') {
      seenCash = true
      continue
    }
    // 자산별 조건이 있으면 그 조건으로, 없으면 전략 전체 판정을 사용
    const own = (params.conditions || []).filter((c) => (c.target || '').trim() && (c.target === r.role || c.target === r.티커))
    let passed: boolean | null
    let note = ''
    if (own.length) {
      const ev = evaluateConditions({ ...params, conditions: own }, series, r.티커, r.market || 'KR')
      passed = ev.overall
      note = own.map(describeCondition).join(' & ')
    } else {
      passed = anchorEval.overall
      note = anchorEval.results.map((x) => x.label).join(params.mode === 'any' ? ' 또는 ' : ' 그리고 ')
    }
    const mode = passed === true ? params.on_pass : params.on_fail
    const { tgt, note: actNote } = targetFor(mode, r, { total, cash: cashCur, winner, params, restore })
    targetCashTgt += total - tgt // 대략적 현금 잔액 (아래에서 정확히 재계산)
    rows.push({
      전략: code,
      티커: r.티커,
      ETF: r.ETF,
      현재금액: r.현재금액,
      목표금액: tgt,
      '매매액(+매수/-매도)': tgt - r.현재금액,
      비고: `${actNote}${note ? ` · ${note}` : ''}`,
    })
  }

  if (seenCash) {
    // 비현금 자산 목표의 합을 빼서 현금 목표를 잔액으로 결정
    const equityTgt = rows.reduce((a, r) => a + r.목표금액, 0)
    const cashTgt = Math.max(0, total - equityTgt)
    rows.push({
      전략: code,
      티커: 'CASH',
      ETF: '현금',
      현재금액: cashCur,
      목표금액: cashTgt,
      '매매액(+매수/-매도)': cashTgt - cashCur,
      비고: '잔여 현금',
    })
  }
  void targetCashTgt
  return rows
}
