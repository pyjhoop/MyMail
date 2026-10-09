# MyMail 개발 계획

현재 단계: **M5. 동기화 엔진**

규칙: 한 세션에 작업 하나. 끝나면 체크하고, 커밋하고, `/clear`.

## 사전 준비 (사용자)

- [ ] Claude Design 결과물 확정 → `docs/design/`에 저장
- [x] Rust 설치 (rustup + Visual Studio C++ 빌드 도구)
- [x] pnpm 활성화 (`corepack enable pnpm`)
- [ ] Gmail: Google 계정 2단계 인증 켜기 → 앱 비밀번호 만들기 (개발용 테스트 계정 권장)
- [ ] 네이버: IMAP 사용 켜기, 애플리케이션 비밀번호 발급 (개발용 테스트 계정 권장)
- [ ] 실서버 테스트용으로 `.env.example`을 복사해 `.env` 작성 (앱 자체는 비밀번호를 keyring에 저장)

## M0. 프로젝트 뼈대

- [x] create-tauri-app(React + TS + Vite)을 임시 폴더에 생성 후 이 폴더로 병합 (기존 CLAUDE.md·docs·.claude 유지)
- [x] 린트(ESLint)·포맷(Prettier)·테스트(Vitest), `pnpm typecheck` 스크립트
- [x] Rust: clippy·rustfmt 설정, 모듈 폴더 생성
- [x] `/verify` 통과, CLAUDE.md 명령어 갱신

## M1. UI 셸 (가짜 데이터)

- [x] `tokens.css` (디자인 토큰, 라이트·다크)
- [x] 프레임 없는 창 + 타이틀 바
- [x] 4단 레이아웃 + 패널 너비 드래그 조절·저장
- [x] 계정 레일(전체·계정·추가), 폴더 패널, 메일 목록(가상화), 본문
- [x] 통합 받은편지함 화면, 빈·로딩·오류 상태

## M2. 데이터 계층

- [x] SQLite 스키마(계정·폴더·메일·첨부 메타) + 마이그레이션 + FTS5
- [x] `MailProvider` trait + `FakeProvider`
- [x] Tauri command와 `lib/ipc.ts` 연결, UI가 Fake 데이터를 DB에서 읽기

## M3. 네이버 (IMAP/SMTP)

- [x] 로그인·keyring 저장, 실패 안내(IMAP 꺼짐·앱 비밀번호)
- [x] 폴더 목록(한글 디코딩), 메일 헤더·본문 조회

## M3.1. HTML 메일 표시 (M3 후속, 실계정 테스트에서 발견)

- [x] 미리보기·본문 텍스트 추출 개선: HTML 주석·Outlook 조건부 주석(`<!--[if mso]>…<![endif]-->`)·`<style>`·`<script>`가 텍스트에 섞이지 않게 제거 (`providers/imap/parse.rs`, 실제 깨진 메일 샘플을 테스트로 추가)
- [x] HTML 본문 저장: 텍스트 본문과 별도로 정제 전 원문 HTML을 보관(마이그레이션 추가), `get_mail`이 함께 내려줌
- [x] 샌드박스 iframe + DOMPurify로 HTML 렌더링 (스크립트 금지, 다크 모드·본문 너비 대응)
- [x] 외부 이미지 기본 차단 + "이미지 표시" 버튼, `cid:` 인라인 이미지는 첨부에서 꺼내 표시
- [x] 링크는 기본 브라우저로 열기 (앱 안에서 이동 금지)

## M4. Gmail (IMAP/SMTP + 앱 비밀번호)

- [x] imap.gmail.com 연결, M3의 IMAP 코드 재사용, 실패 안내(2단계 인증·앱 비밀번호). smtp.gmail.com은 발송이 없는 지금은 연결할 곳이 없어 M6(작성·발송)에서 한다
- [x] 라벨(X-GM-LABELS)·스레드(X-GM-THRID), `[Gmail]` 특수 폴더는 SPECIAL-USE로 식별
- [x] 전체보관함·라벨 폴더 중복을 X-GM-MSGID로 한 번만 저장

## M5. 동기화 엔진

- [ ] 전체 동기화(최근부터, 이어받기, 진행률)
- [ ] 새 메일 감지(IMAP IDLE, 미지원 시 주기 조회)
- [ ] 읽음·삭제·이동 양방향 반영, 오프라인 큐

## M6. 작성·발송

- [ ] 작성기(인라인·새 창), 주소 자동완성, 서명, 첨부
- [ ] 임시보관함 자동 저장, 발송·실패 처리

## M7. 검색·알림·마무리

- [ ] 계정 내 검색(FTS5), 통합 받은편지함 실데이터 연결
- [ ] Windows 알림, 트레이, 시작 시 실행
- [ ] 키보드 단축키, 설정 화면
- [ ] 설치 파일 빌드(NSIS), 자동 업데이트
