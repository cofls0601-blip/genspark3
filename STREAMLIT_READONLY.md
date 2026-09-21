# Streamlit 읽기 전용 Google Sheets 버전

이 버전은 Google Cloud, 서비스 계정, API 키를 사용하지 않습니다.

## 실행

```bash
pip install -r requirements.txt
streamlit run streamlit_app.py
```

## 보유내역 불러오기

Google Sheets의 첫 행에 다음 열 이름을 사용합니다.

```text
strategy account ticker name market category role target_pct shares
```

방법은 두 가지입니다.

1. 공유 권한을 **링크가 있는 모든 사용자: 뷰어**로 설정하고, 해당 탭의 URL을 앱 사이드바에 입력합니다.
2. 공개 링크를 사용하지 않으려면 시트 범위를 헤더와 함께 복사하여 앱의 붙여넣기 입력창에 넣습니다.

## 결과 보관

`복사용 데이터` 탭에서 다음 표를 TSV로 복사하거나 CSV로 다운로드합니다.

- 월말 스냅샷
- 액션 및 실제 실행 이력
- 현재 보유내역

앱은 Google Sheets에 직접 데이터를 쓰지 않습니다.
