import type { GameTypeId } from "./newGame";
import type { OpeningGenerationCandidate } from "./openingGenerationCandidate";

/**
 * AI 生成的开局结构标签。标签描述“故事怎么开始”，不描述实体名称；
 * 因而可以用于去重，又不会把 NPC/地点名字变成服务端硬编码内容。
 */
export const OPENING_SCENE_FRAMES = [
  "street", "market", "inn", "outskirts", "station", "workshop", "shrine", "other",
] as const;
export const OPENING_NPC_ARCHETYPES = [
  "witness", "keeper", "courier", "merchant", "official", "craftsperson", "guide", "other",
] as const;
export const OPENING_LEAD_TYPES = [
  "trace", "document", "testimony", "token", "message", "object", "other",
] as const;
export const OPENING_CONFLICT_MODES = [
  "concealment", "misdirection", "dispute", "pursuit", "betrayal", "other",
] as const;

export type OpeningVariationProfile = Readonly<{
  readonly sceneFrame: typeof OPENING_SCENE_FRAMES[number];
  readonly npcArchetype: typeof OPENING_NPC_ARCHETYPES[number];
  readonly leadType: typeof OPENING_LEAD_TYPES[number];
  readonly conflictMode: typeof OPENING_CONFLICT_MODES[number];
}>;

export type OpeningNoveltyRecord = Readonly<{
  readonly gameType: GameTypeId;
  readonly fingerprint: string;
  readonly semanticFingerprint: string;
  readonly semanticText: string;
  readonly summary: string;
  readonly profile: OpeningVariationProfile;
  readonly createdAt: string;
}>;

export type OpeningNoveltyContext = Readonly<{
  readonly recent: readonly OpeningNoveltyRecord[];
  readonly attempt: number;
}>;

export const DEFAULT_OPENING_VARIATION_PROFILE: OpeningVariationProfile = {
  sceneFrame: "other",
  npcArchetype: "other",
  leadType: "other",
  conflictMode: "other",
};

function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

export function parseOpeningVariationProfile(value: unknown): OpeningVariationProfile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !isOneOf(OPENING_SCENE_FRAMES, record.sceneFrame)
    || !isOneOf(OPENING_NPC_ARCHETYPES, record.npcArchetype)
    || !isOneOf(OPENING_LEAD_TYPES, record.leadType)
    || !isOneOf(OPENING_CONFLICT_MODES, record.conflictMode)
  ) return null;
  return {
    sceneFrame: record.sceneFrame,
    npcArchetype: record.npcArchetype,
    leadType: record.leadType,
    conflictMode: record.conflictMode,
  };
}

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function withoutNames(value: string, names: readonly string[]): string {
  return names.reduce((current, name) => name === "" ? current : current.split(name).join(""), value);
}

function profileOf(candidate: OpeningGenerationCandidate): OpeningVariationProfile {
  return candidate.opening.variationProfile ?? DEFAULT_OPENING_VARIATION_PROFILE;
}

function semanticParts(candidate: OpeningGenerationCandidate): readonly string[] {
  const names = [
    candidate.opening.location.name,
    candidate.opening.location.buildingName ?? "",
    candidate.opening.npc.name,
    candidate.opening.quest.name,
  ];
  const facts = candidate.world.publicFacts.map((fact) => fact.text);
  return [
    candidate.opening.location.description,
    candidate.opening.npc.role,
    candidate.opening.npc.description,
    ...facts,
    candidate.opening.quest.description,
    candidate.storyContract.centralConflict,
  ].map((part) => normalizeText(withoutNames(part, names)));
}

function fullParts(candidate: OpeningGenerationCandidate): readonly string[] {
  return [
    candidate.world.summary,
    candidate.world.tone,
    ...candidate.world.themes,
    ...candidate.world.publicFacts.map((fact) => `${fact.key}:${fact.text}`),
    candidate.opening.location.name,
    candidate.opening.location.buildingName ?? "",
    candidate.opening.location.description,
    candidate.opening.npc.name,
    candidate.opening.npc.role,
    candidate.opening.npc.description,
    candidate.opening.quest.name,
    candidate.opening.quest.description,
    candidate.storyContract.centralConflict,
  ].map(normalizeText);
}

/** 从候选中提取可持久化的故事指纹；不会改写候选内容。 */
export function createOpeningNoveltyRecord(input: {
  readonly candidate: OpeningGenerationCandidate;
  readonly gameType: GameTypeId;
  readonly createdAt: string;
}): OpeningNoveltyRecord {
  const profile = profileOf(input.candidate);
  const semanticText = semanticParts(input.candidate).filter(Boolean).join("|");
  const fullText = fullParts(input.candidate).join("|");
  const summary = [
    `地点：${input.candidate.opening.location.name}`,
    `建筑：${input.candidate.opening.location.buildingName ?? input.candidate.opening.location.name}`,
    `NPC：${input.candidate.opening.npc.name}（${input.candidate.opening.npc.role}）`,
    `任务：${input.candidate.opening.quest.name}`,
    `结构：${profile.sceneFrame}/${profile.npcArchetype}/${profile.leadType}/${profile.conflictMode}`,
  ].join("；");
  return {
    gameType: input.gameType,
    fingerprint: stableHash(fullText),
    semanticFingerprint: stableHash(semanticText),
    semanticText,
    summary,
    profile,
    createdAt: input.createdAt,
  };
}

function characterBigrams(value: string): Set<string> {
  const result = new Set<string>();
  if (value.length <= 2) {
    if (value.length > 0) result.add(value);
    return result;
  }
  for (let index = 0; index < value.length - 1; index += 1) {
    result.add(value.slice(index, index + 2));
  }
  return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function profileSimilarity(left: OpeningVariationProfile, right: OpeningVariationProfile): number {
  const values = [
    left.sceneFrame === right.sceneFrame,
    left.npcArchetype === right.npcArchetype,
    left.leadType === right.leadType,
    left.conflictMode === right.conflictMode,
  ];
  return values.filter(Boolean).length / values.length;
}

/**
 * 返回 0..1 的故事相似度。实体名称只通过 full fingerprint 参与精确重复判断，
 * 语义相似度主要看去除名称后的内容与结构标签，因此“老陈”不是禁用词。
 */
export function openingNoveltySimilarity(
  left: OpeningNoveltyRecord,
  right: OpeningNoveltyRecord,
): number {
  if (left.gameType !== right.gameType) return 0;
  if (left.fingerprint === right.fingerprint) return 1;
  if (left.semanticFingerprint === right.semanticFingerprint) return 0.96;
  const semantic = jaccard(characterBigrams(left.semanticText), characterBigrams(right.semanticText));
  const profile = profileSimilarity(left.profile, right.profile);
  return semantic * 0.72 + profile * 0.28;
}

export function isOpeningTooSimilar(
  candidate: OpeningNoveltyRecord,
  history: readonly OpeningNoveltyRecord[],
  threshold = 0.78,
): boolean {
  return history.some((previous) => openingNoveltySimilarity(candidate, previous) >= threshold);
}
