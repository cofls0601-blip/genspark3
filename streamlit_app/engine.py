from __future__ import annotations

import json
from datetime import date, timedelta

import numpy as np
import pandas as pd
import yfinance as yf


def yahoo_symbol(ticker: str, market: str) -> str:
    if ticker == "CASH":
        return ticker
    if market == "KR" and "." not in ticker:
        return f"{ticker.zfill(6)}.KS"
    return ticker


def _series(ticker: str, market: str, as_of: date, adjusted: bool = False) -> pd.Series:
    end = as_of + timedelta(days=1)
    start = as_of - timedelta(days=620)
    data = yf.download(yahoo_symbol(ticker, market), start=start, end=end, auto_adjust=False, progress=False, threads=False)
    if data.empty:
        return pd.Series(dtype=float)
    column = data["Adj Close" if adjusted and "Adj Close" in data.columns else "Close"]
    if isinstance(column, pd.DataFrame):
        column = column.iloc[:, 0]
    return pd.to_numeric(column, errors="coerce").dropna()


def enrich_prices(holdings: pd.DataFrame, as_of: date, adjusted: bool = False) -> tuple[pd.DataFrame, list[str]]:
    out = holdings.copy()
    out["close"] = 0.0
    out["fx"] = 1.0
    out["sma10"] = np.nan
    out["momentum12"] = np.nan
    out["drawdown120"] = np.nan
    warnings: list[str] = []
    fx = _series("KRW=X", "US", as_of)
    usdkrw = float(fx.iloc[-1]) if not fx.empty else 0.0
    for idx, row in out.iterrows():
        ticker = str(row["ticker"]).strip()
        if not ticker or ticker.lower() == "nan":
            continue
        if ticker == "CASH":
            out.at[idx, "close"] = 1.0
            continue
        try:
            prices = _series(ticker, str(row["market"]), as_of, adjusted)
            if prices.empty:
                raise ValueError("종가 데이터 없음")
            out.at[idx, "close"] = float(prices.iloc[-1])
            out.at[idx, "fx"] = usdkrw if row["market"] == "US" else 1.0
            monthly = prices.resample("ME").last()
            if len(monthly) >= 10:
                out.at[idx, "sma10"] = float(monthly.tail(10).mean())
            if len(monthly) >= 13:
                out.at[idx, "momentum12"] = float(monthly.iloc[-1] / monthly.iloc[-13] - 1)
            recent = prices.tail(120)
            if len(recent) >= 20:
                out.at[idx, "drawdown120"] = float(recent.iloc[-1] / recent.max() - 1)
        except Exception as exc:
            warnings.append(f"{ticker}: {exc}")
    return out, warnings


def portfolio_view(priced: pd.DataFrame) -> pd.DataFrame:
    df = priced.copy()
    for col in ["shares", "target_pct", "close", "fx"]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
    df["평가액"] = df["shares"] * df["close"] * df["fx"]
    totals = df.groupby("strategy")["평가액"].transform("sum")
    df["현재비중"] = np.where(totals > 0, df["평가액"] / totals * 100, 0)
    grand = df["평가액"].sum()
    df["전체비중"] = np.where(grand > 0, df["평가액"] / grand * 100, 0)
    df["괴리"] = df["현재비중"] - df["target_pct"]
    return df


def _params(strategies: pd.DataFrame, code: str) -> tuple[str, dict]:
    row = strategies.loc[strategies["code"] == code]
    if row.empty:
        return "static", {}
    item = row.iloc[0]
    try:
        params = json.loads(item.get("params_json") or "{}")
    except json.JSONDecodeError:
        params = {}
    return str(item.get("rule") or "static"), params


