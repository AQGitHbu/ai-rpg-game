# MVP Phase 4C：结构化输出可靠性与离线回归 实现计划

> **对 Claude 的执行要求：** 每完成一个任务，使用 superpowers:subagent-driven-development（或 executing-plans）的评审流程后再进入下一任务。严格 TDD：先写失败测试并确认失败原因，再写实现。

**目标：** 为真实 AI 开局候选增加显式的结构化输出格式配置（`AI_OUTPUT_FORMAT`），在不改变任何既有失败类别、重试与 fallback 契约的前提下降低非法 JSON 概率；同时建立 Phase 4C 版本化离线 fixture 集与三类型完整游戏回归，使日常开发验收零网络、零计费；smoke 增加脱敏安全汇总。

**Spec 依据：**
- `docs/superpowers/specs/2026-07-29-phase4c-real-ai-output-reliability-and-offline-regression-design.md`（本阶段设计）
- `docs/superpowers/specs/2026-07-28-ai-contract-simulation-and-dynamic-opening-design.md`（4A/4B 基线契约）

**工作区：** 一切修改只发生在 worktree `f:\AI2\ai-rpg-game\.worktrees\phase4c-planning`（分支 `codex/phase4c-planning`）。**严禁写 main 检出的任何文件。**

**基线：** HEAD=f4db525，`npm test` 51 文件 / 793 测试全绿（2026-07-29 实测）。

**架构总览：** `parseAiRuntimeConfig` 新增非敏感键 `AI_OUTPUT_FORMAT` 的解析（available 分支携带 `outputFormat`）；新纯函数模块 `scenarioResponseFormat.ts` 把格式映射为 OpenAI-compatible `response_format` extraBody；live source 新增可选 `extraBody` 选项透传给 `transport.complete` 第三参数；factory 按 outputFormat 装配。离线侧新增 `data/fixtures/phase4c/` 版本化 fixture 集 + 契约回归 + 三类型完整旅程回归。smoke 增加按输出格式统计的安全汇总纯函数。

## 全局约束（每个任务都必须遵守）

1. **契约冻结：** `SCENARIO_CANDIDATE_CONTRACT_VERSION` 保持 `"phase4b-v1"`；11 个失败类别、8 个生成阶段、`origin` 取值一律不新增不修改。
2. **不改 foundation：** `@ai-game/ai-transport` 已支持 `options.extraBody`（`buildRequestBody` 先展开 extraBody、再用 model/messages/temperature 覆盖核心字段），本阶段零 foundation 改动。
3. **脱敏红线：** 输出格式不进入玩家 API、UI、存档、客户端 bundle，也**不进入 audit**（spec §2 明确）。诊断/日志绝不回显任何 env 值、prompt、玩家原文、模型原文、URL、密钥。
4. **零网络：** 所有新增测试不读 `.env.local`、不发 fetch。真实调用只经 `RUN_REAL_AI_SMOKE=1` 的 smoke。不做 provider 能力探测。
5. **分层边界：** `@ai-game/ai-transport` 只允许 `src/game/application/server/ai/` 导入（`dependencyBoundaries.test.ts` 守卫）；composition root 是唯一读 process.env 的生产点。
6. **测试约定：** vitest 测试文件 node 环境需 `/** @vitest-environment node */` 头注释；`*.node-test.mjs` 由 `node --test` 运行；SQLite 回归用 `tmp/` 下 RUN_PREFIX 独立目录（模仿 phase4a 回归的清扫模式）。
7. **TDD：** 每一步先写测试→运行确认按预期失败→写实现→运行确认通过→跑 `npx vitest run <相关文件>`；任务收尾跑 `npm run typecheck`。
8. 每个任务完成后单独 `git commit`（信息用英文祈使句，如 `feat: parse AI_OUTPUT_FORMAT runtime config`）。

## 涉及文件总览

```
修改  src/game/application/server/ai/aiRuntimeConfig.ts            （Task 1）
修改  src/game/application/server/ai/aiRuntimeConfig.test.ts       （Task 1）
新建  src/game/application/server/ai/scenarioResponseFormat.ts     （Task 2）
新建  src/game/application/server/ai/scenarioResponseFormat.test.ts（Task 2）
修改  src/game/application/server/ai/liveScenarioCandidateSource.ts       （Task 3）
修改  src/game/application/server/ai/liveScenarioCandidateSource.test.ts  （Task 3）
修改  src/game/application/server/ai/scenarioCandidateSourceFactory.ts    （Task 3）
新建  src/game/application/server/ai/scenarioCandidateSourceFactory.test.ts（Task 3）
新建  data/fixtures/phase4c/manifest.json + 12 个 fixture 文件      （Task 4）
新建  src/game/application/phase4cStructuredOutputRegression.test.ts（Task 4）
新建  src/game/application/phase4cOfflineJourneyRegression.test.ts  （Task 5）
修改  scripts/phase4bAiSmoke.mjs                                    （Task 6）
修改  scripts/phase4bAiSmoke.node-test.mjs                          （Task 6）
修改  docs/agent/AI环境.md、当前开发阶段.md、MVP核心闭环.md、
      docs/Agent文档索引.md、docs/agent/current-phase.json、.env.example（Task 7）
```

---

## Task 1：`AI_OUTPUT_FORMAT` 运行时配置解析

**文件：** `src/game/application/server/ai/aiRuntimeConfig.ts`、`aiRuntimeConfig.test.ts`

