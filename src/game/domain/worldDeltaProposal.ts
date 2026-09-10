// 世界变化提案的纯解析（原 server/ai/liveWorldEvolutionSource 的 parser 归属）。
//
// 这里是 domain 层：只做逐字段重建与越权引用剔除的纯结构校验，不审批、
// 不分配品牌 ID、不写状态（那些是 gameplay worldEvolution 的职责）。
// 规则过滤仍留在 gameplay，不在此复制一份。

import type { DynamicLocationPlacement, WorldDeltaProposal } from "./worldDelta";
import type { InvestigationApproach } from "./worldState";
import type { GameTypeId } from "./newGame";
import {
  parseNpcCreationAnchors,
  parseNpcGoalProposals,
  parseNpcRelationshipSeedProposals,
} from "./entity";

/** worldDelta 名称类字段（name/label）的长度边界；planning prompt 契约同源引用。 */
export const WORLD_DELTA_MAX_NAME = 40;
/** worldDelta 正文类字段（text/description/beatSummary 截断上限）的长度边界。 */
export const WORLD_DELTA_MAX_TEXT = 200;

// 调查方式安全边界：显式列表必须恰好 2-3 条；张力在 [-5, 20]。
export const MIN_APPROACH_COUNT = 2;
export const MAX_APPROACH_COUNT = 3;
export const MIN_TENSION_DELTA = -5;
export const MAX_TENSION_DELTA = 20;

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function validName(v: unknown): v is string {
  if (!isStr(v)) return false;
  const t = v.trim();
  return t.length >= 2 && t.length <= WORLD_DELTA_MAX_NAME;
}

function validText(v: unknown): v is string {
  if (!isStr(v)) return false;
  const t = v.trim();
  return t.length > 0 && t.length <= WORLD_DELTA_MAX_TEXT;
}

/** 严格键集合：既不允许未知键，也不允许缺字段。 */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key))
    && keys.every((key) => key in value);
}

function hasNoUnknownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseLocationRef(v: unknown): { readonly kind: "existing"; readonly id: string } | { readonly kind: "new_location" } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  if (rec.kind === "new_location") {
    return hasExactKeys(rec, ["kind"]) ? { kind: "new_location" } : null;
  }
  if (rec.kind === "existing" && isStr(rec.id) && rec.id.trim() !== "") {
    return hasExactKeys(rec, ["kind", "id"]) ? { kind: "existing", id: rec.id.trim() } : null;
  }
  return null;
}

function parseMountedRef(v: unknown): "current" | "new_location" | null {
  return v === "current" || v === "new_location" ? v : null;
}

export type ParsedInvestigationApproaches = {
  readonly approaches: readonly InvestigationApproach[];
  readonly logCategories: readonly string[];
};

/**
 * 解析/校验 AI 提交的 investigationApproaches（世界演化入口，泄漏在此闭环）：
 * - 非数组或缺省 = 自动揭示，不产生日志；
 * - 逐条拒绝：approachId/label/hint 非空、quality 枚举、张力在界内、id 唯一、
 *   硬泄漏（完整正文子串）；
 * - label/hint 可以复用事实中的地点、人物和线索关键词；只有完整事实正文
 *   出现在 label/hint 中时才拒绝，避免把正常的调查入口误判为泄漏。
 */
export function parseFactInvestigationApproaches(
  raw: unknown,
  factText: string,
): ParsedInvestigationApproaches | null {
  if (!Array.isArray(raw) || raw.length < MIN_APPROACH_COUNT || raw.length > MAX_APPROACH_COUNT) {
    return null;
  }
  const seenIds = new Set<string>();
  const kept: InvestigationApproach[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (!hasNoUnknownKeys(entry, ["approachId", "label", "hint", "evidenceQuality", "tensionDelta"])) return null;
    const approachId = typeof entry.approachId === "string" ? entry.approachId.trim() : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const hint = entry.hint === undefined ? undefined : typeof entry.hint === "string" ? entry.hint.trim() : "";
    const quality = entry.evidenceQuality === "clean" ? "clean" : entry.evidenceQuality === "noisy" ? "noisy" : null;
    const tensionDelta = typeof entry.tensionDelta === "number" && Number.isFinite(entry.tensionDelta)
      ? entry.tensionDelta
      : null;
    if (approachId === "" || label === "" || hint === "" || quality === null || tensionDelta === null) return null;
    if (tensionDelta < MIN_TENSION_DELTA || tensionDelta > MAX_TENSION_DELTA) return null;
    if (seenIds.has(approachId)) return null;
    const leakTexts = [label, ...(hint === undefined ? [] : [hint])];
    const factTrimmed = factText.trim();
    if (factTrimmed !== "" && leakTexts.some((text) => text.includes(factTrimmed))) return null;
    seenIds.add(approachId);
    kept.push({ approachId, label, ...(hint === undefined ? {} : { hint }), evidenceQuality: quality, tensionDelta });
  }
  return { approaches: kept, logCategories: [] };
}

