"use client";

import type React from "react";

export function SceneNarrationBar(props: Readonly<{
  narration: string;
  onDismiss: () => void;
}>): React.JSX.Element | null {
  const { narration, onDismiss } = props;
  if (narration === "") return null;
  return (
    <div className="scene-narration-bar" role="status" aria-live="polite">
      <p className="scene-narration-bar-text">{narration}</p>
      <button
        type="button"
        className="scene-narration-bar-close"
        aria-label="关闭旁白"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
