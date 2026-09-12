import { createAiSourceFailure } from "../../aiGenerationRetry";
import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { OpeningGenerationSource } from "../../createGame";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import { parseOpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import type { GameLength, GameSetup } from "@/game/domain/newGame";
import { validateOpeningGenerationCandidate } from "@/game/gameplay/rpg/openingGeneration";
import type { OpeningNoveltyContext } from "@/game/domain/openingNovelty";
import { TARGET_ACTS } from "@/game/domain/storyBudget";
import { buildStylePolicy } from "../../stylePolicy";
import { createRpgAiClient, RPG_AI_DEFAULT_POLICIES, type RpgAiClient } from "./rpgAiClient";
import type { ProviderJsonMode } from "./providerRequestOptions";
import { AiGenerationError, classifyAiFailure, transportFailureCodeToCategory } from "../../aiGenerationFailure";
import { parseStructuredJsonObject } from "@/game/core/json";

// ---------------------------------------------------------------------------
// 开局生成源（live/fixture）。
//
// 编排：AI 原始 JSON → schema parse → 机械修复（无创意）→ 引用完整性修复 →
// 纯 validator → 成功返回 generated candidate。
// 失败抛出携带稳定 kind 的 AiGenerationError，由 createGame 负责返回失败。
// 机械修复只允许空数组/空字符串/数值回退等无创意修复；不得修改剧情语义。
// 敏感信息不进入日志。
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: unknown, allowedKeys: readonly string[]): boolean {
  if (!isRecord(value)) return true;
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasOnlyKeysInArray(value: unknown, allowedKeys: readonly string[]): boolean {
  return !Array.isArray(value) || value.every((entry) => hasOnlyKeys(entry, allowedKeys));
}

/**
 * Opening candidates are a closed creation contract. Keep this check structural
 * and separate from the semantic parser so repair can still normalize malformed
 * arrays/strings, while unknown creation/runtime fields fail closed.
 */
export function hasOnlyKnownOpeningCandidateKeys(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["world", "player", "prologue", "storyContract", "opening"])) return false;

  const world = value.world;
  if (isRecord(world)) {
    if (!hasOnlyKeys(world, ["summary", "tone", "themes", "publicFacts"])) return false;
    if (!hasOnlyKeysInArray(world.publicFacts, ["key", "text", "investigationApproaches"])) return false;
    if (Array.isArray(world.publicFacts)) {
      for (const fact of world.publicFacts) {
        if (!isRecord(fact)) continue;
        if (!hasOnlyKeysInArray(fact.investigationApproaches, ["approachId", "label", "hint", "evidenceQuality", "tensionDelta"])) return false;
      }
    }
  }

  const player = value.player;
  if (isRecord(player) && !hasOnlyKeys(player, ["name", "identity", "backgroundSummary", "baseStats"])) return false;
  if (isRecord(player) && isRecord(player.baseStats)
    && !hasOnlyKeys(player.baseStats, ["hp", "attack", "defense"])) return false;

  const storyContract = value.storyContract;
  if (isRecord(storyContract)) {
    if (!hasOnlyKeys(storyContract, ["version", "targetActs", "centralConflict", "endingDirections", "delivery"])) return false;
    if (!hasOnlyKeysInArray(storyContract.endingDirections, ["key", "theme"])) return false;
    if (isRecord(storyContract.delivery)
      && !hasOnlyKeys(storyContract.delivery, ["itemKey", "recipientKey", "verificationFactKeys"])) return false;
  }

  const opening = value.opening;
  if (!isRecord(opening) || !hasOnlyKeys(opening, ["location", "npc", "item", "quest", "situation", "firstScene", "variationProfile"])) return false;

  const location = opening.location;
  if (isRecord(location) && !hasOnlyKeys(location, ["name", "description", "buildingName", "scale"])) return false;

  const npc = opening.npc;
  if (isRecord(npc)) {
    if (!hasOnlyKeys(npc, ["name", "role", "description", "knownFactKeys", "privateFactKeys", "anchors", "goals"])) return false;
    if (isRecord(npc.anchors) && !hasOnlyKeys(npc.anchors, ["selfConcept", "values", "speechStyle", "capabilityBoundaries", "taboos"])) return false;
    if (!hasOnlyKeysInArray(npc.goals, ["horizon", "description", "priority", "reason"])) return false;
  }

  const item = opening.item;
  if (isRecord(item) && !hasOnlyKeys(item, ["key", "name", "description", "kind", "tags"])) return false;

  const quest = opening.quest;
  if (isRecord(quest)) {
    if (!hasOnlyKeys(quest, ["name", "description", "objective"])) return false;
    if (isRecord(quest.objective) && !hasOnlyKeys(quest.objective, ["kind"])) return false;
  }

  const situation = opening.situation;
  if (isRecord(situation)) {
    if (!hasOnlyKeys(situation, ["history", "threads", "npcConnection", "responses"])) return false;
    if (!hasOnlyKeysInArray(situation.history, ["key", "factKeys", "participantRefs", "causeHistoryKeys"])) return false;
    if (!hasOnlyKeysInArray(situation.threads, ["key", "questionFactKey", "supportingFactKeys", "participantRefs", "causeHistoryKeys"])) return false;
    if (isRecord(situation.npcConnection) && !hasOnlyKeys(situation.npcConnection, ["familiarity", "stance", "basisHistoryKeys"])) return false;
    if (!hasOnlyKeysInArray(situation.responses, ["key", "dialogueAct", "topic"])) return false;
    if (Array.isArray(situation.responses)) {
      for (const response of situation.responses) {
        const topic = isRecord(response) ? response.topic : undefined;
        if (isRecord(topic) && !hasOnlyKeys(topic, ["kind", "key"])) return false;
      }
    }
  }

  const firstScene = opening.firstScene;
  if (isRecord(firstScene)) {
    if (!hasOnlyKeys(firstScene, ["narration", "npcLine", "choices"])) return false;
    if (isRecord(firstScene.npcLine) && !hasOnlyKeys(firstScene.npcLine, ["text", "emotion", "usedFactKeys"])) return false;
    if (!hasOnlyKeysInArray(firstScene.choices, ["candidateId", "label"])) return false;
  }

  if (isRecord(opening.variationProfile)
    && !hasOnlyKeys(opening.variationProfile, ["sceneFrame", "npcArchetype", "leadType", "conflictMode"])) return false;
  return true;
}

