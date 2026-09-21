# 자산배분 리밸런싱 도우미 (Asset Rebalancing Helper)

기존 Streamlit 앱(`asset_allocation_app_v17.py`)을 **Cloudflare Pages + Hono + D1** 로 옮긴 웹앱입니다.
가장 큰 변화는 두 가지입니다.

1. **노코드 전략 규칙 빌더** — JSON/코딩 없이 UI 에서 "QQQ 현재가가 SMA 10개월 상회 → 매수 유지" 같은 규칙을 조립합니다.
2. **Yahoo Finance 단일 데이터 소스** — 원본이 요구하던 4개 비밀키(KRX_AUTH_KEY, KRX_BASE_URL, DATA_GO_SERVICE_KEY, SQLITE_PATH)가 **모두 불필요**해졌습니다.

## URL

| 구분 | 주소 |
|---|---|
| 프로덕션 | https://asset-rebalance-app.pages.dev |
| 최신 배포 | https://d992d3ab.asset-rebalance-app.pages.dev |
| 로컬 개발 | http://localhost:3000 |
| GitHub | https://github.com/cofls0601-blip/genspark3 |

## 주요 기능

### 1. 노코드 규칙 빌더 (핵심)
`설정` 탭에서 전략별로 조건을 문장처럼 조립합니다.

- **기준 티커** — 비우면 자기 종목. 보유하지 않은 종목도 지정 가능(예: QQQ, SPY, `^KS200`)
- **기준 시장** — KR / US
- **모멘텀 기준(지표)** 4종
  - `SMA 대비` — 현재가 / SMA(N) − 1 (상회하면 양수)
  - `모멘텀` — N기간 수익률
  - `낙폭` — 현재가 / N기간 최고가 − 1 (고점대비 하락률)
  - `현재 가격` — 절대값 비교
- **기간 / 단위** — 개월 또는 일
- **상회 여부** — 상회(>), 이상(≥), 하회(<), 이하(≤)
- **임계값** — 지표가 % 기반이면 % 로 입력(내부 저장은 소수)
- **적용 대상** — 특정 role/티커만 개별 판정(선택)
- **조건 결합** — 모두 충족(AND) / 하나라도 충족(OR)
- **동작** — 조건 충족 시(`on_pass`) / 미충족 시(`on_fail`) 각각
  - 목표비중으로 복원 · 그대로 유지 · 전량 현금화 · 현금에서 일부 매수 · 모멘텀 1위 종목에 집중
- **목표비중 복원 시점** — 항상 / 분기말에만
- **실시간 판정** — "지금 판정해보기" 버튼으로 현재 시세 기준 참/거짓과 현재값을 즉시 확인

예시(사용자 요청 그대로): `기준 티커 QQQ` + `SMA 대비` + `10개월` + `상회` + `목표비중으로 복원` → 저장하면 바로 적용됩니다.

### 2. 오늘의 리밸런싱
- 총 자산 / 직전 기록 대비 증감
- **오늘의 액션** — 전략별 매수·매도 목록, 실행 체크박스(자동 저장)
- "최신 가격으로 계획 만들기" 버튼 하나로 전체 재계산
- 기록 저장 · 인쇄

### 3. 포트폴리오
- 자산군별 현재비중 vs 목표비중 괴리(%p)
- 전략별 목표/현재 비중 막대, 종목별 평가액
- 보유수량 인라인 편집

### 4. 기록 · 성과
- 스냅샷 타임라인, 스프레드시트용 한 줄 복사
- CAGR / MDD(하락·회복기간) / 변동성 / Sharpe / Sortino / XIRR / TWR / β·α
- 벤치마크(QQQ, SPY, KOSPI200 + 사용자 추가) 비교 차트
- 입출금 원장, 백업/복원

### 5. 설정
- 전략 추가/삭제/순서변경/활성화
- **규칙 종류는 드롭다운에서 직접 선택** (`ruleMeta.choices` 로 내려가며, 코드에 전략별로 하드코딩하지 않음)
  - 선택지: 목표비중으로 맞추기 / 추세(SMA) 필터 / 모멘텀 상위 선택 / 낙폭 분할매수 / 낙폭 비중 전환 / 장기 보유 / 노코드 규칙 빌더
  - 규칙 파라미터(내장 규칙은 자동 생성 폼, 노코드 규칙은 조건 빌더)