### Step 1.1 写失败测试

在 `aiRuntimeConfig.test.ts` 中：

a) **先改既有断言**——两个 available 用例的 `toEqual` 期望对象各加一行 `outputFormat: "prompt_only"`（放在 `config` 之后）。此刻运行必然失败（实现还没有该字段）。

b) 追加新 describe 块：

```ts
describe("parseAiRuntimeConfig：AI_OUTPUT_FORMAT（Phase 4C）", () => {
  it.each(["json_schema", "json_object", "prompt_only"] as const)(
    "合法值 %s ⇒ available 且 outputFormat 原样",
    (format) => {
      const result = parseAiRuntimeConfig({ ...VALID_ENV, AI_OUTPUT_FORMAT: format });
      expect(result.status).toBe("available");
      if (result.status === "available") expect(result.outputFormat).toBe(format);
    }
  );

  it("缺失 / 空白 ⇒ 默认 prompt_only（既有部署请求形状不变）", () => {
    for (const value of [undefined, "", "   "]) {
      const result = parseAiRuntimeConfig({ ...VALID_ENV, AI_OUTPUT_FORMAT: value });
      expect(result).toEqual({
        status: "available",
        config: {
          baseUrl: "https://api.example.com/v1",
          model: "some-model",
          apiKey: "sk-secret-value-123"
        },
        outputFormat: "prompt_only"
      });
    }
  });

  it("包裹空白的合法值 trim 后接受", () => {
    const result = parseAiRuntimeConfig({ ...VALID_ENV, AI_OUTPUT_FORMAT: "  json_object  " });
    expect(result.status).toBe("available");
    if (result.status === "available") expect(result.outputFormat).toBe("json_object");
  });

  it("无效值 ⇒ unavailable + AI_CONFIG_OUTPUT_FORMAT_INVALID（不回显值）", () => {
    const result = parseAiRuntimeConfig({ ...VALID_ENV, AI_OUTPUT_FORMAT: "yaml-forever" });
    expect(result).toEqual({
      status: "unavailable",
      diagnostics: ["AI_CONFIG_OUTPUT_FORMAT_INVALID"]
    });
    expect(JSON.stringify(result)).not.toContain("yaml-forever");
  });

  it("大小写敏感：JSON_SCHEMA 视为无效", () => {
    const result = parseAiRuntimeConfig({ ...VALID_ENV, AI_OUTPUT_FORMAT: "JSON_SCHEMA" });
    expect(result).toEqual({
      status: "unavailable",
      diagnostics: ["AI_CONFIG_OUTPUT_FORMAT_INVALID"]
    });
  });

  it("与三键诊断共存时追加在末尾（顺序稳定可断言）", () => {
    const result = parseAiRuntimeConfig({
      AI_API_BASE_URL: "",
      AI_MODEL: "m",
      AI_API_KEY: "k",
      AI_OUTPUT_FORMAT: "bogus"
    });
    expect(result).toEqual({
      status: "unavailable",
      diagnostics: ["AI_CONFIG_BASE_URL_MISSING", "AI_CONFIG_OUTPUT_FORMAT_INVALID"]
    });
  });
});
```

运行 `npx vitest run src/game/application/server/ai/aiRuntimeConfig.test.ts`，确认失败（类型错误也算预期失败——outputFormat 尚不存在）。

### Step 1.2 实现

`aiRuntimeConfig.ts` 修改点：

a) 在 `AiRuntimeConfigResult` 之前加：

```ts
/** Phase 4C：显式输出格式（spec §1）。缺省 prompt_only，绝不隐式探测 provider 能力。 */
export const AI_OUTPUT_FORMATS = ["json_schema", "json_object", "prompt_only"] as const;
export type AiOutputFormat = (typeof AI_OUTPUT_FORMATS)[number];
```

b) available 分支类型加字段：

```ts
export type AiRuntimeConfigResult =
  | Readonly<{ status: "available"; config: AiTransportConfig; outputFormat: AiOutputFormat }>
  | Readonly<{ status: "unavailable"; diagnostics: readonly string[] }>;
```

c) `parseAiRuntimeConfig` 内，在 base URL 校验块之后、`if (diagnostics.length > 0 || ...)` 之前插入：

```ts
  // Phase 4C：AI_OUTPUT_FORMAT 严格三值（大小写敏感）；缺失/空白默认 prompt_only，
  // 无效值给稳定诊断码（绝不回显），生产最终走 unavailable → fallback。
  const rawFormat = (env.AI_OUTPUT_FORMAT ?? "").trim();
  let outputFormat: AiOutputFormat = "prompt_only";
  if (rawFormat !== "") {
    if ((AI_OUTPUT_FORMATS as readonly string[]).includes(rawFormat)) {
      outputFormat = rawFormat as AiOutputFormat;
    } else {
      diagnostics.push("AI_CONFIG_OUTPUT_FORMAT_INVALID");
    }
  }
```

d) 成功返回值加 `outputFormat`：

```ts
  return {
    status: "available",
    config: { baseUrl: values.baseUrl, model: values.model, apiKey: values.apiKey },
    outputFormat
  };
```

同时更新文件头注释（Phase 4B → Phase 4B/4C，提及第四个非敏感键）。

### Step 1.3 验证

