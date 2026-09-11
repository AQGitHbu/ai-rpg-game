import { createHash } from "node:crypto";
import { collectDisclosures, readyUnits, sceneSnapshot, type ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import { fail, type Check, type Unit, type UnitOutput } from "@/game/domain/narrativeUnit";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import { projectUnitContext, type SafeContext } from "./perspectiveContext";

/** 只有当前说话正文及本次新披露的授权事实，没有全局骨架。 */
export type DisclosureReviewRequest = Readonly<{
  speakerId: string;
  text: string;
  claims: readonly Readonly<{ factId: string; text: string; certainty: "known" | "suspected"; audienceIds: readonly string[] }>[];
}>;

export function disclosureReviewRequest(input: Readonly<{
  plan: ApprovedPlan; unit: Unit; output: UnitOutput; context: SafeContext;
  approved: ReadonlyMap<string, UnitOutput>;
}>): Check<DisclosureReviewRequest | null> {
  if (input.output.stage !== "character") return { ok: true, value: null };
  const before = new Map(input.approved);
  before.delete(input.unit.key);
  const disclosed = collectDisclosures({ ...input, approved: before });
  if (!disclosed.ok) return disclosed;
  const snapshot = sceneSnapshot({ plan: input.plan, point: input.unit.point, approved: before });
  if (!snapshot.ok) return snapshot;
  const claims: DisclosureReviewRequest["claims"][number][] = [];
  for (const observation of disclosed.value) {
    if (observation.source.kind !== "speech") continue;
    const audienceIds = observation.audienceIds.filter(id => {
      if (snapshot.value.learned.some(o => o.fact.factId === observation.fact.factId && o.audienceIds.includes(id)
        && (o.fact.certainty === "known" || observation.fact.certainty === "suspected"))) return false;
      if (id === String(PLAYER_ENTITY_ID)) {
        const known = snapshot.value.world.worldFacts.some(f => String(f.factId) === observation.fact.factId && f.discovered)
          || snapshot.value.world.eventLedger.some(event => event.payload.type === "narrative_observed"
            && event.payload.audienceId === id && String(event.payload.factId) === observation.fact.factId
            && (event.payload.certainty === "known" || observation.fact.certainty === "suspected"));
        return !known;
      }
      const npc = snapshot.value.world.entityStore.records.find(r => r.core.kind === "npc" && String(r.core.id) === id);
      const entry = npc !== undefined && "knowledge" in npc
        ? npc.knowledge.entries.find(e => String(e.factId) === observation.fact.factId) : undefined;
      return entry === undefined || (entry.certainty === "suspected" && observation.fact.certainty === "known");
    });
    if (audienceIds.length === 0) continue;
    const fact = input.context.visibleFacts.find(f => f.id === observation.fact.factId);
    if (fact === undefined) return fail("disclosure_review_fact_unavailable");
    claims.push({ factId: fact.id, text: fact.text, certainty: observation.fact.certainty, audienceIds: [...audienceIds].sort() });
  }
  return { ok: true, value: claims.length === 0 ? null : {
    speakerId: input.output.speakerId, text: input.output.parts.map(p => p.text).join("\n"), claims,
  } };
}

/** 服务端在审核 pass 后铸造，绑定完整输出与单元/步骤，模型不能自报。 */
export function disclosureReviewDigest(unit: Unit, output: UnitOutput, request: DisclosureReviewRequest): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, unit, output, request })).digest("hex");
}

/** 发布前重放凭据，不在发布期间偷偷调用模型。 */
export function validateJobDisclosureReviews(job: StoredJob, plan: ApprovedPlan): Check<true> {
  const approved = new Map<string, UnitOutput>();
  while (approved.size < plan.units.length) {
    const ready = readyUnits(plan.units, new Set(approved.keys()));
    if (ready.length === 0) return fail("staged_dependency_unmet");
    for (const unit of ready) {
      const stored = job.units.find(s => s.key === unit.key);
      if (stored?.status !== "approved" || stored.value === null || !("stage" in stored.value)) return fail("assemble_unit_missing");
      const output = stored.value;
      const context = projectUnitContext({ plan, unit, approved });
      if (!context.ok) return context;
      const request = disclosureReviewRequest({ plan, unit, output, context: context.value, approved });
      if (!request.ok) return request;
      if (request.value !== null && stored.disclosureReviewDigest !== disclosureReviewDigest(unit, output, request.value))
        return fail("disclosure_review_required");
      approved.set(unit.key, output);
    }
  }
  return { ok: true, value: true };
}
