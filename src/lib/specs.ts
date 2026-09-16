/**
 * 전략 스펙 + 리밸런싱 규칙 엔진 (원본 strategy_engine.py 의 TypeScript 포팅)
 *
 * - 전략 정의(자산 유니버스·목표비중·규칙·파라미터)는 코드가 아니라 DB 의 kv 스펙에 둔다.
 * - 규칙은 RULE_REGISTRY 로 디스패치된다 (if/elif 제거).
 * - 새 전략 = 스펙에 rule 만 지정하면 끝. 파라미터는 params 로 조정.
 * - DB/프레임워크에 의존하지 않는 순수 계산 모듈 (단위 테스트 가능).
 */

export type Asset = {
  ticker: string
  name: string
  market: 'KR' | 'US'
  role: string
  target_pct: number
  category: string
  signal_ticker?: string
}

export type Spec = {
  code: string
  account: string
  display_order: number
  description: string
  dynamic: boolean
  active: boolean
  annual_limit: number
  rule: string
  params: Record<string, any>
  assets: Asset[]
}

export type StrategyConfig = {
  code: string
  account: string
  description: string
  dynamic: boolean
  active: boolean
  annual_limit: number
}

/** 규칙 입력 행 — 리밸런싱 계산 시점의 종목별 상태 */
export type SignalRow = {
  전략: string
  티커: string
  ETF: string
  role: string
  /** 조건 판정(노코드 규칙)이 참조하는 시장 구분 */
  market: 'KR' | 'US'
  종가: number
  SMA10: number | null
  'SMA 위': string // 'YES' | 'NO' | '데이터부족' | '—'
  '12M': number | null
  현재금액: number
  '목표%': number
  분류: string
}

export type PlanRow = {
  전략: string
  티커: string
  ETF: string
  현재금액: number
  목표금액: number
  '매매액(+매수/-매도)': number
  비고: string
}

export const CATEGORY_OPTIONS = [
  '현금',
  '금',
  '선진국 주식',
  '신흥국 주식',
  '선진국 채권',
  '신흥국 채권',
  '기타',
]

/** ---------------------------------------------------------------------------
 * 기본 스펙 템플릿 — DB 에 스펙이 없을 때 이 내용으로 시드한다.
 * 이후 전략 변경은 모두 설정 UI(또는 스펙 JSON)에서만 하면 되고 코드 수정은 없다.
 * ------------------------------------------------------------------------- */
