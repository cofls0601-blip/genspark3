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
    params: { sma_tickers: ['133690', '245350'], sma_months: 10, quarter_end_restore: true },
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
      stock_ticker: '360750',
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

/**
 * 규칙별 '종목별 목표비중(target_pct) 입력이 필요한가' 메타데이터.
 *  - 'asset' : 종목별 목표% 를 실제로 사용한다 → 설정 화면에서 입력받고 합계 100% 를 검증한다.
 *  - 'rule'  : 비중은 규칙 파라미터가 결정한다(예: GSM 1위 80%/현금 20%, SSO 70→85%)
 *              → 종목별 목표% 는 쓰지 않으므로 입력을 요구하지 않고 할 일 목록에도 반영하지 않는다.
 *  - 'none'  : 목표비중 개념이 없다(장기 보유) → 매매 계획을 만들지 않는다.
 */
export const RULE_WEIGHT_USAGE: Record<string, 'asset' | 'rule' | 'none'> = {
  static: 'asset',
  sma_filter_rebalance: 'asset',
  visual: 'asset', // on_pass/on_fail 이 'target' 일 때만 실제 사용 (ruleUsesAssetWeights 참고)
  momentum_rotate: 'rule',
  drawdown_buy: 'rule',
  drawdown_shift: 'rule',
  hold: 'none',
}

/** 설정 화면에 표시할 규칙별 비중 안내 문구 */
export const RULE_WEIGHT_NOTE: Record<string, string> = {
  static: '종목별 목표% 를 입력하면 그 비중으로 맞춥니다.',
  sma_filter_rebalance: '종목별 목표% 를 입력하면 SMA 이탈 종목을 현금화하고 분기말에 복원합니다.',
  visual: '조건 충족 시 동작이 “목표비중으로 복원”일 때만 종목별 목표% 를 사용합니다.',
  momentum_rotate: '비중은 규칙이 정합니다(1위 자산 80% / 현금 20%). 종목별 목표% 는 쓰지 않습니다.',
  drawdown_buy: '비중은 규칙이 정합니다(트리거 발동 시 대기현금의 50% 매수). 종목별 목표% 는 쓰지 않습니다.',
  drawdown_shift: '비중은 규칙이 정합니다(발동 시 주식 비중 상향). 종목별 목표% 는 쓰지 않습니다.',
  hold: '장기 보유 전략입니다. 매매 계획을 만들지 않아 할 일 목록에 나타나지 않습니다.',
}

/**
 * 이 규칙(스펙)이 종목별 목표% 를 실제로 쓰는지 판정한다.
 * 노코드(visual) 규칙은 '목표비중으로 복원' 동작을 쓸 때만 비중이 필요하다.
 */
export function ruleUsesAssetWeights(rule: string, params?: Record<string, any> | null): boolean {
  const basis = RULE_WEIGHT_USAGE[rule] || 'asset'
  if (basis !== 'asset') return false
  if (rule === 'visual') {
    const p = params || {}
    return p.on_pass === 'target' || p.on_fail === 'target'
  }
  return true
}

/**
 * 전략별 비중 사용 메타데이터를 한 번에 만든다 (설정 UI 가 그대로 소비).
 *  - usesWeights: 종목별 목표% 입력칸을 보여줄지 여부
 *  - note: 이 전략의 비중이 어떻게 정해지는지 안내 문구
 */
export function weightMetaOf(
  specs: Record<string, Spec>,
): Record<string, { usage: 'asset' | 'rule' | 'none'; usesWeights: boolean; note: string }> {
  const out: Record<string, { usage: 'asset' | 'rule' | 'none'; usesWeights: boolean; note: string }> = {}
  for (const [code, sp] of Object.entries(specs || {})) {
    const rule = sp?.rule || 'static'
    out[code] = {
      usage: RULE_WEIGHT_USAGE[rule] || 'asset',
      usesWeights: ruleUsesAssetWeights(rule, sp?.params),
      note: RULE_WEIGHT_NOTE[rule] || '',
    }
  }
  return out
}

