import { describe, expect, it } from "vitest";
import { asQuestId } from "./worldEntity";
import {
  MAX_MANDATORY_BEATS,
  type MandatoryNarrativeBeat,
  type ObjectiveRef,
  type ObjectiveTransition,
} from "./narrativeBeat";

describe("narrativeBeat（Task 4 领域接口）", () => {
  it("强制叙事节拍上限为 8", () => {
    expect(MAX_MANDATORY_BEATS).toBe(8);
  });

  it("ObjectiveRef 保存 questId / objectiveIndex / label", () => {
    const ref: ObjectiveRef = { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" };
    expect(ref).toEqual({ questId: "quest_0", objectiveIndex: 0, label: "与老板交谈" });
  });

  it("ObjectiveTransition 四种模式均为封闭值", () => {
    const modes = ["unchanged", "progressed", "advanced_act", "ready_for_ending"] as const;
    for (const mode of modes) {
      const transition: ObjectiveTransition = { before: null, completed: [], after: null, mode };
      expect(transition.mode).toBe(mode);
    }
  });

  it("MandatoryNarrativeBeat 只允许计划定义的九种 kind", () => {
    const kinds = [
      "player_utterance", "item_obtained", "fact_discovered", "quest_progress",
      "quest_advanced", "battle_started", "battle_round", "battle_resolved", "entity_introduced",
    ] as const;
    for (const kind of kinds) {
      const beat: MandatoryNarrativeBeat = { beatId: `beat_${kind}`, kind, subjectIds: [], instruction: "i" };
      expect(beat.kind).toBe(kind);
    }
  });

  it("形状 JSON round-trip 不丢失", () => {
    const transition: ObjectiveTransition = {
      before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" },
      completed: [{ questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" }],
      after: null,
      mode: "advanced_act",
    };
    expect(JSON.parse(JSON.stringify(transition))).toEqual(transition);
  });
});
