import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { EvolutionNeed, WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";

// ---------------------------------------------------------------------------
// WorldEvolutionSource：可注入的 AI 世界演化提议 port。
// 只负责"提议"：产出纯提案（普通字符串 ID 引用），审批/铸造 ID/装配预览状态
// 是 gameplay worldEvolution 纯函数职责。生产注入 live source，离线注入确定性
// source；propose 失败返回 typed failure，不再由编排层尝试确定性 fallback。
// ---------------------------------------------------------------------------

export type WorldEvolutionSourceContext = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly need: EvolutionNeed;
  readonly action?: Action;
  readonly reason: string;
  /** 仅用于关联 world AI 审计事件，不进入世界状态或 prompt 事实字段。 */
  readonly auditLink?: AiTextAuditLink;
};

/**
 * 世界演化 source 结果：成功返回 proposal（可能为 null 表示无需演化），
 * 失败返回稳定 AiGenerationFailure。proposal: null 不再代表"请换 deterministic source"。
 */
export type WorldEvolutionSourceResult =
  | { readonly ok: true; readonly proposal: WorldDeltaProposal | null }
  | { readonly ok: false; readonly failure: AiGenerationFailure };

export type WorldEvolutionSource = {
  propose(ctx: WorldEvolutionSourceContext): Promise<WorldEvolutionSourceResult>;
};
