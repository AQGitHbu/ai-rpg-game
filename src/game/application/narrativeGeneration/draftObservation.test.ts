import { expect, it } from "vitest";
import { approvePlanningContext } from "./approvePlanningContext";
import { projectUnitContext } from "./perspectiveContext";
import { collectDisclosures } from "@/game/gameplay/rpg/narrativePlanning";
import { createStagedHarness } from "../testing/stagedNarrativeHarness.testutil";
import { makeStagedPlan } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId } from "@/game/domain/worldEntity";
import type { PlanProposal } from "@/game/domain/narrativePlan";

// Actual NPC parts/references from wuxia planning call8dd2ca84-169c-49a8-b7c1-2f3e285c2a2d.
// The isolated fixture keeps those facts and ownership; no semantic approval of the raw prose is claimed.
async function observedDraft(wait = false) {
  const h = createStagedHarness(); await h.startDecision(); const loaded = await h.readJob();
  if (!loaded.ok || loaded.value.input.kind !== "decision") throw Error("fixture");
  const input = loaded.value.input; const base = makeStagedPlan(); const npc = base.units.find(unit => unit.stage === "character")!;
  const narration = base.units.find(unit => unit.stage === "narration")!;
  const observations = [
    { key: "obs_npc_token", point: npc.point, audienceIds: ["player_0", "npc_0"], fact: { factId: "fact_1", certainty: "known" as const }, source: { kind: "speech" as const, speakerId: "npc_0" } },
    { key: "obs_npc_han_shan", point: npc.point, audienceIds: ["player_0", "npc_0"], fact: { factId: "fact_4", certainty: "known" as const }, source: { kind: "speech" as const, speakerId: "npc_0" } },
  ];
  const world = createWorldStateFixtureWith({ generation: input.world.generation, base: input.world }, {
    worldFacts: [{ factId: asFactId("fact_1"), text: "劫案现场只留下唯一线索：一枚寒山派的青铜令牌。", source: "generated", discovered: wait },
      { factId: asFactId("fact_4"), text: "寒山派近年式微，门人稀疏，多在外走动。", source: "generated", discovered: false }],
    npcs: input.world.npcs.map(entry => ({ ...entry, memory: { ...entry.memory, knownFactIds: [asFactId("fact_1"), asFactId("fact_4")] } })), eventLedger: input.world.eventLedger,
  });
  const plan: PlanProposal = { ...base, observations: [...observations, ...(wait ? [{ key: "upstream_witness", point: narration.point,
    audienceIds: ["player_0", "npc_0"], fact: { factId: "fact_1", certainty: "known" as const }, source: { kind: "witness" as const } }] : [])],
    units: base.units.map(unit => unit.stage === "character" && unit.speakerId === "npc_0" ? { ...unit, dependencies: wait ? [narration.key] : unit.dependencies, taskFactIds: ["fact_4"], requiredObservationKeys: observations.map(observation => observation.key),
      requiredBeats: observations.map((observation, index) => ({ beatId: index === 0 ? "beat_char_token" : "beat_char_han_shan", kind: "fact_discovered", factIds: [observation.fact.factId], evidence: [{ kind: "conditional", observationKey: observation.key }], instruction: "本单元呈现对应事实" })),
      draft: { stage: "character", speakerId: "npc_0", emotion: "guarded", actions: [], answeredBeatIds: ["beat_char_token", "beat_char_han_shan"], parts: [
        { text: "“令牌？拿来我看。”郑伯接过令牌，凑近灯笼翻了翻，眉头拧起来。", facts: [], evidence: [{ kind: "conditional", observationKey: "obs_npc_token" }], beatIds: ["beat_char_token"] },
        { text: "“寒山派的东西。这派早不似从前，门人稀了，令牌多是外门弟子带的。”他把令牌递回来，手有些抖，“你在哪儿沾上这个的？”", facts: [{ factId: "fact_4", certainty: "known" }], evidence: [{ kind: "conditional", observationKey: "obs_npc_han_shan" }], beatIds: ["beat_char_han_shan"] },
      ] } } : unit.stage === "narration" && wait && unit.draft?.stage === "narration" ? { ...unit, taskFactIds: ["fact_1"], requiredObservationKeys: ["upstream_witness"],
        draft: { ...unit.draft, parts: unit.draft.parts.map(part => ({ ...part, facts: [{ factId: "fact_1", certainty: "known" }] })) } } : unit),
  };
  return { input: { ...input, world }, plan };
}
it.each([false, true])("missing owned observation fact is rejected before acceptance even if awaiting upstream=%s", async wait => {
  const { input, plan } = await observedDraft(wait);
  const result = approvePlanningContext(input, plan);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code: "plan_draft_observation_missing" });
  if (result.ok) throw Error("expected rejection");
  expect(JSON.parse(result.detail!)).toMatchObject({ unitKey: "character_npc_0", observations: [{ observationKey: "obs_npc_token", factId: "fact_1", certainty: "known" }] });
});
it("explicit or same-order implicit ownership requires facts; downgraded complete draft remains valid", async () => {
  const { input, plan } = await observedDraft();
  const complete: PlanProposal = { ...plan, units: plan.units.map(unit => unit.draft?.stage !== "character" || unit.speakerId !== "npc_0" ? unit : { ...unit, requiredObservationKeys: [],
    draft: { ...unit.draft, parts: unit.draft.parts.map((part, index) => index === 0 ? { ...part, evidence: [], facts: [{ factId: "fact_1", certainty: "suspected" }] } : { ...part, evidence: [] }) } }) };
  const result = approvePlanningContext(input, complete);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const implicit = { ...plan, units: plan.units.map(unit => ({ ...unit, requiredObservationKeys: [] })) };
  expect(approvePlanningContext(input, implicit)).toMatchObject({ ok: false, code: "plan_draft_observation_missing" });
  const upgraded = { ...complete, observations: complete.observations.map(observation => ({ ...observation, fact: { ...observation.fact, certainty: "suspected" as const } })) };
  expect(approvePlanningContext(input, upgraded).ok).toBe(false);
});