export const DEFAULT_STRATEGIES: Spec[] = [
  {
    code: 'LAA',
    account: '과세 연금저축',
    display_order: 0,
    description:
      '변형 LAA — 나스닥/유로스탁스만 10개월 SMA 필터, 이탈 시 현금화. 목표비중 복원은 분기 말에만.',
    dynamic: false,
    active: true,
    annual_limit: 0,
    rule: 'sma_filter_rebalance',
    params: { sma_roles: ['NASDAQ', 'EuroStoxx'], sma_months: 10, quarter_end_restore: true },
    assets: [
      { ticker: '133690', name: 'TIGER 미국나스닥100', market: 'KR', role: 'NASDAQ', target_pct: 12.5, category: '선진국 주식' },
      { ticker: '245350', name: 'TIGER 유로스탁스배당30', market: 'KR', role: 'EuroStoxx', target_pct: 12.5, category: '선진국 주식' },
      { ticker: '360750', name: 'TIGER 미국S&P500', market: 'KR', role: 'S&P500', target_pct: 12.5, category: '선진국 주식' },
      { ticker: '251350', name: 'KODEX 선진국MSCI World', market: 'KR', role: 'MSCI World', target_pct: 15.5, category: '선진국 주식' },
      { ticker: '132030', name: 'KODEX 골드선물(H)', market: 'KR', role: 'Gold', target_pct: 25, category: '금' },
      { ticker: '148070', name: 'KIWOOM 국고채10년', market: 'KR', role: 'Bond', target_pct: 22, category: '선진국 채권' },
      { ticker: 'CASH', name: '현금', market: 'KR', role: '필터이탈 대기현금', target_pct: 0, category: '현금' },
    ],
  },
  {
    code: 'GSM',
    account: '비과세 연금저축',
    display_order: 1,
    description:
      '글로벌 단순 모멘텀 — SMA 통과 후보 중 12개월 수익률 1위에 80% 투자, 20% 현금. 월 1회 리밸런싱.',
    dynamic: true,
    active: true,
    annual_limit: 0,
    rule: 'momentum_rotate',
    params: { sma_qualify: true, winner_share: 0.8, cash_winner_share: 0.2, cash_no_winner: 1 },
    assets: [
      { ticker: '360750', name: 'TIGER 미국S&P500', market: 'KR', role: 'GSM 후보', target_pct: 0, category: '선진국 주식' },
      { ticker: '251350', name: 'KODEX 선진국MSCI World', market: 'KR', role: 'GSM 후보', target_pct: 0, category: '선진국 주식' },
      { ticker: '133690', name: 'TIGER 미국나스닥100', market: 'KR', role: 'GSM 후보', target_pct: 0, category: '선진국 주식' },
      { ticker: '245350', name: 'TIGER 유로스탁스배당30', market: 'KR', role: 'GSM 후보', target_pct: 0, category: '선진국 주식' },
      { ticker: 'CASH', name: '현금', market: 'KR', role: '대기현금', target_pct: 20, category: '현금' },
    ],
  },
  {
    code: 'ISA',
    account: 'ISA',
    display_order: 2,
    description: '나스닥 레버리지 트리거 — 나스닥100 고점대비 -10% 하락 시 분할매수.',
    dynamic: false,
    active: true,
    annual_limit: 0,
    rule: 'drawdown_buy',
    params: { signal: { ticker: 'QQQ', market: 'US', lookback_days: 120 }, threshold: -0.1, buy_fraction: 0.5 },
    assets: [
      { ticker: '418660', name: 'TIGER 미국나스닥100레버리지(합성)', market: 'KR', role: '-10% 트리거', target_pct: 0, category: '선진국 주식', signal_ticker: 'QQQ' },
      { ticker: 'CASH', name: '현금', market: 'KR', role: '대기현금', target_pct: 100, category: '현금' },
    ],
  },
  {
    code: 'SSO',
    account: '일반계좌 2',
    display_order: 3,
    description: 'S&P500 ETF + 현금성 자산. S&P500 고점대비 -15% 하락 시 현금 절반 투입.',
    dynamic: false,
    active: true,
    annual_limit: 0,
    rule: 'drawdown_shift',
    params: {
      signal: { ticker: '360750', market: 'KR', lookback_days: 120 },
      threshold: -0.15,
      normal_stock_pct: 70,
      triggered_stock_pct: 85,
      stock_role: 'S&P500 기준',
    },
    assets: [
      { ticker: '360750', name: 'TIGER 미국S&P500', market: 'KR', role: 'S&P500 기준', target_pct: 70, category: '선진국 주식' },
      { ticker: '153130', name: 'KODEX 단기채권', market: 'KR', role: '현금성', target_pct: 30, category: '현금' },
    ],
  },
  {
    code: 'EM',
    account: '일반계좌 1',
    display_order: 4,
    description: '신흥국 분산 장기보유. 리밸런싱은 연 1회 정도만.',
    dynamic: false,
    active: true,
    annual_limit: 0,
    rule: 'hold',
    params: { hold_note: '매매 없음(연 1회만 허용)' },
    assets: [
      { ticker: '069500', name: 'KODEX 200', market: 'KR', role: '한국', target_pct: 25, category: '신흥국 주식' },
      { ticker: '', name: '중국 ETF 입력', market: 'KR', role: '중국', target_pct: 25, category: '신흥국 주식' },
      { ticker: '', name: '인도 ETF 입력', market: 'KR', role: '인도', target_pct: 25, category: '신흥국 주식' },
      { ticker: '', name: '베트남 ETF 입력', market: 'KR', role: '베트남', target_pct: 25, category: '신흥국 주식' },
    ],
  },
]

/* ---------------------------------------------------------------------------
 * 규칙 레지스트리 — 새 규칙은 registerRule('이름') 으로 추가하고
 * 스펙에서 rule: '이름' 만 지정하면 된다.
 * ------------------------------------------------------------------------- */
export type SeriesResolver = (market: string, ticker: string) => { monthly: number[]; daily: number[] }

export type RuleContext = {
  quarter_end: boolean
  trigger_dd: Record<string, number | null>
  /** 노코드(visual) 규칙이 참조할 가격 시계열 접근자 */
  series?: SeriesResolver
}

