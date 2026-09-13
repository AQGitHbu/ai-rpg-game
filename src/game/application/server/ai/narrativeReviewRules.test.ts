import { describe, expect, it } from "vitest";
import { parseRuleEvidence, resolveCandidatePath } from "./narrativeReviewRules";

const catalog = [
  { key: "item:item_1", kind: "item", impacts: ["item_state"], value: { id: "item_1", owner: "player" } },
  { key: "step:move:loc_2", kind: "step", impacts: ["step_order"], value: { stepKey: "move:loc_2" } },
  { key: "fact:fact_4", kind: "fact", impacts: ["fact_claim", "disclosure"], value: { id: "fact_4", referenceOnly: true } },
  { key: "action:c1", kind: "action", impacts: ["action_binding"], value: { candidateId: "c1" } },
] as const;
describe("rule-grounded review evidence", () => {
  it("requires an existing formal item, not decorative inventory guesses", () => {
    expect(parseRuleEvidence({ basisKey: "item:hat", impact: "item_state", detail: "斗笠不在背包中" }, catalog)).toBeNull();
    expect(parseRuleEvidence({ basisKey: "step:move:loc_2", impact: "item_state", detail: "斗笠不在背包中" }, catalog)).toBeNull();
  });
  it.each([
    ["step:move:loc_2", "step_order", "当前场景提前执行续接移动"],
    ["fact:fact_4", "disclosure", "未告知的保护事实被对玩家说出"],
    ["action:c1", "action_binding", "支持选项写成物品交付"],
    ["item:item_1", "item_state", "正文声称物品已经交付"],
  ])("retains grounded hard defects: %s", (basisKey, impact, detail) => {
    expect(parseRuleEvidence({ basisKey, impact, detail }, catalog)).toEqual({ basisKey, impact, detail });
  });
  it("rejects empty effects and nonexistent candidate paths", () => {
    expect(parseRuleEvidence({ basisKey: "fact:fact_4", impact: "disclosure", detail: "" }, catalog)).toBeNull();
    expect(resolveCandidatePath({ currentScene: { choices: [{ label: "给予" }] } }, "$.currentScene.choices[0].label")).toBe(true);
    expect(resolveCandidatePath({ currentScene: {} }, "currentScene.fake")).toBe(false);
    expect(resolveCandidatePath({}, "__proto__.constructor")).toBe(false);
  });
});