it("new NPC clue reaches ordinary options only after declared, structurally valid real output", async () => {
  const { input, plan } = await observedDraft(); if (plan.decision?.kind !== "ordinary") throw Error("fixture");
  const complete: PlanProposal = { ...plan, decision: { ...plan.decision, options: [
    { ...plan.decision.options[0], publicIntent: { ...plan.decision.options[0].publicIntent, facts: [{ factId: "fact_1", certainty: "known" }] } }, plan.decision.options[1],
  ] }, units: plan.units.map(unit => unit.draft?.stage !== "character" || unit.speakerId !== "npc_0" ? unit : { ...unit,
    draft: { ...unit.draft, parts: unit.draft.parts.map((part, index) => index === 0 ? { ...part, facts: [{ factId: "fact_1", certainty: "known" }] } : part) } }) };
  const result = approvePlanningContext(input, complete); if (!result.ok) throw Error(result.code);
  expect(result.value.world.worldFacts.find(fact => fact.factId === "fact_1")?.discovered).toBe(false);
  const choices = result.value.units.find(unit => unit.stage === "choices")!;
  const npc = result.value.units.find(unit => unit.speakerId === "npc_0")!;
  const before = new Map(result.value.units.filter(unit => unit.key !== npc.key).map(unit => [unit.key, unit.draft!]));
  expect(projectUnitContext({ plan: result.value, unit: choices, approved: before }).ok).toBe(false);
  expect(collectDisclosures({ plan: result.value, unit: npc, output: npc.draft!, approved: before }).ok).toBe(true);
  const after = new Map(before).set(npc.key, npc.draft!);
  const projected = projectUnitContext({ plan: result.value, unit: choices, approved: after });
  expect(projected.ok, JSON.stringify(projected)).toBe(true);
  expect(projected.ok && projected.value.visibleFacts.map(fact => fact.id)).toEqual(["fact_1"]);
  if (npc.draft?.stage !== "character") throw Error("draft");
  const omitted = { ...npc.draft, parts: npc.draft.parts.map(part => ({ ...part, facts: part.facts.filter(fact => fact.factId !== "fact_1") })) };
  expect(collectDisclosures({ plan: result.value, unit: npc, output: omitted, approved: before })).toMatchObject({ ok: false, code: "observation_not_disclosed" });
  expect(projectUnitContext({ plan: result.value, unit: choices, approved: new Map(before).set(npc.key, omitted) }).ok).toBe(false);
  expect(input.world.worldFacts.find(fact => fact.factId === "fact_1")?.discovered).toBe(false);
});

it("same-order implicit narration witness remains valid when its fact is present", async () => {
  const { input, plan } = await observedDraft(true);
  const complete: PlanProposal = { ...plan, units: plan.units.map(unit => unit.draft?.stage === "narration" ? { ...unit, requiredObservationKeys: [],
    draft: { ...unit.draft, parts: unit.draft.parts.map(part => ({ ...part, facts: [{ factId: "fact_1", certainty: "suspected" }] })) } }
    : unit.draft?.stage === "character" && unit.speakerId === "npc_0" ? { ...unit,
      draft: { ...unit.draft, parts: unit.draft.parts.map((part, index) => index === 0 ? { ...part, facts: [{ factId: "fact_1", certainty: "known" }] } : part) } } : unit) };
  expect(approvePlanningContext(input, complete).ok).toBe(true);
  const missing = { ...complete, units: complete.units.map(unit => unit.draft?.stage !== "narration" ? unit : { ...unit,
    draft: { ...unit.draft, parts: unit.draft.parts.map(part => ({ ...part, facts: [] })) } }) };
  expect(approvePlanningContext(input, missing)).toMatchObject({ ok: false, code: "plan_draft_observation_missing" });
});
