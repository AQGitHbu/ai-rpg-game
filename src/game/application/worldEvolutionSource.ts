import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { EvolutionNeed, WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import type { WorldDeltaRejection } from "@/game/gameplay/rpg/worldEvolution";

// ---------------------------------------------------------------------------
// WorldEvolutionSource：可注入的 AI 世界演化提议 port。
// 只负责"提议"：产出纯提案（普通字符串 ID 引用），审批/铸造 ID/装配预览状态
// 是 gameplay worldEvolution 纯函数职责。生产注入 live source，离线注入确定性
// source；propose 失败返回 typed failure，不再由编排层尝试确定性 fallback。
// ---------------------------------------------------------------------------

/**
 * 只供修复 prompt/审计使用的稳定内容修复描述。修复预算只由 application 层
 * （evolveWorld 两轮循环）统一控制；source 自身不递归多次 propose。
 */
export type WorldEvolutionContentRepair = Readonly<{
  readonly attempt: 1;
  readonly reason:
    | "invalid_json"
    | "invalid_schema"
    | "invalid_reference"
    | "approval_rejected";
  readonly approvalCode?: WorldDeltaRejection;
}>;

export type WorldEvolutionSourceContext = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly need: EvolutionNeed;
  readonly action?: Action;
  readonly reason: string;
  /** 仅用于关联 world AI 审计事件，不进入世界状态或 prompt 事实字段。 */
  readonly auditLink?: AiTextAuditLink;
  /** content repair 尝试：由 evolveWorld 在初次失败后注入。 */
  readonly contentRepair?: WorldEvolutionContentRepair;
};

/** 可被 application 层识别并触发一次内容修复的稳定解析原因。 */
export type WorldEvolutionRepairReason = "invalid_json" | "invalid_schema" | "invalid_reference";

/**
 * 世界演化 source 结果：成功返回 proposal（可能为 null 表示无需演化），
 * 失败返回稳定 AiGenerationFailure。proposal: null 不再代表"请换 deterministic source"。
 * 内容可修复失败（invalid_json/invalid_schema/invalid_reference）携带 repairReason，
 * 供 application 层决定是否做一次内容修复；传输/不可用/空响应不带 repairReason。
 */
export type WorldEvolutionSourceResult =
  | { readonly ok: true; readonly proposal: WorldDeltaProposal | null }
  | {
      readonly ok: false;
      readonly failure: AiGenerationFailure;
      readonly repairReason?: WorldEvolutionRepairReason;
    };

export type WorldEvolutionSource = {
  propose(ctx: WorldEvolutionSourceContext): Promise<WorldEvolutionSourceResult>;
};
