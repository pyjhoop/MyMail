const STORAGE_KEY = "mymail.showImages";

/** 외부 이미지를 바로 보여 줄지. 저장된 값이 없으면 켜짐. */
export function loadShowImages(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveShowImages(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // 저장 실패는 무시한다 (다음 실행에서 기본값)
  }
}