- **자산 목록 · 목표비중 편집 + `[변경 저장]` 버튼** (규칙 카드와 자산 카드에서 각각 저장)
- 자산 목록 편집 + 한국/미국 종목 검색
- 휴장일 정책 · 가격 기준(종가/수정종가) · 자산군 목표비중 · 벤치마크

#### 비중을 규칙이 정하는 전략 (중요)
전략마다 목표비중을 **입력해야 하는지**가 다릅니다. 이 정보는 `/api/bootstrap` 의
`weightMeta` 로 내려가고, UI 는 이를 읽어 입력칸을 숨기거나 안내 문구로 대체합니다.

| 규칙 | 비중을 누가 정하나 | UI 동작 |
|---|---|---|
| `static` | 자산별 목표% | 목표% 입력칸 표시 + 합계 100% 경고 |
| `sma_filter_rebalance` | 자산별 목표% | 동일 |
| `visual` | `on_pass`/`on_fail` 이 `target` 일 때만 | 조건에 따라 자동 판단 |
| `momentum_rotate` | 규칙(모멘텀 1위 + 현금비중) | `규칙` 배지, 목표% 숨김 |
| `drawdown_buy` | 규칙(발동 시 현금 → 주식) | `규칙` 배지 |
| `drawdown_shift` | 규칙(발동 시 주식 바스켓 % 로 재조정) | `규칙` 배지 |
| `hold` | 비중 변경 없음 | `매매 없음` |

> 규칙이 비중을 정하는 전략에 목표% 를 억지로 입력하게 만들면, 엔진이 그 값을 읽지
> 않아 **아무 일도 일어나지 않는 매매 항목**이 to-do 리스트에 쌓입니다. 그래서 해당
> 전략은 목표% 입력을 요구하지 않습니다.

### 6. 실행 기록 (월말 리밸런싱 원장)
매월 말 종가로 비중을 확인하고 조정한 **결과를 그대로 남깁니다**. 조정 후 종목별 보유수량이 다음 달 계산의 기준이 되므로, "무엇을 얼마에 사고팔아 수량이 얼마에서 얼마로 바뀌었는지"를 기록합니다.

- **[오늘] 탭 상단에서 `기준일` 선택** → 그 날(종가) 기준으로 계획을 다시 계산 (`POST /api/plan/refresh {date}`)
- **"이 달 말" 버튼** → 그 달 마지막 날로 바로 설정 (`GET /api/month-end`)
- **"실행 반영하고 기록 남기기"** → 계획의 매매를 실제 보유수량에 반영하고 원장에 기록
  - 주식 수량 정수 반올림 옵션
  - 반영 전/후 보유수량과 평가액을 미리 표로 확인
  - 반영 결과가 `kv:rebalances` 에 쌓임
- **실행 기록 탭** → 기록 목록 · 종목별 변동 상세 · 되돌리기(수량 복원) · 그 날짜 스냅샷 저장

원장 1건에 저장되는 것: 기준일, 기록시각, 반영에 쓴 종목별 종가, 종목별 `매매금액 / 수량변동 / 반영 전후 수량 / 반영 전후 평가액 / 목표금액`, 전략별 매수·매도 합계, 총자산 변화, 환율.

