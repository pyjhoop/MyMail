---
name: verify
description: MyMail 전체 검증(타입 검사, 린트, 프론트 테스트, rustfmt, clippy, cargo test)을 실행하고 결과를 요약한다. 구현을 마친 뒤, 또는 "검증해줘", "/verify" 요청 시 사용.
---

# /verify

프로젝트 루트에서 아래를 순서대로 실행한다. 아직 없는 단계(예: M0 이전이라 `package.json`이나 `src-tauri/Cargo.toml`이 없음)는 "건너뜀"으로 표시한다.

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test --run`
4. `cd src-tauri && cargo fmt --check`
5. `cd src-tauri && cargo clippy --all-targets -- -D warnings`
6. `cd src-tauri && cargo test`

## 실패 처리

- 방금 작업한 범위 안의 실패면 원인을 고치고 해당 단계부터 다시 실행한다. 최대 3회.
- 범위 밖 파일 때문에 실패하면 고치지 말고 보고만 한다.
- 출력은 실패한 부분의 핵심 줄(파일:줄, 메시지)만 인용한다. 전체 로그를 붙이지 않는다.

## 보고 형식

| 단계 | 결과 |
| --- | --- |
| typecheck | 통과 / 실패 / 건너뜀 |
| … | … |

실패가 남았으면 남은 항목과 원인을 한 줄씩 적는다.
