import { describe, expect, it } from "vitest";
import { approvePreparedContinuation } from "./approvePreparedContinuation";
import { asNarrativeJobId } from "@/game/domain/events";
import { asFactId, asLocationId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
import type { PreparedStepDescriptor } from "@/game/gameplay/rpg/preparedContinuation";

function descriptor(): Parameters<typeof approvePreparedContinuation>[0]["descriptors"][number] {
  const locationId = asLocationId("loc_temple");
  const npcId = asNpcId("npc_beggar");
  return {
    stepId: "prepared_1",
    objectiveKey: "quest_2:0",
    consumptionGroupKey: "quest_2:0:move",
    trigger: { kind: "move", locationId },
    authority: {
      questId: asQuestId("quest_2"),
      objectiveIndex: 0,
      allowedEntityIds: [String(locationId), String(npcId)],
      visibleFactIds: [],
    },
    arrivalNpc: {
      id: npcId,
      name: "老乞丐",
      role: "破庙守夜人",
      publicProfile: "常年借宿镇外破庙",
      knownFactCards: [],
      sceneVisibleFactIds: [],
      goals: ["确认来者是否可信"],
      speechAuthority: {
        speakerNpcId: npcId,
        responseTier: "neutral",
        allowedFactIds: [],
        withheldFactIds: [],
        allowedFactCards: [],
        allowedEventIds: [],
        recentInteractions: [],
        identityAnchors: {
          selfConcept: "破庙守夜人",
          values: [],
          speechStyle: "克制",
          capabilityBoundaries: [],
          taboos: [],
        },
        activeGoals: [],
        relationships: [],
        evidenceKeys: [],
      },
    },
    choiceCandidates: [
      { candidateId: "prepared_1_choice_1", action: { type: "talk", npcId, dialogueAct: "support" } },
      { candidateId: "prepared_1_choice_2", action: { type: "talk", npcId, dialogueAct: "challenge" } },
    ],
    nextStepIds: [],
  };
}

function descriptorWithoutSpeechAuthority(): PreparedStepDescriptor {
  const base = descriptor();
  const arrivalNpc = base.arrivalNpc;
  if (arrivalNpc === undefined) throw new Error("fixture requires an arrival NPC");
  const { speechAuthority, ...legacyArrivalNpc } = arrivalNpc;
  void speechAuthority;
  return { ...base, arrivalNpc: legacyArrivalNpc };
}

function proposal(step: PreparedStepDescriptor["stepId"] = "prepared_1") {
  return {
    stepId: step,
    segments: [{ beatId: "atmosphere", text: "你沿山路抵达破庙。" }],
    npcLine: {
      npcId: "npc_beggar",
      text: "后生，脚步放轻些。这里昨夜来过不该来的人。",
      emotion: "guarded" as const,
      answeredBeatIds: [],
      usedFactIds: [],
      usedEventIds: [],
    },
    objectiveLink: { questId: "quest_2", objectiveIndex: 0, mode: "hint" as const },
    choices: [
      { candidateId: "prepared_1_choice_1", label: "老丈，昨夜来的是谁？" },
      { candidateId: "prepared_1_choice_2", label: "你若隐瞒，我只能自己搜。" },
    ],
    source: "generated" as const,
  };
}

describe("approvePreparedContinuation", () => {
  it("rebuilds a complete move seed from server descriptors without minting tokens", () => {
    const result = approvePreparedContinuation({
      originJobId: asNarrativeJobId("job_dialogue_2"),
      proposals: [proposal()],
      descriptors: [descriptor()],
      activeStepIds: ["prepared_1"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.steps[0]?.scene.choiceSeeds).toHaveLength(2);
    expect("choiceToken" in (result.prepared.steps[0]?.scene.choiceSeeds[0] ?? {})).toBe(false);
    expect(result.prepared.steps[0]?.scene.event).toEqual({ kind: "travel", locationId: asLocationId("loc_temple") });
  });

  it("fails closed when the prepared speaker has no real speech authority", () => {
    const result = approvePreparedContinuation({
      originJobId: asNarrativeJobId("job_dialogue_2"),
      proposals: [proposal()],
      descriptors: [descriptorWithoutSpeechAuthority()],
      activeStepIds: ["prepared_1"],
    });

    expect(result).toEqual({ ok: false, code: "invalid_entity_reference" });
  });

  it("does not treat descriptor visible facts as speech authority", () => {
    const baseDescriptor = descriptorWithoutSpeechAuthority();
    const descriptorWithVisibleFact = {
      ...baseDescriptor,
      authority: { ...baseDescriptor.authority, visibleFactIds: [asFactId("fact_secret")] },
    };
    const invalid = {
      ...proposal(),
      npcLine: { ...proposal().npcLine!, usedFactIds: ["fact_secret"] },
    };

    expect(approvePreparedContinuation({
      originJobId: asNarrativeJobId("job_dialogue_2"),
      proposals: [invalid],
      descriptors: [descriptorWithVisibleFact],
      activeStepIds: ["prepared_1"],
    })).toEqual({ ok: false, code: "invalid_entity_reference" });
  });

  it("rejects wrong speakers and other-NPC interaction references atomically", () => {
    const wrongSpeaker = {
      ...proposal(),
      npcLine: { ...proposal().npcLine!, npcId: "npc_other" },
    };
    const otherNpcInteraction = {
      ...proposal(),
      npcLine: { ...proposal().npcLine!, usedEventIds: ["npc_other:trade"] },
    };

    expect(approvePreparedContinuation({
      originJobId: asNarrativeJobId("job_dialogue_2"),
      proposals: [wrongSpeaker],
      descriptors: [descriptor()],
      activeStepIds: ["prepared_1"],
    })).toEqual({ ok: false, code: "invalid_entity_reference" });
    expect(approvePreparedContinuation({
      originJobId: asNarrativeJobId("job_dialogue_2"),
      proposals: [otherNpcInteraction],
      descriptors: [descriptor()],
      activeStepIds: ["prepared_1"],
    })).toEqual({ ok: false, code: "invalid_event_reference" });
  });

  it("rejects a provider candidate that is not present in the server descriptor", () => {
    const invalid = { ...proposal(), choices: [{ candidateId: "invented", label: "越权" }, proposal().choices[1]!] };
    expect(approvePreparedContinuation({
      originJobId: asNarrativeJobId("job_dialogue_2"),
      proposals: [invalid],
      descriptors: [descriptor()],
      activeStepIds: ["prepared_1"],
    })).toEqual({ ok: false, code: "invalid_choice_candidate" });
  });

  it("rejects a prepared NPC line with an unauthorized fact reference atomically", () => {
    const invalid = {
      ...proposal(),
      npcLine: { ...proposal().npcLine!, usedFactIds: ["fact_secret"] },
    };
    const result = approvePreparedContinuation({
      originJobId: asNarrativeJobId("job_dialogue_2"),
      proposals: [invalid],
      descriptors: [descriptor()],
      activeStepIds: ["prepared_1"],
    });
    expect(result).toEqual({ ok: false, code: "invalid_fact_reference" });
  });

  it("reports duplicate speech references with their own rejection code", () => {
    const duplicatedFacts = {
      ...proposal(),
      npcLine: { ...proposal().npcLine!, usedFactIds: ["fact_secret", "fact_secret"] },
    };
    expect(approvePreparedContinuation({
      originJobId: asNarrativeJobId("job_dialogue_2"),
      proposals: [duplicatedFacts],
      descriptors: [descriptor()],
      activeStepIds: ["prepared_1"],
    })).toEqual({ ok: false, code: "duplicate_npc_reference" });

    const duplicatedInteractions = {
      ...proposal(),
      npcLine: { ...proposal().npcLine!, usedEventIds: ["npc_beggar:trade", "npc_beggar:trade"] },
    };
    expect(approvePreparedContinuation({
      originJobId: asNarrativeJobId("job_dialogue_2"),
      proposals: [duplicatedInteractions],
      descriptors: [descriptor()],
      activeStepIds: ["prepared_1"],
    })).toEqual({ ok: false, code: "duplicate_npc_reference" });
  });

  it("rejects missing or unknown graph nodes atomically", () => {
    expect(approvePreparedContinuation({
      originJobId: asNarrativeJobId("job_dialogue_2"),
      proposals: [],
      descriptors: [descriptor()],
      activeStepIds: ["prepared_1"],
    })).toEqual({ ok: false, code: "missing_step" });
    expect(approvePreparedContinuation({
      originJobId: asNarrativeJobId("job_dialogue_2"),
      proposals: [{ ...proposal(), stepId: "invented" }],
      descriptors: [descriptor()],
      activeStepIds: ["prepared_1"],
    })).toEqual({ ok: false, code: "unknown_step" });
  });
});
