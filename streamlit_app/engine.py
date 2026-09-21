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


def validate_configuration(holdings: pd.DataFrame, strategies: pd.DataFrame) -> list[str]:
    warnings = []
    duplicates = holdings[holdings.duplicated(["strategy", "ticker"], keep=False) & holdings["ticker"].astype(str).ne("")]
    if not duplicates.empty:
        pairs = duplicates[["strategy", "ticker"]].drop_duplicates().astype(str).agg("/".join, axis=1)
        warnings.append("중복 종목: " + ", ".join(pairs))
    for code, group in holdings.groupby("strategy", sort=False):
        rule, params = _params(strategies, code)
        if rule in {"static", "sma_filter_rebalance"}:
            total = pd.to_numeric(group["target_pct"], errors="coerce").fillna(0).sum()
            if abs(total - 100) > .1:
                warnings.append(f"{code}: 목표비중 합계가 {total:.1f}%입니다.")
        if rule == "momentum_rotate":
            allocation = float(params.get("winner_share", .8)) + float(params.get("cash_winner_share", .2))
            if abs(allocation - 1) > .001:
                warnings.append(f"{code}: 1위 자산과 현금 비중의 합이 {allocation:.1%}입니다.")
        if rule == "drawdown_shift":
            stock = str(params.get("stock_ticker") or params.get("signal", {}).get("ticker", ""))
            if stock and stock not in set(group["ticker"].astype(str)):
                warnings.append(f"{code}: 주식 티커 {stock}가 구성 종목에 없습니다.")
    return warnings


