-- 스냅샷 저장 시 자동으로 남기는 보조 백업 (최근 30개 유지)
-- 원본 Streamlit 앱의 write_auto_backup() 이 로컬 파일로 남기던 것을 D1 테이블로 옮긴 것.
CREATE TABLE IF NOT EXISTS auto_backup (
  date TEXT PRIMARY KEY,
  created_at TEXT,
  data TEXT
);