export type RuleFn = (spec: Spec, vdf: SignalRow[], ctx: RuleContext) => PlanRow[]

export const RULE_REGISTRY: Record<string, RuleFn> = {}

export const RULE_DESC: Record<string, string> = {
  static: '정적 비중 복원 (사용자 추가 전략 기본)',
  sma_filter_rebalance: 'SMA 필터 + 분기말 목표 복원 (LAA형)',
  momentum_rotate: '모멘텀 로테이션 — SMA 통과 후보 중 12M 1위 (GSM형)',
  drawdown_buy: '낙폭 트리거 분할매수 — 신호 고점대비 하락 시 현금 일부 투입 (ISA형)',
  drawdown_shift: '낙폭 트리거 비중 전환 — 발동 시 주식 비중 상향 (SSO형)',
  hold: '보유 유지 — 리밸런싱 없음 (EM형)',
}

export const RULE_FRIENDLY_NAME: Record<string, string> = {
  static: '정적 비중 복원',
  sma_filter_rebalance: 'SMA 필터 + 분기말 복원 (LAA)',
  momentum_rotate: '모멘텀 로테이션 (GSM)',
  drawdown_buy: '낙폭 트리거 분할매수 (ISA)',
  drawdown_shift: '낙폭 트리거 비중 전환 (SSO)',
  hold: '보유 유지 (EM)',
}

/** 규칙별 사용자 입력 스키마 — 설정 UI 가 이 정의로 입력칸을 자동 생성한다. */
export type UiField = {
  path: string[]
  label: string
  type: 'bool' | 'int' | 'float' | 'fraction_pct' | 'select' | 'csv_list' | 'text'
  default?: any
  min?: number
  max?: number
  step?: number
  options?: string[]
  help?: string
}

export const RULE_UI_SCHEMA: Record<string, UiField[]> = {
  static: [],
  sma_filter_rebalance: [
    { path: ['sma_roles'], label: 'SMA 필터 적용 role (쉼표 구분)', type: 'csv_list', default: ['NASDAQ', 'EuroStoxx'], help: '이 role 의 자산만 SMA 필터를 적용하고, 이탈 시 현금화합니다.' },
    { path: ['sma_months'], label: 'SMA 개월 수', type: 'int', default: 10, min: 2, max: 24 },
    { path: ['quarter_end_restore'], label: '분기말에만 목표비중 복원', type: 'bool', default: true, help: '체크하면 분기말(3·6·9·12월)에만 목표비중을 복원합니다.' },
  ],
  momentum_rotate: [
    { path: ['sma_qualify'], label: 'SMA 통과 후보만 선정', type: 'bool', default: true },
    { path: ['winner_share'], label: '1위 종목 투자비중', type: 'fraction_pct', default: 0.8, min: 0, max: 100, help: '% 단위로 입력합니다.' },
    { path: ['cash_winner_share'], label: '선정 시 현금비중', type: 'fraction_pct', default: 0.2, min: 0, max: 100 },
    { path: ['cash_no_winner'], label: '전 후보 이탈 시 현금비중', type: 'fraction_pct', default: 1.0, min: 0, max: 100 },
  ],
  drawdown_buy: [
    { path: ['signal', 'ticker'], label: '신호 티커', type: 'text', default: 'QQQ', help: '고점대비 하락률을 계산할 신호 종목입니다.' },
    { path: ['signal', 'market'], label: '신호 시장', type: 'select', default: 'US', options: ['US', 'KR'] },
    { path: ['signal', 'lookback_days'], label: '고점 룩백(거래일)', type: 'int', default: 120, min: 20, max: 500 },
    { path: ['threshold'], label: '발동 임계 하락률', type: 'fraction_pct', default: -0.1, min: -100, max: 0, help: '예: -10% → -10 입력' },
    { path: ['buy_fraction'], label: '현금 투입 비율', type: 'fraction_pct', default: 0.5, min: 0, max: 100 },
  ],
  drawdown_shift: [
    { path: ['signal', 'ticker'], label: '신호 티커', type: 'text', default: '360750' },
    { path: ['signal', 'market'], label: '신호 시장', type: 'select', default: 'KR', options: ['US', 'KR'] },
    { path: ['signal', 'lookback_days'], label: '고점 룩백(거래일)', type: 'int', default: 120, min: 20, max: 500 },
    { path: ['threshold'], label: '발동 임계 하락률', type: 'fraction_pct', default: -0.15, min: -100, max: 0 },
    { path: ['normal_stock_pct'], label: '평시 주식비중', type: 'float', default: 70, min: 0, max: 100 },
    { path: ['triggered_stock_pct'], label: '발동 시 주식비중', type: 'float', default: 85, min: 0, max: 100 },
    { path: ['stock_role'], label: '주식 자산의 role', type: 'text', default: 'S&P500 기준' },
  ],
  hold: [{ path: ['hold_note'], label: '보유 메모', type: 'text', default: '매매 없음(연 1회만 허용)' }],
}

