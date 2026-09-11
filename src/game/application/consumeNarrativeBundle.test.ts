import { expect, it } from "vitest";
import { consumeNarrativeBundle } from "./consumeNarrativeBundle";
import { createDecisionWorldFixture, createDecisionStoryFixture } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { asNarrativeJobId, type CommittedNarrativeEvent } from "@/game/domain/events";
import { parseNarrativeBundleState, type BundleScenePremises, type NarrativeBundleState } from "@/game/domain/narrativeBundle";
import { PLAYER_ENTITY_ID, asFactId } from "@/game/domain/worldEntity";

const required = { observationKey: "heard", audienceId: String(PLAYER_ENTITY_ID), factId: "fact_routes", certainty: "known" as const };
function consume(premises: BundleScenePremises, receipt?: { sequence: number; certainty: "known" | "suspected" }, withTask = false) {
  const base = createDecisionWorldFixture();
  const world = receipt === undefined ? base : { ...base, eventLedger: [...base.eventLedger, {
    ...base.eventLedger.at(-1)!, kind: "narrative_observed", sequence: receipt.sequence,
    payload: { type: "narrative_observed", ...required, factId: asFactId(required.factId), certainty: receipt.certainty, source: { kind: "witness" } },
  } as CommittedNarrativeEvent] };
  const bundle: NarrativeBundleState = { contractVersion: 2, endingLabels: null, originJobId: asNarrativeJobId("bundle_test"),
    activeStepIds: ["arrival"], terminal: { kind: "next_decision", target: { kind: "continuation_step", stepId: "arrival" } },
    steps: [{ stepId: "arrival", objectiveKey: "quest:0", consumptionGroupKey: "arrival",
      trigger: { kind: "move", locationId: world.currentLocationId }, nextStepIds: [], observations: [], expressionOrder: [], premises,
      scene: { segments: [{ beatId: "atmosphere", text: "风吹过门前。" }], event: { kind: "travel", locationId: world.currentLocationId },
        npcLine: null, objectiveLink: null, choiceSeeds: withTask ? ["ask", "challenge"].map(act => ({
          label: act === "ask" ? "谁说的？" : "我不相信。", action: { type: "talk" as const, npcId: world.npcs[0]!.id, dialogueAct: act as "ask" | "challenge" },
          task: { intent: act as "ask" | "challenge", focusFactIds: ["fact_routes"], prerequisiteFactIds: [], inquiries: [{ factId: "fact_routes", aspects: ["source" as const] }] },
        })) : [], source: "generated" } }],
  };
  expect(parseNarrativeBundleState(bundle).ok).toBe(true);
  const baseStory = createDecisionStoryFixture();
  if (baseStory.narrative.status !== "ready") throw Error("fixture not ready");
  const story = { ...baseStory, narrative: { ...baseStory.narrative, narrativeBundle: bundle } };
  const result = consumeNarrativeBundle({ beforeStoryState: story, resolvedStoryState: story, resolvedWorldState: world,
    action: { type: "move", locationId: world.currentLocationId }, actionId: "move_test", postCommitRevision: 2,
    resolvedEvent: { actionId: "move_test", status: "success", eventKind: "travel", facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [] },
    domainEvents: [base.eventLedger.at(-1)!],
  });
  return { result, world, bundle };
}

it("消费拒绝缺失、旧包同名及 certainty 不足的观察回执", () => {
  const premises = { locationId: String(createDecisionWorldFixture().currentLocationId), afterSequence: 3, observations: [required] };
  for (const receipt of [undefined, { sequence: 3, certainty: "known" as const }, { sequence: 4, certainty: "suspected" as const }]) {
    const { result, world } = consume(premises, receipt);
    expect(result).toEqual({ ok: false, code: "NARRATIVE_CONTINUATION_INVALID" });
    expect(world.eventLedger.some(event => event.kind === "narrative_scene_presented")).toBe(false);
  }
});

it("消费拒绝与条件快照不同的实际地点", () => {
  expect(consume({ locationId: "elsewhere", afterSequence: 0, observations: [] }).result)
    .toEqual({ ok: false, code: "NARRATIVE_CONTINUATION_INVALID" });
});

it("合法无条件片段仍能消费并提交场景事件", () => {
  expect(consume({ locationId: String(createDecisionWorldFixture().currentLocationId), afterSequence: 0, observations: [] }).result.ok).toBe(true);
});

it("未来快照依赖的规则发现必须在消费时实际成立，否则零写入", () => {
  const premises = { locationId: String(createDecisionWorldFixture().currentLocationId), afterSequence: 0,
    observations: [], discoveredFactIds: ["fact_routes"] };
  expect(consume(premises).result.ok).toBe(true);
  const missing = consume({ ...premises, discoveredFactIds: ["fact_not_discovered"] });
  expect(missing.result).toEqual({ ok: false, code: "NARRATIVE_CONTINUATION_INVALID" });
  expect(missing.world.eventLedger.some(event => event.kind === "narrative_scene_presented")).toBe(false);
});

it.each([null, "fact_routes", [""], ["fact_routes", "fact_routes"], [1]])("存档拒绝非法规则事实前提：%j", discoveredFactIds => {
  const { bundle } = consume({ locationId: String(createDecisionWorldFixture().currentLocationId), afterSequence: 0, observations: [] });
  const invalid = { ...bundle, steps: bundle.steps.map(step => ({ ...step, premises: { ...step.premises, discoveredFactIds } })) };
  expect(parseNarrativeBundleState(invalid).ok).toBe(false);
});


it("后续场景种子的问询任务在消费重铸 token 后保留", () => {
  const { result } = consume({ locationId: String(createDecisionWorldFixture().currentLocationId), afterSequence: 0, observations: [] }, undefined, true);
  expect(result.ok).toBe(true);
  if (!result.ok || result.nextStoryState.narrative.status !== "ready") throw Error("ready");
  expect(result.nextStoryState.narrative.choiceRegistry[0]?.task?.inquiries).toEqual([{ factId: "fact_routes", aspects: ["source"] }]);
});
