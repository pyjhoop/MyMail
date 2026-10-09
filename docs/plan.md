# MyMail 개발 계획

현재 단계: **사전 준비** (디자인 확정 대기)

규칙: 한 세션에 작업 하나. 끝나면 체크하고, 커밋하고, `/clear`.

## 사전 준비 (사용자)

- [ ] Claude Design 결과물 확정 → `docs/design/`에 저장
- [ ] Rust 설치 (rustup + Visual Studio C++ 빌드 도구)
- [ ] pnpm 활성화 (`corepack enable pnpm`)
- [ ] Google Cloud: 프로젝트 생성, Gmail API 활성화, OAuth 클라이언트(데스크톱 앱) 발급, 동의 화면 '프로덕션' 게시
- [ ] 네이버: IMAP 사용 켜기, 애플리케이션 비밀번호 발급 (개발용 테스트 계정 권장)
- [ ] `.env.example`을 복사해 `.env` 작성

## M0. 프로젝트 뼈대

- [ ] create-tauri-app(React + TS + Vite)을 임시 폴더에 생성 후 이 폴더로 병합 (기존 CLAUDE.md·docs·.claude 유지)
- [ ] 린트(ESLint)·포맷(Prettier)·테스트(Vitest), `pnpm typecheck` 스크립트
- [ ] Rust: clippy·rustfmt 설정, 모듈 폴더 생성
- [ ] `/verify` 통과, CLAUDE.md 명령어 갱신

## M1. UI 셸 (가짜 데이터)

- [ ] `tokens.css` (디자인 토큰, 라이트·다크)
- [ ] 프레임 없는 창 + 타이틀 바
- [ ] 4단 레이아웃 + 패널 너비 드래그 조절·저장
- [ ] 계정 레일(전체·계정·추가), 폴더 패널, 메일 목록(가상화), 본문
- [ ] 통합 받은편지함 화면, 빈·로딩·오류 상태

## M2. 데이터 계층

- [ ] SQLite 스키마(계정·폴더·메일·첨부 메타) + 마이그레이션 + FTS5
- [ ] `MailProvider` trait + `FakeProvider`
- [ ] Tauri command와 `lib/ipc.ts` 연결, UI가 Fake 데이터를 DB에서 읽기

## M3. 네이버 (IMAP/SMTP)

- [ ] 로그인·keyring 저장, 실패 안내(IMAP 꺼짐·앱 비밀번호)
- [ ] 폴더 목록(한글 디코딩), 메일 헤더·본문 조회

## M4. Gmail

- [ ] OAuth 2.0 PKCE(시스템 브라우저 + 루프백), 토큰 갱신
- [ ] 라벨·메일 조회

## M5. 동기화 엔진

- [ ] 전체 동기화(최근부터, 이어받기, 진행률)
- [ ] 새 메일 감지(Gmail 변경 내역 조회, 네이버 IDLE/주기 조회)
- [ ] 읽음·삭제·이동 양방향 반영, 오프라인 큐

## M6. 작성·발송

- [ ] 작성기(인라인·새 창), 주소 자동완성, 서명, 첨부
- [ ] 임시보관함 자동 저장, 발송·실패 처리

## M7. 검색·알림·마무리

- [ ] 계정 내 검색(FTS5), 통합 받은편지함 실데이터 연결
- [ ] Windows 알림, 트레이, 시작 시 실행
- [ ] 키보드 단축키, 설정 화면
- [ ] 설치 파일 빌드(NSIS), 자동 업데이트
