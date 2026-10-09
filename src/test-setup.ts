import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { fakeInvoke } from "./test/fixtures";

// 느린 CI 러너에서도 비동기 조회(findBy·waitFor)가 기본 1초에 걸려 흔들리지 않게 한다.
configure({ asyncUtilTimeout: 4000 });

// vitest globals를 켜지 않았으므로 테스트마다 DOM을 직접 정리한다.
afterEach(cleanup);

// 테스트에는 Tauri 런타임이 없으므로 백엔드 호출을 가짜로 바꾼다.
vi.mock("@tauri-apps/api/core", () => ({ invoke: fakeInvoke }));
