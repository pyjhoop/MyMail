import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import styles from "./ResizeHandle.module.css";

interface Props {
  label: string;
  /** 핸들 왼쪽 패널의 현재 너비 (키보드 조절 기준) */
  value: number;
  /** 패널 왼쪽 끝의 화면 x 좌표를 기준으로 계산한 새 너비 */
  onDrag: (width: number) => void;
  onEnd: () => void;
  onReset: () => void;
  /** 패널 왼쪽 끝의 화면 x 좌표 */
  getOrigin: () => number;
}

const KEY_STEP = 16;

export function ResizeHandle({ label, value, onDrag, onEnd, onReset, getOrigin }: Props) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = getOrigin();
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) onDrag(e.clientX - origin.current);
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    onEnd();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onDrag(value + (e.key === "ArrowRight" ? KEY_STEP : -KEY_STEP));
      onEnd();
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      className={`${styles.handle} ${dragging ? styles.dragging : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