`npx vitest run src/game/application/server/ai/` 全绿；`npm run typecheck` 通过（若 factory 等调用点因新字段报错，本任务只需保证不破坏——`outputFormat` 是新增字段而非改名，理论上无连锁）。提交。

---

## Task 2：`scenarioResponseFormat.ts` 纯函数与静态严格 JSON Schema

**文件：** 新建 `src/game/application/server/ai/scenarioResponseFormat.ts`、`scenarioResponseFormat.test.ts`

### Step 2.1 写失败测试

`scenarioResponseFormat.test.ts`（node 环境注释可省——纯函数无 DOM 依赖，与 aiRuntimeConfig.test.ts 保持一致不加）：

```ts
import { describe, expect, it } from "vitest";
import {
  buildScenarioResponseFormatExtraBody,
  SCENARIO_CANDIDATE_JSON_SCHEMA
} from "./scenarioResponseFormat";

// ---------------------------------------------------------------------------
// Phase 4C spec §2：三种输出格式 → response_format extraBody 的纯函数契约。
// schema 是静态版本化数据：本测试同时守卫 strict 模式的结构性约束
// （所有 object 节点 additionalProperties:false 且 required 全覆盖）。
// ---------------------------------------------------------------------------

describe("buildScenarioResponseFormatExtraBody", () => {
  it("prompt_only ⇒ undefined（请求形状与 Phase 4B 完全一致）", () => {
    expect(buildScenarioResponseFormatExtraBody("prompt_only")).toBeUndefined();
  });

  it("json_object ⇒ 通用 JSON object response_format", () => {
    expect(buildScenarioResponseFormatExtraBody("json_object")).toEqual({
      response_format: { type: "json_object" }
    });
  });

  it("json_schema ⇒ strict 命名 schema", () => {
    const body = buildScenarioResponseFormatExtraBody("json_schema");
    expect(body).toEqual({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "scenario_blueprint_candidate",
          strict: true,
          schema: SCENARIO_CANDIDATE_JSON_SCHEMA
        }
      }
    });
  });
});

describe("SCENARIO_CANDIDATE_JSON_SCHEMA：strict 结构守卫", () => {
  it("根节点覆盖候选全部 16 个字段且拒绝未知字段", () => {
    expect(SCENARIO_CANDIDATE_JSON_SCHEMA.additionalProperties).toBe(false);
    expect([...SCENARIO_CANDIDATE_JSON_SCHEMA.required].sort()).toEqual(
      [
        "schemaVersion", "generationId", "seed", "templateVersion", "gameType",
        "inputDigest", "world", "player", "locations", "npcs", "quests",
        "enemies", "items", "endings", "openingScene", "contentBudget"
      ].sort()
    );
  });

  it("所有 object 节点 additionalProperties:false 且 required 全覆盖（strict 前提）", () => {
    const violations: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (record.type === "object") {
        const properties = record.properties as Record<string, unknown> | undefined;
        const required = record.required as string[] | undefined;
        if (record.additionalProperties !== false) violations.push(`${path}: additionalProperties`);
        if (
          properties === undefined ||
          required === undefined ||
          [...Object.keys(properties)].sort().join(",") !== [...required].sort().join(",")
        ) {
          violations.push(`${path}: required 未全覆盖`);
        }
      }
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    };
    walk(SCENARIO_CANDIDATE_JSON_SCHEMA, "$");
    expect(violations).toEqual([]);
  });

  it("schema 可 JSON 序列化往返（纯数据，无函数/undefined）", () => {
    const roundTrip = JSON.parse(JSON.stringify(SCENARIO_CANDIDATE_JSON_SCHEMA));
    expect(roundTrip).toEqual(SCENARIO_CANDIDATE_JSON_SCHEMA);
  });

  it("关键封闭 union 与常量：gameType 七值、contentBudget 全 const、quest anyOf 两分支", () => {
    const properties = SCENARIO_CANDIDATE_JSON_SCHEMA.properties as Record<string, any>;
    expect(properties.gameType.enum).toEqual([
      "wuxia", "xianxia", "fantasy", "science_fiction",
      "urban", "alternate_history", "post_apocalypse"
    ]);
    expect(properties.schemaVersion).toEqual({ const: 1 });
    expect(properties.contentBudget.properties.mainLocations).toEqual({ const: 4 });
    expect(properties.contentBudget.properties.endings).toEqual({ const: 2 });
    expect(properties.quests.items.anyOf).toHaveLength(2);
  });
});
```

运行确认失败（模块不存在）。

### Step 2.2 实现

`scenarioResponseFormat.ts` 完整内容：

```ts
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
```

注意：测试直接读 `SCENARIO_CANDIDATE_JSON_SCHEMA.required` 等属性，需要该常量类型放宽为 `Record<string, unknown>` 后在测试里 `as` 收窄——测试中已用 `as Record<string, any>` 处理 `properties`，`required` 访问用 `[...SCENARIO_CANDIDATE_JSON_SCHEMA.required as string[]]` 如遇类型报错可在测试中局部 `const schema = SCENARIO_CANDIDATE_JSON_SCHEMA as Record<string, any>;` 统一访问。

### Step 2.3 验证

`npx vitest run src/game/application/server/ai/scenarioResponseFormat.test.ts` 全绿；`npm run typecheck`。提交。

---

## Task 3：live source 透传 extraBody + factory 按格式装配

**文件：** `liveScenarioCandidateSource.ts`、`liveScenarioCandidateSource.test.ts`、`scenarioCandidateSourceFactory.ts`、新建 `scenarioCandidateSourceFactory.test.ts`