// 机械修复：只做无创意、可推导的修复。返回是否发生变更。
//   - 数组字段为 null/非数组 → 空数组；
//   - 字符串字段为 null/非字符串 → 空字符串；
//   - 旧候选数值字段非法 → fixture 默认（仅为旧 fixture 解析兼容，编译阶段不采纳）；
//   不修改剧情语义、不新增/删除实体、不重写文本。
export function repairOpeningGenerationCandidate(
  raw: unknown,
): { readonly candidate: OpeningGenerationCandidate | null; readonly repaired: boolean } {
  if (!isRecord(raw)) return { candidate: null, repaired: false };
  if (!hasOnlyKnownOpeningCandidateKeys(raw)) return { candidate: null, repaired: false };
  let repaired = false;

  const fixArray = (v: unknown): readonly unknown[] => {
    if (Array.isArray(v)) return v;
    repaired = true;
    return [];
  };
  const fixString = (v: unknown): string => {
    if (typeof v === "string" && v !== "") return v;
    repaired = true;
    return "";
  };

  const world = isRecord(raw.world) ? raw.world : null;
  const player = isRecord(raw.player) ? raw.player : null;
  const storyContract = isRecord(raw.storyContract) ? raw.storyContract : null;
  const opening = isRecord(raw.opening) ? raw.opening : null;
  if (world === null || player === null || storyContract === null || opening === null) {
    return { candidate: null, repaired: repaired || true };
  }

  const rawBase = isRecord(player.baseStats) ? player.baseStats : null;
  // 缺省/非法数值回退 fixture 默认（100/10/5），避免 AI 用自定义属性键时生成 0 HP 不可玩开局。
  const pickStat = (key: "hp" | "attack" | "defense", fallback: number): number => {
    const value = rawBase?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    repaired = true;
    return fallback;
  };

  const fixed: Record<string, unknown> = {
    ...raw,
    world: {
      ...world,
      summary: fixString(world.summary),
      tone: fixString(world.tone),
      themes: fixArray(world.themes),
      publicFacts: fixArray(world.publicFacts),
    },
    player: {
      ...player,
      name: fixString(player.name),
      identity: fixString(player.identity),
      backgroundSummary: fixString(player.backgroundSummary),
      baseStats: {
        hp: pickStat("hp", 100),
        attack: pickStat("attack", 10),
        defense: pickStat("defense", 5),
      },
    },
    storyContract: {
      ...storyContract,
      centralConflict: fixString(storyContract.centralConflict),
      endingDirections: fixArray(storyContract.endingDirections),
    },
    opening: {
      location: (() => {
        const location = isRecord(opening.location) ? opening.location : null;
        if (location === null) {
          repaired = true;
          return { name: "", description: "", scale: "town" };
        }
        const name = fixString(location.name);
        const description = fixString(location.description);
        // buildingName 是展示层的同一候选字段。缺省时沿用候选地点名，
        // 不创造新名称，也不把它改成服务端固定建筑名；地点名为空时不补字段，
        // 让下游 parser 正确拒绝这个不可玩的候选。
        const buildingName = typeof location.buildingName === "string" && location.buildingName.trim() !== ""
          ? location.buildingName
          : name === "" ? undefined : name;
        return {
          ...location,
          name,
          description,
          ...(buildingName === undefined ? {} : { buildingName }),
        };
      })(),
      npc: (() => {
        const npc = isRecord(opening.npc) ? opening.npc : null;
        if (npc === null) {
          repaired = true;
          return { name: "", role: "", description: "", knownFactKeys: [], privateFactKeys: [] };
        }
        return {
          ...npc,
          name: fixString(npc.name),
          role: fixString(npc.role),
          description: fixString(npc.description),
          knownFactKeys: fixArray(npc.knownFactKeys),
          privateFactKeys: fixArray(npc.privateFactKeys),
        };
      })(),
      ...(opening.item === undefined ? {} : { item: opening.item }),
      quest: (() => {
        const quest = isRecord(opening.quest) ? opening.quest : null;
        if (quest === null) {
          repaired = true;
          return { name: "", description: "", objective: { kind: "talk_to_opening_npc" } };
        }
        return {
          ...quest,
          name: fixString(quest.name),
          description: fixString(quest.description),
        };
      })(),
      situation: opening.situation,
      ...(opening.variationProfile === undefined ? {} : { variationProfile: opening.variationProfile }),
    },
  };

  const parsed = parseOpeningGenerationCandidate(fixed);
  if (!parsed.ok) return { candidate: null, repaired: repaired || true };
  return { candidate: parsed.value, repaired };
}