// 설정 화면은 이 메타데이터를 읽어 자동으로 입력칸을 만든다.
// 전략별 숫자/종목/조건은 specs(스펙 JSON)에만 저장되고, 화면 코드는 전략마다 하드코딩하지 않는다.
export const RULE_FRIENDLY_NAME: Record<string, string> = {
  static: '목표비중으로 맞추기',
  sma_filter_rebalance: '추세(SMA) 필터 + 정기 복원',
  momentum_rotate: '모멘텀 상위 자산 선택',
  drawdown_buy: '고점 대비 하락 시 분할매수',
  drawdown_shift: '고점 대비 하락 시 비중 전환',
  hold: '장기 보유(자동 리밸런싱 없음)',
  // 노코드 빌더도 하나의 '규칙'이다. 여기에 없으면 규칙 드롭다운에 나타나지 않아
  // 한 번 노코드로 전환한 전략은 내장 규칙으로 되돌아올 수 없다.
  visual: '노코드 규칙 빌더(조건 직접 조립)',
}

/**
 * 규칙 선택 드롭다운에 노출할 순서. RULE_FRIENDLY_NAME 의 키를 그대로 쓰되,
 * 화면에서 먼저 보여주고 싶은 순서를 명시한다(누락된 규칙은 뒤에 자동 추가).
 */
export const RULE_ORDER: string[] = [
  'static',
  'sma_filter_rebalance',
  'momentum_rotate',
  'drawdown_buy',
  'drawdown_shift',
  'hold',
  'visual',
]

/** 드롭다운/설정 화면용 규칙 목록 (등록된 규칙만, 순서 보장) */
export function ruleChoices(): { v: string; t: string }[] {
  const known = RULE_ORDER.filter((r) => RULE_FRIENDLY_NAME[r])
  const rest = Object.keys(RULE_FRIENDLY_NAME).filter((r) => !known.includes(r))
  return [...known, ...rest].map((r) => ({ v: r, t: RULE_FRIENDLY_NAME[r] }))
}

/**
 * 한국 상장코드는 항상 6자리다. 규칙 설정 화면에 사용자가 '69500'처럼 앞자리 0을 빼고
 * 입력해도 실제 보유 종목 티커('069500')와 매칭되도록 양쪽을 같은 형식으로 맞춘다.
 */
export function normTicker(t: any): string {
  const s = String(t ?? '').trim()
  return /^\d+$/.test(s) ? s.padStart(6, '0') : s.toUpperCase()
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
    {
      path: ['sma_tickers'],
      label: 'SMA를 적용할 티커',
      type: 'csv_list',
      default: [],
      help: 'SMA 상회/하회를 볼 실제 보유 종목의 티커를 쉼표로 구분해 입력하세요(이 전략에 이미 들어있는 종목이어야 합니다). 예: 133690, 245350',
    },
    { path: ['sma_months'], label: '이동평균 기간(개월)', type: 'int', default: 10, min: 1, max: 60, step: 1 },
    { path: ['quarter_end_restore'], label: '분기말에 목표비중으로 복원', type: 'bool', default: true },
  ],
  momentum_rotate: [
    { path: ['sma_qualify'], label: 'SMA 통과 자산만 후보로 사용', type: 'bool', default: true },
    { path: ['winner_share'], label: '1등 자산 투자비중(%)', type: 'fraction_pct', default: 0.8, min: 0, max: 100, step: 1 },
    { path: ['cash_winner_share'], label: '1등 선정 시 현금비중(%)', type: 'fraction_pct', default: 0.2, min: 0, max: 100, step: 1 },
    { path: ['cash_no_winner'], label: '통과 자산이 없을 때 현금비중(%)', type: 'fraction_pct', default: 1.0, min: 0, max: 100, step: 1 },
  ],
  drawdown_buy: [
    { path: ['signal', 'ticker'], label: '하락률 판단 기준 티커', type: 'text', default: 'QQQ' },
    { path: ['signal', 'market'], label: '기준 티커 시장', type: 'select', default: 'US', options: ['US', 'KR'] },
    { path: ['signal', 'lookback_days'], label: '최근 고점 확인 기간(거래일)', type: 'int', default: 120, min: 20, max: 500, step: 5 },
    { path: ['threshold'], label: '매수 발동 하락률(%)', type: 'fraction_pct', default: -0.1, min: -90, max: 0, step: 1, help: '예: -10 입력 → 최근 고점 대비 -10% 이하에서 발동' },
    { path: ['buy_fraction'], label: '발동 시 대기현금 투입비중(%)', type: 'fraction_pct', default: 0.5, min: 0, max: 100, step: 5 },
  ],
  drawdown_shift: [
    { path: ['signal', 'ticker'], label: '하락률 판단 기준 티커', type: 'text', default: '360750' },
    { path: ['signal', 'market'], label: '기준 티커 시장', type: 'select', default: 'KR', options: ['KR', 'US'] },
    { path: ['signal', 'lookback_days'], label: '최근 고점 확인 기간(거래일)', type: 'int', default: 120, min: 20, max: 500, step: 5 },
    { path: ['threshold'], label: '비중 전환 발동 하락률(%)', type: 'fraction_pct', default: -0.15, min: -90, max: 0, step: 1 },
    {
      path: ['normal_stock_pct'],
      label: '평상시 주식비중(%)',
      type: 'float',
      default: 70,
      min: 0,
      max: 100,
      step: 1,
      help: '발동 전에는 매매하지 않습니다. 안내 문구용 기준값입니다.',
    },
    {
      path: ['triggered_stock_pct'],
      label: '발동 시 주식비중(%)',
      type: 'float',
      default: 85,
      min: 0,
      max: 100,
      step: 1,
      help: '트리거가 발동하면 주식 바스켓을 이 비중으로 올리고 현금을 줄입니다.',
    },
  ],
  hold: [{ path: ['hold_note'], label: '리밸런싱 메모', type: 'text', default: '매매 없음(연 1회만 허용)' }],
}