def build_action_plan(view: pd.DataFrame, strategies: pd.DataFrame, as_of: date) -> pd.DataFrame:
    rows: list[dict] = []
    for code, sub in view.groupby("strategy", sort=False):
        rule, params = _params(strategies, code)
        total = float(sub["평가액"].sum())
        targets = {str(r.ticker): float(r.target_pct) for r in sub.itertuples()}
        notes = {str(r.ticker): "목표비중 복원" for r in sub.itertuples()}
        if rule == "hold":
            targets = {str(r.ticker): float(r.현재비중) for r in sub.itertuples()}
            notes = {str(r.ticker): "장기보유 · 매매 없음" for r in sub.itertuples()}
        elif rule == "sma_filter_rebalance":
            quarter_end = as_of.month in {3, 6, 9, 12}
            filtered = set(map(str, params.get("sma_tickers", [])))
            cash_target = targets.get("CASH", 0.0)
            for r in sub.itertuples():
                ticker = str(r.ticker)
                if ticker in filtered and pd.notna(r.sma10) and r.close < r.sma10:
                    cash_target += targets.get(ticker, 0.0)
                    targets[ticker] = 0.0
                    notes[ticker] = "10개월 SMA 이탈 → 현금화"
                elif not quarter_end:
                    targets[ticker] = float(r.현재비중)
                    notes[ticker] = "분기 중 유지"
            targets["CASH"] = cash_target
        elif rule == "momentum_rotate":
            usable = sub[(sub["ticker"] != "CASH") & sub["sma10"].notna() & sub["momentum12"].notna()]
            passing = usable[usable["close"] > usable["sma10"]].sort_values("momentum12", ascending=False)
            targets = {str(t): 0.0 for t in sub["ticker"]}
            if passing.empty:
                targets["CASH"] = 100.0
            else:
                winner = str(passing.iloc[0]["ticker"])
                targets[winner] = float(params.get("winner_share", .8)) * 100
                targets["CASH"] = float(params.get("cash_winner_share", .2)) * 100
                notes[winner] = "SMA 통과 후보 중 12개월 모멘텀 1위"
        elif rule in {"drawdown_buy", "drawdown_shift"}:
            equities = sub[sub["ticker"] != "CASH"]
            signal = params.get("signal", {})
            signal_ticker = str(signal.get("ticker", ""))
            signal_market = str(signal.get("market", "KR"))
            signal_series = _series(signal_ticker, signal_market, as_of) if signal_ticker else pd.Series(dtype=float)
            recent = signal_series.tail(int(signal.get("lookback_days", 120)))
            dd = float(recent.iloc[-1] / recent.max() - 1) if len(recent) >= 20 else None
            threshold = float(params.get("threshold", -.1))
            if dd is None or dd > threshold:
                targets = {str(r.ticker): float(r.현재비중) for r in sub.itertuples()}
                notes = {str(r.ticker): "트리거 미발동 · 유지" for r in sub.itertuples()}
            elif rule == "drawdown_buy":
                stock = str(equities.iloc[0]["ticker"])
                cash_pct = float(sub.loc[sub["ticker"] == "CASH", "현재비중"].sum())
                buy_pct = cash_pct * float(params.get("buy_fraction", .5))
                targets = {str(r.ticker): float(r.현재비중) for r in sub.itertuples()}
                targets[stock] += buy_pct
                targets["CASH"] = cash_pct - buy_pct
                notes[stock] = f"낙폭 {dd:.1%} 트리거 발동"
            else:
                stock_pct = float(params.get("triggered_stock_pct", 85))
                normal_stock_pct = float(params.get("normal_stock_pct", 70))
                targets = {str(r.ticker): 0.0 for r in sub.itertuples()}

                # Preserve the user's configured stock mix instead of splitting
                # the triggered stock allocation equally across all equities.
                configured = {
                    str(r.ticker): max(0.0, float(r.target_pct))
                    for r in equities.itertuples()
                }
                configured_total = sum(configured.values())
                if configured_total <= 0:
                    configured = {
                        str(r.ticker): max(0.0, float(r.현재비중))
                        for r in equities.itertuples()
                    }
                    configured_total = sum(configured.values())

                if configured_total > 0:
                    for ticker, weight in configured.items():
                        targets[ticker] = stock_pct * weight / configured_total
                        notes[ticker] = (
                            f"낙폭 {dd:.1%} 트리거 발동 · "
                            f"주식 {normal_stock_pct:.0f}%→{stock_pct:.0f}%"
                        )
                targets["CASH"] = 100 - stock_pct
                notes["CASH"] = f"낙폭 {dd:.1%} 트리거 발동 · 현금 축소"

        for r in sub.itertuples():
            target_value = total * targets.get(str(r.ticker), 0.0) / 100
            amount = target_value - float(r.평가액)
            unit_krw = float(r.close) * float(r.fx)
            qty = round(amount / unit_krw, 4) if unit_krw > 0 and r.ticker != "CASH" else 0.0
            if abs(amount) < 1000:
                continue
            rows.append({"실행": False, "전략": code, "티커": r.ticker, "종목": r.name,
                         "구분": "매수" if amount > 0 else "매도", "현재평가액": r.평가액,
                         "예상매매액": amount, "제안수량": qty, "실제수량": 0.0,
                         "근거": notes.get(str(r.ticker), "목표비중 조정"), "메모": ""})
    columns = ["실행", "전략", "티커", "종목", "구분", "현재평가액", "예상매매액", "제안수량", "실제수량", "근거", "메모"]
    return pd.DataFrame(rows, columns=columns)
