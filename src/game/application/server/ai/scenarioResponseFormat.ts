import type { AiOutputFormat } from "./aiRuntimeConfig";

// ---------------------------------------------------------------------------
// Phase 4C spec §2：RPG 私有的结构化请求 body 构建（纯函数、纯数据）。
//
// - schema 静态对应 domain 的 ScenarioBlueprintCandidate（scenarioBlueprint.ts），
//   strict 模式要求每个 object 节点 additionalProperties:false 且 required 全覆盖；
//   封闭 union 用 anyOf，字面量用 const/enum。
// - 无论 provider 是否遵守 schema，返回内容仍走 root-shape 检查、
//   validateScenarioBlueprintCandidate、机械修复与 compile——schema 不是信任边界。
// - transport 不感知本模块：extraBody 经 liveScenarioCandidateSource 透传。
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const STRING: JsonSchema = { type: "string" };
const NUMBER: JsonSchema = { type: "number" };
const BOOLEAN: JsonSchema = { type: "boolean" };
const STRING_ARRAY: JsonSchema = { type: "array", items: STRING };

function arrayOf(items: JsonSchema): JsonSchema {
  return { type: "array", items };
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

const QUEST: JsonSchema = {
  anyOf: [
    strictObject({ ...QUEST_COMMON, kind: { const: "main" }, stage: { enum: [1, 2, 3] } }),
    strictObject({ ...QUEST_COMMON, kind: { const: "side" } })
  ]
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

// 与 domain CONTENT_BUDGET 完全对照的字面量：候选必须原样复述预算。
const CONTENT_BUDGET_SCHEMA = strictObject({
  mainLocations: { const: 4 },
  hiddenLocationsMax: { const: 1 },
  coreNpcsMin: { const: 4 },
  coreNpcsMax: { const: 6 },
  companionsMax: { const: 1 },
  sideQuestsMax: { const: 2 },
  endings: { const: 2 }
});

/** ScenarioBlueprintCandidate 的静态 strict JSON Schema（版本随候选契约 phase4b-v1）。 */
export const SCENARIO_CANDIDATE_JSON_SCHEMA = strictObject({
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
  locations: arrayOf(LOCATION),
  npcs: arrayOf(NPC),
  quests: arrayOf(QUEST),
  enemies: arrayOf(ENEMY),
  items: arrayOf(ITEM),
  endings: arrayOf(ENDING),
  openingScene: OPENING_SCENE,
  contentBudget: CONTENT_BUDGET_SCHEMA
});

/**
 * 输出格式 → chat completion extraBody。prompt_only 返回 undefined：
 * 请求形状与 Phase 4B 完全一致（不发送 response_format）。
 */
export function buildScenarioResponseFormatExtraBody(
  format: AiOutputFormat
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
            schema: SCENARIO_CANDIDATE_JSON_SCHEMA
          }
        }
      };
  }
}
