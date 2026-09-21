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
import importlib
import streamlit_app.engine as allocation_engine

# Streamlit Community Cloud can keep imported modules alive while pulling a new
# commit.  Reload the calculation engine when a newly deployed symbol is not yet
# present in that process, so the UI and engine can never run as mixed versions.
if not hasattr(allocation_engine, "validate_configuration"):
    allocation_engine = importlib.reload(allocation_engine)

build_action_plan = allocation_engine.build_action_plan
comparison_history = allocation_engine.comparison_history
enrich_prices = allocation_engine.enrich_prices
performance_summary = allocation_engine.performance_summary
portfolio_view = allocation_engine.portfolio_view
sortino = allocation_engine.sortino
twr = allocation_engine.twr
validate_configuration = allocation_engine.validate_configuration
xirr = allocation_engine.xirr


st.set_page_config(page_title="월말 자산배분 도우미", page_icon="📊", layout="wide")
st.markdown("""<style>
:root{--surface:#fff;--border:#e2e8f0;--muted:#64748b;--ink:#0f172a;--primary:#2563eb;--bg:#f6f8fc}
.stApp{background:var(--bg);color:var(--ink)}
.block-container{max-width:1280px;padding-top:1.15rem;padding-bottom:4rem}
section[data-testid="stSidebar"]{background:#0f172a;border-right:1px solid #1e293b}
section[data-testid="stSidebar"] *{color:#e2e8f0}
.app-hero{background:linear-gradient(125deg,#0f172a 0%,#1e3a8a 62%,#2563eb 120%);color:white;border-radius:22px;padding:25px 28px;margin-bottom:18px;box-shadow:0 14px 35px rgba(15,23,42,.15)}
.app-hero .eyebrow{font-size:.72rem;font-weight:750;letter-spacing:.13em;color:#93c5fd}
.app-hero .title{font-size:1.85rem;font-weight:850;letter-spacing:-.04em;margin:.25rem 0}
.app-hero .sub{font-size:.9rem;color:#cbd5e1}
.weight-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:13px 14px;margin:8px 0;box-shadow:0 1px 3px rgba(15,23,42,.04)}
.weight-head{display:flex;justify-content:space-between;gap:10px;font-weight:700}
.weight-meta{font-size:.78rem;color:var(--muted);margin-top:5px}
.weight-bar{height:12px;display:flex;overflow:hidden;border-radius:999px;background:#eef0f3;margin-top:9px}
[data-testid="stMetric"]{background:#fff;border:1px solid var(--border);border-radius:15px;padding:.85rem 1rem;box-shadow:0 1px 3px rgba(15,23,42,.04)}
[data-testid="stMetricValue"]{font-weight:800;letter-spacing:-.03em}
.stTabs [data-baseweb="tab-list"]{gap:.35rem;background:#eef2f7;border-radius:13px;padding:.35rem}
.stTabs [data-baseweb="tab"]{height:2.65rem;border-radius:9px;padding:0 .85rem}
.stTabs [aria-selected="true"]{background:#fff;color:var(--primary);box-shadow:0 1px 3px rgba(15,23,42,.08)}
div[data-testid="stExpander"],div[data-testid="stDataFrame"]{border-color:var(--border);border-radius:14px;overflow:hidden}
.stButton>button,.stDownloadButton>button{border-radius:10px;min-height:2.55rem;font-weight:650}
h1,h2,h3,h4{letter-spacing:-.03em}
@media(max-width:640px){.block-container{padding:.7rem}.stButton>button{width:100%}.app-hero{padding:19px 17px;border-radius:16px}.app-hero .title{font-size:1.38rem}.stTabs [data-baseweb="tab-list"]{overflow-x:auto}}
</style>""", unsafe_allow_html=True)


def won(value: float) -> str:
    return f"{value:,.0f}원"


def weight_card(name: str, current: float, target: float, amount: float) -> None:
    current, target = max(0.0, current), max(0.0, target)
    scale = max(100.0, current, target, 1.0)
    green, blue, red = min(current, target) / scale * 100, max(target-current, 0) / scale * 100, max(current-target, 0) / scale * 100
    bars = "".join([
        f'<div style="width:{green}%;background:#16a34a"></div>' if green else "",
        f'<div style="width:{blue}%;background:#3b82f6"></div>' if blue else "",
        f'<div style="width:{red}%;background:#ef4444"></div>' if red else "",
    ])
    st.markdown(f'<div class="weight-card"><div class="weight-head"><span>{name}</span><span>{current:.1f}%</span></div>'
                f'<div class="weight-meta">{won(amount)} · 목표 {target:.1f}% · 괴리 {current-target:+.1f}%p</div>'
                f'<div class="weight-bar">{bars}</div><div class="weight-meta">🟢 목표 충족 · 🔵 목표 미달 · 🔴 목표 초과</div></div>', unsafe_allow_html=True)


