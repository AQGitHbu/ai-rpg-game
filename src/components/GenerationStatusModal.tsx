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
      readonly kind: "action-failure";
      readonly failureKind: AiFailureKind;
      readonly onRetry: () => void | Promise<void>;
      readonly battleVisible?: boolean;
    }
  | {
      readonly kind: "narrative-failure";
      readonly failureKind: AiFailureKind;
      readonly onRetry: () => void | Promise<void>;
      readonly battleVisible?: boolean;
    }
  | {
      /**
       * 开局分阶段生成失败：任务独立于 GameRecord 存在，旧存档未被替换。
       * 因此这里既提供「同任务重试」，也提供「放弃本次生成」这一显式出口。
       */
      readonly kind: "creation-failure";
      readonly failureKind: AiFailureKind;
      readonly onRetry: () => void | Promise<void>;
      readonly onCancel: () => void | Promise<void>;
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

const FAILURE_COPY = {
  action: {
    AI_CALL_FAILED: { title: "本次选择提交失败", description: "这次选择尚未生效，AI 调用失败。" },
    AI_RESPONSE_INVALID: { title: "本次选择提交失败", description: "这次选择尚未生效，AI 返回格式不符合要求。" },
  },
  narrative: {
    AI_CALL_FAILED: { title: "NPC回应生成失败", description: "你的选择已经生效，但 AI 调用失败。" },
    AI_RESPONSE_INVALID: { title: "NPC回应生成失败", description: "你的选择已经生效，但 AI 返回格式不符合要求。" },
  },
  creation: {
    AI_CALL_FAILED: { title: "开局生成失败", description: "AI 调用失败，本次开局尚未创建。" },
    AI_RESPONSE_INVALID: { title: "开局生成失败", description: "AI 返回格式不符合要求，本次开局尚未创建。" },
  },
} as const;

export function GenerationStatusModal(props: GenerationStatusModalProps) {
  const { kind, onRetry, battleVisible = false } = props;
  const actionFailure = kind === "action-failure" ? FAILURE_COPY.action[props.failureKind] : undefined;
  const narrativeFailure = kind === "narrative-failure" ? FAILURE_COPY.narrative[props.failureKind] : undefined;
  const creationFailure = kind === "creation-failure" ? FAILURE_COPY.creation[props.failureKind] : undefined;
  const copy = kind === "action-failure" ? {
    title: actionFailure?.title ?? "本次选择提交失败",
    description: actionFailure?.description ?? "本次选择提交失败，请重试。",
    hint: "这次选择尚未生效，规则状态未变化。",
  } : kind === "narrative-failure" ? {
    title: narrativeFailure?.title ?? "NPC回应生成失败",
    description: narrativeFailure?.description ?? "NPC回应生成失败，请重试。",
    hint: "你的选择已经生效，规则状态已保留。",
  } : kind === "creation-failure" ? {
    title: creationFailure?.title ?? "开局生成失败",
    description: creationFailure?.description ?? "开局生成失败，请重试。",
    hint: "重试会继续同一个生成任务；放弃后可以重新填写开局。",
  } : COPY[kind];
  const isFailure = kind === "narrative-failure" || kind === "action-failure" || kind === "creation-failure";
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
        {isFailure ? null : <span className="narrative-generation-spinner" aria-hidden="true" />}
        <h2 id="generation-status-title">{copy.title}</h2>
        {isFailure ? <p role="alert">{copy.description}</p> : <p>{battleVisible ? "战斗结果正在结算，下一回合即将开始。" : copy.description}</p>}
        <p className="narrative-generation-modal-hint">{copy.hint}</p>
        <p className="narrative-generation-modal-elapsed">已等待 {elapsedSeconds} 秒</p>
        {kind === "action-failure" ? (
          <button type="button" className="narrative-generation-modal-retry" onClick={() => void onRetry?.()}>
            重试当前选择
          </button>
        ) : kind === "narrative-failure" ? (
          <button type="button" className="narrative-generation-modal-retry" onClick={() => void onRetry?.()}>
            重试生成回应
          </button>
        ) : kind === "creation-failure" ? (
          <div className="narrative-generation-modal-actions">
            <button type="button" className="narrative-generation-modal-retry" onClick={() => void props.onRetry()}>
              重试生成
            </button>
            <button type="button" className="narrative-generation-modal-cancel" onClick={() => void props.onCancel()}>
              放弃本次生成
            </button>
          </div>
        ) : onRetry && elapsedSeconds >= 15 ? (
          <button type="button" className="narrative-generation-modal-retry" onClick={onRetry}>
            重新检查生成状态
          </button>
        ) : null}
      </section>
    </div>
  );
}
