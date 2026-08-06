"use client";

import { useEffect, useRef, useState } from "react";

/** Phase 14 序幕开场组件的 props：与 PrologueDefinition 结构一致。 */
interface PrologueScreenProps {
  prologue: { text: string; tone: "serious" | "epic" | "mysterious" };
  onComplete: () => void;
}

/** 允许跳过序幕的按键白名单：Enter/Space（确认）+ Escape（退出）。其它键（Tab、
 *  屏幕阅读器快捷键、浏览器 F12 等）不得被拦截，避免无障碍回退。 */
const SKIP_KEYS: ReadonlySet<string> = new Set(["Enter", " ", "Escape"]);

/** Phase 14: 黑底白字序幕开场组件。逐字淡入后，点击/按键跳过并触发 onComplete。 */
export function PrologueScreen({ prologue, onComplete }: PrologueScreenProps) {
  const [displayedText, setDisplayedText] = useState("");
  const [isComplete, setIsComplete] = useState(false);
  // 幂等防护：双击/连击时 onComplete 只触发一次（服务端 CAS 是兜底，但 UI 层避免
  // 重复请求与可能的状态闪烁）。
  const submittedRef = useRef(false);

  // 逐字淡入动画：epic 基调较慢（80ms/字），其余 50ms/字。
  useEffect(() => {
    let index = 0;
    const speed = prologue.tone === "epic" ? 80 : 50;
    const timer = setInterval(() => {
      if (index < prologue.text.length) {
        setDisplayedText(prologue.text.slice(0, index + 1));
        index++;
      } else {
        clearInterval(timer);
        setIsComplete(true);
      }
    }, speed);
    return () => clearInterval(timer);
  }, [prologue.text, prologue.tone]);

  /** 点击/按键跳过：未完成时先显示全文，已完成时触发 onComplete（仅一次）。 */
  const handleSkip = () => {
    if (!isComplete) {
      setDisplayedText(prologue.text);
      setIsComplete(true);
      return;
    }
    if (submittedRef.current) return;
    submittedRef.current = true;
    onComplete();
  };

  // 白名单键跳过：依赖 isComplete 以绑定最新的 handleSkip 闭包。
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!SKIP_KEYS.has(event.key)) return;
      event.preventDefault();
      handleSkip();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isComplete]);

  return (
    <div
      className="prologue-screen"
      role="dialog"
      aria-label="游戏序幕"
      onClick={handleSkip}
    >
      <div className="prologue-content">
        <p className="prologue-text">{displayedText}</p>
        {isComplete && <p className="prologue-hint">点击或按 Enter / Space / Esc 继续</p>}
      </div>
    </div>
  );
}
