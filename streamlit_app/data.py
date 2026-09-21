from __future__ import annotations

import io
import json
import re
from datetime import date, datetime, timezone
from urllib.parse import parse_qs, quote, urlparse

import pandas as pd

HOLDING_COLUMNS = ["strategy", "account", "ticker", "name", "market", "category", "role", "target_pct", "shares"]
STRATEGY_COLUMNS = ["code", "rule", "params_json", "active"]
SNAPSHOT_COLUMNS = ["date", "saved_at", "strategy", "account", "ticker", "name", "category", "close", "shares", "value", "weight_pct", "target_pct", "memo"]
ACTION_COLUMNS = ["date", "saved_at", "strategy", "ticker", "name", "side", "planned_shares", "actual_shares", "planned_amount", "done", "reason", "memo"]


class DataError(RuntimeError):
    pass


def normalize_holdings(frame: pd.DataFrame) -> pd.DataFrame:
    missing = [column for column in HOLDING_COLUMNS if column not in frame.columns]
    if missing:
        raise DataError(f"보유내역에 필요한 열이 없습니다: {', '.join(missing)}")
    df = frame.reindex(columns=HOLDING_COLUMNS).copy()
    for column in ["strategy", "account", "ticker", "name", "market", "category", "role"]:
        df[column] = df[column].fillna("").astype(str).str.strip()
    df["market"] = df["market"].str.upper().replace("", "KR")
    raw = df["ticker"].str.replace(r"\.0$", "", regex=True)
    is_kr_code = df["market"].eq("KR") & raw.ne("") & raw.ne("CASH")
    df["ticker"] = raw.where(~is_kr_code, raw.str.zfill(6))
    for column in ["target_pct", "shares"]:
        df[column] = pd.to_numeric(df[column], errors="coerce").fillna(0.0)
    return df


def normalize_strategies(frame: pd.DataFrame) -> pd.DataFrame:
    missing = [column for column in STRATEGY_COLUMNS if column not in frame.columns]
    if missing:
        raise DataError(f"전략표에 필요한 열이 없습니다: {', '.join(missing)}")
    return frame.reindex(columns=STRATEGY_COLUMNS).copy()


def load_default_holdings() -> pd.DataFrame:
    return normalize_holdings(pd.read_csv("config/default_holdings.csv", dtype={"ticker": str}))


def load_default_strategies() -> pd.DataFrame:
    with open("config/default_strategies.json", encoding="utf-8") as handle:
        items = json.load(handle)
    return pd.DataFrame([{
        "code": item["code"], "rule": item["rule"],
        "params_json": json.dumps(item.get("params", {}), ensure_ascii=False), "active": True,
    } for item in items], columns=STRATEGY_COLUMNS)


def _google_csv_url(url: str, sheet_name: str | None = None) -> str:
    match = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", url)
    if not match:
        raise DataError("올바른 Google Sheets URL이 아닙니다.")
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    fragment = parse_qs(parsed.fragment)
    gid = (query.get("gid") or fragment.get("gid") or ["0"])[0]
    if sheet_name:
        return f"https://docs.google.com/spreadsheets/d/{match.group(1)}/gviz/tq?tqx=out:csv&sheet={quote(sheet_name)}"
    return f"https://docs.google.com/spreadsheets/d/{match.group(1)}/export?format=csv&gid={gid}"


def read_public_google_sheet(url: str, kind: str = "holdings", sheet_name: str | None = None) -> pd.DataFrame:
    try:
        frame = pd.read_csv(_google_csv_url(url, sheet_name), dtype={"ticker": str})
    except Exception as exc:
        raise DataError("시트를 읽지 못했습니다. 링크 공유가 '링크가 있는 모든 사용자: 뷰어'인지 확인하세요.") from exc
    return normalize_holdings(frame) if kind == "holdings" else normalize_strategies(frame)


def read_optional_sheet(url: str, sheet_name: str, columns: list[str]) -> pd.DataFrame:
    try:
        frame = pd.read_csv(_google_csv_url(url, sheet_name), dtype={"ticker": str})
        if not set(columns).issubset(frame.columns):
            return pd.DataFrame(columns=columns)
        return frame.reindex(columns=columns)
    except Exception:
        return pd.DataFrame(columns=columns)


def read_workbook(url: str) -> dict[str, pd.DataFrame]:
    try:
        strategies = read_public_google_sheet(url, "strategies", "Strategies")
    except DataError:
        strategies = load_default_strategies()
    return {
        "holdings": read_public_google_sheet(url, "holdings", "Holdings"),
        "strategies": strategies,
        "snapshots": read_optional_sheet(url, "Snapshots", SNAPSHOT_COLUMNS),
        "actions": read_optional_sheet(url, "Actions", ACTION_COLUMNS),
    }


def read_pasted_holdings(text: str) -> pd.DataFrame:
    if not text.strip():
        raise DataError("붙여넣은 데이터가 없습니다.")
    try:
        delimiter = "\t" if "\t" in text.partition("\n")[0] else ","
        return normalize_holdings(pd.read_csv(io.StringIO(text), sep=delimiter, dtype={"ticker": str}))
    except DataError:
        raise
    except Exception as exc:
        raise DataError(f"붙여넣은 표를 해석하지 못했습니다: {exc}") from exc


def export_month(as_of: date, view: pd.DataFrame, plan: pd.DataFrame, memo: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    snapshots = pd.DataFrame({
        "date": as_of.isoformat(), "saved_at": stamp,
        "strategy": view["strategy"], "account": view["account"], "ticker": view["ticker"],
        "name": view["name"], "category": view["category"], "close": view["close"],
        "shares": view["shares"], "value": view["평가액"], "weight_pct": view["전체비중"],
        "target_pct": view["target_pct"], "memo": memo,
    }).reindex(columns=SNAPSHOT_COLUMNS)
    actions = pd.DataFrame({
        "date": as_of.isoformat(), "saved_at": stamp, "strategy": plan["전략"],
        "ticker": plan["티커"], "name": plan["종목"], "side": plan["구분"],
        "planned_shares": plan["제안수량"], "actual_shares": plan["실제수량"],
        "planned_amount": plan["예상매매액"], "done": plan["실행"],
        "reason": plan["근거"], "memo": plan["메모"],
    }).reindex(columns=ACTION_COLUMNS)
    return snapshots, actions


def to_tsv(frame: pd.DataFrame, include_header: bool = True) -> str:
    return frame.fillna("").to_csv(index=False, sep="\t", header=include_header, lineterminator="\n")


def to_csv_bytes(frame: pd.DataFrame) -> bytes:
    return frame.fillna("").to_csv(index=False, lineterminator="\n").encode("utf-8-sig")
