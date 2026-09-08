# 집현전 법원경매 조회

공개 조회용 경매 데이터 사이트입니다.

- 수집 실행은 Windows 노트북 worker + 외부 cloud master로 분리합니다.
- cloud master는 최신 공고, 과거 공고 백필, 기본정보와 최종 데이터 병합을 담당합니다.
- laptop worker는 상세정보, 매각일정, 유찰결과, 낙찰가, 감정평가 요약 등을 보강합니다.
- GitHub Actions 자동 수집은 중지하고 비상 수동 실행용 workflow만 남깁니다.
- 1990년까지 과거 월별 데이터를 순차적으로 백필합니다.
- 공개 저장소에는 사건번호, 주소, 감정가, 최저가, 유찰, 매각기일 등 서비스용 가공 데이터만 저장합니다.
- 임차인·채무자 등 개인정보가 포함될 수 있는 원문 자료는 이 공개 저장소에 저장하지 않습니다.

설치: `DUAL_COLLECTOR_SETUP.md`

조회: https://kingkclee.github.io/auction-view/

진도: https://kingkclee.github.io/auction-view/progress.html
