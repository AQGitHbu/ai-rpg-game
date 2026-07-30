import type { GameLength } from "./newGame";

// ---------------------------------------------------------------------------
// 预算策略：时长档位 → 主线弧长 + 演进软上限。开局预算与安全硬上限全档位统一，
// 时长只影响"故事走多远"，不影响开局生成体积。数值表唯一事实源在此，
// validator / schema / prompt / 闸门一律引用本模块，禁止另写字面量。
// ---------------------------------------------------------------------------

export type BudgetPolicy = {
  readonly policyVersion: 1;
  readonly gameLength: GameLength;
  readonly mainActs: number;
  readonly opening: {
    readonly mainLocationsMin: number;
    readonly mainLocationsMax: number;
    readonly hiddenLocationsMax: number;
    readonly coreNpcsMin: number;
    readonly coreNpcsMax: number;
    readonly companionsMax: number;
    readonly sideQuestsMax: number;
    readonly endings: number;
    readonly townLocationsMax: number;
  };
  readonly expansion: {
    readonly locationsSoftMax: number | null;
    readonly npcsSoftMax: number | null;
  };
  readonly safety: {
    readonly locationsHardMax: number;
    readonly npcsHardMax: number;
  };
};

const OPENING = Object.freeze({
  mainLocationsMin: 3, mainLocationsMax: 5, hiddenLocationsMax: 1,
  coreNpcsMin: 4, coreNpcsMax: 6, companionsMax: 1,
  sideQuestsMax: 2, endings: 2, townLocationsMax: 2
});
const SAFETY = Object.freeze({ locationsHardMax: 40, npcsHardMax: 30 });

const PRESETS = Object.freeze({
  short: { mainActs: 3, locationsSoftMax: 8, npcsSoftMax: 10 },
  medium: { mainActs: 5, locationsSoftMax: 14, npcsSoftMax: 16 },
  long: { mainActs: 8, locationsSoftMax: 22, npcsSoftMax: 24 },
  open: { mainActs: 5, locationsSoftMax: null, npcsSoftMax: null }
} as const);

export function createBudgetPolicy(gameLength: GameLength): BudgetPolicy {
  const preset = PRESETS[gameLength];
  return Object.freeze({
    policyVersion: 1, gameLength, mainActs: preset.mainActs,
    opening: OPENING, safety: SAFETY,
    expansion: Object.freeze({
      locationsSoftMax: preset.locationsSoftMax, npcsSoftMax: preset.npcsSoftMax
    })
  });
}

/** 旧存档（无 budgetPolicy 字段）的等价策略：3 幕、主地点恒 4，与旧 CONTENT_BUDGET 语义逐项一致。 */
export const LEGACY_BUDGET_POLICY: BudgetPolicy = Object.freeze({
  policyVersion: 1, gameLength: "short", mainActs: 3,
  opening: Object.freeze({ ...OPENING, mainLocationsMin: 4, mainLocationsMax: 4 }),
  expansion: Object.freeze({ locationsSoftMax: 8, npcsSoftMax: 10 }),
  safety: SAFETY
});

export function budgetPolicyOf(blueprint: { readonly budgetPolicy?: BudgetPolicy }): BudgetPolicy {
  return blueprint.budgetPolicy ?? LEGACY_BUDGET_POLICY;
}

/** 终局幕号：所有 stage === 3 的硬编码判定改为引用此函数。 */
export function finalMainActOf(blueprint: { readonly budgetPolicy?: BudgetPolicy }): number {
  return budgetPolicyOf(blueprint).mainActs;
}
