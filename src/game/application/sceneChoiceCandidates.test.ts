import { describe, expect, it } from "vitest";
import { asLocationId, asNpcId } from "@/game/domain/worldEntity";
import { asFactId } from "@/game/domain/worldEntity";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import { buildPreparedSceneCandidates, buildSelectableSceneCandidates } from "./sceneChoiceCandidates";

describe("scene choice candidates prepared projection boundary", () => {
  it("preserves gameplay-owned prepared candidate IDs and actions", () => {
    const npcId = asNpcId("npc_beggar");
    const candidates = buildPreparedSceneCandidates({
      choiceCandidates: [
        {
          candidateId: "prepared_1_choice_1",
          action: { type: "talk", npcId, dialogueAct: "support" },
        },
        {
          candidateId: "prepared_1_choice_2",
          action: { type: "talk", npcId, dialogueAct: "challenge" },
        },
      ],
    });

    expect(candidates).toEqual([
      {
        candidateId: "prepared_1_choice_1",
        label: "表示支持，继续听对方说明",
        action: { type: "talk", npcId, dialogueAct: "support" },
      },
      {
        candidateId: "prepared_1_choice_2",
        label: "提出质疑，要求对方拿出依据",
        action: { type: "talk", npcId, dialogueAct: "challenge" },
      },
    ]);
  });

  it("does not derive IDs from entity names or labels", () => {
    const candidates = buildPreparedSceneCandidates({
      choiceCandidates: [{
        candidateId: "prepared_7_choice_1",
        action: { type: "move", locationId: asLocationId("loc_temple") },
      }],
    });
    expect(candidates[0]?.candidateId).toBe("prepared_7_choice_1");
    expect(candidates[0]?.label).toBe("（继续行动）");
  });

  it("projects a server-approved investigation method as the same concrete Action", () => {
    const candidates = buildSelectableSceneCandidates({
      objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
      currentLocation: { id: asLocationId("loc_archive"), name: "档案室", description: "d", kind: "main" },
      presentNpcs: [],
      focusNpcContext: undefined,
      objectiveTarget: null,
      job: { actionSummary: { kind: "move", locationId: asLocationId("loc_archive") }, resolvedEvent: { eventKind: "travel" } },
      legalActionCandidates: [{ kind: "investigate" as never, label: "保持原样查验", targetId: "fact_sealed", approachId: "quiet" }],
    } as unknown as SceneGenerationContext);

    expect(candidates).toEqual([expect.objectContaining({
      label: "（保持原样查验）",
      action: { type: "investigate", factId: asFactId("fact_sealed"), approachId: "quiet" },
    })]);
  });
});