export function registerRule(key: string, fn: RuleFn): void {
  RULE_REGISTRY[key] = fn
}

/**
 * 구버전 스펙(예: sma_roles=['NASDAQ'])은 역할명 텍스트로 매칭했는데, 이제는 실제 티커로 매칭한다.
 * 엔진 자체는 구버전 키도 계속 읽어서(하위호환) 저장 안 해도 안 깨지지만, 화면에 빈 칸으로 보이면
 * "설정이 사라졌나?" 싶을 수 있어서, 현재 보유 종목의 role 을 역참조해 화면에 보여줄 값만 미리 채운다.
 * 실제 저장은 여전히 [이 규칙 저장] 을 눌러야 이뤄진다.
 */
export function migrateLegacyRoleParams(
  rule: string,
  params: Record<string, any>,
  assets: { strategy: string; ticker: string; role: string }[],
  code: string,
): Record<string, any> {
  const out: Record<string, any> = { ...(params || {}) }
  const sub = (assets || []).filter((a) => a.strategy === code)
  if (rule === 'sma_filter_rebalance' && !out.sma_tickers && Array.isArray(out.sma_roles)) {
    const roles = new Set(out.sma_roles)
    const tickers = sub.filter((a) => roles.has(a.role)).map((a) => a.ticker)
    if (tickers.length) out.sma_tickers = tickers
  }
  if (rule === 'drawdown_shift' && !out.stock_ticker && out.stock_role) {
    const match = sub.find((a) => a.role === out.stock_role)
    if (match) out.stock_ticker = match.ticker
  }
  return out
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
  // sma_tickers(신규, 실제 티커 매칭)가 있으면 그걸 쓰고, 없으면 구버전 sma_roles(역할명 텍스트 매칭)로
  // 동작한다 — 전략 규칙 설정 화면에서 다시 저장하기 전까지 기존 설정이 조용히 깨지지 않게 하기 위함.
  const smaTickers = new Set<string>((params.sma_tickers || []).map((t: any) => normTicker(t)))
  const smaRolesLegacy: string[] = params.sma_roles || []
  const quarterEnd = !!ctx.quarter_end
  const rows: PlanRow[] = []

  for (const r of laa) {
    const filtered = smaTickers.has(normTicker(r.티커)) || (smaTickers.size === 0 && smaRolesLegacy.includes(r.role))
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

  // SMA/12M 신호를 계산할 수 없는 후보는 판정 자체가 불가능하다.
  // 데이터 부족만으로 전량 매도/현금화를 제안하지 않도록, 이런 자산은 교체 대상에서 제외하고 보유를 유지한다.
  const deficient = gsm.filter((r) => r['SMA 위'] === '데이터부족')
  const usable = gsm.filter((r) => r['SMA 위'] !== '데이터부족')

  const passing = usable
    .filter((r) => r['SMA 위'] === 'YES')
    .sort((a, b) => n(b['12M'], -Infinity) - n(a['12M'], -Infinity))
  const winner = passing.length ? passing[0] : null
  const winShare = n(params.winner_share, 0.8)

  // 규칙이 관리하지 않는(데이터 부족) 자산은 투자 가능 금액에서 빼야 합계가 100% 를 넘지 않는다.
  const heldValue = deficient.reduce((a, r) => a + n(r.현재금액), 0)
  const pool = total - heldValue

  const rows: PlanRow[] = deficient.map((r) => ({
    전략: code,
    티커: r.티커,
    ETF: r.ETF,
    현재금액: r.현재금액,
    목표금액: r.현재금액,
    '매매액(+매수/-매도)': 0,
    비고: '데이터부족 · 보유 유지',
  }))

  for (const r of usable) {
    const isWinner = winner !== null && r.티커 === winner.티커
    const tgt = isWinner ? pool * winShare : 0
    const note = isWinner ? `선정(${Math.round(winShare * 100)}%)` : r['SMA 위'] === 'NO' ? 'SMA 이탈' : '미선정(순위 밀림)'
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

  const cashTgt =
    winner !== null
      ? pool * n(params.cash_winner_share, 0.2)
      : usable.length
        ? pool * n(params.cash_no_winner, 1.0)
        : cashCur // 판정 가능한 후보가 하나도 없으면 현금도 그대로 둔다
  rows.push({
    전략: code,
    티커: 'CASH',
    ETF: '현금',
    현재금액: cashCur,
    목표금액: cashTgt,
    '매매액(+매수/-매도)': cashTgt - cashCur,
    비고: winner !== null ? '전략 대기현금' : usable.length ? '전 후보 SMA 이탈' : '후보 데이터 부족 · 유지',
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
  const equities = subAll.filter((r) => r.티커 !== 'CASH')
  const cashCur = subAll.filter((r) => r.티커 === 'CASH').reduce((a, r) => a + n(r.현재금액), 0)
  const total = equities.reduce((a, r) => a + n(r.현재금액), 0) + cashCur

  const dd = ctx.trigger_dd?.[code]
  const threshold = n(params?.threshold, -0.15)
  const triggered = dd !== null && dd !== undefined && Number(dd) <= threshold
  const normalPct = n(params?.normal_stock_pct, 70)
  const triggeredPct = n(params?.triggered_stock_pct, 85)
  const sigName = params?.signal?.ticker || ''
  const ddTxt = dd === null || dd === undefined ? '데이터 없음' : pf(dd)

  // 트리거 전에는 매매하지 않는다. 이 규칙은 '발동 시 비중 전환'이 목적이므로,
  // 평시에 종목별 목표% 를 맞추려고 매매를 만들면 할 일 목록만 불필요하게 늘어난다.
  if (!triggered) {
    return subAll.map((r) => ({
      전략: code,
      티커: r.티커,
      ETF: r.ETF,
      현재금액: r.현재금액,
      목표금액: r.현재금액,
      '매매액(+매수/-매도)': 0,
      비고:
        r.티커 === 'CASH'
          ? `대기(${sigName} 고점대비 ${ddTxt}) · 매매 없음`
          : `평시 유지(주식 ${normalPct}% 기준) · 매매 없음`,
    }))
  }

  // 발동: 주식 바스켓 전체를 triggeredPct 로 올리고 현금을 나머지로 줄인다.
  const stockTgt = (total * triggeredPct) / 100
  const cashTgt = total - stockTgt
  const eqCur = equities.reduce((a, r) => a + n(r.현재금액), 0)
  const rows: PlanRow[] = equities.map((r) => {
    // 바스켓 안에서 현재 비중대로 나눠 담는다 (보유하지 않은 종목을 새로 만들지 않는다).
    const share = eqCur > 0 ? n(r.현재금액) / eqCur : 1 / Math.max(1, equities.length)
    const tgt = stockTgt * share
    return {
      전략: code,
      티커: r.티커,
      ETF: r.ETF,
      현재금액: r.현재금액,
      목표금액: tgt,
      '매매액(+매수/-매도)': tgt - n(r.현재금액),
      비고: `트리거 발동(${sigName} 고점대비 ${ddTxt}) → 주식 ${normalPct}% → ${triggeredPct}%`,
    }
  })
  rows.push({
    전략: code,
    티커: 'CASH',
    ETF: '현금',
    현재금액: cashCur,
    목표금액: cashTgt,
    '매매액(+매수/-매도)': cashTgt - cashCur,
    비고: '발동 → 현금 축소',
  })
  return rows
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
