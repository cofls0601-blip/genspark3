from __future__ import annotations

import json
from datetime import date

import pandas as pd
import plotly.express as px
import streamlit as st

from streamlit_app.data import (
    DataError,
    export_month,
    load_default_holdings,
    load_default_strategies,
    read_pasted_holdings,
    read_workbook,
    to_csv_bytes,
    to_tsv,
)
from streamlit_app.engine import (
    build_action_plan, comparison_history, enrich_prices, performance_summary, portfolio_view,
)


st.set_page_config(page_title="월말 자산배분 도우미", page_icon="📊", layout="wide")


def won(value: float) -> str:
    return f"{value:,.0f}원"


if "holdings" not in st.session_state:
    st.session_state.holdings = load_default_holdings()
if "strategies" not in st.session_state:
    st.session_state.strategies = load_default_strategies()
if "snapshots" not in st.session_state:
    st.session_state.snapshots = pd.DataFrame()
if "actions" not in st.session_state:
    st.session_state.actions = pd.DataFrame()
if "benchmarks" not in st.session_state:
    st.session_state.benchmarks = "QQQ, SPY, ^KS200"

st.title("월말 자산배분 도우미")
st.caption("금융계좌·Google Cloud 연결 없이 계산하고, 결과를 Google Sheets에 직접 붙여넣습니다.")

with st.sidebar:
    st.header("월말 기준")
    as_of = st.date_input("기준일", value=date.today())
    price_mode = st.radio("가격", ["종가", "수정종가"], horizontal=True)
    refresh = st.button("종가 새로 조회", type="primary", use_container_width=True)
    st.caption("휴장일이면 기준일 이전의 가장 최근 거래일을 사용합니다.")

    st.divider()
    st.subheader("읽기 전용 Google Sheets")
    sheet_url = st.text_input("스프레드시트 URL", placeholder="https://docs.google.com/spreadsheets/d/...")
    if st.button("전체 데이터 읽기", use_container_width=True):
        try:
            workbook = read_workbook(sheet_url)
            for key, frame in workbook.items():
                st.session_state[key] = frame
            st.session_state.pop("priced_holdings", None)
            st.success("Holdings·Strategies·Snapshots·Actions를 불러왔습니다.")
        except DataError as exc:
            st.error(str(exc))
    st.caption("탭 이름은 Holdings, Strategies, Snapshots, Actions를 사용합니다. Strategies 이하 탭은 없어도 됩니다.")

holdings = st.session_state.holdings.copy()
strategies = st.session_state.strategies.copy()

if refresh or "priced_holdings" not in st.session_state:
    with st.spinner("Yahoo Finance에서 종가를 조회하고 있습니다..."):
        priced, warnings = enrich_prices(holdings, as_of, adjusted=price_mode == "수정종가")
        st.session_state.priced_holdings = priced
        st.session_state.price_warnings = warnings

priced = st.session_state.priced_holdings.copy()
view = portfolio_view(priced)
plan = build_action_plan(view, strategies, as_of)

for warning in st.session_state.get("price_warnings", []):
    st.warning(warning)

tab_dashboard, tab_plan, tab_holdings, tab_settings, tab_history, tab_export = st.tabs(
    ["대시보드", "액션 플랜", "보유내역", "전략 설정", "기록·성과", "복사용 데이터"]
)

with tab_dashboard:
    total = float(view["평가액"].sum()) if not view.empty else 0
    cash = float(view.loc[view["category"] == "현금", "평가액"].sum()) if not view.empty else 0
    c1, c2, c3 = st.columns(3)
    c1.metric("총 평가액", won(total))
    c2.metric("현금", won(cash), f"{cash / total * 100:.1f}%" if total else "0%")
    c3.metric("조회 기준일", as_of.isoformat())

    left, right = st.columns(2)
    with left:
        st.subheader("종목별 비중")
        fig = px.sunburst(
            view[view["평가액"] > 0], path=["strategy", "name"], values="평가액",
            color="category", height=470,
        )
        st.plotly_chart(fig, use_container_width=True)
    with right:
        st.subheader("전략별 비중")
        by_strategy = view.groupby("strategy", as_index=False)["평가액"].sum()
        fig = px.pie(by_strategy, names="strategy", values="평가액", hole=.45, height=470)
        st.plotly_chart(fig, use_container_width=True)

    st.subheader("목표 대비 괴리")
    chart = view[view["ticker"] != "CASH"].copy()
    fig = px.bar(
        chart, x="name", y=["현재비중", "target_pct"], barmode="group",
        labels={"value": "비중(%)", "name": "종목", "variable": "구분"}, height=430,
    )
    st.plotly_chart(fig, use_container_width=True)

