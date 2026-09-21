/**
 * 문헌으로 보고된 자산배분 전략 템플릿 라이브러리.
 *
 *  - 정적(static)  : 목표비중이 고정되어 있고 주기적으로 그 비중으로 되돌린다.
 *  - 동적(dynamic) : 추세/모멘텀 신호에 따라 비중이 바뀐다(규칙이 비중을 정한다).
 *
 * 각 템플릿은 '완성품'이 아니라 **출발점**이다. 사용자가 저장한 뒤 자산·목표% 를
 * 가감해서 자기 전략으로 만드는 것을 전제로 한다.
 *
 * 시장/티커 표기
 *  - 문헌의 자산군을 그대로 재현하려고 미국 상장 ETF(SPY·TLT·GLD …)를 기본으로 쓴다.
 *  - `kr` 이 있으면 한국 상장 ETF 근사 대체 티커다(설정 화면의 '한국 ETF로 변환' 옵션).
 *    완전히 같은 지수가 아니므로 참고용 근사치다.
 */
export type TemplateAsset = {
  /** 티커 */
  t: string
  /** 종목명 */
  n: string
  /** 시장 */
  m: 'KR' | 'US'
  /** 역할 표기 */
  r: string
  /** 목표비중(%) */
  p: number
  /** 자산군 */
  c: string
  /** 한국 상장 ETF 근사 대체 */
  kr?: { t: string; n: string }
}

export type StrategyTemplate = {
  id: string
  name: string
  /** 정적 / 동적 */
  kind: 'static' | 'dynamic'
  /** 계열 (예: 'Keller TAA', '고정비중') */
  family: string
  /** 기본 규칙 */
  rule: string
  params: Record<string, any>
  description: string
  /** 출처(문헌) */
  source: string
  /** 리밸런싱 주기 안내 */
  rebalance: string
  /** 기대 특성 */
  trait: string
  assets: TemplateAsset[]
}

const CAT = {
  cash: '현금',
  gold: '금',
  dev: '선진국 주식',
  em: '신흥국 주식',
  devBond: '선진국 채권',
  emBond: '신흥국 채권',
  etc: '기타',
} as const

/** 미국 ETF → 한국 상장 ETF 근사 대체 (동일 지수는 아니고 유사 노출) */
const KR: Record<string, { t: string; n: string }> = {
  SPY: { t: '360750', n: 'TIGER 미국S&P500' },
  VTI: { t: '360750', n: 'TIGER 미국S&P500' },
  QQQ: { t: '133690', n: 'TIGER 미국나스닥100' },
  EFA: { t: '251350', n: 'KODEX 선진국MSCI World' },
  VEA: { t: '251350', n: 'KODEX 선진국MSCI World' },
  VXUS: { t: '251350', n: 'KODEX 선진국MSCI World' },
  EEM: { t: '195930', n: 'TIGER 신흥국MSCI' },
  VWO: { t: '195930', n: 'TIGER 신흥국MSCI' },
  TLT: { t: '305080', n: 'TIGER 미국채10년선물' },
  IEF: { t: '152380', n: 'KODEX 국채선물10년' },
  SHY: { t: '153130', n: 'KODEX 단기채권' },
  BND: { t: '153130', n: 'KODEX 단기채권' },
  TIP: { t: '153130', n: 'KODEX 단기채권' },
  VNQ: { t: '329200', n: 'TIGER 리츠부동산인프라' },
  GLD: { t: '132030', n: 'KODEX 골드선물(H)' },
}

const us = (t: string, n: string, c: string, p: number, r = ''): TemplateAsset => ({ t, n, m: 'US', r, p, c, kr: KR[t] })
const kr = (t: string, n: string, c: string, p: number, r = ''): TemplateAsset => ({ t, n, m: 'KR', r, p, c })
const cash = (p: number, r = '대기현금'): TemplateAsset => ({ t: 'CASH', n: '현금', m: 'KR', r, p, c: CAT.cash })

/* ────────────────────────────── 정적 자산배분 ────────────────────────────── */

