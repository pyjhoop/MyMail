import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { fakeInvoke } from "./test/fixtures";

// vitest globals를 켜지 않았으므로 테스트마다 DOM을 직접 정리한다.
afterEach(cleanup);

// 테스트에는 Tauri 런타임이 없으므로 백엔드 호출을 가짜로 바꾼다.
vi.mock("@tauri-apps/api/core", () => ({ invoke: fakeInvoke }));
