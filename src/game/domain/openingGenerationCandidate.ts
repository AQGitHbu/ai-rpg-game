import type { StatBlock } from "./worldEntity";
import type { StoryContract, StoryDeliveryContract } from "./storyContract";
import type { InvestigationApproach } from "./worldState";
import { parseOpeningVariationProfile, type OpeningVariationProfile } from "./openingNovelty";
import type { NarrativeEmotion } from "./narrative";
import {
  parseNpcCreationAnchors,
  parseNpcGoalProposals,
} from "./entity/npcComponents";
import type { NpcGoalProposal, NpcIdentityAnchors } from "./entity/npcComponents";
import { parseOpeningSituation, type OpeningSituationProposal } from "./openingSituation";

// ---------------------------------------------------------------------------
// Task 2：开局切片候选——AI/确定性 fallback 只产出这一份材料：
// 世界前提、玩家、序幕、故事契约与首个开场地点/NPC/任务。
//
// 与旧全量世界候选不同：本候选没有 locations/npcs/quests 实体数组，只有
// 单个 opening 子结构；ID 一律由编译器铸造（loc_0/npc_0/quest_0/fact_N），
// 候选内只携带事实 key 字符串。引用完整性由 gameplay validator 校验。
// ---------------------------------------------------------------------------

export type OpeningGenerationCandidate = {
  readonly world: {
    readonly summary: string;
    readonly tone: string;
    readonly themes: readonly string[];
    readonly publicFacts: readonly {
      readonly key: string;
      readonly text: string;
      /** 复用 WorldFactEntry 的同一 InvestigationApproach 类型，编译时逐条复制。 */
      readonly investigationApproaches?: readonly InvestigationApproach[];
    }[];
  };
  readonly player: {
    readonly name: string;
    readonly identity: string;
    readonly backgroundSummary: string;
    readonly baseStats: StatBlock;
  };
  readonly prologue: string;
  readonly storyContract: StoryContract;
  readonly opening: {
    readonly location: {
      readonly name: string;
      readonly description: string;
      /** AI 生成的剧情建筑名；缺省时编译器回退到地点名。 */
      readonly buildingName?: string;
      readonly scale: "town";
    };
    readonly npc: {
      readonly name: string;
      readonly role: string;
      readonly description: string;
      readonly knownFactKeys: readonly string[];
      readonly privateFactKeys: readonly string[];
      readonly anchors: NpcIdentityAnchors;
      readonly goals: readonly NpcGoalProposal[];
    };
    /** Optional core delivery item; if present it starts with the player. */
    readonly item?: {
      readonly key: string;
      readonly name: string;
      readonly description: string;
      readonly kind: string;
      readonly tags: readonly string[];
    };
    /** 描述开局结构的抽象标签，不包含实体名称。 */
    readonly variationProfile?: OpeningVariationProfile;
    readonly quest: {
      readonly name: string;
      readonly description: string;
      readonly objective: { readonly kind: "talk_to_opening_npc" };
    };
    readonly situation: OpeningSituationProposal;
    /** Task 6：开局首个决策场景——AI 生成的一句焦点 NPC 台词、旁白与恰好两个候选选项。 */
    readonly firstScene?: {
      readonly narration: string;
      readonly npcLine: {
        readonly text: string;
        readonly emotion: NarrativeEmotion;
        readonly usedFactKeys: readonly string[];
      };
      readonly choices: readonly {
        readonly candidateId: string;
        readonly label: string;
      }[];
    };
  };
};

// ---------------------------------------------------------------------------
// schema parser：AI 原始 unknown → OpeningGenerationCandidate。
// 只做形状/枚举检查，不做引用校验（留给 gameplay validator）。
// ---------------------------------------------------------------------------