def rebalance_status(group: pd.DataFrame) -> tuple[str, str]:
    if group.empty:
        return "⚪ 데이터 없음", "계획 데이터가 없습니다."
    current = pd.to_numeric(group["현재평가액"], errors="coerce").fillna(0)
    trades = pd.to_numeric(group["예상매매액"], errors="coerce").fillna(0).abs()
    ratio = float(trades.max() / current.sum()) if current.sum() > 0 else 0
    if ratio >= .10: return "🔴 리밸런싱 필요", f"최대 조정액 {ratio:.1%}"
    if ratio >= .03: return "🟡 점검 권장", f"최대 조정액 {ratio:.1%}"
    return "🟢 정상", "목표비중과의 괴리가 크지 않습니다."


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
if "cashflows" not in st.session_state:
    st.session_state.cashflows = pd.DataFrame(columns=["date", "amount", "memo", "strategy"])
if "category_targets" not in st.session_state:
    st.session_state.category_targets = pd.DataFrame(columns=["category", "target_pct"])

st.markdown("""<div class="app-hero"><div class="eyebrow">PORTFOLIO REBALANCING</div>
<div class="title">월말 자산배분 도우미</div>
<div class="sub">지정일 종가 · 전략별 신호 · 실행 체크 · 성과 비교 · Google Sheets 수동 기록</div></div>""", unsafe_allow_html=True)

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
            st.success("Holdings·Strategies·Snapshots·Actions·Cashflows·CategoryTargets를 불러왔습니다.")
        except DataError as exc:
            st.error(str(exc))
    st.caption("탭 이름은 Holdings, Strategies, Snapshots, Actions, Cashflows, CategoryTargets를 사용합니다. Holdings 외 탭은 없어도 됩니다.")

holdings = st.session_state.holdings.copy()
strategies = st.session_state.strategies.copy()
active_mask = ~strategies["active"].astype(str).str.lower().isin(["false", "0", "no"])
active_codes = set(strategies.loc[active_mask, "code"].astype(str))
active_holdings = holdings[holdings["strategy"].astype(str).isin(active_codes)].copy()

if refresh or "priced_holdings" not in st.session_state:
    with st.spinner("Yahoo Finance에서 종가를 조회하고 있습니다..."):
        priced, warnings = enrich_prices(active_holdings, as_of, adjusted=price_mode == "수정종가")
        st.session_state.priced_holdings = priced
        st.session_state.price_warnings = warnings

priced = st.session_state.priced_holdings.copy()
view = portfolio_view(priced)
plan = build_action_plan(view, strategies, as_of)

for warning in st.session_state.get("price_warnings", []):
    st.warning(warning)

tab_dashboard, tab_plan, tab_holdings, tab_settings, tab_history, tab_export = st.tabs(
    ["🏠 대시보드", "🔄 리밸런싱 실행", "📦 보유내역", "⚙️ 전략 설정", "📈 기록·성과", "📋 복사용 데이터"]
)

with tab_dashboard:
    total = float(view["평가액"].sum()) if not view.empty else 0
    cash = float(view.loc[view["category"] == "현금", "평가액"].sum()) if not view.empty else 0
    c1, c2, c3 = st.columns(3)
    c1.metric("총 평가액", won(total))
    c2.metric("현금", won(cash), f"{cash / total * 100:.1f}%" if total else "0%")
    c3.metric("조회 기준일", as_of.isoformat())

    st.markdown("### 전략별 목표비중 현황")
    for code, group in view.groupby("strategy", sort=False):
        cfg = strategies.loc[strategies["code"].astype(str) == str(code)]
        account = str(cfg.iloc[0]["account"]) if not cfg.empty else str(code)
        with st.expander(f"{code} · {account} · {won(group['평가액'].sum())}", expanded=True):
            for row in group.itertuples():
                weight_card(str(row.name or row.ticker), float(row.현재비중), float(row.target_pct), float(row.평가액))

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
        color_discrete_map={"현재비중": "#2563eb", "target_pct": "#94a3b8"},
    )
    st.plotly_chart(fig, use_container_width=True)

    st.subheader("전체 자산군 분포")
    categories = view.groupby("category", as_index=False)["평가액"].sum()
    categories["비중"] = categories["평가액"] / max(categories["평가액"].sum(), 1) * 100
    targets = dict(zip(st.session_state.category_targets.get("category", []), pd.to_numeric(st.session_state.category_targets.get("target_pct", []), errors="coerce").fillna(0)))
    categories["목표비중"] = categories["category"].map(lambda x: targets.get(x, 0.0))
    categories["괴리(%p)"] = categories["비중"] - categories["목표비중"]
    st.dataframe(categories, use_container_width=True, hide_index=True)

