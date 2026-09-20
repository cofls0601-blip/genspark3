from __future__ import annotations

import json
from datetime import date, datetime, timezone

import gspread
import pandas as pd
import streamlit as st
from google.oauth2.service_account import Credentials


SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
SCHEMA = {
    "Holdings": ["strategy", "account", "ticker", "name", "market", "category", "role", "target_pct", "shares"],
    "Strategies": ["code", "rule", "params_json", "active"],
    "Snapshots": ["date", "saved_at", "strategy", "account", "ticker", "name", "category", "close", "shares", "value", "weight_pct", "target_pct", "memo"],
    "Actions": ["date", "saved_at", "strategy", "ticker", "name", "side", "planned_shares", "actual_shares", "planned_amount", "done", "reason", "memo"],
}


class StoreError(RuntimeError):
    pass


class GoogleSheetsStore:
    def __init__(self, spreadsheet_id: str, credentials_info: dict):
        credentials = Credentials.from_service_account_info(credentials_info, scopes=SCOPES)
        self.book = gspread.authorize(credentials).open_by_key(spreadsheet_id)

    @classmethod
    def from_streamlit_secrets(cls) -> "GoogleSheetsStore":
        try:
            spreadsheet_id = st.secrets["google_sheets"]["spreadsheet_id"]
            credentials_info = dict(st.secrets["gcp_service_account"])
            return cls(spreadsheet_id, credentials_info)
        except Exception as exc:
            raise StoreError(f"Google Sheets 연결 실패: {exc}") from exc

    def ensure_schema(self) -> None:
        existing = {w.title for w in self.book.worksheets()}
        for title, columns in SCHEMA.items():
            if title not in existing:
                ws = self.book.add_worksheet(title=title, rows=1000, cols=max(12, len(columns)))
                ws.append_row(columns)
        if self.read("Holdings").empty:
            defaults = pd.read_csv("config/default_holdings.csv", dtype={"ticker": str})
            self.replace("Holdings", defaults)
        if self.read("Strategies").empty:
            with open("config/default_strategies.json", encoding="utf-8") as fh:
                items = json.load(fh)
            defaults = pd.DataFrame([
                {"code": x["code"], "rule": x["rule"], "params_json": json.dumps(x.get("params", {}), ensure_ascii=False), "active": True}
                for x in items
            ])
            self.replace("Strategies", defaults)

    def worksheet(self, title: str):
        return self.book.worksheet(title)

    def read(self, title: str) -> pd.DataFrame:
        records = self.worksheet(title).get_all_records(numericise_ignore=[1])
        df = pd.DataFrame(records, columns=SCHEMA[title])
        if title == "Holdings" and not df.empty:
            raw = df["ticker"].fillna("").astype(str).str.strip().str.replace(r"\.0$", "", regex=True)
            is_kr_code = df["market"].eq("KR") & raw.ne("") & raw.ne("CASH")
            df["ticker"] = raw.where(~is_kr_code, raw.str.zfill(6))
            for col in ["target_pct", "shares"]:
                df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
        return df

    def replace(self, title: str, frame: pd.DataFrame) -> None:
        cols = SCHEMA[title]
        clean = frame.reindex(columns=cols).fillna("")
        values = [cols] + clean.astype(object).values.tolist()
        ws = self.worksheet(title)
        ws.clear()
        ws.update(values, value_input_option="USER_ENTERED")

    def append(self, title: str, frame: pd.DataFrame) -> None:
        if frame.empty:
            return
        cols = SCHEMA[title]
        values = frame.reindex(columns=cols).fillna("").astype(object).values.tolist()
        self.worksheet(title).append_rows(values, value_input_option="USER_ENTERED")

    def save_month(self, as_of: date, view: pd.DataFrame, plan: pd.DataFrame, memo: str) -> None:
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        snapshots = pd.DataFrame({
            "date": as_of.isoformat(), "saved_at": stamp,
            "strategy": view["strategy"], "account": view["account"], "ticker": view["ticker"],
            "name": view["name"], "category": view["category"], "close": view["close"],
            "shares": view["shares"], "value": view["평가액"], "weight_pct": view["전체비중"],
            "target_pct": view["target_pct"], "memo": memo,
        })
        actions = pd.DataFrame({
            "date": as_of.isoformat(), "saved_at": stamp, "strategy": plan["전략"],
            "ticker": plan["티커"], "name": plan["종목"], "side": plan["구분"],
            "planned_shares": plan["제안수량"], "actual_shares": plan["실제수량"],
            "planned_amount": plan["예상매매액"], "done": plan["실행"],
            "reason": plan["근거"], "memo": plan["메모"],
        })
        self.append("Snapshots", snapshots)
        self.append("Actions", actions)
