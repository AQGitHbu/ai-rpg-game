"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SKIP_KEYS: ReadonlySet<string> = new Set(["Enter", " ", "Escape"]);

/** 旅行事件全屏黑底白字旁白——复用 PrologueScreen 的视觉风格。 */
export function TravelNarrationScreen(props: Readonly<{
  narration: string;
  onComplete: () => void;
}>): React.JSX.Element {
  const { narration, onComplete } = props;
  const [displayedText, setDisplayedText] = useState("");
  const [isComplete, setIsComplete] = useState(false);
  const submittedRef = useRef(false);

  useEffect(() => {
    let index = 0;
    const timer = setInterval(() => {
      if (index < narration.length) {
        setDisplayedText(narration.slice(0, index + 1));
        index++;
      } else {
        clearInterval(timer);
        setIsComplete(true);
      }
    }, 50);
    return () => clearInterval(timer);
  }, [narration]);

  const handleComplete = useCallback(() => {
    if (!isComplete) {
      setDisplayedText(narration);
      setIsComplete(true);
      return;
    }
    if (submittedRef.current) return;
    submittedRef.current = true;
    onComplete();
  }, [isComplete, narration, onComplete]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!SKIP_KEYS.has(event.key)) return;
      event.preventDefault();
      handleComplete();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleComplete]);

  return (
    <div
      className="travel-narration-screen"
      role="dialog"
      aria-label="旅行旁白"
      onClick={handleComplete}
    >
      <div className="travel-narration-content">
        <p className="travel-narration-text">{displayedText}</p>
        {isComplete ? <p className="travel-narration-hint">点击或按 Enter / Space / Esc 继续</p> : null}
      </div>
    </div>
  );
}
