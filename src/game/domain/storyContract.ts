// ---------------------------------------------------------------------------
// 故事契约：开局生成的有界故事骨架。
// 只含抽象目标（幕数、中心冲突、两个结局方向），绝不包含任何未来实体 ID；
// 具体实体由运行时世界演化（worldDelta / worldEvolution）按需具象化。
// ---------------------------------------------------------------------------

export type EndingDirectionKey = "trust" | "doubt";

/**
 * Optional opening contract for a delivery-shaped main story. References are
 * local candidate keys, never runtime Entity IDs; the compiler binds only the
 * entities that are actually materialized.
 */
export type StoryDeliveryContract = {
  readonly itemKey: string;
  readonly recipientKey: string;
  readonly verificationFactKeys: readonly string[];
};

export type StoryContract = {
  readonly version: 1;
  readonly targetActs: 3 | 5;
  readonly centralConflict: string;
  readonly endingDirections: readonly [
    { readonly key: "trust"; readonly theme: string },
    { readonly key: "doubt"; readonly theme: string },
  ];
  readonly delivery?: StoryDeliveryContract;
};

/** 从开局档位构建默认故事契约：短局 3 幕、中局 5 幕；结局方向只存主题，不含实体引用。 */
export function createStoryContract(input: {
  gameLength: "short" | "medium";
  centralConflict: string;
  endingThemes: { trust: string; doubt: string };
  delivery?: StoryDeliveryContract;
}): StoryContract {
  return {
    version: 1,
    targetActs: input.gameLength === "short" ? 3 : 5,
    centralConflict: input.centralConflict,
    endingDirections: [
      { key: "trust", theme: input.endingThemes.trust },
      { key: "doubt", theme: input.endingThemes.doubt },
    ],
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
  };
}