const STATIC: StrategyTemplate[] = [
  {
    id: 'all-weather',
    name: '올웨더 (All Weather)',
    kind: 'static',
    family: '고정비중 · 리스크 패리티',
    rule: 'static',
    params: {},
    description:
      '경기 국면(성장/침체 × 물가 상승/하락) 4분면에 자산을 배치해 어느 국면에서도 버티도록 설계한 대표적 고정비중 포트폴리오.',
    source: 'Ray Dalio / Bridgewater (1996) — "All Weather" 전략',
    rebalance: '연 1회 또는 괴리 ±5%p 초과 시',
    trait: '주식 30% 수준. 변동성 낮고 채권·금 비중이 큼',
    assets: [
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 30, '성장/주식'),
      us('TLT', 'iShares 20+년 미국채', CAT.devBond, 40, '침체 방어'),
      us('IEF', 'iShares 7-10년 미국채', CAT.devBond, 15, '침체 방어(중기)'),
      us('GLD', 'SPDR 금', CAT.gold, 7.5, '물가 상승'),
      us('DBC', 'Invesco 원자재', CAT.etc, 7.5, '물가 상승(원자재)'),
    ],
  },
  {
    id: 'permanent',
    name: '영구 포트폴리오 (Permanent)',
    kind: 'static',
    family: '고정비중 · 4분면 균등',
    rule: 'static',
    params: {},
    description: '주식·장기채·금·현금을 25%씩 동일 배분. 어떤 국면에서도 한 자산이 방어하는 구조를 노린다.',
    source: 'Harry Browne (1981) — "Fail-Safe Investing"',
    rebalance: '연 1회 또는 밴드(15~35%) 이탈 시',
    trait: '매우 보수적. 실질 구매력 보존 목표',
    assets: [
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 25, '번영'),
      us('TLT', 'iShares 20+년 미국채', CAT.devBond, 25, '디플레이션'),
      us('GLD', 'SPDR 금', CAT.gold, 25, '인플레이션'),
      cash(25, '현금(단기채)'),
    ],
  },
  {
    id: 'golden-butterfly',
    name: '골든 버터플라이 (Golden Butterfly)',
    kind: 'static',
    family: '고정비중 · 영구 포트폴리오 변형',
    rule: 'static',
    params: {},
    description:
      '영구 포트폴리오에 미국 소형가치주를 추가해 성장 노출을 늘린 5자산 균등(각 20%) 구성. 주식 40% + 방어 60%.',
    source: 'Tyler (PortfolioCharts) — Permanent Portfolio 확장',
    rebalance: '연 1회 또는 밴드 이탈 시',
    trait: '주식 40%. 영구 포트폴리오보다 성장성↑, 여전히 방어적',
    assets: [
      us('VTI', 'Vanguard 전체 미국 주식', CAT.dev, 20, '번영(대형)'),
      us('IWN', 'iShares 러셀2000 가치', CAT.dev, 20, '번영(소형가치)'),
      us('TLT', 'iShares 20+년 미국채', CAT.devBond, 20, '디플레이션'),
      us('SHY', 'iShares 1-3년 미국채', CAT.devBond, 20, '현금성'),
      us('GLD', 'SPDR 금', CAT.gold, 20, '인플레이션'),
    ],
  },
  {
    id: 'classic-6040',
    name: '클래식 60/40',
    kind: 'static',
    family: '고정비중 · 전통적 균형',
    rule: 'static',
    params: {},
    description: '주식 60% + 채권 40%. 가장 널리 쓰이는 기준선(benchmark) 구성.',
    source: '전통적 균형 펀드 (Bogle, Vanguard 등)',
    rebalance: '분기 또는 연 1회',
    trait: '기준선. 주식 위험의 대부분을 그대로 안음',
    assets: [
      us('VTI', 'Vanguard 전체 미국 주식', CAT.dev, 60, '성장'),
      us('BND', 'Vanguard 전체 미국 채권', CAT.devBond, 40, '방어'),
    ],
  },
  {
    id: 'three-fund',
    name: '3-펀드 포트폴리오 (Bogleheads)',
    kind: 'static',
    family: '고정비중 · 단순 분산',
    rule: 'static',
    params: {},
    description: '미국 주식 + 미국 외 주식 + 채권 세 개만으로 구성하는 가장 단순한 글로벌 분산형.',
    source: 'John C. Bogle / Bogleheads 커뮤니티',
    rebalance: '연 1회',
    trait: '주식 75%. 단순하고 낮은 비용',
    assets: [
      us('VTI', 'Vanguard 전체 미국 주식', CAT.dev, 45, '미국 주식'),
      us('VXUS', 'Vanguard 전체 미국 외 주식', CAT.dev, 30, '선진/신흥 주식'),
      us('BND', 'Vanguard 전체 미국 채권', CAT.devBond, 25, '채권'),
    ],
  },
  {
    id: 'swensen',
    name: '예일 모델 (Swensen)',
    kind: 'static',
    family: '기관형 · 대안자산 포함',
    rule: 'static',
    params: {},
    description: '대학 기금 운용 방식에 착안해 주식·부동산·채권을 넓게 분산한 장기 성장형 구성.',
    source: 'David Swensen (Yale Endowment) — "Unconventional Success"',
    rebalance: '연 1회',
    trait: '주식 + 리츠 70%. 성장 지향',
    assets: [
      us('VTI', 'Vanguard 전체 미국 주식', CAT.dev, 30, '미국 주식'),
      us('EFA', 'iShares 선진국 MSCI EAFE', CAT.dev, 15, '선진국 주식'),
      us('EEM', 'iShares 신흥국', CAT.em, 5, '신흥국 주식'),
      us('VNQ', 'Vanguard 미국 리츠', CAT.etc, 20, '부동산'),
      us('TLT', 'iShares 20+년 미국채', CAT.devBond, 15, '장기채'),
      us('TIP', 'iShares 물가연동채', CAT.devBond, 15, '물가연동채'),
    ],
  },
  {
    id: 'ivy',
    name: '아이비 포트폴리오 (Ivy)',
    kind: 'static',
    family: '고정비중 · 5자산 균등',
    rule: 'static',
    params: {},
    description: '주식·채권·원자재·리츠 5개 자산군에 20%씩 배분. 동적 버전(Faber 10개월 SMA)의 기반 구성.',
    source: 'Meb Faber (2009) — "The Ivy Portfolio"',
    rebalance: '분기 또는 연 1회',
    trait: '물가 자산 포함. 주식 40%',
    assets: [
      us('VTI', 'Vanguard 전체 미국 주식', CAT.dev, 20, '미국 주식'),
      us('VEU', 'Vanguard 미국 외 주식', CAT.dev, 20, '해외 주식'),
      us('BND', 'Vanguard 전체 미국 채권', CAT.devBond, 20, '채권'),
      us('DBC', 'Invesco 원자재', CAT.etc, 20, '원자재'),
      us('VNQ', 'Vanguard 미국 리츠', CAT.etc, 20, '부동산'),
    ],
  },
  {
    id: 'no-brainer',
    name: '노브레이너 (Bernstein)',
    kind: 'static',
    family: '고정비중 · 4분할',
    rule: 'static',
    params: {},
    description: '미국 대형·소형, 해외, 단기채 4개를 25%씩. 초보자가 그대로 따라할 수 있는 최소 구성.',
    source: 'William Bernstein — "The Intelligent Asset Allocator"',
    rebalance: '연 1회',
    trait: '주식 75%(그중 절반 해외)',
    assets: [
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 25, '미국 대형주'),
      us('IWM', 'iShares 러셀2000', CAT.dev, 25, '미국 소형주'),
      us('EFA', 'iShares 선진국 MSCI EAFE', CAT.dev, 25, '해외 주식'),
      us('SHY', 'iShares 1-3년 미국채', CAT.devBond, 25, '단기채'),
    ],
  },
  {
    id: 'coffeehouse',
    name: '커피하우스 (Coffeehouse)',
    kind: 'static',
    family: '고정비중 · 60/40 + 금',
    rule: 'static',
    params: {},
    description: '60/40 에 금 10% 를 섞어 인플레이션·위기 국면을 완충한 구성.',
    source: 'Bill Schultheis — "The Coffeehouse Investor"',
    rebalance: '연 1회',
    trait: '주식 60%, 채권 40%, 그중 금 10%',
    assets: [
      us('VTI', 'Vanguard 전체 미국 주식', CAT.dev, 30, '미국 주식'),
      us('VXUS', 'Vanguard 전체 미국 외 주식', CAT.dev, 30, '해외 주식'),
      us('BND', 'Vanguard 전체 미국 채권', CAT.devBond, 30, '채권'),
      us('GLD', 'SPDR 금', CAT.gold, 10, '금'),
    ],
  },
  {
    id: 'risk-parity-4',
    name: '간이 리스크 패리티 (4자산)',
    kind: 'static',
    family: '고정비중 · 위험 균등 근사',
    rule: 'static',
    params: {},
    description: '주식·장기채·금·현금을 동일 비중으로 나눠 자산별 위험 기여도를 비슷하게 맞추는 단순화 버전.',
    source: 'Risk Parity 계열 (Bridgewater·AQR) 단순 근사',
    rebalance: '분기 또는 연 1회',
    trait: '주식 25%. 채권·금 비중이 커 변동성 낮음',
    assets: [
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 25, '주식'),
      us('TLT', 'iShares 20+년 미국채', CAT.devBond, 25, '장기채'),
      us('GLD', 'SPDR 금', CAT.gold, 25, '금'),
      cash(25, '현금'),
    ],
  },
]

