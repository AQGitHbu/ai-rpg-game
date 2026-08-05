"use client";

import { useEffect, useState } from "react";

/** Phase 14 序幕开场组件的 props：与 PrologueDefinition 结构一致。 */
interface PrologueScreenProps {
  prologue: { text: string; tone: "serious" | "epic" | "mysterious"; durationMs?: number };
  onComplete: () => void;
}

/** Phase 14: 黑底白字序幕开场组件。逐字淡入后，点击/按键跳过并触发 onComplete。 */
export function PrologueScreen({ prologue, onComplete }: PrologueScreenProps) {
  const [displayedText, setDisplayedText] = useState("");
  const [isComplete, setIsComplete] = useState(false);

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

  /** 点击/按键跳过：未完成时先显示全文，已完成时触发 onComplete。 */
  const handleSkip = () => {
    if (!isComplete) {
      setDisplayedText(prologue.text);
      setIsComplete(true);
    } else {
      onComplete();
    }
  };

  // 任意键跳过：依赖 isComplete 以绑定最新的 handleSkip 闭包。
  useEffect(() => {
    const handleKey = () => handleSkip();
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
        {isComplete && <p className="prologue-hint">点击任意处继续</p>}
      </div>
    </div>
  );
}