## API 경로

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 헬스체크 |
| GET | `/api/bootstrap` | 앱 전체 상태(스펙·전략·자산·기록·성과·설정) 일괄 로드 |
| GET | `/api/plan/quick` | 캐시 우선 계획 계산 (일상 사용) |
| POST | `/api/plan/refresh` | 강제 새로고침 계획 계산 |
| POST | `/api/plan/preview-conditions` | 규칙 빌더용 조건 실시간 판정 |
| GET | `/api/specs` | 스펙 다시 읽기 |
| POST | `/api/strategies` | 전략 추가 |
| PATCH | `/api/strategies/:code` | 전략 정보 수정 |
| DELETE | `/api/strategies/:code` | 전략 삭제 |
| POST | `/api/strategies/reorder` | 순서 변경 |
| **PUT** | **`/api/specs/:code`** | **규칙(스펙) 저장 — 노코드 빌더의 저장 경로** |
| PUT | `/api/assets` | 보유자산 일괄 저장 |
| POST | `/api/assets` | 종목 추가 |
| DELETE | `/api/assets/:id` | 종목 삭제 |
| PUT | `/api/settings` | 휴장일 정책 · 가격 기준 |
| PUT | `/api/category-targets` | 자산군 목표비중 |
| PUT | `/api/custom-benchmarks` | 사용자 벤치마크 |
| GET | `/api/rule-meta` | 규칙 메타(이름·UI 스키마) |
| POST | `/api/history/snapshot` | 스냅샷 저장 |
| DELETE | `/api/history/:date` | 스냅샷 삭제 |
| GET | `/api/history/:date/row` | 스프레드시트용 한 줄 |
| GET | `/api/performance` | 성과 지표 (`?range=1m\|3m\|6m\|1y\|ytd\|all`) |
| GET/PUT | `/api/cashflows` | 입출금 원장 |
| GET/PUT | `/api/executions` | 실행 체크리스트 |
| POST | `/api/benchmarks/backfill` | 벤치마크 과거치 백필 |
| GET | `/api/backup` / POST `/api/restore` | 백업 / 복원 |
| GET | `/api/search` | 종목 검색 (`?q=&market=KR\|US`) |
| POST | `/api/resolve-symbol` | 티커 → 현재가 조회 |
| GET | `/api/templates` | 문헌 자산배분 템플릿 목록 (`?kind=static\|dynamic`) |
| GET | `/api/templates/:id` | 템플릿 상세 |
| POST | `/api/strategies/from-template` | 템플릿으로 새 전략 생성 |
| POST | `/api/strategies/:code/apply-template` | 기존 전략에 템플릿 적용 |
| GET | `/api/month-end` | `?date=` → 그 달 마지막 날 |
| POST | `/api/rebalance/apply` | 계획을 보유수량에 반영 + 원장 기록 |
| GET | `/api/rebalances` | 실행 원장 목록 |
| GET | `/api/rebalances/:id` | 실행 원장 상세 |
| POST | `/api/rebalance/revert` | 실행 되돌리기(수량 복원) |
| DELETE | `/api/rebalances/:id` | 기록 삭제 (수량 유지) |

## 데이터 구조

**저장소: Cloudflare D1 (SQLite)** — 단일 D1 바인딩(`DB`)만 사용합니다.
호스티드 배포 제약상 `kv_namespaces` / `triggers` 는 사용하지 않습니다(검증에서 거부됨).

| 테이블 | 용도 |
|---|---|
| `kv` | 앱 상태 전체를 키-값 JSON 으로 저장 |
| `price_cache` | 종목별 일별 종가·수정종가 (PK: market, ticker, date) |
| `fx_cache` | USD/KRW 환율 캐시 |
| `cache_meta` | 캐시 스키마 버전(불일치 시 가격 캐시 자동 초기화) |
| `kv_quarantine` | 손상된 JSON 원본 보존 |

`kv` 키: `assets`, `history`, `equity`, `cashflows`, `benchmarks`, `strategies`, `category_targets`, `executions`, `custom_benchmarks`, `price_policy`, `price_mode`, `specs`

**데이터 소스: Yahoo Finance 단일** (API 키 불필요)

| 시장 | 심볼 규칙 | 예 |
|---|---|---|
| 한국 | `<6자리>.KS` (또는 `.KQ`) | `069500` → `069500.KS` |
| 미국 | 티커 그대로 | `QQQ` |
| 환율 | `KRW=X` | — |
| 지수 | `^KS200` | — |

## 사용 방법

1. **설정 → 전략 선택 → 규칙 만들기**에서 조건을 조립하고 저장
2. **포트폴리오**에서 보유수량 입력
3. **오늘** 탭에서 "최신 가격으로 계획 만들기"
4. 오늘의 액션 체크리스트대로 매매 후 체크(자동 저장)
5. "기록 저장" 으로 스냅샷 누적 → **기록·성과** 탭에서 지표 확인

## 기술 스택

- **Hono v4** (Cloudflare Workers / Pages)
- **Cloudflare D1** (SQLite)
- **Vanilla JS SPA** — Tailwind CDN + Font Awesome CDN, `U.*` 코어 + `window.PAGES`/`window.ACTIONS` 레지스트리
- **Vite** (`@hono/vite-build/cloudflare-pages` → `dist/_worker.js`)
- **PM2** (로컬 개발 프로세스 관리)

## 로컬 개발

