from __future__ import annotations

from datetime import date

import pandas as pd
import plotly.express as px
import streamlit as st

from streamlit_app.data import ReadOnlySheetsStore, StoreError, build_month_exports
from streamlit_app.engine import build_action_plan, enrich_prices, portfolio_view


st.set_page_config(page_title="월말 자산배분 도우미", page_icon="📊", layout="wide")


@st.cache_resource
def get_store() -> ReadOnlySheetsStore:
    return ReadOnlySheetsStore.from_streamlit_secrets()


def won(value: float) -> str:
    return f"{value:,.0f}원"


st.title("월말 자산배분 도우미")
st.caption("Google Sheets는 읽기 전용으로 사용하고, 월말 리밸런싱 결과는 복사해서 직접 붙여넣습니다.")

try:
    store = get_store()
except StoreError as exc:
    st.error(str(exc))
    st.info("README의 읽기 전용 Google Sheets 연결 절차를 확인하세요.")
    st.stop()

holdings = store.read("Holdings")
strategies = store.read("Strategies")

with st.sidebar:
    st.header("월말 기준")
    as_of = st.date_input("기준일", value=date.today())
    price_mode = st.radio("가격", ["종가", "수정종가"], horizontal=True)
    refresh = st.button("종가 새로 조회", type="primary", use_container_width=True)
    st.caption("휴장일이면 기준일 이전의 가장 최근 거래일을 사용합니다.")

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

tab_dashboard, tab_plan, tab_holdings, tab_history = st.tabs(
    ["대시보드", "액션 플랜", "보유내역", "월별 기록"]
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
    memo = st.text_area("이번 달 판단 메모", placeholder="시장 상황, 예외 처리, 실행하지 않은 이유 등을 기록하세요.")
    edited_plan = st.data_editor(
        plan,
        use_container_width=True,
        hide_index=True,
        disabled=[c for c in plan.columns if c not in {"실행", "실제수량", "메모"}],
        column_config={
            "실행": st.column_config.CheckboxColumn(),
            "예상매매액": st.column_config.NumberColumn(format="%,.0f원"),
            "현재평가액": st.column_config.NumberColumn(format="%,.0f원"),
        },
    )
    snapshots_export, actions_export = build_month_exports(as_of, view, edited_plan, memo)

    st.markdown("#### Google Sheets에 붙여넣기")
    st.caption("아래 표는 탭으로 구분되어 있습니다. 전체 선택 → 복사 후 Google Sheets의 첫 셀에 붙여넣으세요.")

    snap_tsv = snapshots_export.to_csv(sep="\t", index=False)
    action_tsv = actions_export.to_csv(sep="\t", index=False)

    c1, c2 = st.columns(2)
    with c1:
        st.download_button(
            "Snapshots TSV 다운로드",
            data=snap_tsv.encode("utf-8-sig"),
            file_name=f"snapshots_{as_of.isoformat()}.tsv",
            mime="text/tab-separated-values",
            use_container_width=True,
        )
    with c2:
        st.download_button(
            "Actions TSV 다운로드",
            data=action_tsv.encode("utf-8-sig"),
            file_name=f"actions_{as_of.isoformat()}.tsv",
            mime="text/tab-separated-values",
            use_container_width=True,
        )

    st.text_area("Snapshots 복사용", value=snap_tsv, height=180)
    st.text_area("Actions 복사용", value=action_tsv, height=180)

with tab_holdings:
    st.subheader("보유수량·종목 편집")
    st.caption("CASH의 shares에는 원화 현금 금액을 입력합니다. 미국 자산은 USD/KRW 환율이 자동 적용됩니다.")
    editable_cols = ["strategy", "account", "ticker", "name", "market", "category", "role", "target_pct", "shares"]
    edited = st.data_editor(
        holdings[editable_cols], num_rows="dynamic", use_container_width=True, hide_index=True,
        column_config={
            "market": st.column_config.SelectboxColumn(options=["KR", "US"]),
            "target_pct": st.column_config.NumberColumn(min_value=0.0, max_value=100.0, format="%.2f"),
            "shares": st.column_config.NumberColumn(min_value=0.0, format="%.4f"),
        },
    )
    st.info("읽기 전용 모드입니다. 보유수량 변경은 Google Sheets의 Holdings 시트에서 직접 수정하세요.")
    edited_tsv = edited.to_csv(sep="\t", index=False)
    st.download_button(
        "편집한 보유내역 TSV 다운로드",
        data=edited_tsv.encode("utf-8-sig"),
        file_name="holdings_edited.tsv",
        mime="text/tab-separated-values",
        use_container_width=True,
    )

with tab_history:
    st.subheader("월별 스냅샷")
    snapshots = store.read_optional("Snapshots")
    actions = store.read_optional("Actions")
    if snapshots.empty:
        st.caption("Snapshots 시트가 없거나 공개되지 않았습니다.")
    else:
        st.dataframe(snapshots.sort_values("date", ascending=False), use_container_width=True, hide_index=True)
    st.subheader("매매 실행 이력")
    if actions.empty:
        st.caption("Actions 시트가 없거나 공개되지 않았습니다.")
    else:
        st.dataframe(actions.sort_values("date", ascending=False), use_container_width=True, hide_index=True)