### Step 3.1 live source 失败测试

在 `liveScenarioCandidateSource.test.ts` 追加 describe（沿用该文件既有的 fake transport / 有效候选构造 helper，先读文件再插入）：

```ts
describe("Phase 4C：extraBody 透传", () => {
  it("提供 extraBody 时以第三参数 { extraBody } 传给 transport.complete", async () => {
    // 用既有 fake transport 模式记录调用参数：
    const calls: unknown[][] = [];
    const transport = {
      complete: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: false as const, code: "timeout" as const, latencyMs: 5 };
      }
    };
    const extraBody = { response_format: { type: "json_object" } };
    const source = createLiveScenarioCandidateSource({
      transport: transport as never,
      config: TEST_CONFIG,          // 该文件既有的测试 config 常量（如命名不同则沿用现名）
      buildMessages: () => [],
      audit: { record: () => {} },
      extraBody
    });
    await source.generate(TEST_REQUEST); // 该文件既有的测试 request 常量
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual({ extraBody });
  });

  it("未提供 extraBody 时第三参数为 undefined（Phase 4B 形状不变）", async () => {
    /* 同上骨架，不传 extraBody，断言 calls[0][2] === undefined 或 calls[0].length === 2 */
  });
});
```

另确认该文件已有"多个 fence → invalid_json"用例；若没有，补一条：`content` 为两个 ```json fence 拼接的字符串 ⇒ `category: "invalid_json"`、诊断 `["LIVE_INVALID_JSON"]`（多 fence 文本不满足单一 fence 正则，整体也非合法 JSON）。

### Step 3.2 live source 实现

`liveScenarioCandidateSource.ts`：

a) options 加可选字段：

```ts
export type LiveScenarioCandidateSourceOptions = Readonly<{
  transport: AiTransport;
  config: AiTransportConfig;
  buildMessages: (request: ScenarioGenerationRequest) => readonly AiMessage[];
  audit: ScenarioGenerationAudit;
  /** Phase 4C：结构化输出 extraBody（response_format）；undefined = 不发送。 */
  extraBody?: Readonly<Record<string, unknown>>;
}>;
```

b) 解构加 `extraBody`，调用改为：

```ts
        result = await transport.complete(
          config,
          messages,
          extraBody === undefined ? undefined : { extraBody: { ...extraBody } }
        );
```

（浅拷贝防调用方后续变异共享对象；测试断言用 `toEqual` 不受影响。）

### Step 3.3 factory 失败测试（新建 `scenarioCandidateSourceFactory.test.ts`）

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewGameInput } from "@/game/domain";
import wuxiaFixture from "../../../../../data/fixtures/phase1/wuxia.json";
import { TEST_TRACE_ID } from "../../applicationFixture.testutil";
import { createScenarioCandidateSource } from "./scenarioCandidateSourceFactory";

// ---------------------------------------------------------------------------
// factory 装配契约（Phase 4C）：
// - env 无效（含 AI_OUTPUT_FORMAT 非法）⇒ unavailable source，不创建 transport；
// - env 有效 ⇒ 按 outputFormat 把 response_format extraBody 传进 transport.complete。
// 全部离线：transport 由测试注入 fake，绝不真实 fetch。
// ---------------------------------------------------------------------------

const VALID_ENV = {
  AI_API_BASE_URL: "https://api.example.com/v1",
  AI_MODEL: "some-model",
  AI_API_KEY: "sk-secret-value-123"
};

const REQUEST = {
  input: (wuxiaFixture as { input: NewGameInput }).input,
  seed: "seed-factory-test",
  traceId: TEST_TRACE_ID
};

function fakeTransport() {
  const calls: unknown[][] = [];
  return {
    calls,
    transport: {
      complete: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: false as const, code: "timeout" as const, latencyMs: 1 };
      }
    }
  };
}

afterEach(() => vi.restoreAllMocks());

describe("createScenarioCandidateSource：无效配置", () => {
  it("AI_OUTPUT_FORMAT 非法 ⇒ unavailable + 稳定诊断，且不创建 transport", async () => {
    const transportFactory = vi.fn();
    const source = createScenarioCandidateSource(
      { ...VALID_ENV, AI_OUTPUT_FORMAT: "bogus" },
      { transportFactory }
    );
    const attempt = await source.generate(REQUEST);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.origin).toBe("unavailable");
      expect(attempt.diagnostics).toEqual(["AI_CONFIG_OUTPUT_FORMAT_INVALID"]);
    }
    expect(transportFactory).not.toHaveBeenCalled();
  });
});

describe("createScenarioCandidateSource：extraBody 按格式装配", () => {
  it.each([
    [undefined, undefined],
    ["prompt_only", undefined],
    ["json_object", { response_format: { type: "json_object" } }]
  ] as const)("AI_OUTPUT_FORMAT=%s ⇒ 第三参数 %j", async (format, expected) => {
    vi.spyOn(console, "log").mockImplementation(() => {}); // 静音默认 audit
    const { calls, transport } = fakeTransport();
    const source = createScenarioCandidateSource(
      { ...VALID_ENV, AI_OUTPUT_FORMAT: format },
      { transportFactory: () => transport as never }
    );
    await source.generate(REQUEST);
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual(expected === undefined ? undefined : { extraBody: expected });
  });

  it("json_schema ⇒ strict 命名 schema 进入 extraBody", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls, transport } = fakeTransport();
    const source = createScenarioCandidateSource(
      { ...VALID_ENV, AI_OUTPUT_FORMAT: "json_schema" },
      { transportFactory: () => transport as never }
    );
    await source.generate(REQUEST);
    const options = calls[0][2] as { extraBody: { response_format: Record<string, any> } };
    expect(options.extraBody.response_format.type).toBe("json_schema");
    expect(options.extraBody.response_format.json_schema.name).toBe("scenario_blueprint_candidate");
    expect(options.extraBody.response_format.json_schema.strict).toBe(true);
  });
});
```