export type ParseOpeningGenerationCandidateResult =
  | { readonly ok: true; readonly value: OpeningGenerationCandidate }
  | { readonly ok: false; readonly code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLocalStoryKey(value: unknown): value is string {
  return isNonEmptyString(value)
    && /^[a-z][a-z0-9_]*$/.test(value)
    && !/^(?:loc|npc|item|quest|enemy|fact|ending)_\d+$/.test(value);
}

function parseDeliveryContract(value: unknown): StoryDeliveryContract | null {
  if (!isRecord(value)
    || !isLocalStoryKey(value.itemKey)
    || !isLocalStoryKey(value.recipientKey)
    || !isStringArray(value.verificationFactKeys)
    || value.verificationFactKeys.length === 0
    || new Set(value.verificationFactKeys).size !== value.verificationFactKeys.length
    || value.verificationFactKeys.some((key) => !isLocalStoryKey(key))) return null;
  return {
    itemKey: value.itemKey,
    recipientKey: value.recipientKey,
    verificationFactKeys: value.verificationFactKeys,
  };
}

const NARRATIVE_EMOTIONS: readonly string[] = [
  "neutral", "warm", "guarded", "afraid", "angry", "sad",
];

function isStatBlock(value: unknown): value is StatBlock {
  if (!isRecord(value)) return false;
  return (isNumber(value.hp) || value.hp === undefined)
    && (isNumber(value.attack) || value.attack === undefined)
    && (isNumber(value.defense) || value.defense === undefined);
}

/**
 * 形状/枚举检查：approachId/label 必须为字符串，evidenceQuality 只能是
 * clean|noisy，tensionDelta 必须是有限数值，hint 可选字符串。
 * 数量/重复/越界/正文泄漏等语义校验由 gameplay 校验层（Task 2）负责。
 */
function parseInvestigationApproaches(value: unknown): readonly InvestigationApproach[] | null {
  if (!Array.isArray(value)) return null;
  const approaches: InvestigationApproach[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (typeof entry.approachId !== "string") return null;
    if (typeof entry.label !== "string") return null;
    if (entry.evidenceQuality !== "clean" && entry.evidenceQuality !== "noisy") return null;
    if (!isNumber(entry.tensionDelta)) return null;
    if (entry.hint !== undefined && typeof entry.hint !== "string") return null;
    approaches.push({
      approachId: entry.approachId as string,
      label: entry.label as string,
      ...(entry.hint === undefined ? {} : { hint: entry.hint as string }),
      evidenceQuality: entry.evidenceQuality as "clean" | "noisy",
      tensionDelta: entry.tensionDelta as number,
    });
  }
  return approaches;
}

export function parseOpeningGenerationCandidate(
  input: unknown,
): ParseOpeningGenerationCandidateResult {
  if (!isRecord(input)) return { ok: false, code: "NOT_AN_OBJECT" };
  const { world, player, prologue, storyContract, opening } = input;

  if (!isRecord(world)) return { ok: false, code: "INVALID_WORLD" };
  if (typeof world.summary !== "string" || typeof world.tone !== "string") {
    return { ok: false, code: "INVALID_WORLD_TEXT" };
  }
  if (!isStringArray(world.themes)) return { ok: false, code: "INVALID_WORLD_LISTS" };
  if (!Array.isArray(world.publicFacts)) return { ok: false, code: "INVALID_FACT" };
  const parsedPublicFacts: {
    key: string;
    text: string;
    investigationApproaches?: readonly InvestigationApproach[];
  }[] = [];
  for (const fact of world.publicFacts) {
    if (!isRecord(fact) || typeof fact.key !== "string" || typeof fact.text !== "string") {
      return { ok: false, code: "INVALID_FACT" };
    }
    if (fact.investigationApproaches !== undefined) {
      const approaches = parseInvestigationApproaches(fact.investigationApproaches);
      if (approaches === null) return { ok: false, code: "INVALID_FACT" };
      parsedPublicFacts.push({ key: fact.key, text: fact.text, investigationApproaches: approaches });
    } else {
      parsedPublicFacts.push({ key: fact.key, text: fact.text });
    }
  }

  if (!isRecord(player)) return { ok: false, code: "INVALID_PLAYER" };
  if (typeof player.name !== "string" || typeof player.identity !== "string") {
    return { ok: false, code: "INVALID_PLAYER_TEXT" };
  }
  if (!isStatBlock(player.baseStats)) return { ok: false, code: "INVALID_PLAYER_STATS" };

  if (typeof prologue !== "string") return { ok: false, code: "INVALID_PROLOGUE" };

  if (!isRecord(storyContract)) return { ok: false, code: "INVALID_STORY_CONTRACT" };
  if (storyContract.version !== 1) return { ok: false, code: "INVALID_STORY_CONTRACT" };
  if (storyContract.targetActs !== 3 && storyContract.targetActs !== 5) {
    return { ok: false, code: "INVALID_STORY_CONTRACT" };
  }
  if (typeof storyContract.centralConflict !== "string") return { ok: false, code: "INVALID_STORY_CONTRACT" };
  if (!Array.isArray(storyContract.endingDirections) || storyContract.endingDirections.length !== 2) {
    return { ok: false, code: "INVALID_ENDING_DIRECTION" };
  }
  const [trust, doubt] = storyContract.endingDirections;
  if (
    !isRecord(trust) || !isRecord(doubt)
    || trust.key !== "trust" || doubt.key !== "doubt"
    || typeof trust.theme !== "string" || typeof doubt.theme !== "string"
  ) {
    return { ok: false, code: "INVALID_ENDING_DIRECTION" };
  }
  const parsedDelivery = storyContract.delivery === undefined
    ? undefined
    : parseDeliveryContract(storyContract.delivery);
  if (parsedDelivery === null) {
    return { ok: false, code: "INVALID_STORY_CONTRACT" };
  }
  const delivery = parsedDelivery === undefined ? undefined : parsedDelivery;

  if (!isRecord(opening)) return { ok: false, code: "INVALID_OPENING" };
  if (!isRecord(opening.location)) return { ok: false, code: "INVALID_OPENING_LOCATION" };
  if (
    typeof opening.location.name !== "string"
    || typeof opening.location.description !== "string"
    || opening.location.scale !== "town"
  ) {
    return { ok: false, code: "INVALID_OPENING_LOCATION" };
  }
  const buildingName = opening.location.buildingName === undefined
    ? undefined
    : typeof opening.location.buildingName === "string" && opening.location.buildingName.trim() !== ""
      ? opening.location.buildingName
      : null;
  if (buildingName === null) return { ok: false, code: "INVALID_OPENING_LOCATION" };
  if (!isRecord(opening.npc)) return { ok: false, code: "INVALID_OPENING_NPC" };
  const anchors = parseNpcCreationAnchors(opening.npc.anchors);
  const goals = parseNpcGoalProposals(opening.npc.goals);
  if (
    typeof opening.npc.name !== "string"
    || typeof opening.npc.role !== "string"
    || typeof opening.npc.description !== "string"
    || !isStringArray(opening.npc.knownFactKeys)
    || !isStringArray(opening.npc.privateFactKeys)
    || anchors === null
    || goals === null
  ) {
    return { ok: false, code: "INVALID_OPENING_NPC" };
  }
  let item: OpeningGenerationCandidate["opening"]["item"];
  if (opening.item !== undefined) {
    if (!isRecord(opening.item)
      || !isLocalStoryKey(opening.item.key)
      || !isNonEmptyString(opening.item.name)
      || !isNonEmptyString(opening.item.description)
      || !isNonEmptyString(opening.item.kind)
      || !isStringArray(opening.item.tags)) {
      return { ok: false, code: "INVALID_OPENING_ITEM" };
    }
    item = {
      key: opening.item.key,
      name: opening.item.name,
      description: opening.item.description,
      kind: opening.item.kind,
      tags: opening.item.tags,
    };
  }
  if (delivery !== undefined && (item === undefined || item.key !== delivery.itemKey)) {
    return { ok: false, code: "INVALID_STORY_CONTRACT" };
  }
  if (!isRecord(opening.quest)) return { ok: false, code: "INVALID_OPENING_QUEST" };
  if (
    typeof opening.quest.name !== "string"
    || typeof opening.quest.description !== "string"
    || !isRecord(opening.quest.objective)
    || opening.quest.objective.kind !== "talk_to_opening_npc"
  ) {
    return { ok: false, code: "INVALID_OPENING_QUEST" };
  }
  const situation = parseOpeningSituation(opening.situation);
  if (situation === null) return { ok: false, code: "INVALID_OPENING_SITUATION" };

  // Task 6: parse optional firstScene
  let firstScene: OpeningGenerationCandidate["opening"]["firstScene"] | undefined = undefined;
  if (opening.firstScene !== undefined) {
    if (!isRecord(opening.firstScene)) return { ok: false, code: "INVALID_OPENING_FIRST_SCENE" };
    if (typeof opening.firstScene.narration !== "string" || !isNonEmptyString(opening.firstScene.narration)) {
      return { ok: false, code: "INVALID_OPENING_FIRST_SCENE" };
    }
    if (!isRecord(opening.firstScene.npcLine)
      || typeof opening.firstScene.npcLine.text !== "string"
      || !isNonEmptyString(opening.firstScene.npcLine.text)
      || !NARRATIVE_EMOTIONS.includes(opening.firstScene.npcLine.emotion as string)
      || !isStringArray(opening.firstScene.npcLine.usedFactKeys)
    ) {
      return { ok: false, code: "INVALID_OPENING_FIRST_SCENE" };
    }
    if (!Array.isArray(opening.firstScene.choices)
      || opening.firstScene.choices.length !== 2
      || !opening.firstScene.choices.every((c: unknown) => isRecord(c)
        && typeof c.candidateId === "string"
        && isNonEmptyString(c.candidateId as string)
        && typeof c.label === "string"
        && isNonEmptyString(c.label as string),
      )
    ) {
      return { ok: false, code: "INVALID_OPENING_FIRST_SCENE" };
    }
    firstScene = {
      narration: opening.firstScene.narration as string,
      npcLine: {
        text: opening.firstScene.npcLine.text as string,
        emotion: opening.firstScene.npcLine.emotion as NarrativeEmotion,
        usedFactKeys: opening.firstScene.npcLine.usedFactKeys as readonly string[],
      },
      choices: (opening.firstScene.choices as readonly { candidateId: string; label: string }[]),
    };
  }
  const variationProfile = opening.variationProfile === undefined
    ? undefined
    : parseOpeningVariationProfile(opening.variationProfile);
  if (opening.variationProfile !== undefined && variationProfile === null) {
    return { ok: false, code: "INVALID_OPENING_VARIATION_PROFILE" };
  }
  const normalizedVariationProfile = variationProfile === null ? undefined : variationProfile;

  const value: OpeningGenerationCandidate = {
    world: {
      summary: world.summary,
      tone: world.tone,
      themes: world.themes,
      publicFacts: parsedPublicFacts,
    },
    player: {
      name: player.name as string,
      identity: player.identity as string,
      backgroundSummary: typeof player.backgroundSummary === "string" ? player.backgroundSummary : "",
      baseStats: {
        hp: isNumber(player.baseStats.hp) ? player.baseStats.hp : 0,
        attack: isNumber(player.baseStats.attack) ? player.baseStats.attack : 0,
        defense: isNumber(player.baseStats.defense) ? player.baseStats.defense : 0,
      },
    },
    prologue,
    storyContract: {
      version: 1,
      targetActs: storyContract.targetActs as 3 | 5,
      centralConflict: storyContract.centralConflict as string,
      endingDirections: [
        { key: "trust", theme: trust.theme as string },
        { key: "doubt", theme: doubt.theme as string },
      ],
      ...(delivery === undefined ? {} : { delivery }),
    },
    opening: {
      location: {
        name: opening.location.name as string,
        description: opening.location.description as string,
        ...(buildingName === undefined ? {} : { buildingName }),
        scale: "town",
      },
      npc: {
        name: opening.npc.name as string,
        role: opening.npc.role as string,
        description: opening.npc.description as string,
        knownFactKeys: opening.npc.knownFactKeys,
        privateFactKeys: opening.npc.privateFactKeys,
        anchors,
        goals,
      },
      ...(item === undefined ? {} : { item }),
      quest: {
        name: opening.quest.name as string,
        description: opening.quest.description as string,
        objective: { kind: "talk_to_opening_npc" },
      },
      situation,
      ...(firstScene === undefined ? {} : { firstScene }),
      ...(normalizedVariationProfile === undefined ? {} : { variationProfile: normalizedVariationProfile }),
    },
  };

  return { ok: true, value };
}
