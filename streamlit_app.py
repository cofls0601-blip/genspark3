from __future__ import annotations

from datetime import date

import plotly.express as px
import streamlit as st

from streamlit_app.data import (
    DataError,
    export_month,
    load_default_holdings,
    load_default_strategies,
    read_pasted_holdings,
    read_public_google_sheet,
    to_csv_bytes,
    to_tsv,
)
from streamlit_app.engine import build_action_plan, enrich_prices, portfolio_view


st.set_page_config(page_title="월말 자산배분 도우미", page_icon="📊", layout="wide")


def won(value: float) -> str:
    return f"{value:,.0f}원"


if "holdings" not in st.session_state:
    st.session_state.holdings = load_default_holdings()
if "strategies" not in st.session_state:
    st.session_state.strategies = load_default_strategies()

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
    sheet_url = st.text_input("보유내역 시트 URL", placeholder="https://docs.google.com/spreadsheets/d/...")
    if st.button("시트에서 보유내역 읽기", use_container_width=True):
        try:
            st.session_state.holdings = read_public_google_sheet(sheet_url)
            st.session_state.pop("priced_holdings", None)
            st.success("보유내역을 불러왔습니다.")
        except DataError as exc:
            st.error(str(exc))
    st.caption("해당 탭의 첫 행이 열 이름이어야 하며, 공유 권한은 '링크가 있는 모든 사용자: 뷰어'여야 합니다.")

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

tab_dashboard, tab_plan, tab_holdings, tab_export = st.tabs(
    ["대시보드", "액션 플랜", "보유내역", "복사용 데이터"]
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