export function registerRule(key: string, fn: RuleFn): void {
  RULE_REGISTRY[key] = fn
}

const n = (v: any, d = 0): number => {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return d
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}
const pf = (x: number | null | undefined): string =>
  x === null || x === undefined || Number.isNaN(Number(x)) ? '데이터 없음' : `${(Number(x) * 100).toFixed(2)}%`

/* ---------------------------------------------------------------------------
 * 규칙 1: 정적 비중 복원 (사용자 추가 전략 기본 규칙)
 * ------------------------------------------------------------------------- */
registerRule('static', (spec, vdf) => {
  const code = spec.code
  const subAll = vdf.filter((r) => r.전략 === code)
  if (!subAll.length) return []
  const sub = subAll.filter((r) => r.티커 !== 'CASH')
  const cash = subAll.filter((r) => r.티커 === 'CASH').reduce((a, r) => a + n(r.현재금액), 0)
  const total = sub.reduce((a, r) => a + n(r.현재금액), 0) + cash
  const rows: PlanRow[] = sub.map((r) => {
    const tgt = (total * n(r['목표%'])) / 100
    return {
      전략: code,
      티커: r.티커,
      ETF: r.ETF,
      현재금액: r.현재금액,
      목표금액: tgt,
      '매매액(+매수/-매도)': tgt - r.현재금액,
      비고: '목표비중 리밸런싱',
    }
  })
  if (cash > 0 || subAll.some((r) => r.티커 === 'CASH')) {
    const cashPct = subAll.filter((r) => r.티커 === 'CASH').reduce((a, r) => a + n(r['목표%']), 0)
    const cashTgt = (total * cashPct) / 100
    rows.push({
      전략: code,
      티커: 'CASH',
      ETF: '현금',
      현재금액: cash,
      목표금액: cashTgt,
      '매매액(+매수/-매도)': cashTgt - cash,
      비고: '현금 목표비중',
    })
  }
  return rows
})

/* ---------------------------------------------------------------------------
 * 규칙 2: SMA 필터 리밸런싱 (LAA형)
 * ------------------------------------------------------------------------- */
registerRule('sma_filter_rebalance', (spec, vdf, ctx) => {
  const code = spec.code
  const params = spec.params || {}
  const subAll = vdf.filter((r) => r.전략 === code)
  if (!subAll.length) return []
  const laa = subAll.filter((r) => r.티커 !== 'CASH')
  const cashRow = subAll.filter((r) => r.티커 === 'CASH')
  const cashCur = cashRow.reduce((a, r) => a + n(r.현재금액), 0)
  const total = laa.reduce((a, r) => a + n(r.현재금액), 0) + cashCur
  let cashPct = cashRow.reduce((a, r) => a + n(r['목표%']), 0)
  const smaRoles: string[] = params.sma_roles || []
  const quarterEnd = !!ctx.quarter_end
  const rows: PlanRow[] = []

  for (const r of laa) {
    const filtered = smaRoles.includes(r.role)
    const breached = filtered && r['SMA 위'] === 'NO'
    if (breached) cashPct += n(r['목표%'])
    let tgt: number
    let note: string
    if (breached) {
      tgt = 0
      note = 'SMA 이탈 → 현금화'
    } else if (quarterEnd) {
      tgt = (total * n(r['목표%'])) / 100
      note = '목표비중 복원(분기말)'
    } else {
      tgt = r.현재금액
      note = '유지(분기중)'
    }
    rows.push({
      전략: code,
      티커: r.티커,
      ETF: r.ETF,
      현재금액: r.현재금액,
      목표금액: tgt,
      '매매액(+매수/-매도)': tgt - r.현재금액,
      비고: note,
    })
  }
  const cashTgt = (total * cashPct) / 100
  rows.push({
    전략: code,
    티커: 'CASH',
    ETF: '현금',
    현재금액: cashCur,
    목표금액: cashTgt,
    '매매액(+매수/-매도)': cashTgt - cashCur,
    비고: '필터 이탈 자산 보관',
  })
  return rows
})

