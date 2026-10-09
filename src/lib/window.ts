// 프레임 없는 창의 창 버튼. 브라우저(pnpm dev)·테스트에서는 아무 일도 하지 않는다.
import { getCurrentWindow } from "@tauri-apps/api/window";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function run(action: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
  if (!inTauri()) return;
  await action(getCurrentWindow());
}

export const minimizeWindow = () => run((w) => w.minimize());
export const toggleMaximizeWindow = () => run((w) => w.toggleMaximize());
export const closeWindow = () => run((w) => w.close());
