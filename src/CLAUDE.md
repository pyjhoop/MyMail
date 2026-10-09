# src/ (React UI)

- 구조: `components/`(공용 조각), `features/<기능>/`(상태 + 화면), `lib/ipc.ts`(invoke 래퍼와 타입), `styles/tokens.css`
- 백엔드 호출은 `lib/ipc.ts` 함수로만 한다. 컴포넌트에서 `invoke` 직접 호출 금지.
- 디자인 기준은 `docs/design/`의 해당 화면 `.dc.html`. 수치는 그 파일과 `tokens.css`를 따른다.
- 긴 목록(메일 목록 등)은 가상화한다. 10만 건 폴더도 끊김 없어야 한다.
- 패널 너비 조절: 폴더 180~320px, 목록 300~520px, 더블클릭 시 기본값, 값은 저장해 다음 실행 때 복원.
- 테스트: Vitest + Testing Library (M0에서 확정). 새 컴포넌트는 최소 렌더 테스트 1개.
