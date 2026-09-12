import { expect, it } from "vitest";
import { parseLiveDraftPlan } from "./liveDraftPlan";
import { makeDecisionPlan } from "./testing/stagedNarrativeFixture.testutil";
function wire() {
  const plan = makeDecisionPlan(); if (plan.decision?.kind !== "ordinary") throw Error("fixture");
  return { ...plan, units: plan.units.map(({ taskFactIds: _, ...unit }) => unit),
    decision: { ...plan.decision, options: plan.decision.options.map(option => { const { text: _, ...references } = option.publicIntent; return { ...option, publicIntent: references }; }) } };
}
it("mechanically derives references and unique candidate text", () => {
  const parsed = parseLiveDraftPlan(wire()); expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw Error(parsed.code);
  expect(parsed.value.decision?.options[0]?.publicIntent.text).toBe(makeDecisionPlan().decision?.options[0]?.publicIntent.text);
  expect(parsed.value.units.every(unit => unit.draft !== undefined && unit.task === undefined)).toBe(true);
});
it.each(["missing", "stage", "speaker", "candidate", "task", "duplicateText", "extra"])("rejects malformed fresh draft: %s", kind => {
  const value = structuredClone(wire());
  const raw = value as unknown as { units: Record<string, unknown>[]; decision: { options: { publicIntent: Record<string, unknown> }[] } };
  if (kind === "missing") delete raw.units[0]!.draft;
  if (kind === "task") raw.units[0]!.task = {};
  if (kind === "stage") raw.units[0]!.stage = "choices";
  if (kind === "speaker") raw.units[1]!.speakerId = "wrong_npc";
  if (kind === "candidate") raw.units[2]!.draft = { stage: "choices", labels: [{ candidateId: "other", label: "我相信你。" }, { candidateId: "wrong", label: "为什么？" }] };
  if (kind === "duplicateText") raw.decision.options[0]!.publicIntent.text = "重复正文";
  if (kind === "extra") raw.units[0]!.unexpected = true;
  expect(parseLiveDraftPlan(raw).ok).toBe(false);
});

it("fresh opening requires explicit known facts while the historical parser remains readable", async () => {
  const { createFixtureOpeningCandidateSource } = await import("@/game/application/createGame");
  const { makeOpeningStagedPlan } = await import("./testing/stagedNarrativeFixture.testutil");
  const { parsePlanProposal } = await import("./narrativePlan");
  const candidate = await createFixtureOpeningCandidateSource().generate({ gameType: "wuxia", gameLength: "short", seed: "known" });
  const plan = makeOpeningStagedPlan(candidate);
  if (plan.decision?.kind !== "ordinary" || plan.opening === null) throw Error("fixture");
  const { knownFactKeys: _, ...historicalPlayer } = plan.opening.player;
  const old = { ...plan, opening: { ...plan.opening, player: historicalPlayer } };
  expect(parsePlanProposal(old).ok).toBe(true);
  const fresh = { ...old, units: old.units.map(({ taskFactIds: _, ...unit }) => unit),
    decision: { ...plan.decision, options: plan.decision.options.map(option => {
      const { text: _, ...publicIntent } = option.publicIntent; return { ...option, publicIntent };
    }) } };
  expect(parseLiveDraftPlan(fresh)).toMatchObject({ ok: false, code: "opening_player_known_facts_missing" });
  expect(parseLiveDraftPlan({ ...fresh, opening: { ...fresh.opening, player: { ...historicalPlayer, knownFactKeys: [] } } }).ok).toBe(true);
});