with tab_plan:
    st.subheader("이번 달 액션 플랜")
    st.caption("계획은 참고값입니다. 주문 전 가격·세금·수수료와 실제 주문 가능 수량을 확인하세요.")
    memo = st.text_area("이번 달 판단 메모", key="month_memo", placeholder="시장 상황, 예외 처리, 실행하지 않은 이유 등을 기록하세요.")
    edited_plan = st.data_editor(
        plan, key="action_editor", use_container_width=True, hide_index=True,
        disabled=[column for column in plan.columns if column not in {"실행", "실제수량", "메모"}],
        column_config={
            "실행": st.column_config.CheckboxColumn(),
            "예상매매액": st.column_config.NumberColumn(format="%,.0f원"),
            "현재평가액": st.column_config.NumberColumn(format="%,.0f원"),
        },
    )

with tab_holdings:
    st.subheader("보유수량·종목 편집")
    st.caption("CASH의 shares에는 원화 현금 금액을 입력합니다. 변경은 현재 브라우저 세션에만 유지됩니다.")
    editable_cols = ["strategy", "account", "ticker", "name", "market", "category", "role", "target_pct", "shares"]
    edited = st.data_editor(
        holdings[editable_cols], key="holding_editor", num_rows="dynamic", use_container_width=True, hide_index=True,
        column_config={
            "market": st.column_config.SelectboxColumn(options=["KR", "US"]),
            "target_pct": st.column_config.NumberColumn(min_value=0.0, max_value=100.0, format="%.2f"),
            "shares": st.column_config.NumberColumn(min_value=0.0, format="%.4f"),
        },
    )
    if st.button("편집한 보유내역 적용"):
        st.session_state.holdings = edited.copy()
        st.session_state.pop("priced_holdings", None)
        st.success("현재 세션에 적용했습니다. 종가를 다시 조회하세요.")

    st.subheader("표를 직접 붙여넣기")
    pasted = st.text_area("Google Sheets에서 헤더 포함 범위를 복사해 붙여넣으세요", height=160)
    if st.button("붙여넣은 보유내역 적용"):
        try:
            st.session_state.holdings = read_pasted_holdings(pasted)
            st.session_state.pop("priced_holdings", None)
            st.success("현재 세션에 적용했습니다.")
        except DataError as exc:
            st.error(str(exc))

with tab_settings:
    st.subheader("전략 구성과 규칙 설정")
    st.caption("변경값은 현재 세션에 적용되며, 아래 복사용 데이터에서 Strategies와 Holdings를 시트에 반영합니다.")
    rule_names = {
        "static": "정적 목표비중", "sma_filter_rebalance": "10개월 SMA 필터",
        "momentum_rotate": "모멘텀 1위 로테이션", "drawdown_buy": "낙폭 분할매수",
        "drawdown_shift": "낙폭 비중전환", "hold": "보유 유지",
    }
    strategy_codes = strategies["code"].astype(str).tolist()
    selected = st.selectbox("설정할 전략", strategy_codes)
    current = strategies.loc[strategies["code"].astype(str) == selected].iloc[0]
    rule = st.selectbox(
        "규칙", list(rule_names), index=list(rule_names).index(str(current["rule"])),
        format_func=lambda value: rule_names[value],
    )
    try:
        params = json.loads(current.get("params_json") or "{}")
    except Exception:
        params = {}

    if rule == "sma_filter_rebalance":
        candidates = holdings.loc[holdings["strategy"] == selected, "ticker"].astype(str).tolist()
        params["sma_tickers"] = st.multiselect("SMA 필터 대상", candidates, default=[x for x in params.get("sma_tickers", []) if x in candidates])
        params["sma_months"] = st.number_input("SMA 기간(개월)", 2, 24, int(params.get("sma_months", 10)))
        params["quarter_end_restore"] = st.checkbox("분기말 목표비중 복원", bool(params.get("quarter_end_restore", True)))
    elif rule == "momentum_rotate":
        params["winner_share"] = st.slider("1위 자산 비중", 0.0, 1.0, float(params.get("winner_share", .8)), .05)
        params["cash_winner_share"] = st.slider("현금 비중", 0.0, 1.0, float(params.get("cash_winner_share", .2)), .05)
        params["cash_no_winner"] = 1.0
    elif rule in {"drawdown_buy", "drawdown_shift"}:
        signal = params.get("signal", {})
        c1, c2, c3 = st.columns(3)
        signal["ticker"] = c1.text_input("기준 티커", str(signal.get("ticker", "QQQ")))
        signal["market"] = c2.selectbox("기준 시장", ["KR", "US"], index=1 if signal.get("market") == "US" else 0)
        signal["lookback_days"] = c3.number_input("고점 확인 거래일", 20, 500, int(signal.get("lookback_days", 120)))
        params["signal"] = signal
        params["threshold"] = st.number_input("발동 하락률", -0.90, 0.0, float(params.get("threshold", -.10)), .01, format="%.2f")
        if rule == "drawdown_buy":
            params["buy_fraction"] = st.slider("발동 시 현금 투입 비율", 0.0, 1.0, float(params.get("buy_fraction", .5)), .05)
        else:
            params["normal_stock_pct"] = st.slider("평시 주식비중(안내용)", 0, 100, int(params.get("normal_stock_pct", 70)))
            params["triggered_stock_pct"] = st.slider("발동 시 주식비중", 0, 100, int(params.get("triggered_stock_pct", 85)))
    elif rule == "hold":
        params["hold_note"] = st.text_input("표시 메모", str(params.get("hold_note", "매매 없음")))

    if st.button("전략 규칙 적용", type="primary"):
        updated = st.session_state.strategies.copy()
        mask = updated["code"].astype(str) == selected
        updated.loc[mask, "rule"] = rule
        updated.loc[mask, "params_json"] = json.dumps(params, ensure_ascii=False)
        st.session_state.strategies = updated
        st.success("현재 세션에 적용했습니다.")

    st.divider()
    st.markdown("#### 전체 전략표")
    edited_strategies = st.data_editor(
        st.session_state.strategies, num_rows="dynamic", use_container_width=True, hide_index=True,
        column_config={"rule": st.column_config.SelectboxColumn(options=list(rule_names))},
    )
    if st.button("전체 전략표 적용"):
        st.session_state.strategies = edited_strategies
        st.success("전체 전략표를 적용했습니다.")

