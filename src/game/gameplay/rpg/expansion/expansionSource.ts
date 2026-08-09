import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { ExpansionProposal } from "./expansionTypes";

// ---------------------------------------------------------------------------
// ExpansionSource：可注入的 AI 世界扩展 port。
// 纯类型定义，供 application 回合编排和 expansion/index 安全导入。
// 生产环境注入 live source，测试/离线注入 fixture source。
// fixture 实现在 application/server/ai/expansionSource.ts。
// ---------------------------------------------------------------------------

export type ExpansionSourceContext = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly action: Action;
  readonly triggerReason: string;
};

export type ExpansionSourceResult = {
  readonly proposals: readonly ExpansionProposal[];
};

export type ExpansionSource = {
  propose(ctx: ExpansionSourceContext): Promise<ExpansionSourceResult>;
};
