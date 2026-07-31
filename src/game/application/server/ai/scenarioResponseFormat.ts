import type { BudgetPolicy } from "@/game/domain";
import type { AiOutputFormat } from "./aiRuntimeConfig";

// ---------------------------------------------------------------------------
// Task 8：RPG 私有的结构化请求 body 构建（纯函数、纯数据）。
//
// - schema 按 BudgetPolicy 动态构建：stage 区间、budgetPolicy 叶子精确锁定；
//   strict 模式要求每个 object 节点 additionalProperties:false 且 required 全覆盖。
// - 无论 provider 是否遵守 schema，返回内容仍走 root-shape 检查、
//   validateScenarioBlueprintCandidate、机械修复与 compile——schema 不是信任边界。
// - transport 不感知本模块：extraBody 经 liveScenarioCandidateSource 透传。
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const STRING: JsonSchema = { type: "string" };
const NUMBER: JsonSchema = { type: "number" };
const BOOLEAN: JsonSchema = { type: "boolean" };
const STRING_ARRAY: JsonSchema = { type: "array", items: STRING };

function arrayOf(items: JsonSchema, extra?: Record<string, unknown>): JsonSchema {
  return { type: "array", items, ...extra };
}

/** strict object：required 恒等于全部 properties 键，杜绝手写遗漏。 */
function strictObject(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties
  };
}

/** 叶子精确锁定：JSON Schema 无 null const 惯例，统一用 enum: [value]。 */
function enumLock(value: unknown): JsonSchema {
  return { enum: [value] };
}

const STAT_BLOCK = strictObject({ hp: NUMBER, attack: NUMBER, defense: NUMBER });

const WORLD_FACT = strictObject({
  id: STRING,
  text: STRING,
  source: { enum: ["player_input", "generated"] }
});

const WORLD = strictObject({
  summary: STRING,
  tone: STRING,
  themes: STRING_ARRAY,
  facts: arrayOf(WORLD_FACT),
  tags: STRING_ARRAY
});

const PLAYER = strictObject({
  name: STRING,
  identity: STRING,
  backgroundSummary: STRING,
  startingLocationId: STRING,
  startingItemIds: STRING_ARRAY,
  baseStats: STAT_BLOCK
});

const LOCATION = strictObject({
  id: STRING,
  name: STRING,
  description: STRING,
  kind: { enum: ["main", "hidden"] },
  scale: { enum: ["scene", "town"] },
  connectedLocationIds: STRING_ARRAY,
  npcIds: STRING_ARRAY,
  availableItemIds: STRING_ARRAY,
  tags: STRING_ARRAY
});

const NPC = strictObject({
  id: STRING,
  name: STRING,
  role: STRING,
  description: STRING,
  locationId: STRING,
  isCompanion: BOOLEAN,
  knownFactIds: STRING_ARRAY,
  tags: STRING_ARRAY
});

const QUEST_OBJECTIVE: JsonSchema = {
  anyOf: [
    strictObject({ kind: { const: "visit_location" }, locationId: STRING }),
    strictObject({ kind: { const: "talk_to_npc" }, npcId: STRING }),
    strictObject({ kind: { const: "obtain_item" }, itemId: STRING }),
    strictObject({ kind: { const: "discover_fact" }, factId: STRING }),
    strictObject({ kind: { const: "defeat_enemy" }, enemyId: STRING })
  ]
};

const QUEST_OUTCOME: JsonSchema = {
  anyOf: [
    strictObject({ kind: { const: "unlock_quests" }, questIds: STRING_ARRAY }),
    strictObject({ kind: { const: "reach_ending" }, endingId: STRING }),
    strictObject({ kind: { const: "closed" } })
  ]
};

const QUEST_COMMON: Record<string, JsonSchema> = {
  id: STRING,
  name: STRING,
  description: STRING,
  objectives: arrayOf(QUEST_OBJECTIVE),
  onSuccess: QUEST_OUTCOME,
  onFailure: QUEST_OUTCOME,
  tags: STRING_ARRAY
};

const ENEMY = strictObject({
  id: STRING,
  name: STRING,
  tier: { enum: ["normal", "boss"] },
  stats: STAT_BLOCK,
  locationId: STRING,
  tags: STRING_ARRAY
});

const ITEM = strictObject({
  id: STRING,
  name: STRING,
  description: STRING,
  kind: STRING,
  tags: STRING_ARRAY
});

