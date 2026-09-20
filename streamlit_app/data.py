from __future__ import annotations

import json
from datetime import date, datetime, timezone
from urllib.parse import quote

import pandas as pd
import streamlit as st


SCHEMA = {
    "Holdings": ["strategy", "account", "ticker", "name", "market", "category", "role", "target_pct", "shares"],
    "Strategies": ["code", "rule", "params_json", "active"],
    "Snapshots": ["date", "saved_at", "strategy", "account", "ticker", "name", "category", "close", "shares", "value", "weight_pct", "target_pct", "memo"],
    "Actions": ["date", "saved_at", "strategy", "ticker", "name", "side", "planned_shares", "actual_shares", "planned_amount", "done", "reason", "memo"],
}


class StoreError(RuntimeError):
    pass


class ReadOnlySheetsStore:
    """Read published/public Google Sheets as CSV without Google Cloud credentials."""

    def __init__(self, spreadsheet_id: str):
        self.spreadsheet_id = spreadsheet_id.strip()

    @classmethod
    def from_streamlit_secrets(cls) -> "ReadOnlySheetsStore":
        try:
            spreadsheet_id = st.secrets["google_sheets"]["spreadsheet_id"]
        except Exception as exc:
            raise StoreError(
                "Google Sheets 읽기 설정이 없습니다. Streamlit Secrets에 "
                "[google_sheets] spreadsheet_id = \"...\" 를 입력하세요."
            ) from exc
        return cls(str(spreadsheet_id))

    def _csv_url(self, title: str) -> str:
        return (
            f"https://docs.google.com/spreadsheets/d/{self.spreadsheet_id}/gviz/tq"
            f"?tqx=out:csv&sheet={quote(title)}"
        )

    def read(self, title: str) -> pd.DataFrame:
        try:
            df = pd.read_csv(self._csv_url(title), dtype={"ticker": str})
        except Exception as exc:
            raise StoreError(
                f"{title} 시트를 읽지 못했습니다. 스프레드시트가 링크로 열람 가능하게 "
                f"공유되어 있고 '{title}' 탭이 존재하는지 확인하세요: {exc}"
            ) from exc

        expected = SCHEMA[title]
        missing = [c for c in expected if c not in df.columns]
        if missing:
            raise StoreError(f"{title} 시트에 필요한 열이 없습니다: {', '.join(missing)}")

        df = df.reindex(columns=expected)
        if title == "Holdings" and not df.empty:
            raw = df["ticker"].fillna("").astype(str).str.strip().str.replace(r"\.0$", "", regex=True)
            is_kr_code = df["market"].eq("KR") & raw.ne("") & raw.ne("CASH")
            df["ticker"] = raw.where(~is_kr_code, raw.str.zfill(6))
            for col in ["target_pct", "shares"]:
                df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
        if title == "Strategies" and not df.empty:
            df["active"] = df["active"].astype(str).str.lower().isin(["true", "1", "yes", "y"])
        return df

    def read_optional(self, title: str) -> pd.DataFrame:
        try:
            return self.read(title)
        except StoreError:
            return pd.DataFrame(columns=SCHEMA[title])


def build_month_exports(as_of: date, view: pd.DataFrame, plan: pd.DataFrame, memo: str):
    """Build rows that can be pasted directly into Snapshots and Actions."""
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    snapshots = pd.DataFrame({
        "date": as_of.isoformat(), "saved_at": stamp,
        "strategy": view["strategy"], "account": view["account"], "ticker": view["ticker"],
        "name": view["name"], "category": view["category"], "close": view["close"],
        "shares": view["shares"], "value": view["평가액"], "weight_pct": view["전체비중"],
        "target_pct": view["target_pct"], "memo": memo,
    }).reindex(columns=SCHEMA["Snapshots"])

    actions = pd.DataFrame({
        "date": as_of.isoformat(), "saved_at": stamp, "strategy": plan["전략"],
        "ticker": plan["티커"], "name": plan["종목"], "side": plan["구분"],
        "planned_shares": plan["제안수량"], "actual_shares": plan["실제수량"],
        "planned_amount": plan["예상매매액"], "done": plan["실행"],
        "reason": plan["근거"], "memo": plan["메모"],
    }).reindex(columns=SCHEMA["Actions"])
    return snapshots, actions