/* ────────────────────────────── 동적 자산배분 ────────────────────────────── */

const DYNAMIC: StrategyTemplate[] = [
  {
    id: 'gtaa-faber',
    name: 'Faber GTAA (10개월 SMA)',
    kind: 'dynamic',
    family: '추세추종 · 자산별 필터',
    rule: 'sma_filter_rebalance',
    params: { sma_tickers: ['VTI', 'VEU', 'BND', 'DBC', 'VNQ'], sma_months: 10, quarter_end_restore: true },
    description:
      '각 자산이 10개월 이동평균 위에 있으면 보유, 아래로 내려가면 그 자산만 현금화한다. 추세 필터 하나로 낙폭을 크게 줄이는 고전적 TAA.',
    source: 'Meb Faber (2007) — "A Quantitative Approach to Tactical Asset Allocation"',
    rebalance: '월 1회 판정',
    trait: '주식 40% 기준. 하락장에서 자동으로 현금 비중↑',
    assets: [
      us('VTI', 'Vanguard 전체 미국 주식', CAT.dev, 20, '미국 주식'),
      us('VEU', 'Vanguard 미국 외 주식', CAT.dev, 20, '해외 주식'),
      us('BND', 'Vanguard 전체 미국 채권', CAT.devBond, 20, '채권'),
      us('DBC', 'Invesco 원자재', CAT.etc, 20, '원자재'),
      us('VNQ', 'Vanguard 미국 리츠', CAT.etc, 20, '부동산'),
      cash(0, '추세 이탈 대기현금'),
    ],
  },
  {
    id: 'laa',
    name: 'LAA (Lazy Asset Allocation)',
    kind: 'dynamic',
    family: 'Keller TAA · 소수 자산 필터',
    rule: 'sma_filter_rebalance',
    params: { sma_tickers: ['QQQ', 'EFA'], sma_months: 10, quarter_end_restore: true },
    description:
      '자산군 전체를 복잡하게 나누지 않고, 소수의 성장 자산에만 SMA 필터를 걸고 이탈 시 현금화한다. 규칙이 단순해 관리 부담이 적다.',
    source: 'Wouter Keller & Jan Keuning (2016) — Lazy Asset Allocation',
    rebalance: '월 1회 판정 + 분기말 목표 복원',
    trait: '필터 대상이 적어 매매가 드묾',
    assets: [
      us('QQQ', 'Invesco QQQ (나스닥100)', CAT.dev, 12.5, '필터 대상(성장)'),
      us('EFA', 'iShares 선진국 MSCI EAFE', CAT.dev, 12.5, '필터 대상(해외)'),
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 25, '주식'),
      us('IEF', 'iShares 7-10년 미국채', CAT.devBond, 25, '채권'),
      us('GLD', 'SPDR 금', CAT.gold, 25, '금'),
      cash(0, '필터 이탈 대기현금'),
    ],
  },
  {
    id: 'gem',
    name: 'GEM (Global Equities Momentum)',
    kind: 'dynamic',
    family: 'Antonacci 듀얼 모멘텀',
    rule: 'momentum_rotate',
    params: { sma_qualify: true, winner_share: 1, cash_winner_share: 0, cash_no_winner: 1 },
    description:
      '미국 주식과 해외 주식 중 12개월 상대 모멘텀이 강한 쪽을 고르되, 절대 모멘텀(무위험 대비)이 음수면 전액 현금으로 피신한다. 상대+절대 모멘텀의 결합.',
    source: 'Gary Antonacci (2014) — "Dual Momentum Investing"',
    rebalance: '월 1회 판정',
    trait: '한 자산에 집중. 신호가 나쁘면 100% 현금',
    assets: [
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 0, '후보(미국)'),
      us('EFA', 'iShares 선진국 MSCI EAFE', CAT.dev, 0, '후보(해외)'),
      cash(100, '절대모멘텀 이탈 시 대기현금'),
    ],
  },
  {
    id: 'vaa-g4',
    name: 'VAA-G4 (Vigilant Asset Allocation)',
    kind: 'dynamic',
    family: 'Keller TAA · 경계(canary) 자산',
    rule: 'momentum_rotate',
    params: { sma_qualify: true, winner_share: 1, cash_winner_share: 0, cash_no_winner: 1 },
    description:
      '공격 자산의 모멘텀 상위를 고르되, 경계(canary) 자산에 하나라도 악화 신호가 나오면 방어 자산으로 빠르게 이동한다. "카나리아" 개념을 대중화한 모델.',
    source: 'Wouter Keller & Jan Keuning (2017) — Vigilant Asset Allocation',
    rebalance: '월 1회 판정',
    trait: '빠른 위험 회피. 방어 자산은 채권 중심',
    assets: [
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 0, '공격 후보'),
      us('EFA', 'iShares 선진국 MSCI EAFE', CAT.dev, 0, '공격 후보'),
      us('EEM', 'iShares 신흥국', CAT.em, 0, '공격 후보'),
      us('IEF', 'iShares 7-10년 미국채', CAT.devBond, 0, '방어 자산'),
      us('SHY', 'iShares 1-3년 미국채', CAT.devBond, 0, '방어 자산'),
      cash(100, '신호 악화 시 대기현금'),
    ],
  },
  {
    id: 'daa-g12',
    name: 'DAA-G12 (Defensive Asset Allocation)',
    kind: 'dynamic',
    family: 'Keller TAA · 경계 자산 + 방어 로테이션',
    rule: 'momentum_rotate',
    params: { sma_qualify: true, winner_share: 1, cash_winner_share: 0, cash_no_winner: 1 },
    description:
      '경계 자산의 모멘텀 개수로 위험 예산을 정하고, 위험 구간에서는 방어 자산을 상대 모멘텀로 다시 고른다. VAA보다 방어 자산 선택지를 넓힌 모델.',
    source: 'Wouter Keller & Thomas Keuning (2017) — Defensive Asset Allocation',
    rebalance: '월 1회 판정',
    trait: '위험 구간에서도 채권 내 로테이션',
    assets: [
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 0, '공격 후보'),
      us('EFA', 'iShares 선진국 MSCI EAFE', CAT.dev, 0, '공격 후보'),
      us('EEM', 'iShares 신흥국', CAT.em, 0, '공격 후보'),
      us('IEF', 'iShares 7-10년 미국채', CAT.devBond, 0, '방어 후보(중기채)'),
      us('TLT', 'iShares 20+년 미국채', CAT.devBond, 0, '방어 후보(장기채)'),
      us('SHY', 'iShares 1-3년 미국채', CAT.devBond, 0, '방어 후보(단기채)'),
      us('GLD', 'SPDR 금', CAT.gold, 0, '방어 후보(금)'),
      cash(100, '신호 악화 시 대기현금'),
    ],
  },
  {
    id: 'paa-g12',
    name: 'PAA-G12 (Protective Asset Allocation)',
    kind: 'dynamic',
    family: 'Keller TAA · 분할 위험 축소',
    rule: 'momentum_rotate',
    params: { sma_qualify: true, winner_share: 1, cash_winner_share: 0, cash_no_winner: 1 },
    description:
      '하나의 신호로 전부 이동하는 대신, 위험 신호 개수에 비례해 방어 자산 비중을 나눠 줄인다. 전량 이탈하지 않아 왕복매매가 줄어든다.',
    source: 'Wouter Keller & Thomas Keuning (2016) — Protective Asset Allocation',
    rebalance: '월 1회 판정',
    trait: '위험 축소가 단계적. 매매 빈도 낮음',
    assets: [
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 0, '공격 후보'),
      us('EFA', 'iShares 선진국 MSCI EAFE', CAT.dev, 0, '공격 후보'),
      us('EEM', 'iShares 신흥국', CAT.em, 0, '공격 후보'),
      us('IEF', 'iShares 7-10년 미국채', CAT.devBond, 0, '방어 자산'),
      cash(100, '신호 악화 시 대기현금'),
    ],
  },
  {
    id: 'baa-g12',
    name: 'BAA-G12 (Bold Asset Allocation)',
    kind: 'dynamic',
    family: 'Keller TAA · 공격형 3유니버스',
    rule: 'momentum_rotate',
    params: { sma_qualify: true, winner_share: 1, cash_winner_share: 0, cash_no_winner: 1 },
    description:
      '공격·방어·경계 3개 자산군을 두고 느린 상대 모멘텀 + 빠른 절대 모멘텀 + 위기 보호를 결합한 공격형 모델. 성장 자산 비중이 가장 높다.',
    source: 'Wouter Keller & Jan van Putten (2022) — Bold Asset Allocation',
    rebalance: '월 1회 판정',
    trait: '공격적. 경계 신호가 나오면 빠르게 현금·채권',
    assets: [
      us('QQQ', 'Invesco QQQ (나스닥100)', CAT.dev, 0, '공격 후보(성장)'),
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 0, '공격 후보(대형)'),
      us('EEM', 'iShares 신흥국', CAT.em, 0, '공격 후보(신흥국)'),
      us('IEF', 'iShares 7-10년 미국채', CAT.devBond, 0, '방어 자산'),
      us('TLT', 'iShares 20+년 미국채', CAT.devBond, 0, '방어 자산'),
      cash(100, '경계 신호 시 대기현금'),
    ],
  },
  {
    id: 'haa',
    name: 'HAA (Hybrid Asset Allocation)',
    kind: 'dynamic',
    family: 'Keller TAA · 고정 수익 기반 하이브리드',
    rule: 'momentum_rotate',
    params: { sma_qualify: true, winner_share: 1, cash_winner_share: 0, cash_no_winner: 1 },
    description:
      '항상 일정 비중을 채권(고정 수익)에 두고, 나머지를 경계 신호에 따라 주식/방어 자산 사이에서 움직인다. 주식 노출을 0으로 만들지 않는다.',
    source: 'Wouter Keller & Jan Keuning (2018) — Hybrid Asset Allocation',
    rebalance: '월 1회 판정',
    trait: '주식 비중이 0이 되지 않는 완충형',
    assets: [
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 0, '공격 후보'),
      us('QQQ', 'Invesco QQQ (나스닥100)', CAT.dev, 0, '공격 후보(성장)'),
      us('EFA', 'iShares 선진국 MSCI EAFE', CAT.dev, 0, '공격 후보(해외)'),
      us('IEF', 'iShares 7-10년 미국채', CAT.devBond, 0, '고정 수익·방어'),
      cash(100, '대기현금'),
    ],
  },
  {
    id: 'dga',
    name: 'DGA (Dividend & Growth Allocation)',
    kind: 'dynamic',
    family: 'Keller 계열 변형 · 배당+성장',
    rule: 'momentum_rotate',
    params: { sma_qualify: true, winner_share: 1, cash_winner_share: 0, cash_no_winner: 1 },
    description:
      '성장 자산과 배당(고배당·리츠·우선주) 자산을 함께 후보로 두고 모멘텀 상위를 고르는 변형. 배당 자산이 후보에 포함되어 방어 구간에서도 수익원이 남는다.',
    source: 'Keller 계열 TAA 변형 (성장 + 배당 결합) — 사용자 정의로 가감 권장',
    rebalance: '월 1회 판정',
    trait: '배당 자산 포함. 방어 구간에서도 현금흐름 유지',
    assets: [
      us('SPY', 'SPDR S&P 500 ETF', CAT.dev, 0, '성장 후보'),
      us('QQQ', 'Invesco QQQ (나스닥100)', CAT.dev, 0, '성장 후보'),
      us('SCHD', 'Schwab 미국 배당주', CAT.dev, 0, '배당 후보'),
      us('VNQ', 'Vanguard 미국 리츠', CAT.etc, 0, '배당 후보(리츠)'),
      us('IEF', 'iShares 7-10년 미국채', CAT.devBond, 0, '방어 자산'),
      cash(100, '대기현금'),
    ],
  },
]

