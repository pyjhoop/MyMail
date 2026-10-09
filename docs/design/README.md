# 디자인 파일

[Claude Design 캔버스](https://claude.ai/artifact/SSz7h7PQkGSupzPTKHwzdq)에서 받은 원본 파일이다(2026-10-09, 버전 1791522665-aa65, Gmail 앱 비밀번호 반영). 캔버스를 수정하면 다시 받아야 한다.

- 브라우저로 바로 열면 제대로 안 보인다(캔버스 런타임 `support.js`와 폰트가 없음). 화면은 캔버스 링크에서 보고, 이 파일들은 **수치·색·문구를 읽는 용도**로 쓴다.
- 각 파일의 `<style>` 안 CSS 변수(`--color-*`, `--account-*`)가 디자인 토큰이다. `src/styles/tokens.css`는 `Tokens.dc.html` 기준으로 만든다.
- 다크 모드 값은 각 파일의 `.mm.dark` 블록에 있다.
- 화면 배치·제목은 `canvas.json`에 있다.

| 파일 | 화면 |
| --- | --- |
| Main.dc.html | 메인 — 개인 Gmail 받은편지함 (라이트) |
| MainDark.dc.html | 메인 (다크) — Main을 `dark` 속성으로 불러옴 |
| Unified.dc.html | 전체 통합 받은편지함 |
| Resize.dc.html | 패널 너비 조절 — 핸들 상태, 접힘 |
| Tokens.dc.html | 디자인 토큰 |
| ComposeInline.dc.html | 작성기 A — 본문 인라인 답장 |
| ComposeWindow.dc.html | 작성기 B — 별도 창 (계정 선택, 드래그 앤 드롭, 예약 발송) |
| FirstRun.dc.html | 첫 실행 — 계정 없음 |
| AddAccount.dc.html | 계정 추가 모달 — 4단계 (Gmail·네이버 모두 앱 비밀번호) |
| SearchSuggest.dc.html | 검색 — 포커스, 추천 |
| Search.dc.html | 검색 — 결과, 필터 칩 |
| Settings.dc.html | 설정 — 계정 탭 |
| Notify.dc.html | Windows 알림 토스트, 트레이 메뉴 |
| States.dc.html | 상태 — 로딩, 빈 폴더, 미선택, 오프라인, 인증 오류, 발송 실패 |
| Components.dc.html | 컴포넌트 상태 시트 |