### Step 3.4 factory 实现

`scenarioCandidateSourceFactory.ts`：

```ts
import { createOpenAiCompatibleTransport, type AiTransport } from "@ai-game/ai-transport";
// …既有 import 保持，新增：
import { buildScenarioResponseFormatExtraBody } from "./scenarioResponseFormat";

/** 测试注入点：只允许替换 transport 创建（保持生产装配唯一）。 */
export type ScenarioCandidateSourceFactoryOptions = Readonly<{
  transportFactory?: () => AiTransport;
}>;

export function createScenarioCandidateSource(
  env: Record<string, string | undefined>,
  options: ScenarioCandidateSourceFactoryOptions = {}
): ScenarioCandidateSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "unavailable") {
    return createUnavailableScenarioCandidateSource(runtime.diagnostics);
  }
  const profiles = loadScenarioProfiles();
  return createLiveScenarioCandidateSource({
    transport: (options.transportFactory ?? createOpenAiCompatibleTransport)(),
    config: runtime.config,
    buildMessages: (request) => buildScenarioPromptMessages(request, profiles),
    audit: createStructuredScenarioGenerationAudit({ log: (line) => console.log(line) }),
    // Phase 4C：按显式输出格式构建 response_format；prompt_only ⇒ undefined。
    extraBody: buildScenarioResponseFormatExtraBody(runtime.outputFormat)
  });
}
```

（文件头注释补一句 Phase 4C 说明；`compositionRoot.ts` 无需改动——第二参数有默认值。）

### Step 3.5 验证

`npx vitest run src/game/application/server/` 全绿；`npm run typecheck`；`npx vitest run src/dependencyBoundaries.test.ts`（确认边界守卫不受新 import 影响）。提交。

---

## Task 4：Phase 4C 版本化离线 fixture 集与契约回归

**文件：** `data/fixtures/phase4c/`（manifest + 12 个 fixture）、新建 `src/game/application/phase4cStructuredOutputRegression.test.ts`

### Step 4.1 fixture 文件

先复制 6 个既有 fixture（PowerShell，在 worktree 根执行）：

```powershell
mkdir data/fixtures/phase4c
Copy-Item data/fixtures/phase4/generated-wuxia.json,data/fixtures/phase4/generated-science-fiction.json,data/fixtures/phase4/generated-urban.json,data/fixtures/phase4/repairable-extra-fields.json,data/fixtures/phase4/unrepairable-reference.json,data/fixtures/phase4/budget-exceeded.json data/fixtures/phase4c/
```

再新建 6 个：

`data/fixtures/phase4c/format-not-json.json`：
```json
{
  "$comment": "结构化 provider 仍可能吐 prose：非 JSON 文本必须落 invalid_json。",
  "responseText": "很抱歉，我需要更多信息才能生成这个世界的设定。"
}
```

