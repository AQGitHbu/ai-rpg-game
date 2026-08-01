// ---------------------------------------------------------------------------
// storyEvalArtifacts：评估产物共享类型（spec §6.3 / Task 13 扩展点）。
// Task 8 只定义 journey 写入 story.jsonl 的行的最小类型；Task 13 将扩展
// memorySummary/npcProfile/directorPlan 细节等字段与产物辅助函数。
// ---------------------------------------------------------------------------

/** story.jsonl 单行：场景行或结局行（sceneIndex 为场景序号，1-based）。 */
export type StoryEvalStoryRow = Readonly<{
  readonly kind: "scene" | "ending";
  readonly sceneIndex: number;
  readonly sceneId?: string;
  readonly mainStage?: number | null;
  readonly narration?: string;
  readonly npcLine?: Readonly<{ readonly text: string; readonly emotion: string }> | null;
  readonly choices?: readonly Readonly<{ readonly label: string; readonly actionKey: string }>[];
  readonly directorPlan?: Readonly<Record<string, unknown>> | null;
  readonly fallback?: boolean;
  readonly playerChoice?: Readonly<{ readonly index: number; readonly actionKey: string; readonly reason: string }>;
  readonly newEvents?: readonly Readonly<{ readonly type: string }>[];
  readonly outcome?: string | null;
}>;