def build_action_plan(view: pd.DataFrame, strategies: pd.DataFrame, as_of: date) -> pd.DataFrame:
    rows: list[dict] = []
    for code, sub in view.groupby("strategy", sort=False):
        sub = sub.copy()
        rule, params = _params(strategies, code)
        total = float(sub["평가액"].sum())
        target_values = {str(r.ticker): float(r.평가액) for r in sub.itertuples()}
        notes = {str(r.ticker): "유지" for r in sub.itertuples()}
        non_cash = sub[sub["ticker"] != "CASH"]

        if rule == "static":
            target_values = {str(r.ticker): total * float(r.target_pct) / 100 for r in sub.itertuples()}
            notes = {str(r.ticker): "목표비중 리밸런싱" for r in sub.itertuples()}
        elif rule == "hold":
            notes = {str(r.ticker): str(params.get("hold_note", "장기보유 · 매매 없음")) for r in sub.itertuples()}
        elif rule == "sma_filter_rebalance":
            quarter_end = as_of.month in {3, 6, 9, 12}
            filtered = set(map(str, params.get("sma_tickers", [])))
            for r in non_cash.itertuples():
                ticker = str(r.ticker)
                breached = ticker in filtered and pd.notna(r.sma10) and float(r.close) < float(r.sma10)
                if breached:
                    target_values[ticker] = 0.0
                    notes[ticker] = "SMA 이탈 → 현금화"
                elif quarter_end:
                    target_values[ticker] = total * float(r.target_pct) / 100
                    notes[ticker] = "목표비중 복원(분기말)"
                else:
                    notes[ticker] = "유지(분기중)"
            if "CASH" in target_values:
                target_values["CASH"] = max(0.0, total - sum(target_values[str(t)] for t in non_cash["ticker"]))
                notes["CASH"] = "필터 이탈 자산 보관"
        elif rule == "momentum_rotate":
            candidates = non_cash
            deficient = candidates[candidates["sma10"].isna() | candidates["momentum12"].isna()]
            usable = candidates.drop(deficient.index)
            passing = usable[usable["close"] > usable["sma10"]].sort_values("momentum12", ascending=False)
            held_value = float(deficient["평가액"].sum())
            pool = total - held_value
            for r in usable.itertuples():
                target_values[str(r.ticker)] = 0.0
                notes[str(r.ticker)] = "SMA 이탈" if float(r.close) <= float(r.sma10) else "미선정(순위 밀림)"
            for r in deficient.itertuples():
                notes[str(r.ticker)] = "데이터 부족 · 보유 유지"
            if not passing.empty:
                winner = str(passing.iloc[0]["ticker"])
                target_values[winner] = pool * float(params.get("winner_share", .8))
                notes[winner] = "SMA 통과 후보 중 12개월 모멘텀 1위"
                cash_value = pool * float(params.get("cash_winner_share", .2))
                cash_note = "전략 대기현금"
            else:
                cash_value = pool
                cash_note = "통과 후보 없음 → 현금"
            if "CASH" in target_values:
                target_values["CASH"] = cash_value
                notes["CASH"] = cash_note
        elif rule in {"drawdown_buy", "drawdown_shift"}:
            signal = params.get("signal", {})
            signal_ticker = str(signal.get("ticker", ""))
            same_signal = sub[sub["ticker"].astype(str) == signal_ticker]["drawdown120"].dropna()
            if not same_signal.empty:
                dd = float(same_signal.iloc[0])
            else:
                signal_series = _series(signal_ticker, str(signal.get("market", "KR")), as_of) if signal_ticker else pd.Series(dtype=float)
                recent = signal_series.tail(int(signal.get("lookback_days", 120)))
                dd = float(recent.iloc[-1] / recent.max() - 1) if len(recent) >= 20 else None
            threshold = float(params.get("threshold", -.1))
            triggered = dd is not None and dd <= threshold
            if rule == "drawdown_buy":
                cash_rows = sub[sub["ticker"] == "CASH"]
                stock_rows = non_cash
                if not stock_rows.empty and not cash_rows.empty:
                    stock_ticker = str(stock_rows.iloc[0]["ticker"])
                    cash_current = float(cash_rows["평가액"].sum())
                    buy = cash_current * float(params.get("buy_fraction", .5)) if triggered else 0.0
                    target_values[stock_ticker] = float(stock_rows.iloc[0]["평가액"]) + buy
                    target_values["CASH"] = cash_current - buy
                    notes[stock_ticker] = f"낙폭 {dd:.1%} 트리거 발동" if triggered else f"대기({dd:.1%})" if dd is not None else "대기(데이터 없음)"
                    notes["CASH"] = "매수 재원" if triggered else "대기현금 유지"
            else:
                stock_ticker = str(params.get("stock_ticker") or signal_ticker)
                if stock_ticker not in set(sub["ticker"].astype(str)) and not non_cash.empty:
                    stock_ticker = str(non_cash.iloc[0]["ticker"])
                stock_pct = float(params.get("triggered_stock_pct", 85) if triggered else params.get("normal_stock_pct", 70))
                target_values[stock_ticker] = total * stock_pct / 100
                defensive = sub[sub["ticker"].astype(str) != stock_ticker]
                defensive_total = total - target_values[stock_ticker]
                current_defensive = float(defensive["평가액"].sum())
                for r in defensive.itertuples():
                    share = float(r.평가액) / current_defensive if current_defensive > 0 else 1 / max(1, len(defensive))
                    target_values[str(r.ticker)] = defensive_total * share
                    notes[str(r.ticker)] = "트리거 발동 → 현금성 축소" if triggered else "평시 목표비중"
                notes[stock_ticker] = f"트리거 발동({dd:.1%}) → 주식 {stock_pct:.0f}%" if triggered else f"평시 주식 {stock_pct:.0f}%"

        for r in sub.itertuples():
            target_value = float(target_values.get(str(r.ticker), r.평가액))
            amount = target_value - float(r.평가액)
            unit_krw = float(r.close) * float(r.fx)
            qty = round(amount / unit_krw, 4) if unit_krw > 0 and r.ticker != "CASH" else 0.0
            side = "매수" if amount > 1000 else ("매도" if amount < -1000 else "유지")
            rows.append({"실행": False, "전략": code, "티커": r.ticker, "종목": r.name,
                         "구분": side, "현재평가액": float(r.평가액), "목표평가액": target_value,
                         "예상매매액": amount, "제안수량": qty, "실제수량": 0.0,
                         "근거": notes.get(str(r.ticker), "유지"), "메모": ""})
    columns = ["실행", "전략", "티커", "종목", "구분", "현재평가액", "목표평가액", "예상매매액", "제안수량", "실제수량", "근거", "메모"]
    return pd.DataFrame(rows, columns=columns)


def performance_summary(snapshots: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, float | None]]:
    if snapshots.empty:
        return pd.DataFrame(columns=["date", "portfolio"]), {"cagr": None, "mdd": None, "volatility": None, "sharpe": None}
    df = snapshots.copy()
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["value"] = pd.to_numeric(df["value"], errors="coerce").fillna(0.0)
    equity = df.groupby("date", as_index=False)["value"].sum().rename(columns={"value": "portfolio"}).sort_values("date")
    equity = equity[equity["portfolio"] > 0]
    if len(equity) < 2:
        return equity, {"cagr": None, "mdd": None, "volatility": None, "sharpe": None}
    values = equity["portfolio"]
    years = max((equity["date"].iloc[-1] - equity["date"].iloc[0]).days / 365.25, 1 / 12)
    cagr = float((values.iloc[-1] / values.iloc[0]) ** (1 / years) - 1)
    mdd = float((values / values.cummax() - 1).min())
    returns = values.pct_change().dropna()
    volatility = float(returns.std(ddof=1) * np.sqrt(12)) if len(returns) >= 2 else None
    sharpe = float(returns.mean() / returns.std(ddof=1) * np.sqrt(12)) if len(returns) >= 2 and returns.std(ddof=1) > 0 else None
    return equity, {"cagr": cagr, "mdd": mdd, "volatility": volatility, "sharpe": sharpe}


