import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest globals를 켜지 않았으므로 테스트마다 DOM을 직접 정리한다.
afterEach(cleanup);