// 引用完整性修复：过滤 NPC known/private fact keys 中不存在于 publicFacts 的
// 悬空引用。不新增实体、不修改文本，仅保证引用闭合，属无创意修复。
export function sanitizeOpeningFactReferences(
  candidate: OpeningGenerationCandidate,
): OpeningGenerationCandidate {
  const factKeys = new Set(candidate.world.publicFacts.map((fact) => fact.key));
  const known = candidate.opening.npc.knownFactKeys.filter((key) => factKeys.has(key));
  const privateKeys = candidate.opening.npc.privateFactKeys.filter((key) => factKeys.has(key));
  if (known.length === candidate.opening.npc.knownFactKeys.length
    && privateKeys.length === candidate.opening.npc.privateFactKeys.length) {
    return candidate;
  }
  return {
    ...candidate,
    opening: {
      ...candidate.opening,
      npc: { ...candidate.opening.npc, knownFactKeys: known, privateFactKeys: privateKeys },
    },
  };
}

export type OpeningGenerationSourceDeps = {
  readonly transport?: AiTransport;
  readonly config?: AiTransportConfig;
  /** Shared RPG client supplied by the server composition root. */
  readonly aiClient?: RpgAiClient;
  readonly jsonMode?: ProviderJsonMode;
  readonly logger?: GameLogger;
};

export const LIVE_OPENING_MAX_TOKENS = RPG_AI_DEFAULT_POLICIES.opening.maxTokens ?? 0;

