import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { EvolutionNeed, WorldDeltaProposal } from "@/game/domain/worldDelta";

// ---------------------------------------------------------------------------
// WorldEvolutionSource：可注入的 AI 世界演化提议 port。
// 只负责"提议"：产出纯提案（普通字符串 ID 引用），审批/铸造 ID/装配预览状态
// 是 gameplay worldEvolution 纯函数职责。生产注入 live source，离线注入确定性
// source；propose 抛错或返回 null 由编排层以"无提案"降级。
// ---------------------------------------------------------------------------

export type WorldEvolutionSourceContext = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly need: EvolutionNeed;
  readonly action?: Action;
  readonly reason: string;
};

export type WorldEvolutionSourceResult = {
  readonly proposal: WorldDeltaProposal | null;
};

export type WorldEvolutionSource = {
  propose(ctx: WorldEvolutionSourceContext): Promise<WorldEvolutionSourceResult>;
};
