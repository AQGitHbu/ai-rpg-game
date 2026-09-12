import { expect, it } from "vitest";
import { approvePlan, sceneSnapshot } from "@/game/gameplay/rpg/narrativePlanning";
import { branchWorld, branchStory, LOC_A, LOC_B, LOC_C } from "@/game/gameplay/rpg/narrativePlanning/branchFixture.testutil";
import { asFactId, asNpcId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { makeStagedPlan, makeCharacterOutput, makeNarrationOutput } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import type { UnitOutput } from "@/game/domain/narrativeUnit";
import { projectUnitContext } from "./perspectiveContext";
import { approveUnit } from "./approveUnit";

function setup(audienceIds: readonly string[] = [PLAYER_ENTITY_ID, "npc_0", "npc_1"]) {
  const base = branchWorld();
  const npc = base.npcs[0]!;
  const world = branchWorld({ worldFacts: [{ factId: asFactId("fact_rumor"), text: "废窑可能有人停留。", source: "generated", discovered: false }],
    npcs: [ { ...npc, memory: { ...npc.memory, knownFactIds: [asFactId("fact_rumor")] } },
      { ...npc, id: asNpcId("npc_1"), name: "小陈", memory: { ...npc.memory, npcId: asNpcId("npc_1") } } ],
  });
  const proposal = makeStagedPlan(true);
  const result = approvePlan({ kind: "decision", world, story: branchStory(), proposal: { ...proposal,
    observations: [{ key: "heard", point: { stepKey: "current", order: 2 }, audienceIds,
      fact: { factId: "fact_rumor", certainty: "known" }, source: { kind: "speech", speakerId: "npc_0" } }],
    units: proposal.units.map(unit => unit.key === "character_npc_0" ? { ...unit, requiredObservationKeys: ["heard"] } : unit),
  } });
  if (!result.ok) throw new Error(result.code);
  const output = { ...makeCharacterOutput("npc_0"), parts: [{ text: "废窑可能有人停留。", facts: [{ factId: "fact_rumor", certainty: "suspected" as const }],
    evidence: [{ kind: "conditional" as const, observationKey: "heard" }], beatIds: [] }] };
  const approved = new Map<string, UnitOutput>([["narration_current", makeNarrationOutput()], ["character_npc_0", output]]);
  return { plan: result.value, approved, world };
}

it("下游只获得已批准上游披露，保留 suspected，不制造 EventId 或提前提交 NPC 知识", () => {
  const { plan, approved, world } = setup();
  const before = JSON.stringify(world);
  const unit = plan.units.find(unit => unit.key === "character_npc_1")!;
  const missing = sceneSnapshot({ plan, point: unit.point, approved: new Map() });
  expect(missing.ok && missing.value.learned).toEqual([]);
  const context = projectUnitContext({ plan, unit, approved });
  if (!context.ok) throw new Error(context.code);
  expect(context.value.visibleFacts).toContainEqual({ id: "fact_rumor", text: "废窑可能有人停留。", certainty: "suspected",
    sources: [{ kind: "conditional", observationKey: "heard" }] });
  const answer = { ...makeCharacterOutput("npc_1"), parts: [{ text: "那里可能有人，我不能肯定。", facts: [{ factId: "fact_rumor", certainty: "suspected" as const }],
    evidence: [{ kind: "conditional" as const, observationKey: "heard" }], beatIds: [] }] };
  expect(approveUnit({ unit, context: context.value, output: answer }).ok).toBe(true);
  expect(approveUnit({ unit, context: context.value, output: { ...answer, parts: answer.parts.map(part => ({ ...part, facts: [{ factId: "fact_rumor", certainty: "known" }] })) } }).ok).toBe(false);
  expect(JSON.stringify(world)).toBe(before);
  expect(world.eventLedger).toHaveLength(0);
  expect(world.npcs.find(npc => npc.id === "npc_1")!.memory.knownFactIds).toEqual([]);
});

it("未列为受众的 NPC 即使在 DAG 中依赖对白，也不能获得该条件认知", () => {
  const { plan, approved } = setup([PLAYER_ENTITY_ID, "npc_0"]);
  const unit = plan.units.find(unit => unit.key === "character_npc_1")!;
  const result = projectUnitContext({ plan, unit, approved });
  if (!result.ok) throw new Error(result.code);
  expect(result.value.visibleFacts).toEqual([]);
  expect(JSON.stringify(result.value)).not.toContain("废窑可能有人停留");
});

it("未来快照只预览本路径位置，不读取兄弟分支观察，原世界仍在起点", () => {
  const { plan, approved, world } = setup();
  const narration = plan.units[0]!;
  const units = [...plan.units, { ...narration, key: "at_b", point: { stepKey: "b", order: 1 } },
    { ...narration, key: "at_c", point: { stepKey: "c", order: 1 }, requiredObservationKeys: ["c_only"] }];
  const future = { ...plan, currentUtterance: { npcId: "npc_0", text: "本场的提问不可转给未来角色" }, units, proposal: { ...plan.proposal, units,
    steps: [{ key: "b", trigger: { kind: "move" as const, locationId: LOC_B }, next: [] }, { key: "c", trigger: { kind: "move" as const, locationId: LOC_C }, next: [] }],
    observations: [...plan.proposal.observations, { key: "c_only", point: { stepKey: "c", order: 0 }, audienceIds: [PLAYER_ENTITY_ID], fact: { factId: "fact_rumor", certainty: "known" as const }, source: { kind: "witness" as const } }],
  } };
  approved.set("at_c", { stage: "narration", actionKeys: [], parts: [{ text: "兄弟路径", facts: [{ factId: "fact_rumor", certainty: "known" }], evidence: [], beatIds: [] }] });
  const result = sceneSnapshot({ plan: future, point: { stepKey: "b", order: 1 }, approved });
  if (!result.ok) throw new Error(result.code);
  expect(result.value.world.currentLocationId).toBe(LOC_B);
  expect(result.value.learned.map(observation => observation.key)).toEqual(["heard"]);
  expect(result.value.world.eventLedger).toEqual(world.eventLedger);
  expect(world.currentLocationId).toBe(LOC_A);
  const futureContext = projectUnitContext({ plan: future, unit: units.find(unit => unit.key === "at_b")!, approved });
  expect(futureContext.ok && futureContext.value.playerUtterance).toBe(null);
  expect(futureContext.ok && futureContext.value.scene?.locationId).toBe(LOC_B);
  expect(futureContext.ok && futureContext.value.scene?.locationName).toBe("废窑");
});