with tab_history:
    st.subheader("월별 기록·성과")
    snapshots_history = st.session_state.snapshots.copy()
    actions_history = st.session_state.actions.copy()
    if snapshots_history.empty:
        st.info("Snapshots 탭에 월말 기록을 누적한 뒤 스프레드시트를 다시 읽으면 성과가 표시됩니다.")
    else:
        equity, metrics = performance_summary(snapshots_history)
        m1, m2, m3, m4 = st.columns(4)
        fmt = lambda value: "—" if value is None else f"{value:.2%}"
        m1.metric("CAGR", fmt(metrics["cagr"]))
        m2.metric("MDD", fmt(metrics["mdd"]))
        m3.metric("연환산 변동성", fmt(metrics["volatility"]))
        m4.metric("Sharpe", "—" if metrics["sharpe"] is None else f"{metrics['sharpe']:.2f}")

        benchmark_text = st.text_input("비교 벤치마크", value=st.session_state.benchmarks, help="Yahoo Finance 티커를 쉼표로 구분")
        st.session_state.benchmarks = benchmark_text
        compare, benchmark_warnings = comparison_history(snapshots_history, benchmark_text.split(","))
        for warning in benchmark_warnings:
            st.warning(warning)
        if not compare.empty:
            fig = px.line(compare, x="date", y="value", color="series", markers=True, labels={"value": "시작=100", "date": "기준일", "series": "비교"})
            st.plotly_chart(fig, use_container_width=True)

        by_strategy = snapshots_history.copy()
        by_strategy["value"] = pd.to_numeric(by_strategy["value"], errors="coerce").fillna(0)
        by_strategy = by_strategy.groupby(["date", "strategy"], as_index=False)["value"].sum()
        by_strategy["normalized"] = by_strategy.groupby("strategy")["value"].transform(lambda s: s / s.iloc[0] * 100 if len(s) and s.iloc[0] else s)
        st.plotly_chart(px.line(by_strategy, x="date", y="normalized", color="strategy", markers=True, labels={"normalized": "시작=100"}), use_container_width=True)
        st.dataframe(snapshots_history.sort_values("date", ascending=False), use_container_width=True, hide_index=True)
        if not actions_history.empty:
            st.markdown("#### 실행 이력")
            st.dataframe(actions_history.sort_values("date", ascending=False), use_container_width=True, hide_index=True)

with tab_export:
    st.subheader("Google Sheets 복사용 데이터")
    st.caption("아래 코드 상자의 복사 아이콘을 누른 뒤 Google Sheets의 첫 셀에 붙여넣으세요.")
    snapshots, actions = export_month(as_of, view, edited_plan, st.session_state.get("month_memo", ""))

    st.markdown("#### 월말 스냅샷")
    st.code(to_tsv(snapshots), language=None)
    st.download_button(
        "스냅샷 CSV 다운로드", to_csv_bytes(snapshots),
        file_name=f"snapshots_{as_of.isoformat()}.csv", mime="text/csv",
    )

    st.markdown("#### 액션 및 실행 이력")
    st.code(to_tsv(actions), language=None)
    st.download_button(
        "액션 CSV 다운로드", to_csv_bytes(actions),
        file_name=f"actions_{as_of.isoformat()}.csv", mime="text/csv",
    )

    st.markdown("#### 현재 보유내역")
    st.code(to_tsv(st.session_state.holdings), language=None)
    st.download_button(
        "보유내역 CSV 다운로드", to_csv_bytes(st.session_state.holdings),
        file_name="holdings.csv", mime="text/csv",
    )

    st.markdown("#### 전략 설정")
    st.code(to_tsv(st.session_state.strategies), language=None)
    st.download_button(
        "전략 설정 CSV 다운로드", to_csv_bytes(st.session_state.strategies),
        file_name="strategies.csv", mime="text/csv",
    )