`data/fixtures/phase4c/format-multi-fence.json`：
```json
{
  "$comment": "多个 code fence 不满足单一 fence 契约：整体不是合法 JSON ⇒ invalid_json。",
  "responseText": "```json\n{\"a\":1}\n```\n再补充一份：\n```json\n{\"b\":2}\n```"
}
```

`data/fixtures/phase4c/format-wrong-root.json`：
```json
{
  "$comment": "根形状缺少六个数组字段 ⇒ schema_violation（root-shape 检查层）。",
  "candidate": { "world": {}, "openingScene": {}, "player": {} }
}
```

`data/fixtures/phase4c/transport-timeout.json`：
```json
{ "failureMode": "timeout", "diagnostics": ["FIXTURE_TRANSPORT_TIMEOUT"] }
```

`data/fixtures/phase4c/transport-rate-limited.json`：
```json
{ "failureMode": "rate_limited", "diagnostics": ["FIXTURE_TRANSPORT_RATE_LIMITED"] }
```

`data/fixtures/phase4c/transport-service-error.json`：
```json
{ "failureMode": "service_error", "diagnostics": ["FIXTURE_TRANSPORT_SERVICE_ERROR"] }
```

### Step 4.2 manifest

`data/fixtures/phase4c/manifest.json`——`contractVersion` **保持 `"phase4b-v1"`**（候选契约本身未变，fixture source 严格校验该值），fixture 集版本用附加键 `fixtureSetVersion`（fixture source 忽略未知顶层键，已核实）：

```json
{
  "$comment": "Phase 4C fixture manifest：候选契约仍是 phase4b-v1（未升级）；fixtureSetVersion 标识本离线集合版本。expectedStages 仅供契约测试。",
  "contractVersion": "phase4b-v1",
  "fixtureSetVersion": "phase4c-v1",
  "fixtures": [ …12 条… ]
}
```

12 条 entry 的 `expectedStages` 规则（与 phase4 manifest 相同事件语法）：

| id | file | expectedFallback | expectedCategory | expectedStages |
|---|---|---|---|---|
| generated-wuxia | generated-wuxia.json | false | — | requested, candidate_received, validating, completed |
| generated-science-fiction | 同名 .json | false | — | 同上 |
| generated-urban | 同名 .json | false | — | 同上 |
| repairable-extra-fields | 同名 .json | false | — | requested, candidate_received, validating, repairing, completed |
| format-not-json | format-not-json.json | true | invalid_json | requested, retrying, falling_back, completed |
| format-multi-fence | format-multi-fence.json | true | invalid_json | requested, retrying, falling_back, completed |
| format-wrong-root | format-wrong-root.json | true | schema_violation | requested, retrying, falling_back, completed |
| unrepairable-reference | 同名 .json | true | reference_broken | requested, candidate_received, validating, retrying, candidate_received, validating, falling_back, completed |
| budget-exceeded | 同名 .json | true | budget_exceeded | 同 unrepairable-reference 行 |
| transport-timeout | transport-timeout.json | true | timeout | requested, retrying, falling_back, completed |
| transport-rate-limited | transport-rate-limited.json | true | rate_limited | requested, retrying, falling_back, completed |
| transport-service-error | transport-service-error.json | true | service_error | requested, retrying, falling_back, completed |

`gameType` 字段：generated-science-fiction 为 `science_fiction`、generated-urban 为 `urban`，其余全部 `wuxia`；`seed` 沿用 phase4 惯例（`phase1-wuxia-001` 等）；`expectedAttempt`：成功候选与含 candidate 的格式失败按 phase4 惯例——candidate 成功送达的（generated-*、repairable、unrepairable、budget）为 `"ok"`，source 层直接失败的（format-*、transport-*）为 `"failed"`。

### Step 4.3 契约回归测试（先写、先看它红）

新建 `src/game/application/phase4cStructuredOutputRegression.test.ts`，**整体结构照抄 `phase4aScenarioGenerationRegression.test.ts`**（同样的 tmp/ 清扫、openRepository、createAndReload、assertBudgetsAndEndings、assertNoInternalLeak helper），差异点：

1. `FIXTURE_ROOT = resolve("data/fixtures/phase4c")`；import `phase4cManifest from "../../../data/fixtures/phase4c/manifest.json"`；RUN_PREFIX 用 `"sqlite-phase4c-regression-"`；gameId 前缀 `game-phase4c-case-`。
2. 顶部加集合版本断言：

```ts
it("manifest：候选契约 phase4b-v1 不升级，fixture 集版本 phase4c-v1", () => {
  expect(phase4cManifest.contractVersion).toBe("phase4b-v1");
  expect(phase4cManifest.fixtureSetVersion).toBe("phase4c-v1");
  expect(phase4cManifest.fixtures).toHaveLength(12);
});
```

3. **遍历 manifest 全部 12 条**（不是挑样本）：`gameType` → phase1 fixture 输入映射（wuxia/science_fiction/urban 三选一）；每条断言：
   - `created.source` 与 `expectedFallback` 对应（false ⇒ `"generated"`，true ⇒ `"fallback"`）；
   - `stages` 严格等于 manifest `expectedStages`；
   - `assertBudgetsAndEndings`、`assertNoInternalLeak`（泄漏黑名单额外加 `"responseText"`、`"failureMode"`）；
   - reload 后 view 一致（createAndReload 已含）。

### Step 4.4 验证

`npx vitest run src/game/application/phase4cStructuredOutputRegression.test.ts` 全绿（12+1 用例）；`npm run typecheck`。提交（fixture + manifest + 测试同一提交）。

---

## Task 5：三类型完整游戏离线旅程回归

**文件：** 新建 `src/game/application/phase4cOfflineJourneyRegression.test.ts`

**意图（spec §3）：** 用 fixture source（generated-wuxia / generated-science-fiction / generated-urban）创建游戏后，沿既有旅程模式执行 探索/移动 → 取得物品 → 三段主线 → 战斗 → 结局 → reload，证明"AI 候选只生成世界，规则系统仍裁决游戏状态"，全程零网络。

### Step 5.1 写测试（红）

结构基础：**helper 全部取自 `phase6BattleEndingRegression.test.ts` 的既有模式**（该文件的 `openRepository / createDependencies / performDeps / loadActiveRecord / mainQuestOfStage / performSequence / buildStage3ReadyIntents / findBossEnemy` 是文件内私有函数；按既有 phase5→phase6 的先例复制到新文件后适配，不改公共模块）。适配点：

1. `createDependencies` 的 `scenarioCandidateSource` 换成 `createFixtureScenarioCandidateSource({ fixtureRoot: resolve("data/fixtures/phase4c"), fixtureId })`；
2. tmp/ 目录 RUN_PREFIX 用 `"sqlite-phase4c-journey-"`；
3. 输入用 phase1 三类型 fixture（同 Task 4）；
4. **旅程必须由实际 blueprint 驱动**：所有地点/NPC/物品/敌人 ID 从 reload 出的 `record.blueprint` 读取（phase6 的 helper 已是这种写法），不得硬编码 fixture 内容——这样任何合法候选都能通过。

用例列表：

```
describe("Phase 4C 离线旅程：三类型 generated 候选跑通完整闭环")
  for each of [wuxia, science_fiction, urban]:
    it(`${gameType}：创建(generated) → stage1/2/3 主线 → 战斗胜利 → 成功结局 → reload`)
      - createGame ⇒ ok、source==="generated"
      - 依 blueprint 完成 stage1、stage2 主线（performSequence + mainQuestOfStage 模式）
      - buildStage3ReadyIntents 后 start_battle(findBossEnemy)，attack 连打至胜利
      - 期望进入 ending 态（view 呈现结局；具体断言沿 phase6 成功结局用例的写法）
      - 全新 repository reload：view 与内存态一致

  it("wuxia：战斗失败 → 失败结局同样是完整存档且可 reload")
      - 同 phase6 失败结局用例的驱动方式（故意败给 boss / 走 onFailure 路线）
      - 断言失败结局呈现 + reload 一致
