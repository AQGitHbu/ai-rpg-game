import { entitiesOfKind } from "@/game/domain/entity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { NarrativeCandidateReviewInput, CandidateDefect } from "../../narrativeCandidateReview";
import { projectNarrativeDraft } from "./narrativeDraftProjection";
import { buildNarrativeProgressRequirements } from "./narrativeProgressContract";
import { buildEntityContextProjection } from "../../entityContextProjection";
import { projectObserverEvidence } from "@/game/gameplay/rpg/narrativeMemory";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: RecordValue, expected: readonly string[]) { return Object.keys(value).length === expected.length && expected.every(key => key in value); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function ownerKey(owner: unknown): string {
  if (!record(owner)) return "none";
  return owner.kind === "player" ? String(PLAYER_ENTITY_ID) : String(owner.npcId ?? owner.locationId ?? "none");
}
type Snapshot = { locationId: string; npcLocations: { npcId: string; locationId: string }[]; itemOwners: { itemId: string; ownerId: string }[]; transfers: { itemId: string; ownerId: string; basisKey: string }[] };
type Check = { path: string; quote: string; basisKey: string; states: Snapshot[]; prerequisiteBasisKeys: string[] };

/** Enumerates all authored prose, never asks the model to choose which fields matter. */
export function buildNarrativeExecutionChecks(input: NarrativeCandidateReviewInput) {
  const checks: Check[] = [];
  if (input.context.kind !== "decision" || "opening" in input.proposal) return checks;
  const proposal = input.proposal;
  const { worldState, storyState, job } = input.context;
  const projection = projectNarrativeDraft({ worldState, storyState, job });
  const reviewWorld = input.context.reviewWorldState ?? worldState;
  const entityProjection = buildEntityContextProjection({ worldState: reviewWorld, storyState, job });
  const visibleItems = new Set([...entityProjection.mandatory, ...entityProjection.optional].filter(entity => entity.kind === "item").map(entity => entity.id));
  if (storyState.delivery !== undefined) visibleItems.add(String(storyState.delivery.itemId));
  const base: Snapshot = {
    locationId: String(worldState.currentLocationId),
    npcLocations: entitiesOfKind(reviewWorld.entityStore, "npc")
      .filter(npc => npc.core.lifecycle === "active" && (npc.dynamicState.met || npc.position.locationId === worldState.currentLocationId || !entitiesOfKind(worldState.entityStore, "npc").some(old => old.core.id === npc.core.id)))
      .map(npc => ({ npcId: String(npc.core.id), locationId: String(npc.position.locationId) })),
    itemOwners: entitiesOfKind(reviewWorld.entityStore, "item").filter(item => visibleItems.has(String(item.core.id))).map(item => ({ itemId: String(item.core.id), ownerId: ownerKey(item.possession.owner) })),
    transfers: projectObserverEvidence({ worldState, storyState, observerId: PLAYER_ENTITY_ID }).events.filter(event => event.outcome === "success").flatMap(event => {
      const payload = event.payload;
      if (payload.type === "item_given") return [{ itemId: String(payload.itemId), ownerId: String(payload.npcId), basisKey: `event:${event.eventId}` }];
      if (payload.type === "item_obtained") return [{ itemId: String(payload.itemId), ownerId: String(PLAYER_ENTITY_ID), basisKey: `event:${event.eventId}` }];
      return [];
    }).filter(item => visibleItems.has(item.itemId)),
  };
  const prerequisiteBasisKeys = [
    `action:${job.actionId}`,
    ...base.transfers.map(transfer => transfer.basisKey),
    ...worldState.worldFacts.filter(fact => fact.discovered).map(fact => `fact:${fact.factId}`),
  ];
  function add(value: unknown, path: string, basisKey: string, states: Snapshot[], bases: string[]) {
    if (typeof value === "string") { checks.push({ path, quote: value, basisKey, states, prerequisiteBasisKeys: bases }); return; }
    if (Array.isArray(value)) { value.forEach((entry, index) => add(entry, `${path}[${index}]`, basisKey, states, bases)); return; }
    if (!record(value)) return;
    for (const [key, child] of Object.entries(value)) {
      // Only prose fields, excluding IDs, emotions, routing and reference declarations.
      if (["usedFactIds", "usedEventIds", "answeredBeatIds", "audienceIds", "referencedEntityIds", "objectiveLink"].includes(key)) continue;
      if (typeof child !== "string" || ["text", "label", "handoffAcknowledgement"].includes(key)) add(child, `${path}.${key}`, basisKey, states, bases);
    }
  }
  const currentBasis = `action:${job.actionId}`;
  add(proposal.currentScene, "currentScene", currentBasis, [base], prerequisiteBasisKeys);
  let slotState = base;
  const cumulative = [...prerequisiteBasisKeys];
  // Match server slot keys, never infer triggers or timing from candidate prose.
  const alternate = projectNarrativeDraft({ worldState, storyState, job, includeDeliveryReturn: true });
  const slots = [projection, alternate].flatMap(graph => graph.slots);
  const descriptors = [projection, alternate].flatMap(graph => graph.descriptorGraph.steps);
  for (const [index, step] of proposal.continuationScenes.entries()) {
    const trigger = slots.find(slot => slot.slotKey === step.stepKey)?.resolution?.trigger;
    if (trigger !== undefined) {
      slotState = { ...slotState, itemOwners: slotState.itemOwners.map(item => ({ ...item })) };
      if (trigger.kind === "move") slotState.locationId = String(trigger.locationId);
      // An existing unmet NPC can be authorized only for a future arrival.
      // Extend this slot's scope from the server descriptor, never the prose or
      // the destination's entire NPC roster; earlier snapshots stay unchanged.
      const descriptor = descriptors.find(descriptor => descriptor.stepKey === step.stepKey);
      const arrivals = entitiesOfKind(reviewWorld.entityStore, "npc").filter(npc => npc.core.lifecycle === "active"
        && npc.position.locationId === slotState.locationId
        && descriptor?.authority.allowedEntityIds.includes(String(npc.core.id))
        && !slotState.npcLocations.some(known => known.npcId === npc.core.id));
      slotState.npcLocations = [...slotState.npcLocations, ...arrivals.map(npc => ({ npcId: String(npc.core.id), locationId: String(npc.position.locationId) }))];
      if (trigger.kind === "take_item" || trigger.kind === "give_item") {
        slotState.transfers = [...slotState.transfers, { itemId: String(trigger.itemId), ownerId: trigger.kind === "take_item" ? String(PLAYER_ENTITY_ID) : String(trigger.npcId), basisKey: `step:${step.stepKey}` }];
        slotState.itemOwners = slotState.itemOwners.map(item => item.itemId === trigger.itemId ? { ...item, ownerId: trigger.kind === "take_item" ? String(PLAYER_ENTITY_ID) : String(trigger.npcId) } : item);
      }
      cumulative.push(`step:${step.stepKey}`);
    }
    add(step.scene, `continuationScenes[${index}].scene`, `step:${step.stepKey}`, trigger === undefined ? [] : [slotState], [...cumulative]);
  }
  function endingStates(themeKey: string) {
    const ending = projection.endingResolutions.find(ending => ending.themeKey === themeKey);
    return ending?.actionPreviews.flatMap(preview => preview.resultingLocationId !== undefined ? [{
      locationId: String(preview.resultingLocationId),
      transfers: [...base.transfers, ...preview.itemOwnershipChanges.filter(change => visibleItems.has(String(change.itemId))).map(change => ({ itemId: String(change.itemId), ownerId: ownerKey(change.after), basisKey: `ending:${themeKey}` }))],
      npcLocations: preview.npcLocations.map(npc => ({ npcId: String(npc.npcId), locationId: String(npc.afterLocationId) })),
      itemOwners: base.itemOwners.map(item => ({ ...item, ownerId: ownerKey(preview.itemOwnershipChanges.find(change => change.itemId === item.itemId)?.after
        ?? entitiesOfKind(reviewWorld.entityStore, "item").find(entry => entry.core.id === item.itemId)?.possession.owner) })),
    }] : []) ?? [];
  }
  proposal.endingOutcomes?.forEach((outcome, index) => {
    const basis = `ending:${outcome.themeKey}`;
    const states = endingStates(outcome.themeKey);
    add(outcome.choiceLabel, `endingOutcomes[${index}].choiceLabel`, basis, states, [...prerequisiteBasisKeys, basis]);
    add(outcome.scene, `endingOutcomes[${index}].scene`, basis, states, [...prerequisiteBasisKeys, basis]);
  });
  const delta = proposal.worldDelta;
  if (record(delta)) {
    if (typeof delta.beatSummary === "string") add(delta.beatSummary, "worldDelta.beatSummary", currentBasis, [base], prerequisiteBasisKeys);
    if (Array.isArray(delta.endingPair)) delta.endingPair.forEach((ending, index) => {
      if (!record(ending)) return;
      const basis = `ending:${ending.themeKey}`;
      for (const field of ["name", "description"]) if (typeof ending[field] === "string") add(ending[field], `worldDelta.endingPair[${index}].${field}`, basis, endingStates(String(ending.themeKey)), [...prerequisiteBasisKeys, basis]);
    });
  }
  return checks;
}

export const NARRATIVE_EXECUTION_CHECK_CONTRACT = [
  "decision 的 pass 必须逐一返回 context.executionChecks 全部路径（不漏、不重复），executionChecks=[{path,quote,basisKey,playerLocation,participants,itemTransfers,completedPrerequisites}]。quote 必须逐字等于该路径的完整候选原文，basisKey 必须等于服务端指定范围。",
  "playerLocation={kind:'unchanged'} 或 {kind:'at',locationId} 或 {kind:'outside_known_location'}，表示正文断言的玩家实际地点；unchanged 表示未断言偏离该槽真实结果。离开当前地点去未定义的船上等应为 outside_known_location。",
  "participants=[{quote,npcId,locationId}] 抽取实际到场/参与关键事项的人物，不是被提及的人；itemTransfers=[{quote,itemId,ownerId,basisKey}] 抽取已完成转移后的实际持有人，ownerId 为 player ID、npc ID 或 location ID，basisKey 精确引用 states.transfers 的具体已发生事件或槽结果，无支持写 null。过去已交付且仍持有的合法回顾可引用历史转移，但不能据此说本次 talk 又执行交付。引文须是本路径非空原文子串。",
  "completedPrerequisites=[{quote,claim,basisKey}] 抽取声称已履行的关键前提（包含其他人代办及时间跳跃）；basisKey 只能引用该检查 prerequisiteBasisKeys 中真实支持 claim 的依据，无支持写 null。该目录只是可引用范围，不代表每个依据证明任意完成事项。必须阅读具体规则值核对 claim；talk 不证明乘船、偿债、兑现承诺。",
  "场内无玩法效果的小动作、装饰、明确未来意向不抽取为已完成转移/前提。若语义不明不能自行视为无效果，应返回 uncertain。模型负责理解完整语义，服务端只确定性核验抽取和规则的绑定/一致性。",
  "progressChecks 必须逐项覆盖 context.progressRequirements，格式 {key,status:'satisfied'|'violated',path,quote,reason}，path 与非空引文来自对应候选范围；ending 主题必须匹配。终幕评价本次委托、立场后果和明确未解决问题。违反推进契约必须 violated，不得降为风格观察；reason 解释具体利害或因果，不能用审美分数。",
].join("\n");

/** null means incomplete/ambiguous extraction; [] means structurally consistent, not proven prose truth. */
export function validateNarrativeExecutionChecks(value: unknown, progress: unknown, input: NarrativeCandidateReviewInput): readonly CandidateDefect[] | null {
  const expected = buildNarrativeExecutionChecks(input);
  if (!Array.isArray(value) || value.length !== expected.length || !Array.isArray(progress)) return null;
  const defects: CandidateDefect[] = [];
  const seen = new Set<string>();
  const defect = (check: Check, reason: string, code: CandidateDefect["code"] = "ACTION_MISMATCH", basisKey = check.basisKey) => defects.push({
    candidateVersion: input.candidateVersion, candidateHash: input.candidateHash, scope: check.path.startsWith("worldDelta") ? "proposal" : "scene",
    code, path: check.path, reason, evidence: { basisKey, impact: basisKey.startsWith("step:") ? "step_order" : "interaction_effect", detail: reason },
  });
  for (const entry of value) {
    if (!record(entry) || !keys(entry, ["path", "quote", "basisKey", "playerLocation", "participants", "itemTransfers", "completedPrerequisites"])) return null;
    const check = expected.find(check => check.path === entry.path);
    if (check === undefined || seen.has(check.path) || entry.quote !== check.quote || entry.basisKey !== check.basisKey || check.states.length === 0) return null;
    seen.add(check.path);
    const location = entry.playerLocation;
    if (!record(location) || !["unchanged", "at", "outside_known_location"].includes(String(location.kind))
      || !keys(location, location.kind === "at" ? ["kind", "locationId"] : ["kind"]) || location.kind === "at" && !nonempty(location.locationId)) return null;
    if (!Array.isArray(entry.participants) || !Array.isArray(entry.itemTransfers) || !Array.isArray(entry.completedPrerequisites)) return null;
    const quoted = (claim: RecordValue) => nonempty(claim.quote) && check.quote.includes(claim.quote);
    if (location.kind === "outside_known_location" || location.kind === "at" && !check.states.every(state => state.locationId === location.locationId)) defect(check, "候选断言的玩家地点不属于该槽真实规则结果。");
    for (const participant of entry.participants) {
      if (!record(participant) || !keys(participant, ["quote", "npcId", "locationId"]) || !quoted(participant) || !nonempty(participant.npcId) || !nonempty(participant.locationId)) return null;
      if (!check.states.every(state => state.locationId === participant.locationId && state.npcLocations.some(npc => npc.npcId === participant.npcId && npc.locationId === participant.locationId))) defect(check, `参与者 ${participant.npcId} 的实际地点没有对应规则依据。`);
    }
    for (const transfer of entry.itemTransfers) {
      if (!record(transfer) || !keys(transfer, ["quote", "itemId", "ownerId", "basisKey"]) || !quoted(transfer) || !nonempty(transfer.itemId) || !nonempty(transfer.ownerId) || transfer.basisKey !== null && !nonempty(transfer.basisKey)) return null;
      if (!check.states.every(state => state.itemOwners.some(item => item.itemId === transfer.itemId && item.ownerId === transfer.ownerId)
        && state.transfers.some(item => item.itemId === transfer.itemId && item.ownerId === transfer.ownerId && item.basisKey === transfer.basisKey))) defect(check, `物品 ${transfer.itemId} 的完成转移不属于该槽真实规则结果。`);
    }
    for (const prerequisite of entry.completedPrerequisites) {
      if (!record(prerequisite) || !keys(prerequisite, ["quote", "claim", "basisKey"]) || !quoted(prerequisite) || !nonempty(prerequisite.claim) || prerequisite.basisKey !== null && !nonempty(prerequisite.basisKey)) return null;
      if (prerequisite.basisKey === null) defect(check, `已完成前提没有规则依据：${prerequisite.claim}`);
      else if (!check.prerequisiteBasisKeys.includes(prerequisite.basisKey as string)) return null;
    }
  }
  const requirements = buildNarrativeProgressRequirements(input);
  if (progress.length !== requirements.length) return null;
  const progressSeen = new Set<string>();
  for (const entry of progress) {
    if (!record(entry) || !keys(entry, ["key", "status", "path", "quote", "reason"]) || !nonempty(entry.reason) || !nonempty(entry.quote)) return null;
    const requirement = requirements.find(requirement => requirement.key === entry.key);
    const check = expected.find(check => check.path === entry.path);
    if (requirement === undefined || check === undefined || progressSeen.has(requirement.key) || !check.quote.includes(entry.quote)
      || !["satisfied", "violated"].includes(String(entry.status))) return null;
    const ending = requirement.key.startsWith("progress:ending:");
    if (ending ? check.basisKey !== requirement.key.slice("progress:".length) : check.basisKey.startsWith("ending:")) return null;
    progressSeen.add(requirement.key);
    if (entry.status === "violated") defect(check, entry.reason, "BROKEN_CAUSALITY", requirement.key);
  }
  return defects;
}
