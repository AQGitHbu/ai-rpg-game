"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

type AdventureOverlayProps = {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
};

export function AdventureOverlay({ title, children, onClose, returnFocusRef }: AdventureOverlayProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        returnFocusRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, returnFocusRef]);

  return (
    <section
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="adventure-overlay"
      tabIndex={-1}
    >
      <div className="adventure-overlay-backdrop" aria-hidden="true" />
      <div className="adventure-overlay-content">
        <button type="button" onClick={() => { onClose(); returnFocusRef.current?.focus(); }} aria-label={"关闭" + title}>
          ×
        </button>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </section>
  );
}