/* ---------------------------------------------------------------------------
 * 규칙 3: 모멘텀 로테이션 (GSM형)
 * ------------------------------------------------------------------------- */
registerRule('momentum_rotate', (spec, vdf) => {
  const code = spec.code
  const params = spec.params || {}
  const subAll = vdf.filter((r) => r.전략 === code)
  if (!subAll.length) return []
  const gsm = subAll.filter((r) => r.티커 !== 'CASH')
  const cashCur = subAll.filter((r) => r.티커 === 'CASH').reduce((a, r) => a + n(r.현재금액), 0)
  const total = gsm.reduce((a, r) => a + n(r.현재금액), 0) + cashCur
  const passing = gsm
    .filter((r) => r['SMA 위'] === 'YES')
    .sort((a, b) => n(b['12M'], -Infinity) - n(a['12M'], -Infinity))
  const winner = passing.length ? passing[0] : null
  const winShare = n(params.winner_share, 0.8)
  const rows: PlanRow[] = gsm.map((r) => {
    const isWinner = winner !== null && r.티커 === winner.티커
    const tgt = isWinner ? total * winShare : 0
    const note = isWinner
      ? `선정(${Math.round(winShare * 100)}%)`
      : r['SMA 위'] === 'NO'
        ? 'SMA 이탈'
        : r['SMA 위'] === '데이터부족'
          ? '데이터부족'
          : '미선정(순위 밀림)'
    return { 전략: code, 티커: r.티커, ETF: r.ETF, 현재금액: r.현재금액, 목표금액: tgt, '매매액(+매수/-매도)': tgt - r.현재금액, 비고: note }
  })
  const cashTgt =
    winner !== null ? total * n(params.cash_winner_share, 0.2) : total * n(params.cash_no_winner, 1.0)
  rows.push({
    전략: code,
    티커: 'CASH',
    ETF: '현금',
    현재금액: cashCur,
    목표금액: cashTgt,
    '매매액(+매수/-매도)': cashTgt - cashCur,
    비고: winner !== null ? '전략 대기현금' : '전 후보 SMA 이탈',
  })
  return rows
})

/* ---------------------------------------------------------------------------
 * 규칙 4: 낙폭 트리거 분할매수 (ISA형)
 * ------------------------------------------------------------------------- */
registerRule('drawdown_buy', (spec, vdf, ctx) => {
  const code = spec.code
  const params = spec.params || {}
  const subAll = vdf.filter((r) => r.전략 === code)
  if (!subAll.length) return []
  const sub = subAll.filter((r) => r.티커 !== 'CASH')
  const cash = subAll.filter((r) => r.티커 === 'CASH').reduce((a, r) => a + n(r.현재금액), 0)
  if (!sub.length) return []
  const r = sub[0]
  const dd = ctx.trigger_dd?.[code]
  const threshold = n(params?.threshold, -0.1)
  const sigName = params?.signal?.ticker || ''
  const triggered = dd !== null && dd !== undefined && Number(dd) <= threshold
  const buy = triggered ? cash * n(params?.buy_fraction, 0.5) : 0
  const note = triggered
    ? `트리거 발동(${sigName} 고점대비 ${pf(dd)}) → 현금 절반 분할매수`
    : `대기(${sigName} 고점대비 ${dd === null || dd === undefined ? '데이터 없음' : pf(dd)})`
  return [
    { 전략: code, 티커: r.티커, ETF: r.ETF, 현재금액: r.현재금액, 목표금액: r.현재금액 + buy, '매매액(+매수/-매도)': buy, 비고: note },
    { 전략: code, 티커: 'CASH', ETF: '현금', 현재금액: cash, 목표금액: cash - buy, '매매액(+매수/-매도)': -buy, 비고: '매수 재원' },
  ]
})

/* ---------------------------------------------------------------------------
 * 규칙 5: 낙폭 트리거 비중 전환 (SSO형)
 * ------------------------------------------------------------------------- */