// live 开局源：AI 产出 → parse → 机械修复 → 引用修复 → 校验 → 成功返回 generated candidate。
// 失败抛出携带稳定 kind 的 AiGenerationError，不调用 generateFallback。
export function createOpeningGenerationSource(
  deps: OpeningGenerationSourceDeps,
): OpeningGenerationSource {
  const { transport, config, logger, jsonMode } = deps;
  const aiClient = deps.aiClient ?? (transport && config
    ? createRpgAiClient({
      transport,
      config,
      logger,
      policies: { opening: { jsonMode: jsonMode ?? "prompt_only" } },
    })
    : undefined);

  const failOpening = (category: Parameters<typeof classifyAiFailure>[0]["category"]): AiGenerationError => {
    const { failure } = createAiSourceFailure("opening", category);
    return new AiGenerationError(failure.kind, "opening", `opening generation failed: ${category}`);
  };

  return {
    async generate(input) {
      if (!aiClient) {
        throw failOpening("unavailable");
      }

      let result: Awaited<ReturnType<typeof aiClient.complete>>;
      try {
        result = await aiClient.complete("opening", [
          { role: "system", content: buildOpeningPrompt(input) },
          { role: "user", content: `生成游戏类型 ${input.gameType} / 长度 ${input.gameLength} / 种子 ${input.seed} / 尝试 ${input.attempt ?? 0} 的开场切片。` },
        ], {
          purpose: "opening_generation",
          trigger: "new_game",
          ...(input.auditLink ?? {}),
          action: {
            kind: "new_game",
            gameType: input.gameType,
            gameLength: input.gameLength,
            attempt: input.attempt ?? 0,
          },
        });
      } catch (error) {
        if (error instanceof AiGenerationError) throw error;
        logger?.warn("opening_generation_transport_failed", { message: (error as Error)?.message });
        throw failOpening("unknown");
      }

      if (!result.ok) {
        logger?.warn("opening_generation_ai_failed", { code: result.code });
        throw failOpening(transportFailureCodeToCategory(result.code));
      }
      const parsed = parseStructuredJsonObject(result.content);
      if (!parsed.ok) {
        logger?.warn("opening_generation_parse_failed", { reason: "json_parse_error" });
        throw failOpening(parsed.reason === "root_not_object" ? "invalid_schema" : "invalid_json");
      }
      if (parsed.normalization === "json_fence") {
        logger?.warn("opening_generation_json_fence_normalized");
      }

      // 机械修复（无创意）后走同一 schema parser + validator。
      const repaired = repairOpeningGenerationCandidate(parsed.value);
      if (repaired.candidate === null) {
        logger?.warn("opening_generation_repair_failed", { reason: "schema_invalid" });
        throw failOpening("invalid_schema");
      }

      // 引用完整性修复（无创意）：NPC fact key 必须存在于 publicFacts，
      // 删除悬空引用不改剧情语义，避免整局回退 fixture 丢失玩家世界观。
      const sanitized = sanitizeOpeningFactReferences(repaired.candidate);

      const validated = validateOpeningGenerationCandidate(sanitized, {
        gameLength: input.gameLength,
        targetActs: TARGET_ACTS[input.gameLength],
      });
      if (!validated.ok) {
        logger?.warn("opening_generation_validation_failed", {
          reason: validated.issues[0]?.code ?? "unknown",
          issueCount: validated.issues.length,
        });
        throw failOpening("invalid_schema");
      }
      // 玩家开局配置是权威输入；实体名、地点和任务仍来自本次 AI 候选，
      // 不在服务端用另一套硬编码内容覆盖候选。
      if (input.setup !== undefined) {
        const candidate = validated.validated;
        return {
          ...candidate,
          player: {
            ...candidate.player,
            name: input.setup.characterName,
            identity: input.setup.characterIdentity,
            backgroundSummary: input.setup.characterProfile ?? candidate.player.backgroundSummary,
          },
        };
      }
      return validated.validated;
    },
  };
}