export const TEMPLATES: StrategyTemplate[] = [...STATIC, ...DYNAMIC]

export function findTemplate(id: string): StrategyTemplate | null {
  return TEMPLATES.find((t) => t.id === id) || null
}

/** UI 로 내려보낼 형태 (필드명을 그대로 유지하되 kind/family 등 메타 포함) */
export function templateList() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    family: t.family,
    rule: t.rule,
    description: t.description,
    source: t.source,
    rebalance: t.rebalance,
    trait: t.trait,
    /** 종목별 목표% 를 실제로 쓰는지 (동적 템플릿은 규칙이 비중을 정한다) */
    usesWeights: t.kind === 'static',
    stats: {
      assets: t.assets.length,
      /** 주식 계열 비중 합계 (정적 템플릿만 의미 있음) */
      equityPct: t.assets.filter((a) => a.c === CAT.dev || a.c === CAT.em).reduce((s, a) => s + a.p, 0),
      cashPct: t.assets.filter((a) => a.c === CAT.cash).reduce((s, a) => s + a.p, 0),
      krConvertible: t.assets.filter((a) => a.kr).length,
    },
    assets: t.assets.map((a) => ({
      ticker: a.t,
      name: a.n,
      market: a.m,
      role: a.r,
      target_pct: a.p,
      category: a.c,
      kr_ticker: a.kr?.t || '',
      kr_name: a.kr?.n || '',
    })),
  }))
}

