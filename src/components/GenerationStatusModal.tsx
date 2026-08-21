"use client";

import { useEffect, useState } from "react";
import type { AiFailureKind } from "@/game/application";

type GenerationStatusModalProps =
  | {
      readonly kind: "creation" | "narrative" | "action";
      readonly onRetry?: () => void | Promise<void>;
      readonly battleVisible?: boolean;
    }
  | {
      readonly kind: "narrative-failure";
      readonly failureKind: AiFailureKind;
      readonly onRetry: () => void | Promise<void>;
      readonly battleVisible?: boolean;
    };

const COPY = {
  creation: {
    title: "正在生成世界……",
    description: "正在准备你的冒险开局，请稍候。",
    hint: "生成过程可能需要几十秒，请保持当前页面。",
  },
  narrative: {
    title: "正在编排下一幕……",
    description: "正在生成故事内容，期间暂时不能操作游戏。",
    hint: "故事生成可能需要几十秒，请保持当前页面。",
  },
  action: {
    title: "正在处理……",
    description: "正在提交你的选择，请稍候。",
    hint: "请求已提交，正在等待故事状态更新。",
  },
} as const;

const FAILURE_COPY: Record<AiFailureKind, { readonly title: string; readonly description: string }> = {
  AI_CALL_FAILED: { title: "AI 调用失败", description: "AI 调用失败，请重试。" },
  AI_RESPONSE_INVALID: { title: "AI 返回格式不符合要求", description: "AI 返回格式不符合要求，请重试。" },
};

export function GenerationStatusModal(props: GenerationStatusModalProps) {
  const { kind, onRetry, battleVisible = false } = props;
  const failure = kind === "narrative-failure" ? FAILURE_COPY[props.failureKind] : undefined;
  const copy = kind === "narrative-failure" ? {
    title: failure?.title ?? "生成失败",
    description: failure?.description ?? "生成失败，请重试。",
    hint: "当前已提交的规则状态已保留。",
  } : COPY[kind];
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsedSeconds((current) => current + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className={`narrative-generation-modal${battleVisible ? " narrative-generation-modal--battle" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="generation-status-title"
    >
      <div className="narrative-generation-modal-backdrop" />
      <section className="narrative-generation-modal-content" aria-live="polite">
        {kind === "narrative-failure" ? null : <span className="narrative-generation-spinner" aria-hidden="true" />}
        <h2 id="generation-status-title">{copy.title}</h2>
        {kind === "narrative-failure" ? <p role="alert">{copy.description}</p> : <p>{battleVisible ? "战斗结果正在结算，下一回合即将开始。" : copy.description}</p>}
        <p className="narrative-generation-modal-hint">{copy.hint}</p>
        <p className="narrative-generation-modal-elapsed">已等待 {elapsedSeconds} 秒</p>
        {kind === "narrative-failure" ? (
          <button type="button" className="narrative-generation-modal-retry" onClick={() => void onRetry?.()}>
            重试
          </button>
        ) : onRetry && elapsedSeconds >= 15 ? (
          <button type="button" className="narrative-generation-modal-retry" onClick={onRetry}>
            重新检查生成状态
          </button>
        ) : null}
      </section>
    </div>
  );
}
