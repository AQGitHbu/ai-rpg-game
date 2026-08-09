// v2.1 共享的叙事进度类型（error-free，不从 v1 业务链路导入）。
// 由 v2.1 read model（gameSessionView）与 UI（NarrativeGenerationModal）消费；
// v1 的 runtimeNarrative.ts 同样 re-export 此类型，避免共享类型漂移。

/** 一个叙事场景涉及的用户可见角色阶段（内部进度契约，不含 provider/提示词/原始输出）。 */
export const NARRATIVE_ROLE_STAGES = ["director", "writer", "npc"] as const;
export type NarrativeRoleStage = (typeof NARRATIVE_ROLE_STAGES)[number];

export type NarrativeGenerationProgress = Readonly<{
  /** 通过审批的角色阶段响应数量。 */
  completedCalls: number;
  /** 常规场景流水线共有三个阶段。 */
  totalCalls: 3;
  currentRole: NarrativeRoleStage;
  attempt: number;
}>;