def comparison_history(snapshots: pd.DataFrame, benchmark_tickers: list[str]) -> tuple[pd.DataFrame, list[str]]:
    equity, _ = performance_summary(snapshots)
    if equity.empty:
        return pd.DataFrame(columns=["date", "series", "value"]), []
    start, end = equity["date"].min(), equity["date"].max() + pd.Timedelta(days=5)
    base = equity.copy()
    base["portfolio"] = base["portfolio"] / base["portfolio"].iloc[0] * 100
    result = [base.rename(columns={"portfolio": "value"}).assign(series="내 포트폴리오")]
    warnings = []
    for ticker in benchmark_tickers:
        ticker = ticker.strip()
        if not ticker:
            continue
        try:
            raw = yf.download(ticker, start=start.date(), end=end.date(), auto_adjust=True, progress=False, threads=False)
            if raw.empty:
                raise ValueError("데이터 없음")
            close = raw["Close"]
            if isinstance(close, pd.DataFrame):
                close = close.iloc[:, 0]
            series = pd.DataFrame({"date": pd.to_datetime(close.index).tz_localize(None), "price": pd.to_numeric(close, errors="coerce")}).dropna()
            matched = pd.merge_asof(equity[["date"]].sort_values("date"), series.sort_values("date"), on="date", direction="backward").dropna()
            if matched.empty:
                raise ValueError("기록일과 일치하는 가격 없음")
            matched["value"] = matched["price"] / matched["price"].iloc[0] * 100
            result.append(matched[["date", "value"]].assign(series=ticker))
        except Exception as exc:
            warnings.append(f"{ticker}: {exc}")
    return pd.concat(result, ignore_index=True)[["date", "series", "value"]], warnings


def xirr(equity: pd.DataFrame, cashflows: pd.DataFrame) -> float | None:
    if equity.empty or cashflows.empty or len(equity) < 2:
        return None
    eq = equity.sort_values("date")
    last_date, last_value = pd.Timestamp(eq.iloc[-1]["date"]), float(eq.iloc[-1]["portfolio"])
    flows = []
    for row in cashflows.itertuples():
        try:
            dt, amount = pd.Timestamp(row.date), -float(row.amount)
            if dt < last_date and amount:
                flows.append((dt, amount))
        except Exception:
            continue
    flows.append((last_date, last_value))
    if len(flows) < 2 or not any(v < 0 for _, v in flows) or not any(v > 0 for _, v in flows):
        return None
    d0 = min(d for d, _ in flows)
    def npv(rate):
        return sum(value / (1 + rate) ** ((dt-d0).days / 365.25) for dt, value in flows)
    lo, hi = -.9999, 100.0
    if npv(lo) * npv(hi) > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        if npv(mid) > 0: lo = mid
        else: hi = mid
    return (lo + hi) / 2


def twr(equity: pd.DataFrame, cashflows: pd.DataFrame) -> float | None:
    if equity.empty or len(equity) < 2:
        return None
    eq = equity.sort_values("date").copy()
    cf = cashflows.copy()
    if not cf.empty:
        cf["date"] = pd.to_datetime(cf["date"], errors="coerce")
        cf["amount"] = pd.to_numeric(cf["amount"], errors="coerce").fillna(0)
    returns = []
    for i in range(1, len(eq)):
        d0, d1 = pd.Timestamp(eq.iloc[i-1]["date"]), pd.Timestamp(eq.iloc[i]["date"])
        v0, v1 = float(eq.iloc[i-1]["portfolio"]), float(eq.iloc[i]["portfolio"])
        flows = cf[(cf["date"] > d0) & (cf["date"] <= d1)]["amount"].sum() if not cf.empty else 0
        if v0 > 0:
            returns.append((v1 - v0 - flows) / v0)
    return float(np.prod([1+r for r in returns])-1) if returns else None


def sortino(equity: pd.DataFrame) -> float | None:
    if equity.empty or len(equity) < 3:
        return None
    returns = equity.sort_values("date")["portfolio"].pct_change().dropna()
    downside = returns[returns < 0]
    if downside.empty:
        return None
    deviation = float(np.sqrt((downside**2).mean()))
    return float(returns.mean() / deviation * np.sqrt(12)) if deviation else None
