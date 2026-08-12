"use client";

type GenerationStatusModalProps = {
  readonly kind: "creation" | "narrative" | "action";
};

const COPY = {
  creation: {
    title: "正在生成世界……",
    description: "正在准备你的冒险开局，请稍候。",
  },
  narrative: {
    title: "正在编排下一幕……",
    description: "正在生成故事内容，期间暂时不能操作游戏。",
  },
  action: {
    title: "正在处理……",
    description: "正在提交你的选择，请稍候。",
  },
} as const;

export function GenerationStatusModal({ kind }: GenerationStatusModalProps) {
  const copy = COPY[kind];

  return (
    <div className="narrative-generation-modal" role="dialog" aria-modal="true" aria-labelledby="generation-status-title">
      <div className="narrative-generation-modal-backdrop" />
      <section className="narrative-generation-modal-content" aria-live="polite">
        <span className="narrative-generation-spinner" aria-hidden="true" />
        <h2 id="generation-status-title">{copy.title}</h2>
        <p>{copy.description}</p>
      </section>
    </div>
  );
}
