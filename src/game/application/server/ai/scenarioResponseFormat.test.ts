import { describe, expect, it } from "vitest";
import { createBudgetPolicy } from "@/game/domain";
import {
  buildScenarioCandidateJsonSchema,
  buildScenarioResponseFormatExtraBody
} from "./scenarioResponseFormat";

// ---------------------------------------------------------------------------
// Task 8：schema 工厂化。
// buildScenarioCandidateJsonSchema(policy) 按 BudgetPolicy 构建 strict schema；
// buildScenarioResponseFormatExtraBody(format, policy) 透传 policy 到 schema。
// ---------------------------------------------------------------------------

type SchemaNodeView = {
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, SchemaNodeView>;
  items: SchemaNodeView;
  enum: unknown[];
  anyOf: unknown[];
  const: unknown;
  type: string;
  minimum: number;
  maximum: number;
  minItems: number;
  maxItems: number;
};

describe("buildScenarioCandidateJsonSchema：policy 驱动", () => {
  it("long 档位 quest main stage 为 integer [1, 8]", () => {
    const schema = buildScenarioCandidateJsonSchema(createBudgetPolicy("long")) as SchemaNodeView;
    const questAnyOf = schema.properties.quests.items.anyOf;
    const mainVariant = questAnyOf.find(
      (branch) => (branch as SchemaNodeView).properties?.kind?.const === "main"
    ) as SchemaNodeView;
    expect(mainVariant.properties.stage).toEqual({ type: "integer", minimum: 1, maximum: 8 });
  });

  it("short 档位 quest main stage 为 integer [1, 3]", () => {
    const schema = buildScenarioCandidateJsonSchema(createBudgetPolicy("short")) as SchemaNodeView;
    const questAnyOf = schema.properties.quests.items.anyOf;
    const mainVariant = questAnyOf.find(
      (branch) => (branch as SchemaNodeView).properties?.kind?.const === "main"
    ) as SchemaNodeView;
    expect(mainVariant.properties.stage).toEqual({ type: "integer", minimum: 1, maximum: 3 });
  });

  it("budgetPolicy 子 schema 叶子用 enum 精确锁定（long 档）", () => {
    const schema = buildScenarioCandidateJsonSchema(createBudgetPolicy("long")) as SchemaNodeView;
    const bp = schema.properties.budgetPolicy;
    expect(bp.properties.mainActs).toEqual({ enum: [8] });
    expect(bp.properties.expansion.properties.locationsSoftMax).toEqual({ enum: [22] });
    expect(bp.properties.safety.properties.locationsHardMax).toEqual({ enum: [40] });
  });

  it("open 档位 null 叶子用 enum: [null] 表达", () => {
    const schema = buildScenarioCandidateJsonSchema(createBudgetPolicy("open")) as SchemaNodeView;
    const bp = schema.properties.budgetPolicy;
    expect(bp.properties.expansion.properties.locationsSoftMax).toEqual({ enum: [null] });
    expect(bp.properties.expansion.properties.npcsSoftMax).toEqual({ enum: [null] });
  });

  it("required 列表含 budgetPolicy 而非 contentBudget", () => {
    const schema = buildScenarioCandidateJsonSchema(createBudgetPolicy("medium")) as SchemaNodeView;
    expect(schema.required).toContain("budgetPolicy");
    expect(schema.required).not.toContain("contentBudget");
  });

  it("locations 数组带 minItems/maxItems（opening 3..6）", () => {
    const schema = buildScenarioCandidateJsonSchema(createBudgetPolicy("short")) as SchemaNodeView;
    const locations = schema.properties.locations;
    expect(locations.minItems).toBe(3);
    expect(locations.maxItems).toBe(6);
  });

  it("同 policy 两次构建 JSON round-trip 相等", () => {
    const policy = createBudgetPolicy("medium");
    const a = buildScenarioCandidateJsonSchema(policy);
    const b = buildScenarioCandidateJsonSchema(policy);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("所有 object 节点 additionalProperties:false 且 required 全覆盖", () => {
    const schema = buildScenarioCandidateJsonSchema(createBudgetPolicy("long"));
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
    walk(schema, "$");
    expect(violations).toEqual([]);
  });
});

describe("buildScenarioResponseFormatExtraBody：policy 参数", () => {
  const policy = createBudgetPolicy("medium");

  it("prompt_only ⇒ undefined", () => {
    expect(buildScenarioResponseFormatExtraBody("prompt_only", policy)).toBeUndefined();
  });

  it("json_object ⇒ 通用 JSON object（不含 schema）", () => {
    expect(buildScenarioResponseFormatExtraBody("json_object", policy)).toEqual({
      response_format: { type: "json_object" }
    });
  });

  it("json_schema ⇒ strict + 对应 policy 的 schema", () => {
    const body = buildScenarioResponseFormatExtraBody("json_schema", policy) as Record<string, any>;
    const jsonSchema = body.response_format.json_schema;
    expect(jsonSchema.name).toBe("scenario_blueprint_candidate");
    expect(jsonSchema.strict).toBe(true);
    expect(jsonSchema.schema).toEqual(buildScenarioCandidateJsonSchema(policy));
  });
});
