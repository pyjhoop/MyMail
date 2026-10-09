# src-tauri/ (Rust 코어)

- 모듈: `commands/`(Tauri command, 얇게), `providers/`(`MailProvider` trait, gmail, naver, fake), `store/`(SQLite + 마이그레이션), `sync/`(동기화 엔진), `auth/`(OAuth, keyring)
- command는 입력 검증과 서비스 호출만 한다. 로직은 해당 모듈에 둔다.
- 에러는 모듈별 `thiserror` 타입으로 정의하고, command 경계에서 직렬화 가능한 에러로 바꾼다. `unwrap`/`expect`는 테스트에서만.
- 비동기는 tokio. 네트워크 호출에는 타임아웃을 건다.
- IMAP 폴더명은 modified UTF-7로 디코딩한다(한글 폴더). 네이버 테스트에 한글 폴더 케이스를 넣는다.
- DB 스키마 변경은 마이그레이션 파일로만 한다.
- 단위 테스트는 `FakeProvider`로 한다. 실서버 통합 테스트는 `#[ignore]`로 두고 사용자가 요청할 때만 실행한다.