```

> 若 generated fixture 的蓝图使 phase6 的某个 helper 假设不成立（例如 stage 主线的 objective 组合不同），以 blueprint 数据驱动的方式泛化该 helper（例如 objective 逐类映射到对应 intent），不得反过来改 fixture 迁就测试。

### Step 5.2 实现与验证

本任务没有生产代码——测试红通常意味着 helper 适配不完整，修测试本身直到绿。完成后：

```
npx vitest run src/game/application/phase4cOfflineJourneyRegression.test.ts
npm test        # 全量确认无回归
```

提交。

---

## Task 6：smoke 安全汇总（按输出格式聚合）

**文件：** `scripts/phase4bAiSmoke.mjs`、`scripts/phase4bAiSmoke.node-test.mjs`

**红线不变：** 通过条件不变（仍是 generated|fallback 契约）；audit 不加输出格式；不输出任何敏感内容；smoke 不进 npm test / test:fast / build。

### Step 6.1 node-test 失败测试

在 `phase4bAiSmoke.node-test.mjs` 追加（沿用该文件既有 `node:test` + mock deps 风格）：

1. `resolveOutputFormatLabel`：`"json_schema"/"json_object"/"prompt_only"` 原样；`undefined/""/"  "` ⇒ `"prompt_only"`；`"bogus-value"` ⇒ `"invalid"` 且返回值不含 `"bogus"`（不回显）。
2. `summarizeSmokeRun`：输入三份 report（generated 带 usage、fallback 带 codes `["transport_timeout"]`、ok:false）⇒ 断言 `{ outputFormat, cases:3, generated:1, fallback:1, failed:1, fallbackCategories:{transport_timeout:1}, totalDurationMs, usage 合计, estimatedCostUsd 合计 }`。
3. `runPhase4bAiSmoke`（mock deps，三例全 generated）：log 输出中恰有一行以 `[phase4b-smoke] summary ` 开头；该行 JSON 可解析且键集合 ⊆ `{outputFormat, cases, generated, fallback, failed, fallbackCategories, totalDurationMs, usage, estimatedCostUsd}`；整行不含 mock 输入中的角色名/premise 字样。
4. 既有安全门禁不回归：无 opt-in 时仍不输出 summary 行（提前 return 1）。

### Step 6.2 实现

`phase4bAiSmoke.mjs` 追加纯函数（放在 `summarizeAuditEvents` 附近）：

```js
/** 输出格式安全标签：合法值原样、缺失/空白→prompt_only、其余→invalid（绝不回显原值）。 */
export const AI_OUTPUT_FORMAT_LABELS = Object.freeze(["json_schema", "json_object", "prompt_only"]);
export function resolveOutputFormatLabel(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") return "prompt_only";
  return AI_OUTPUT_FORMAT_LABELS.includes(trimmed) ? trimmed : "invalid";
}

/** 安全汇总（spec §4）：只聚合白名单可观测字段，通过条件不受影响。 */
export function summarizeSmokeRun(reports, outputFormatLabel) {
  const summary = {
    outputFormat: outputFormatLabel,
    cases: 0,
    generated: 0,
    fallback: 0,
    failed: 0,
    fallbackCategories: {},
    totalDurationMs: 0,
  };
  const usage = {};
  let estimatedCostUsd;
  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    summary.cases += 1;
    if (typeof report.durationMs === "number") {
      summary.totalDurationMs += Math.round(report.durationMs);
    }
    if (report.ok === true && report.source === "generated") {
      summary.generated += 1;
    } else if (report.ok === true && report.source === "fallback") {
      summary.fallback += 1;
      for (const code of Array.isArray(report.codes) ? report.codes : []) {
        if (typeof code !== "string" || code === "attempt_ok") continue;
        summary.fallbackCategories[code] = (summary.fallbackCategories[code] ?? 0) + 1;
      }
    } else {
      summary.failed += 1;
    }
    const reportUsage = report.usage;
    if (reportUsage && typeof reportUsage === "object") {
      for (const key of ["promptTokens", "completionTokens", "totalTokens"]) {
        if (typeof reportUsage[key] === "number") usage[key] = (usage[key] ?? 0) + reportUsage[key];
      }
    }
    if (typeof report.estimatedCostUsd === "number") {
      estimatedCostUsd = (estimatedCostUsd ?? 0) + report.estimatedCostUsd;
    }
  }
  if (Object.keys(usage).length > 0) summary.usage = usage;
  if (estimatedCostUsd !== undefined) summary.estimatedCostUsd = estimatedCostUsd;
  return summary;
}

