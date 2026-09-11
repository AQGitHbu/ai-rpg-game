import { expect, it } from "vitest";
import { createPendingDecisionRecord } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { asNpcId } from "@/game/domain/worldEntity";
import { previousDialogue } from "./dialogueContext";
import { buildPlanningPrompt } from "../server/ai/staged/planningPrompt";

it("规划器收到上一轮实际回答和两个选项，换 NPC 时不继承对话", () => {
  const record = createPendingDecisionRecord();
  const pending = record.storyState.narrative;
  if (pending.status !== "provider_pending") throw Error("pending");
  const scene = { sceneId: "previous", turn: 0, narration: "柳三娘看着你。", usedFactIds: [], source: "generated" as const,
    npcLine: { npcId: pending.job.focusNpcId!, text: "我只知道镇口有告示。", emotion: "neutral" as const, usedFactIds: [], usedEventIds: [] },
    choices: [{ choiceToken: "opaque-a", label: "谁贴的，何时贴的？" }, { choiceToken: "opaque-b", label: "凭什么认定凶手？" }],
    npcDialogues: [{ npcId: asNpcId("other"), npcName: "他人", npcRole: "路人", speechPages: ["OTHER_NPC_HISTORY"], usedFactIds: [], usedEventIds: [] }],
  };
  const input = { kind: "decision" as const, world: record.worldState,
    story: { ...record.storyState, narrative: { ...pending, lastPresentedScene: scene } }, job: pending.job };
  const prompt = buildPlanningPrompt(input);
  expect(prompt).toContain(scene.npcLine.text);
  expect(prompt).toContain(scene.choices[0]!.label);
  expect(prompt).toContain(scene.choices[1]!.label);
  expect(prompt).not.toContain("opaque-a");
  expect(prompt).not.toContain("OTHER_NPC_HISTORY");
  expect(prompt).toContain("这里的候选就是最终意图");
  expect(previousDialogue({ ...input, job: { ...pending.job, focusNpcId: asNpcId("other") } })).toBeNull();
});