/** 把 AI 原始 JSON 逐字段解析/校验为合法 WorldDeltaProposal；非法整条丢弃。 */
export function parseWorldDeltaProposal(
  raw: unknown,
  _gameType?: GameTypeId,
): { readonly proposal: WorldDeltaProposal; readonly logCategories: readonly string[] } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (!hasNoUnknownKeys(rec, [
    "beatSummary", "newLocation", "newNpc", "newItem", "newEnemy", "newFact",
    "nextMainQuest", "endingPair",
  ])) return null;
  const beatSummary = isStr(rec.beatSummary) ? rec.beatSummary.trim().slice(0, WORLD_DELTA_MAX_TEXT) : "";
  if (beatSummary === "") return null;

  let newLocation: WorldDeltaProposal["newLocation"] = null;
  if (rec.newLocation !== null && rec.newLocation !== undefined) {
    if (typeof rec.newLocation !== "object" || Array.isArray(rec.newLocation)) return null;
    const l = rec.newLocation as Record<string, unknown>;
    if (!hasNoUnknownKeys(l, ["name", "description", "scale", "placement", "connectFromLocationId"])) return null;
    const scale = l.scale;
    const placement: DynamicLocationPlacement | null = l.placement === "world"
      ? "world"
      : l.placement === "town_building"
        ? "town_building"
        : null;
    if (placement === null) return null;
    if (!validName(l.name) || !validText(l.description)) return null;
    if (scale !== "scene" && scale !== "town") return null;
    if (!isStr(l.connectFromLocationId) || l.connectFromLocationId.trim() === "") return null;
    newLocation = {
      name: l.name.trim(),
      description: l.description.trim(),
      scale,
      placement,
      connectFromLocationId: l.connectFromLocationId.trim(),
    };
  }

  let newNpc: WorldDeltaProposal["newNpc"] = null;
  if (rec.newNpc !== null && rec.newNpc !== undefined) {
    if (typeof rec.newNpc !== "object" || Array.isArray(rec.newNpc)) return null;
    const n = rec.newNpc as Record<string, unknown>;
    if (!hasExactKeys(n, ["name", "role", "description", "locationRef", "anchors", "goals", "relationshipSeeds"])) return null;
    if (!validName(n.name) || !validText(n.role) || !validText(n.description)) return null;
    const locationRef = parseLocationRef(n.locationRef);
    if (locationRef === null) return null;
    const anchors = parseNpcCreationAnchors(n.anchors);
    const goals = parseNpcGoalProposals(n.goals);
    const relationshipSeeds = parseNpcRelationshipSeedProposals(n.relationshipSeeds);
    if (anchors === null || goals === null || relationshipSeeds === null) return null;
    newNpc = {
      name: n.name.trim(),
      role: n.role.trim(),
      description: n.description.trim(),
      locationRef,
      anchors,
      goals,
      relationshipSeeds,
    };
  }

  let newItem: WorldDeltaProposal["newItem"] = null;
  if (rec.newItem !== null && rec.newItem !== undefined) {
    if (typeof rec.newItem !== "object" || Array.isArray(rec.newItem)) return null;
    const it = rec.newItem as Record<string, unknown>;
    if (!hasNoUnknownKeys(it, ["name", "description", "locationRef", "acquisition"])) return null;
    if (!validName(it.name) || !validText(it.description)) return null;
    const locationRef = parseMountedRef(it.locationRef);
    if (locationRef === null) return null;
    if (it.acquisition !== undefined && it.acquisition !== "scene" && it.acquisition !== "npc_gift") return null;
    newItem = {
      name: it.name.trim(),
      description: it.description.trim(),
      locationRef,
      ...(it.acquisition === undefined ? {} : { acquisition: it.acquisition }),
    };
  }

  let newEnemy: WorldDeltaProposal["newEnemy"] = null;
  if (rec.newEnemy !== null && rec.newEnemy !== undefined) {
    if (typeof rec.newEnemy !== "object" || Array.isArray(rec.newEnemy)) return null;
    const e = rec.newEnemy as Record<string, unknown>;
    if (!hasNoUnknownKeys(e, ["name", "tier", "locationRef"])) return null;
    if (!validName(e.name)) return null;
    const tier = e.tier;
    if (tier !== "normal" && tier !== "boss") return null;
    const locationRef = parseMountedRef(e.locationRef);
    if (locationRef === null) return null;
    newEnemy = { name: e.name.trim(), tier, locationRef };
  }

  let newFact: WorldDeltaProposal["newFact"] = null;
  let approachCategories: readonly string[] = [];
  if (rec.newFact !== null && rec.newFact !== undefined) {
    if (typeof rec.newFact !== "object" || Array.isArray(rec.newFact)) return null;
    const f = rec.newFact as Record<string, unknown>;
    if (!hasNoUnknownKeys(f, ["text", "visibility", "investigationLabel", "investigationApproaches"])) return null;
    if (!validText(f.text)) return null;
    const visibility = f.visibility;
    if (visibility !== "public" && visibility !== "npc_private") return null;
    const investigationLabel = f.investigationLabel;
    if (investigationLabel !== undefined && !validName(investigationLabel)) return null;
    const rawApproaches = f.investigationApproaches;
    const parsedApproaches = rawApproaches === undefined
      ? undefined
      : parseFactInvestigationApproaches(rawApproaches, f.text.trim());
    if (parsedApproaches === null) return null;
    approachCategories = parsedApproaches?.logCategories ?? [];
    newFact = {
      text: f.text.trim(),
      visibility,
      ...(investigationLabel === undefined ? {} : { investigationLabel: investigationLabel.trim() }),
      // 缺省字段表示自动揭示；显式列表必须完整通过 source schema 校验。
      ...(parsedApproaches === undefined
        ? {}
        : { investigationApproaches: parsedApproaches.approaches }),
    };
  }

  let nextMainQuest: WorldDeltaProposal["nextMainQuest"] = null;
  if (rec.nextMainQuest !== null && rec.nextMainQuest !== undefined) {
    if (typeof rec.nextMainQuest !== "object" || Array.isArray(rec.nextMainQuest)) return null;
    const q = rec.nextMainQuest as Record<string, unknown>;
    if (!hasNoUnknownKeys(q, ["name", "description", "objectiveText"])) return null;
    if (!validName(q.name) || !validText(q.description) || !validText(q.objectiveText)) return null;
    nextMainQuest = {
      name: q.name.trim(),
      description: q.description.trim(),
      objectiveText: q.objectiveText.trim(),
    };
  }

  let endingPair: WorldDeltaProposal["endingPair"] = null;
  if (rec.endingPair !== null && rec.endingPair !== undefined) {
    if (!Array.isArray(rec.endingPair) || rec.endingPair.length !== 2) return null;
    const parsed: { name: string; description: string; themeKey: "trust" | "doubt" }[] = [];
    for (const item of rec.endingPair) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
      const e = item as Record<string, unknown>;
      if (!hasNoUnknownKeys(e, ["themeKey", "name", "description"])) return null;
      const themeKey = e.themeKey;
      if (themeKey !== "trust" && themeKey !== "doubt") return null;
      if (!validName(e.name) || !validText(e.description)) return null;
      parsed.push({ name: e.name.trim(), description: e.description.trim(), themeKey });
    }
    endingPair = [parsed[0]!, parsed[1]!];
  }

  if (
    newLocation === null && newNpc === null && newItem === null && newEnemy === null
    && newFact === null && nextMainQuest === null && endingPair === null
  ) {
    return null;
  }

  return {
    proposal: { beatSummary, newLocation, newNpc, newItem, newEnemy, newFact, nextMainQuest, endingPair },
    logCategories: approachCategories,
  };
}
