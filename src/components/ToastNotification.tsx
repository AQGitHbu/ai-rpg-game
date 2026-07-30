"use client";

import { useEffect, useRef } from "react";

export interface ToastMessage {
  id: string;
  message: string;
  createdAt: number;
}

const TOAST_FALLBACK_TIMEOUT_MS = 5100;

interface ToastItemProps {
  toast: ToastMessage;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const elementRef = useRef<HTMLParagraphElement | null>(null);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const element = elementRef.current;

    // React 委托的 onAnimationEnd 在缺少 AnimationEvent 的环境（如 jsdom）
    // 不会派发，这里使用原生监听器保证浏览器与测试环境行为一致。
    const handleAnimationEnd = (event: Event) => {
      const animationName = (event as AnimationEvent).animationName;
      if (animationName === "adventure-toast-exit") {
        onDismissRef.current(toast.id);
      }
    };
    element?.addEventListener("animationend", handleAnimationEnd);

    const timer = setTimeout(() => {
      onDismissRef.current(toast.id);
    }, TOAST_FALLBACK_TIMEOUT_MS);

    return () => {
      element?.removeEventListener("animationend", handleAnimationEnd);
      clearTimeout(timer);
    };
  }, [toast.id]);

  return (
    <p ref={elementRef} className="adventure-toast" role="status">
      {toast.message}
    </p>
  );
}

interface ToastContainerProps {
  toasts: readonly ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) {
    return null;
  }
  return (
    <div className="adventure-toast-container">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