const ENDING_REQUIREMENT: JsonSchema = {
  anyOf: [
    strictObject({ kind: { const: "quest_completed" }, questId: STRING }),
    strictObject({ kind: { const: "quest_failed" }, questId: STRING }),
    strictObject({ kind: { const: "fact_discovered" }, factId: STRING })
  ]
};

const ENDING = strictObject({
  id: STRING,
  name: STRING,
  description: STRING,
  requirements: arrayOf(ENDING_REQUIREMENT)
});

const OPENING_SCENE = strictObject({
  id: STRING,
  locationId: STRING,
  narration: STRING,
  presentNpcIds: STRING_ARRAY,
  suggestedActions: STRING_ARRAY,
  investigableFactIds: STRING_ARRAY
});

function budgetPolicySchemaOf(policy: BudgetPolicy): JsonSchema {
  return strictObject({
    policyVersion: enumLock(policy.policyVersion),
    gameLength: enumLock(policy.gameLength),
    mainActs: enumLock(policy.mainActs),
    opening: strictObject({
      mainLocationsMin: enumLock(policy.opening.mainLocationsMin),
      mainLocationsMax: enumLock(policy.opening.mainLocationsMax),
      hiddenLocationsMax: enumLock(policy.opening.hiddenLocationsMax),
      coreNpcsMin: enumLock(policy.opening.coreNpcsMin),
      coreNpcsMax: enumLock(policy.opening.coreNpcsMax),
      companionsMax: enumLock(policy.opening.companionsMax),
      sideQuestsMax: enumLock(policy.opening.sideQuestsMax),
      endings: enumLock(policy.opening.endings),
      townLocationsMax: enumLock(policy.opening.townLocationsMax)
    }),
    expansion: strictObject({
      locationsSoftMax: enumLock(policy.expansion.locationsSoftMax),
      npcsSoftMax: enumLock(policy.expansion.npcsSoftMax)
    }),
    safety: strictObject({
      locationsHardMax: enumLock(policy.safety.locationsHardMax),
      npcsHardMax: enumLock(policy.safety.npcsHardMax)
    })
  });
}

function questSchemaOf(policy: BudgetPolicy): JsonSchema {
  return {
    anyOf: [
      strictObject({
        ...QUEST_COMMON,
        kind: { const: "main" },
        stage: { type: "integer", minimum: 1, maximum: policy.mainActs }
      }),
      strictObject({ ...QUEST_COMMON, kind: { const: "side" } })
    ]
  };
}

/** 按 BudgetPolicy 构建 ScenarioBlueprintCandidate 的 strict JSON Schema。 */
export function buildScenarioCandidateJsonSchema(policy: BudgetPolicy): Readonly<JsonSchema> {
  return strictObject({
    schemaVersion: { const: 1 },
    generationId: STRING,
    seed: STRING,
    templateVersion: STRING,
    gameType: {
      enum: [
        "wuxia", "xianxia", "fantasy", "science_fiction",
        "urban", "alternate_history", "post_apocalypse"
      ]
    },
    inputDigest: STRING,
    world: WORLD,
    player: PLAYER,
    locations: arrayOf(LOCATION, {
      minItems: policy.opening.mainLocationsMin,
      maxItems: policy.opening.mainLocationsMax + policy.opening.hiddenLocationsMax
    }),
    npcs: arrayOf(NPC),
    quests: arrayOf(questSchemaOf(policy)),
    enemies: arrayOf(ENEMY),
    items: arrayOf(ITEM),
    endings: arrayOf(ENDING),
    openingScene: OPENING_SCENE,
    budgetPolicy: budgetPolicySchemaOf(policy)
  });
}

/**
 * 输出格式 → chat completion extraBody。prompt_only 返回 undefined：
 * 请求形状与 Phase 4B 完全一致（不发送 response_format）。
 */
export function buildScenarioResponseFormatExtraBody(
  format: AiOutputFormat,
  policy: BudgetPolicy
): Readonly<Record<string, unknown>> | undefined {
  switch (format) {
    case "prompt_only":
      return undefined;
    case "json_object":
      return { response_format: { type: "json_object" } };
    case "json_schema":
      return {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "scenario_blueprint_candidate",
            strict: true,
            schema: buildScenarioCandidateJsonSchema(policy)
          }
        }
      };
  }
}
