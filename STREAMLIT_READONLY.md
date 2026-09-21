# Streamlit 읽기 전용 Google Sheets 버전

이 버전은 Google Cloud, 서비스 계정, API 키를 사용하지 않습니다.

## 실행

```bash
pip install -r requirements.txt
streamlit run streamlit_app.py
```

## Google Sheets 구성

한 스프레드시트에 다음 탭을 사용합니다.

- `Holdings`: 현재 전략별 종목과 보유수량
- `Strategies`: 전략별 규칙과 파라미터
- `Snapshots`: 매월 말 포트폴리오 상태
- `Actions`: 리밸런싱 계획과 실제 실행 이력
- `Cashflows`: 입출금 원장
- `CategoryTargets`: 전체 자산군 목표비중

`Holdings` 탭의 첫 행은 다음 열 이름을 사용합니다.

Google Sheets의 첫 행에 다음 열 이름을 사용합니다.

```text
strategy account ticker name market category role target_pct shares
```

방법은 두 가지입니다.

1. 공유 권한을 **링크가 있는 모든 사용자: 뷰어**로 설정하고, 스프레드시트 URL을 앱 사이드바에 입력합니다.
2. 공개 링크를 사용하지 않으려면 시트 범위를 헤더와 함께 복사하여 앱의 붙여넣기 입력창에 넣습니다.

앱은 탭 이름으로 네 표를 한 번에 읽습니다. `Strategies`, `Snapshots`, `Actions`가 아직 없으면 기본 전략 또는 빈 기록으로 시작합니다.

## 주요 기능

- 전략별 종목 구성과 목표비중 편집
- LAA SMA 필터, GSM 모멘텀, 낙폭 분할매수·비중전환, 보유 유지 규칙 설정
- 월말 종가 기준 리밸런싱 액션 계산
- 전략별 현재 상태 및 리밸런싱 필요도 표시
- 목표 충족(초록), 미달(파랑), 초과(빨강) 비중 막대
- 전략 추가·삭제, 계좌명·설명·활성화, 구성 종목과 목표비중 편집
- 월별 스냅샷 및 실행 이력 조회
- CAGR, MDD, 연환산 변동성, Sharpe 계산
- QQQ, SPY, KOSPI200 및 사용자 티커 벤치마크 비교

## 결과 보관

`복사용 데이터` 탭에서 다음 표를 TSV로 복사하거나 CSV로 다운로드합니다.

- 월말 스냅샷
- 액션 및 실제 실행 이력
- 현재 보유내역
- 전략 설정
- 입출금 원장
- 자산군 목표비중

앱은 Google Sheets에 직접 데이터를 쓰지 않습니다.
