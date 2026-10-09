# MyMail

Windows용 개인 메일 클라이언트(Gmail 개인 계정 + 네이버 메일). Tauri 2 + React + TypeScript, Rust 코어.

## 문서 (필요할 때만 열 것)

- 진행 계획·현재 단계: `docs/plan.md` ← 작업 시작 전에 확인, 끝나면 체크
- 요구사항: `docs/requirements.md` (원본은 `docs/README.md`의 Claude Docs 링크, 다르면 원본 우선)
- 결정 로그: `docs/decisions.md`
- 디자인: `docs/design/` (Claude Design 캔버스 링크는 `docs/README.md`)

## 명령어

- 개발 실행: `pnpm tauri dev`
- 프론트 검사: `pnpm typecheck && pnpm lint && pnpm test --run` (포맷: `pnpm format`)
- Rust 검사: `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- 전체 검증: `/verify`

## 아키텍처 규칙

- UI(`src/`)는 Tauri command(`invoke`)로만 백엔드를 호출한다. UI에서 메일 서버·DB 직접 접근 금지.
- Gmail·네이버 차이는 `src-tauri/src/providers/`의 `MailProvider` trait 구현체 안에서만 처리한다. 상위 계층에 서비스별 분기 금지.
- 비밀번호·토큰은 keyring(Windows 자격 증명 관리자)에만 저장한다. 로그·DB·파일에 평문 금지.
- HTML 메일은 샌드박스 iframe + DOMPurify로 표시한다. 스크립트 실행 금지, 외부 이미지 기본 차단.
- UI 문구는 한국어만.
- 색·크기·간격은 `src/styles/tokens.css`의 CSS 변수만 쓴다. 하드코딩 금지.

## 작업 방식

- 한 세션에 `docs/plan.md`의 작업 하나만 한다. 범위 밖 파일은 건드리지 않는다.
- 구현 후 `/verify` 통과를 확인하고 결과를 보고한다.
- 테스트는 실제 계정 대신 `FakeProvider`로 한다. 실서버 테스트는 사용자가 요청할 때만.
- `.env`는 읽거나 커밋하지 않는다. 필요한 키 이름은 `.env.example`에만 적는다.
- 응답은 한국어로 한다.