registerRule('drawdown_shift', (spec, vdf, ctx) => {
  const code = spec.code
  const params = spec.params || {}
  const subAll = vdf.filter((r) => r.전략 === code)
  if (!subAll.length) return []
  const total = subAll.reduce((a, r) => a + n(r.현재금액), 0)
  const dd = ctx.trigger_dd?.[code]
  const threshold = n(params?.threshold, -0.15)
  const triggered = dd !== null && dd !== undefined && Number(dd) <= threshold
  const stockPct = triggered ? n(params?.triggered_stock_pct, 85) : n(params?.normal_stock_pct, 70)
  const stockRole = params?.stock_role
  return subAll.map((r) => {
    const isStock = r.role === stockRole
    const tgt = (total * (isStock ? stockPct : 100 - stockPct)) / 100
    const note = isStock
      ? triggered
        ? `트리거 발동(고점대비 ${pf(dd)}) → 현금 절반 투입`
        : `평시 유지(고점대비 ${dd === null || dd === undefined ? '데이터 없음' : pf(dd)})`
      : triggered
        ? '트리거 발동 → 현금 축소'
        : '평시 유지'
    return { 전략: code, 티커: r.티커, ETF: r.ETF, 현재금액: r.현재금액, 목표금액: tgt, '매매액(+매수/-매도)': tgt - r.현재금액, 비고: note }
  })
})

/* ---------------------------------------------------------------------------
 * 규칙 6: 보유 유지 (EM형)
 * ------------------------------------------------------------------------- */
registerRule('hold', (spec, vdf) => {
  const code = spec.code
  const note = spec.params?.hold_note || '매매 없음'
  return vdf
    .filter((r) => r.전략 === code)
    .map((r) => ({
      전략: code,
      티커: r.티커 || '-',
      ETF: r.ETF,
      현재금액: r.현재금액,
      목표금액: r.현재금액,
      '매매액(+매수/-매도)': 0,
      비고: note,
    }))
})

export function applyStrategy(spec: Spec, vdf: SignalRow[], ctx: RuleContext): PlanRow[] {
  const fn = RULE_REGISTRY[spec.rule] || RULE_REGISTRY['static']
  return fn(spec, vdf, ctx)
}

/* ---------------------------------------------------------------------------
 * 스펙 헬퍼
 * ------------------------------------------------------------------------- */
export function specsFromText(txt: string): Record<string, Spec> {
  const data = JSON.parse(txt)
  const out: Record<string, Spec> = {}
  for (const s of data.strategies || []) out[s.code] = s
  return out
}

export function specsToJson(specs: Record<string, Spec>): string {
  const ordered = Object.values(specs).sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99))
  return JSON.stringify({ strategies: ordered }, null, 2)
}

export function specsToConfigs(specs: Record<string, Spec>): StrategyConfig[] {
  return Object.values(specs)
    .sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99))
    .map((s) => ({
      code: s.code,
      account: s.account ?? s.code,
      description: s.description ?? '',
      dynamic: !!s.dynamic,
      active: s.active !== false,
      annual_limit: n(s.annual_limit, 0),
    }))
}

export function orderedCodes(cfgs: StrategyConfig[], specs: Record<string, Spec>): string[] {
  const codes = cfgs.map((c) => c.code)
  const known = Object.values(specs)
    .sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99))
    .filter((s) => codes.includes(s.code))
    .map((s) => s.code)
  const rest = codes.filter((c) => !specs[c])
  return [...known, ...rest]
}

/* ---------------------------------------------------------------------------
 * 순수 계산 헬퍼
 * ------------------------------------------------------------------------- */
export function calcSignals(prices: number[], close: number): { sma: number | null; mom: number | null } {
  const p = (prices || []).map((x) => n(x)).filter((x) => x > 0)
  const sma = p.length >= 10 ? p.slice(-10).reduce((a, b) => a + b, 0) / 10 : null
  const mom = p.length >= 13 && p[p.length - 13] ? p[p.length - 1] / p[p.length - 13] - 1 : null
  return { sma, mom }
}

export function drawdownFromPeak(closes: number[]): number | null {
  const c = (closes || []).map((x) => n(x)).filter((x) => x > 0)
  if (!c.length) return null
  const peak = Math.max(...c)
  if (peak <= 0) return null
  return c[c.length - 1] / peak - 1
}