/**
 * 템플릿 → 스펙(SDP) 변환.
 *  - useKr: 한국 상장 ETF 근사 대체가 있으면 그 티커로 바꾼다.
 *  - overrides: { [ticker]: target_pct } 로 비중을 가감한다.
 *  - extraAssets: 사용자가 덧붙인 자산.
 */
export function templateToSpec(
  tpl: StrategyTemplate,
  code: string,
  opts: { account?: string; useKr?: boolean; overrides?: Record<string, number>; extraAssets?: any[] } = {},
) {
  const useKr = !!opts.useKr
  const assets = tpl.assets.map((a) => {
    const swap = useKr && a.kr ? a.kr : null
    const ticker = swap ? swap.t : a.t
    const name = swap ? swap.n : a.n
    const market = swap ? ('KR' as const) : a.m
    const key = a.t
    const pct = opts.overrides && Object.prototype.hasOwnProperty.call(opts.overrides, key) ? Number(opts.overrides[key]) : a.p
    return { ticker, name, market, role: a.r, target_pct: Number(pct) || 0, category: a.c }
  })
  for (const ex of opts.extraAssets || []) {
    if (!ex || !ex.ticker) continue
    assets.push({
      ticker: String(ex.ticker),
      name: String(ex.name || ''),
      market: ex.market === 'US' ? ('US' as const) : ('KR' as const),
      role: String(ex.role || '추가'),
      target_pct: Number(ex.target_pct) || 0,
      category: String(ex.category || CAT.etc),
    })
  }
  return {
    code,
    account: opts.account || code,
    description: `${tpl.name} — ${tpl.description} [출처: ${tpl.source}]`,
    dynamic: tpl.kind === 'dynamic',
    active: true,
    annual_limit: 0,
    rule: tpl.rule,
    params: JSON.parse(JSON.stringify(tpl.params)),
    assets,
  }
}
