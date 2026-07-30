import type { AiOutputFormat } from "./aiRuntimeConfig";

type Schema = Record<string, unknown>;
const string: Schema = { type: "string" };
const bool: Schema = { type: "boolean" };
const stringArray: Schema = { type: "array", items: string };
const strict = (properties: Record<string, Schema>): Schema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const choice = strict({ actionKey: string, label: string, strategy: string });
const instruction = strict({ npcId: string, speechAct: { enum: ["inform", "ask", "evade", "deny", "warn", "encourage"] }, emotion: { enum: ["neutral", "warm", "guarded", "afraid", "angry", "sad"] }, allowedFactIds: stringArray, mayLie: bool });

export const RUNTIME_NARRATIVE_SCHEMAS: Readonly<Record<"director" | "writer" | "npc", Schema>> = {
  director: strict({ sceneGoal: string, tensionLevel: { type: "integer", minimum: 1, maximum: 5 }, focusNpcId: { type: ["string", "null"] }, relevantFactIds: stringArray, allowedRevealFactIds: stringArray, suggestedActionKeys: { type: "array", minItems: 2, maxItems: 2, items: string }, introducedEntities: { type: "array", items: strict({ kind: { enum: ["npc", "location", "item", "enemy", "fact"] }, id: string }) }, pacing: { enum: ["setup", "develop", "turn", "climax", "resolution"] } }),
  writer: strict({ narration: string, usedFactIds: stringArray, npcInstruction: { anyOf: [instruction, { type: "null" }] }, choices: { type: "array", minItems: 2, maxItems: 2, items: choice } }),
  npc: strict({ text: string, usedFactIds: stringArray, emotion: { enum: ["neutral", "warm", "guarded", "afraid", "angry", "sad"] } }),
};

export function runtimeNarrativeResponseFormat(format: AiOutputFormat, role: keyof typeof RUNTIME_NARRATIVE_SCHEMAS): Readonly<Record<string, unknown>> | undefined {
  if (format === "prompt_only") return undefined;
  if (format === "json_object") return { response_format: { type: "json_object" } };
  return { response_format: { type: "json_schema", json_schema: { name: `runtime_${role}_v1`, strict: true, schema: RUNTIME_NARRATIVE_SCHEMAS[role] } } };
}