function buildOpeningPrompt(input: {
  gameType: string;
  gameLength: GameLength;
  seed: string;
  setup?: GameSetup;
  novelty?: OpeningNoveltyContext;
  attempt?: number;
}): string {
  const targetActs = TARGET_ACTS[input.gameLength];
  const setup = input.setup;
  const setupSection = setup === undefined
    ? ""
    : (() => {
        const policy = buildStylePolicy(setup);
        return `
玩家已提交开局配置，开场切片必须围绕它构建：
- 主角姓名：${setup.characterName}（player.name 必须原样返回，不得更改）
- 主角身份/职业：${setup.characterIdentity}（player.identity 必须原样返回）
${setup.characterProfile !== undefined && setup.characterProfile !== "" ? `- 主角背景（写入 player.backgroundSummary）：${setup.characterProfile}\n` : ""}- 世界观背景（world.summary/publicFacts/开场地点与 NPC 设定必须与之吻合）：${setup.worldPremise}
- 故事开端（开场地点、开场 NPC 与首个任务必须服务于这个开端）：${setup.storyOpening}
- 叙事风格：${policy.narration}（所有文本描述遵循该风格）
- 角色标签：${policy.protagonistTraits.join("、") || "无"}（只影响呈现风格，不得改变规则数值）
- 内容强度：${policy.intensity}（影响描写的克制程度，不得改变规则数值）
- 呈现指令：${policy.narrationInstruction}
- 强度指令：${policy.intensityInstruction}
`;
      })();
  const noveltySection = input.novelty === undefined || input.novelty.recent.length === 0
    ? ""
    : `
近期同题材开局摘要（用于避免故事结构雷同，不得复制名称、角色功能、线索类型和冲突组合）：
${input.novelty.recent.map((record) => `- ${record.summary}`).join("\n")}
本次是第 ${input.novelty.attempt + 1} 次生成尝试。请主动改变开局的场景框架、NPC 功能、线索类型或冲突方式；名称可以自由创作，不能用简单改名伪造差异。
`;
  return `你是一个 RPG 世界设计师。只生成游戏的开场切片，返回严格 JSON（fact key 为普通字符串；实体 ID 一律由服务端铸造，你不得提供实体 ID）。
游戏类型：${input.gameType}
游戏长度：${input.gameLength}
种子：${input.seed}
${setupSection}${noveltySection}
要求：
1. world：summary/tone/themes/publicFacts（key 必须形如 fact_xxx，且全局唯一）
2. player：name/identity/backgroundSummary；战斗属性由服务端规则配置，禁止生成 baseStats
3. prologue：故事序幕（2-3 句），聚焦故事钩子、主角动机和背景冲突：说明主角为什么会来到这条故事线上、什么未解事件或危险正在逼近、以及为什么值得继续行动。它可以提及已确定的世界背景，但不是当前地点的感官镜头；不要描写雨声、光线、气味、脚步、材质等即时细节，不要写 NPC 台词、玩家选项或完整场景表演
4. storyContract：version=1、targetActs=${targetActs}（必须与档位一致）、centralConflict、endingDirections 恰好两个（key 分别为 "trust" 与 "doubt"）。递送型开局可增加 delivery={itemKey,recipientKey,verificationFactKeys}；这些都是本地 key，verificationFactKeys 必须来自 publicFacts。
5. opening.location：开场地点，scale 必须是 "town"（小镇层级），buildingName 是该地点中承载首个 NPC 的剧情建筑名
6. opening.npc：开场焦点 NPC，knownFactKeys/privateFactKeys 必须且只能引用 world.publicFacts 中已定义的 fact key；必须提供完整 anchors；goals 必须是 typed creation proposals。goalId/status 由服务端生成，禁止输出
7. opening.item：仅当玩家故事开端明确包含递送物品时输出一件唯一任务物品，字段为 key/name/description/kind/tags，key 必须与 delivery.itemKey 相同；owner 固定由服务端编译为玩家。其它开局不得生成物品。
8. opening.quest：首个主线任务，objective 只能是 { "kind": "talk_to_opening_npc" }
9. opening.variationProfile：只描述结构差异，四个字段必须从以下枚举中各选一个：
   sceneFrame = street | market | inn | outskirts | station | workshop | shrine | other
   npcArchetype = witness | keeper | courier | merchant | official | craftsperson | guide | other
   leadType = trace | document | testimony | token | message | object | other
   conflictMode = concealment | misdirection | dispute | pursuit | betrayal | other

不得生成未来：不得输出任何未来地点、未来 NPC、未来任务、敌人或结局；除上述递送型开局明确建立的唯一任务物品外，不输出物品。世界只存在开场切片的这一个地点、一个 NPC、一个任务。
叙事职责边界：prologue 只回答“为什么要继续这段故事”，通过故事钩子、人物动机和背景冲突建立期待；不要抢写首个场景的空间氛围或即时感官体验，首个场景的 atmosphere 段由场景表演源负责。
必须严格使用以下字段名与嵌套结构（禁止改名）：
{
  "world": { "summary": "...", "tone": "...", "themes": ["..."], "publicFacts": [{ "key": "fact_xxx", "text": "..." }] },
  "player": { "name": "...", "identity": "...", "backgroundSummary": "..." },
  "prologue": "...",
  "storyContract": { "version": 1, "targetActs": ${targetActs}, "centralConflict": "...", "endingDirections": [{ "key": "trust", "theme": "..." }, { "key": "doubt", "theme": "..." }] },
  "opening": {
    "location": { "name": "...", "description": "...", "buildingName": "...", "scale": "town" },
    "npc": {
      "name": "...", "role": "...", "description": "...", "knownFactKeys": ["fact_xxx"], "privateFactKeys": [],
      "anchors": { "selfConcept": "...", "values": ["..."], "speechStyle": "...", "capabilityBoundaries": ["..."], "taboos": [] },
      "goals": [{ "horizon": "short", "description": "...", "priority": 3, "reason": "..." }]
    },
    "item": { "key": "sealed_letter", "name": "...", "description": "...", "kind": "quest_item", "tags": ["return_required"] },
    "quest": { "name": "...", "description": "...", "objective": { "kind": "talk_to_opening_npc" } },
    "variationProfile": { "sceneFrame": "street", "npcArchetype": "witness", "leadType": "trace", "conflictMode": "concealment" }
  }
}
只返回 JSON，不要其他文字。`;
}