```bash
cd /home/user/webapp
npm install
npm run build
npx wrangler d1 migrations apply asset-rebalance-app-production --local
pm2 start ecosystem.config.cjs
curl http://localhost:3000/api/health
```

## 배포 상태

- **상태**: ✅ **프로덕션 배포 완료 (본인 Cloudflare 계정 / Cloudflare Pages)**
- **프로덕션 URL**: https://asset-rebalance-app.pages.dev
- **Pages 프로젝트**: `asset-rebalance-app` (production branch `main`)
- **D1 데이터베이스**: `asset-rebalance-app-production`
  (`database_id` = `bde23563-ef44-4228-ae1d-2c5cff0a402c`, 바인딩 `DB`)
- **마이그레이션**: `0001_init.sql`, `0002_auto_backup.sql` 적용 완료 (2026-09-19)
- **초기 상태 주입**: 2026-08-28 자산 스냅샷 반영 완료
  (보유자산 31건 · 전략 8개 · 히스토리/평가금액 1건 · 벤치마크 8건)

### 재배포 / 운영 명령

```bash
# 코드 수정 후 재배포
cd /home/user/webapp
npm run build
npx wrangler pages deploy dist --project-name asset-rebalance-app --branch main

# 프로덕션 D1 마이그레이션 (새 마이그레이션 추가 시)
npx wrangler d1 migrations apply asset-rebalance-app-production --remote

# 프로덕션 D1 상태 백업/복원
curl -s https://asset-rebalance-app.pages.dev/api/backup > backup.json
curl -s -X POST https://asset-rebalance-app.pages.dev/api/restore \
  -H 'Content-Type: application/json' --data @backup.json
```

> `main.<project>.pages.dev` 별칭은 이 프로젝트에서 404 를 반환하므로
> **루트 도메인(`https://asset-rebalance-app.pages.dev`)** 을 사용하세요.

## 아직 구현하지 않은 것 (다음 단계 후보)

- 다중 통화(USD/KRW 외), 개별 주식 배당 재투자 처리
- 리밸런싱 계획의 과거 이력 대비 자동 diff 리포트
- 조건에 `sma` 교차(골든/데드크로스) 판정 추가 — 현재는 상회/하회 상태만 판정
- 세금/수수료 반영한 실현손익 계산
- 자동 리밸런싱 알림 (호스티드 배포는 cron 미지원이라 요청 시점 lazy 실행 방식 필요)
- 다중 사용자/로그인 (현재는 단일 사용자 전제)

## 최근 변경 이력

| 날짜 | 내용 |
|---|---|
| 2026-09-21 | **실행 원장 도입** — 기준일(월말 종가) 선택, 계획→보유수량 반영, 원장 기록/되돌리기, 실행 기록 탭. **문헌 전략 템플릿 19종**(정적 10 / 동적 9) 추가 및 설정 탭 선택기. **규칙 드롭다운 버그 수정**(노코드 규칙이 목록에서 누락되어 되돌아올 수 없던 문제) |
| 2026-09-20 | **비중을 규칙이 정하는 전략 지원** — `weightMeta`(usage/usesWeights/note) 를 `/api/bootstrap` 으로 노출, 목표% 입력칸·합계 경고 숨김. `momentum_rotate` 데이터부족 종목 전량 현금화 버그 수정(보유 유지), `drawdown_shift` 발동 전 매매 제거 + 발동 시 주식 바스켓 비례 재조정. **자산 목록·목표비중 `[변경 저장]` 버튼 추가**(`ACTIONS.assetSave`), 규칙 저장과 공용 `saveDraft` 로 통합 |
| 2026-09-20 | **자산 저장 버그 근본 수정** — `reconcileAssets` 를 spec-first 로 재작성. 기존에는 스펙 자산을 *추가만* 하고 `target_pct` 수정·삭제를 무시해 저장이 안 되는 것처럼 보였음. 이제 보유수량(`shares`/`close`/`prices`/`adjclose`)은 유지한 채 수정·삭제 반영 |
| 2026-09-19 | 본인 Cloudflare 계정(Cloudflare Pages) 프로덕션 배포. 2026-08-28 자산 스냅샷 D1 주입(보유자산 31건 · 전략 8개 · 벤치마크 8건) |
| 2026-09-16 | Streamlit → Cloudflare 이식 1차 완료. 노코드 규칙 빌더, Yahoo 단일 소스, D1 저장 계층, 성과 지표 포팅 |
