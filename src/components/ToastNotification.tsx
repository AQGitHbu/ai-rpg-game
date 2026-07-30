"use client";

import { useEffect, useRef, type AnimationEvent } from "react";

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
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const timer = setTimeout(() => {
      onDismissRef.current(toast.id);
    }, TOAST_FALLBACK_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [toast.id]);

  const handleAnimationEnd = (event: AnimationEvent<HTMLParagraphElement>) => {
    if (event.animationName === "adventure-toast-exit") {
      onDismissRef.current(toast.id);
    }
  };

  return (
    <p className="adventure-toast" role="status" onAnimationEnd={handleAnimationEnd}>
      {toast.message}
    </p>
  );
}

interface ToastContainerProps {
  toasts: ToastMessage[];
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
