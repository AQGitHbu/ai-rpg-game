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

// 类型收窄：导出类型为 Record<string, unknown>，测试内以结构化视图访问断言字段。
type SchemaNodeView = {
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, SchemaNodeView>;
  items: SchemaNodeView;
  enum: unknown[];
  anyOf: unknown[];
};

describe("SCENARIO_CANDIDATE_JSON_SCHEMA：strict 结构守卫", () => {
  const schema = SCENARIO_CANDIDATE_JSON_SCHEMA as SchemaNodeView;

  it("根节点覆盖候选全部 16 个字段且拒绝未知字段", () => {
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(
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
    const properties = schema.properties;
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