export function buildRunSummaryLine(reports, outputFormatLabel) {
  return `${DIAG_PREFIX} summary ${JSON.stringify(summarizeSmokeRun(reports, outputFormatLabel))}`;
}
```

编排接线（`runPhase4bAiSmoke`）：

- 解构改为 `const { env, runEnvCheck, runCase, log, outputFormatLabel } = deps;`
- 循环里把每个 `report`（含 crash 时的 `undefined`——crash 分支 push 一个 `{ gameType, ok:false }` 占位以计入 failed）收集进 `const reports = [];`
- 循环结束、`failures` 判定之前插入：`log(buildRunSummaryLine(reports, outputFormatLabel ?? "prompt_only"));`

真实装配：

- `toAiEnvRecord` 增加 `AI_OUTPUT_FORMAT: values.get("AI_OUTPUT_FORMAT")?.decoded,`；
- `realRunCase` 的 `createServerGameEntryPoints({...})` 增加 `AI_OUTPUT_FORMAT: aiEnv.AI_OUTPUT_FORMAT,`（让 smoke 真正走配置的输出格式）；
- 新增真实 label 获取并接入 `main()`：

```js
/** 从 .env.local 读输出格式标签：文件不可读按缺省 prompt_only，绝不抛出。 */
function realOutputFormatLabel() {
  try {
    const values = readAiEnv(resolve(projectRoot, ".env.local"));
    return resolveOutputFormatLabel(values.get("AI_OUTPUT_FORMAT")?.decoded);
  } catch {
    return "prompt_only";
  }
}
```

`main()` 的 deps 加 `outputFormatLabel: realOutputFormatLabel(),`。

### Step 6.3 验证

```
npm run test:phase4b-ai-smoke-script   # node --test 门禁（含新用例）全绿
npm test                               # vitest 不受影响
```

提交。

---

## Task 7：文档事实回写 + 全量离线验收

### Step 7.1 文档修改（全部在 worktree 内）

1. **`docs/agent/AI环境.md`**：
   - 运行时键表加第四个非敏感键 `AI_OUTPUT_FORMAT`（三值、缺省 prompt_only、大小写敏感、无效 ⇒ `AI_CONFIG_OUTPUT_FORMAT_INVALID` ⇒ unavailable → fallback；不进 audit/玩家 API/存档）；
   - 诊断码清单加 `AI_CONFIG_OUTPUT_FORMAT_INVALID`；
   - smoke 段落补：汇总行 `[phase4b-smoke] summary {...}` 的白名单字段与"标签绝不回显原值"约束；
   - **修正既有时间差事实**（现约 L64"尚未执行"）：Phase 4B 真实 smoke 已于本机以 RPG `.env.local` 执行过，三例均满足 `generated | fallback` 契约（不记录 URL/模型原文/密钥）。
2. **`docs/agent/当前开发阶段.md`**：改写为 Phase 4C——目标、7 任务清单、验收命令、指向本计划与 4C spec。
3. **`docs/agent/current-phase.json`**：`phase: "mvp-phase-4c-structured-output-offline-regression"`、`status/implementationStatus` 按完成态、`targetBranch: "codex/phase4c-planning"`、`worktreeName: "phase4c-planning"`、`repositories: ["ai-rpg-game"]`（单仓、`sharedInfrastructureChangeAllowed: false`）、`plan` 指向本文件、`entryDocs` 补 4C spec 与本计划、`acceptanceCommands` 沿用 4B 六条、删除 `familyAcceptance`（本阶段无共享改动）。
4. **`docs/agent/MVP核心闭环.md`**：开局生成段补一句"live source 可按 `AI_OUTPUT_FORMAT` 附带 response_format；候选校验/修复/fallback 契约不变"。
5. **`docs/Agent文档索引.md`**：登记 4C spec 与本计划。
6. **`.env.example`**：AI 三键之后加：

```
# Optional structured-output mode for scenario generation (Phase 4C).
# One of: json_schema | json_object | prompt_only (default when unset).
# Only set a value your provider explicitly supports; invalid values make the
# AI source unavailable (players still get the deterministic fallback opening).
# AI_OUTPUT_FORMAT=prompt_only
```

### Step 7.2 全量验收（全部离线）

```
npm run lint
npm run typecheck
npm test
npm run test:fast
npm run build
npm run test:phase4b-ai-smoke-script
npm run phase:status
```

全绿后提交。真实 smoke（计费）不在本计划的强制验收内：如操作者要求，单独授权后以 `RUN_REAL_AI_SMOKE=1 npm run smoke:ai:phase4b` 执行并只保留汇总行。

---

## 验收清单（对照 spec §测试与验收）

- [ ] `parseAiRuntimeConfig`：三合法值、缺省、无效值测试全离线（Task 1）
- [ ] response_format builder 三模式 + strict schema 结构守卫（Task 2）
- [ ] live source/factory mock transport 断言每种格式请求 body、脱敏与失败映射（Task 3）
- [ ] Phase 4C fixture 契约 + 12 条 manifest 全遍历回归，零 fetch、零 .env.local（Task 4）
- [ ] 三类型完整旅程 + 失败结局离线回归（Task 5）
- [ ] smoke 汇总纯函数 + 门禁扩展；无 opt-in 零请求不回归（Task 6）
- [ ] 文档事实（含 Phase 4B smoke 已执行）与 `.env.example` 更新；七条验收命令全绿（Task 7）