with tab_plan:
    st.subheader("이번 달 액션 플랜")
    st.caption("계획은 참고값입니다. 주문 전 가격·세금·수수료와 실제 주문 가능 수량을 확인하세요.")
    memo = st.text_area("이번 달 판단 메모", key="month_memo", placeholder="시장 상황, 예외 처리, 실행하지 않은 이유 등을 기록하세요.")
    st.markdown("### 전략별 현재 상태")
    signal_cols = view[["strategy", "ticker", "close", "sma10", "momentum12"]].copy()
    detailed = plan.merge(signal_cols, left_on=["전략", "티커"], right_on=["strategy", "ticker"], how="left")
    detailed["목표평가액"] = detailed["현재평가액"] + detailed["예상매매액"]
    for code, group in detailed.groupby("전략", sort=False):
        status, help_text = rebalance_status(group)
        st.markdown(f"#### {code}")
        st.caption(f"{status} · {help_text}")
        m1, m2, m3 = st.columns(3)
        m1.metric("현재", won(group["현재평가액"].sum()))
        m2.metric("목표", won(group["목표평가액"].sum()))
        m3.metric("순매매", won(group["예상매매액"].sum()))
        show = group[["티커", "종목", "close", "sma10", "momentum12", "현재평가액", "목표평가액", "예상매매액", "근거"]].copy()
        def trade_color(value):
            return "color:#dc2626;font-weight:700" if value > 1000 else ("color:#2563eb;font-weight:700" if value < -1000 else "")
        st.dataframe(show.style.map(trade_color, subset=["예상매매액"]), use_container_width=True, hide_index=True)

    st.markdown("### 실행 체크리스트")
    actionable_plan = plan[pd.to_numeric(plan["예상매매액"], errors="coerce").abs() > 1000].copy()
    if actionable_plan.empty:
        st.success("실행할 매매가 없습니다.")
    edited_plan = st.data_editor(
        actionable_plan, key="action_editor", use_container_width=True, hide_index=True,
        disabled=[column for column in actionable_plan.columns if column not in {"실행", "실제수량", "메모"}],
        column_config={
            "실행": st.column_config.CheckboxColumn(),
            "예상매매액": st.column_config.NumberColumn(format="%,.0f원"),
            "현재평가액": st.column_config.NumberColumn(format="%,.0f원"),
        },
    )
    with st.expander("🛡️ 리밸런싱 실행 전 최종 점검"):
        errors = []
        if edited_plan.empty: errors.append("리밸런싱 계획이 없습니다.")
        if (pd.to_numeric(view["close"], errors="coerce").fillna(0) <= 0).any(): errors.append("종가가 없는 종목이 있습니다.")
        for code, group in view.groupby("strategy"):
            rule_row = strategies[strategies["code"].astype(str) == str(code)]
            rule_value = str(rule_row.iloc[0]["rule"]) if not rule_row.empty else "static"
            if rule_value in {"static", "sma_filter_rebalance"}:
                total_target = group["target_pct"].sum()
                if abs(total_target-100) > .1: errors.append(f"{code}: 목표비중 합계가 {total_target:.1f}%입니다.")
        if errors:
            for error in errors: st.warning(error)
        else:
            st.success("가격과 목표비중 기본 점검을 통과했습니다.")

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
    config_warnings = validate_configuration(holdings, strategies)
    if config_warnings:
        with st.expander(f"⚠️ 설정 점검 {len(config_warnings)}건", expanded=True):
            for warning in config_warnings:
                st.warning(warning)
    else:
        st.success("전략 구성과 비중 설정이 기본 검증을 통과했습니다.")
    rule_names = {
        "static": "정적 목표비중", "sma_filter_rebalance": "10개월 SMA 필터",
        "momentum_rotate": "모멘텀 1위 로테이션", "drawdown_buy": "낙폭 분할매수",
        "drawdown_shift": "낙폭 비중전환", "hold": "보유 유지",
    }
    strategy_codes = strategies["code"].astype(str).tolist()
    selected = st.selectbox("설정할 전략", strategy_codes)
    current = strategies.loc[strategies["code"].astype(str) == selected].iloc[0]
    c1, c2 = st.columns(2)
    account_edit = c1.text_input("계좌명", str(current.get("account", selected)))
    active_edit = c2.checkbox("전략 활성화", bool(current.get("active", True)))
    description_edit = st.text_area("전략 설명", str(current.get("description", "")), height=70)
    current_rule = str(current["rule"]) if str(current["rule"]) in rule_names else "static"
    rule = st.selectbox(
        "규칙", list(rule_names), index=list(rule_names).index(current_rule),
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
        updated.loc[mask, "account"] = account_edit
        updated.loc[mask, "active"] = active_edit
        updated.loc[mask, "description"] = description_edit
        st.session_state.strategies = updated
        st.session_state.pop("priced_holdings", None)
        st.success("현재 세션에 적용했습니다.")

    st.divider()
    st.markdown("#### 선택 전략의 구성 종목")
    selected_assets = st.session_state.holdings[st.session_state.holdings["strategy"].astype(str) == selected].copy()
    edited_assets = st.data_editor(
        selected_assets, num_rows="dynamic", use_container_width=True, hide_index=True,
        column_config={
            "market": st.column_config.SelectboxColumn(options=["KR", "US"]),
            "target_pct": st.column_config.NumberColumn(min_value=0.0, max_value=100.0, step=.1),
            "shares": st.column_config.NumberColumn(min_value=0.0, step=1.0),
        },
    )
    target_sum = pd.to_numeric(edited_assets["target_pct"], errors="coerce").fillna(0).sum()
    st.caption(f"목표비중 합계 {target_sum:.1f}%")
    if st.button("구성 종목·목표비중 적용"):
        rest = st.session_state.holdings[st.session_state.holdings["strategy"].astype(str) != selected]
        st.session_state.holdings = pd.concat([rest, edited_assets], ignore_index=True)
        st.session_state.pop("priced_holdings", None)
        st.success("현재 세션에 적용했습니다.")

    with st.expander("전략 추가·삭제"):
        new_code = st.text_input("새 전략 코드").strip().upper()
        new_account = st.text_input("새 전략 계좌명")
        if st.button("새 전략 추가") and new_code:
            if new_code in st.session_state.strategies["code"].astype(str).tolist():
                st.error("이미 존재하는 전략 코드입니다.")
            else:
                row = pd.DataFrame([{"code": new_code, "account": new_account or new_code, "description": "", "dynamic": False, "active": True, "annual_limit": 0, "rule": "static", "params_json": "{}"}])
                st.session_state.strategies = pd.concat([st.session_state.strategies, row], ignore_index=True)
                st.success("전략을 추가했습니다.")
        confirm_delete = st.checkbox(f"{selected} 전략과 소속 종목 삭제 확인")
        if st.button("선택 전략 삭제", disabled=not confirm_delete):
            st.session_state.strategies = st.session_state.strategies[st.session_state.strategies["code"].astype(str) != selected].reset_index(drop=True)
            st.session_state.holdings = st.session_state.holdings[st.session_state.holdings["strategy"].astype(str) != selected].reset_index(drop=True)
            st.session_state.pop("priced_holdings", None)
            st.success("삭제했습니다.")

    st.divider()
    st.markdown("#### 전체 자산군 목표비중")
    categories = ["현금", "금", "선진국 주식", "신흥국 주식", "선진국 채권", "신흥국 채권", "기타"]
    existing_targets = dict(zip(st.session_state.category_targets.get("category", []), pd.to_numeric(st.session_state.category_targets.get("target_pct", []), errors="coerce").fillna(0)))
    category_editor = st.data_editor(pd.DataFrame({"category": categories, "target_pct": [existing_targets.get(x, 0.0) for x in categories]}), hide_index=True, use_container_width=True)
    if st.button("자산군 목표비중 적용"):
        st.session_state.category_targets = category_editor
        st.success("적용했습니다.")

    st.divider()
    st.markdown("#### 전체 전략표")
    edited_strategies = st.data_editor(
        st.session_state.strategies, num_rows="dynamic", use_container_width=True, hide_index=True,
        column_config={"rule": st.column_config.SelectboxColumn(options=list(rule_names))},
    )
    if st.button("전체 전략표 적용"):
        st.session_state.strategies = edited_strategies
        st.session_state.pop("priced_holdings", None)
        st.success("전체 전략표를 적용했습니다.")

with tab_history:
    st.subheader("월별 기록·성과")
    snapshots_history = st.session_state.snapshots.copy()
    actions_history = st.session_state.actions.copy()
    if snapshots_history.empty:
        st.info("Snapshots 탭에 월말 기록을 누적한 뒤 스프레드시트를 다시 읽으면 성과가 표시됩니다.")
    else:
        snapshots_history["date"] = pd.to_datetime(snapshots_history["date"], errors="coerce")
        range_name = st.radio("비교 구간", ["전체", "1년", "6개월", "3개월", "YTD"], horizontal=True)
        last_day = snapshots_history["date"].max()
        cuts = {"1년": last_day-pd.Timedelta(days=365), "6개월": last_day-pd.Timedelta(days=182), "3개월": last_day-pd.Timedelta(days=91), "YTD": pd.Timestamp(f"{last_day.year}-01-01")}
        if range_name != "전체":
            snapshots_history = snapshots_history[snapshots_history["date"] >= cuts[range_name]]
        equity, metrics = performance_summary(snapshots_history)
        cashflows = st.session_state.cashflows.copy()
        irr_value, twr_value, sortino_value = xirr(equity, cashflows), twr(equity, cashflows), sortino(equity)
        m1, m2, m3, m4 = st.columns(4)
        fmt = lambda value: "—" if value is None else f"{value:.2%}"
        m1.metric("CAGR", fmt(metrics["cagr"]))
        m2.metric("MDD", fmt(metrics["mdd"]))
        m3.metric("연환산 변동성", fmt(metrics["volatility"]))
        m4.metric("Sharpe", "—" if metrics["sharpe"] is None else f"{metrics['sharpe']:.2f}")
        x1, x2, x3 = st.columns(3)
        x1.metric("XIRR", fmt(irr_value))
        x2.metric("TWR", fmt(twr_value))
        x3.metric("Sortino", "—" if sortino_value is None else f"{sortino_value:.2f}")

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
        strategy_metrics = []
        for code, group in snapshots_history.groupby("strategy"):
            eq_strategy, met = performance_summary(group)
            strategy_metrics.append({"전략": code, "CAGR": met["cagr"], "MDD": met["mdd"], "변동성": met["volatility"], "Sharpe": met["sharpe"]})
        st.dataframe(pd.DataFrame(strategy_metrics), use_container_width=True, hide_index=True)
        st.dataframe(snapshots_history.sort_values("date", ascending=False), use_container_width=True, hide_index=True)
        if not actions_history.empty:
            st.markdown("#### 실행 이력")
            st.dataframe(actions_history.sort_values("date", ascending=False), use_container_width=True, hide_index=True)

    st.divider()
    st.subheader("입출금 원장")
    st.caption("입금은 +, 출금은 -로 입력합니다. 기록은 Cashflows 탭에 복사해 누적합니다.")
    cashflows_edit = st.data_editor(
        st.session_state.cashflows, num_rows="dynamic", use_container_width=True, hide_index=True,
        column_config={"amount": st.column_config.NumberColumn(step=100000.0)},
    )
    if st.button("입출금 원장 적용"):
        st.session_state.cashflows = cashflows_edit
        st.success("현재 세션에 적용했습니다.")

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

    st.markdown("#### 입출금 원장")
    st.code(to_tsv(st.session_state.cashflows), language=None)
    st.download_button("입출금 CSV 다운로드", to_csv_bytes(st.session_state.cashflows), file_name="cashflows.csv", mime="text/csv")

    st.markdown("#### 자산군 목표비중")
    st.code(to_tsv(st.session_state.category_targets), language=None)
    st.download_button("자산군 목표 CSV 다운로드", to_csv_bytes(st.session_state.category_targets), file_name="category_targets.csv", mime="text/csv")
