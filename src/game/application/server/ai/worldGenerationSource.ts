import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { WorldGenerationSource } from "../../createGame";
import type { WorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import type { GameLength, GameSetup } from "@/game/domain/newGame";
import { parseWorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import { validateWorldGenerationCandidate } from "@/game/gameplay/rpg/worldGeneration";
import { createFixtureWorldSource } from "../../createGame";
import { TARGET_ACTS } from "@/game/domain/storyBudget";

// ---------------------------------------------------------------------------
// 世界生成源（live/fixture）。
//
// 编排：AI 原始 JSON → schema parse → 机械修复（无创意）→ 纯 validator →
// 确定性 fallback（必须通过同一 validator/compiler）。
// 机械修复只允许 ID 格式/空数组/显式可推导引用等无创意修复；不得修改剧情语义
// 来“让测试通过”。敏感信息不进入日志。
// ---------------------------------------------------------------------------

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```json\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// 机械修复：只做无创意、可推导的修复。返回是否发生变更。
//   - 数组字段为 null/非数组 → 空数组；
//   - 字符串字段为 null/非字符串 → 空字符串；
//   - 数值字段非法 → 0；
//   不修改剧情语义、不新增/删除实体、不重写文本。
export function repairWorldGenerationCandidate(
  raw: unknown,
): { readonly candidate: WorldGenerationCandidate | null; readonly repaired: boolean } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { candidate: null, repaired: false };
  }
  const record = raw as Record<string, unknown>;
  let repaired = false;

  const fixArray = (v: unknown): readonly unknown[] => {
    if (Array.isArray(v)) return v;
    repaired = true;
    return [];
  };
  const fixString = (v: unknown): string => {
    if (typeof v === "string") return v;
    repaired = true;
    return "";
  };

  const world: Record<string, unknown> | null = typeof record.world === "object" && record.world !== null
    ? record.world as Record<string, unknown> : null;
  const player: Record<string, unknown> | null = typeof record.player === "object" && record.player !== null
    ? record.player as Record<string, unknown> : null;
  const startAnchor: Record<string, unknown> | null = typeof record.startAnchor === "object" && record.startAnchor !== null
    ? record.startAnchor as Record<string, unknown> : null;

  if (world === null || player === null || startAnchor === null) {
    return { candidate: null, repaired: repaired || true };
  }

  const rawBase = player.baseStats;
  const rawBaseRecord = typeof rawBase === "object" && rawBase !== null && !Array.isArray(rawBase)
    ? rawBase as Record<string, unknown>
    : null;
  // 缺省/非法数值回退同一 fixture 默认（100/10/5），避免 AI 用自定义属性键时生成 0 HP 不可玩开局。
  const pickStat = (key: "hp" | "attack" | "defense", fallback: number): number => {
    const value = rawBaseRecord?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    repaired = true;
    return fallback;
  };
  const baseStats = {
    hp: pickStat("hp", 100),
    attack: pickStat("attack", 10),
    defense: pickStat("defense", 5),
  };
  const worldFixed: Record<string, unknown> = {
    ...world,
    summary: fixString(world.summary),
    tone: fixString(world.tone),
    themes: fixArray(world.themes),
    tags: fixArray(world.tags),
    publicFacts: fixArray(world.publicFacts),
    hiddenFacts: fixArray(world.hiddenFacts),
  };
  const playerFixed: Record<string, unknown> = {
    ...player,
    name: fixString(player.name),
    identity: fixString(player.identity),
    backgroundSummary: fixString(player.backgroundSummary),
    startingLocationId: fixString(player.startingLocationId),
    startingItemIds: fixArray(player.startingItemIds),
    baseStats,
  };
  const anchorFixed: Record<string, unknown> = {
    ...startAnchor,
    locationId: fixString(startAnchor.locationId),
    npcId: fixString(startAnchor.npcId),
    startQuestId: fixString(startAnchor.startQuestId),
    mainThreadId: fixString(startAnchor.mainThreadId),
  };
  const openingBudget = typeof record.openingBudget === "object" && record.openingBudget !== null
    ? record.openingBudget as Record<string, unknown> : null;

  const fixed: Record<string, unknown> = {
    ...record,
    world: worldFixed,
    player: playerFixed,
    startAnchor: anchorFixed,
    locations: fixArray(record.locations).map((entry) => {
      // scale 白名单化：非法值视为缺省（scene），避免脏值流入 WorldState。
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
      const location = entry as Record<string, unknown>;
      if (location.scale !== "town" && location.scale !== "scene" && location.scale !== undefined) {
        repaired = true;
        const { scale: _ignored, ...rest } = location;
        return rest;
      }
      return entry;
    }),
    npcs: fixArray(record.npcs),
    items: fixArray(record.items),
    enemies: fixArray(record.enemies),
    factions: fixArray(record.factions),
    quests: fixArray(record.quests),
    endings: fixArray(record.endings),
    openingBudget: openingBudget ?? { locationsCount: 0, npcsCount: 0, sideQuestsCount: 0, endingsCount: 0, townLocationsCount: 0 },
  };

  const parsed = parseWorldGenerationCandidate(fixed);
  if (!parsed.ok) return { candidate: null, repaired: repaired || true };
  return { candidate: parsed.value, repaired };
}

export type WorldGenerationSourceDeps = {
  readonly transport?: AiTransport;
  readonly config?: AiTransportConfig;
  readonly logger?: GameLogger;
};

// live 世界源：AI 产出 → parse → 机械修复 → 校验 → 失败回退 fixture。
// fixture 必须通过同一 validator/compiler（由 createFixtureWorldSource 保证）。
export function createWorldGenerationSource(
  deps: WorldGenerationSourceDeps,
): WorldGenerationSource {
  const fixture = createFixtureWorldSource();
  const { transport, config, logger } = deps;

  return {
    async generate(input) {
      // 无 transport/config：确定性 fallback（fixture 通过同一 validator/compiler）。
      if (!transport || !config) {
        return fixture.generate(input);
      }

      try {
        // 推理模型偶发返回空内容（empty_response）或瞬时超时：
        // 对瞬时失败最多重试一次，仍失败再走确定性 fallback。
        let result = await transport.complete(config, [
          { role: "system", content: buildWorldPrompt(input) },
          { role: "user", content: `生成游戏类型 ${input.gameType} / 长度 ${input.gameLength} / 种子 ${input.seed} 的世界。` },
        ], { timeoutMs: 240_000 });
        if (!result.ok && (result.code === "empty_response" || result.code === "timeout" || result.code === "service_error")) {
          logger?.warn("world_generation_retry", { code: result.code });
          result = await transport.complete(config, [
            { role: "system", content: buildWorldPrompt(input) },
            { role: "user", content: `生成游戏类型 ${input.gameType} / 长度 ${input.gameLength} / 种子 ${input.seed} 的世界。` },
          ], { timeoutMs: 240_000 });
        }

        if (!result.ok) {
          logger?.warn("world_generation_ai_failed", { code: result.code });
          return fixture.generate(input);
        }
        const parsed = parseJsonResponse(result.content);
        if (parsed === null) {
          logger?.warn("world_generation_parse_failed", { reason: "json_parse_error" });
          return fixture.generate(input);
        }

        // 机械修复（无创意）后走同一 schema parser + validator。
        const repaired = repairWorldGenerationCandidate(parsed);
        if (repaired.candidate === null) {
          logger?.warn("world_generation_repair_failed", { reason: classifyRepairFailure(parsed) });
          return fixture.generate(input);
        }

        // 引用完整性修复（无创意）：NPC fact 引用必须存在于 world facts，
        // 删除悬空引用不改剧情语义，避免整局回退 fixture 丢失玩家世界观。
        const sanitized = sanitizeFactReferences(repaired.candidate);

        const validated = validateWorldGenerationCandidate(sanitized, {
          gameLength: input.gameLength,
          targetActs: TARGET_ACTS[input.gameLength],
        });
        if (!validated.ok) {
          logger?.warn("world_generation_validation_failed", {
            reason: validated.issues[0]?.code ?? "unknown",
            issueCount: validated.issues.length,
          });
          return fixture.generate(input);
        }
        // 玩家开局配置是权威输入：无论 AI 返回什么，角色名/身份/背景必须以配置为准。
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
      } catch (error) {
        logger?.warn("world_generation_transport_failed", { message: (error as Error)?.message });
        return fixture.generate(input);
      }
    },
  };
}

// 引用完整性修复：过滤 NPC known/hidden fact 中不存在于 world facts 的悬空引用。
// 不新增实体、不修改文本，仅保证引用闭合，属无创意修复。
export function sanitizeFactReferences(
  candidate: WorldGenerationCandidate,
): WorldGenerationCandidate {
  const factIds = new Set([
    ...candidate.world.publicFacts.map((fact) => fact.id),
    ...candidate.world.hiddenFacts.map((fact) => fact.id),
  ]);
  let changed = false;
  const npcs = candidate.npcs.map((npc) => {
    const known = npc.knownFactIds.filter((id) => factIds.has(id));
    const hidden = npc.hiddenFactIds.filter((id) => factIds.has(id));
    if (known.length === npc.knownFactIds.length && hidden.length === npc.hiddenFactIds.length) {
      return npc;
    }
    changed = true;
    return { ...npc, knownFactIds: known, hiddenFactIds: hidden };
  });
  return changed ? { ...candidate, npcs } : candidate;
}

// 失败分类（只含结构信息，不含玩家内容，可安全入日志）。
function classifyRepairFailure(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "not_object";
  if (Array.isArray(raw)) return "array_root";
  const record = raw as Record<string, unknown>;
  const missing: string[] = [];
  for (const key of ["world", "player", "startAnchor", "locations", "npcs", "quests", "endings"]) {
    if (!(key in record)) missing.push(key);
  }
  return missing.length > 0 ? `missing:${missing.join(",")}` : "schema_invalid";
}

function buildWorldPrompt(input: { gameType: string; gameLength: GameLength; seed: string; setup?: GameSetup }): string {
  const targetActs = TARGET_ACTS[input.gameLength];
  const setup = input.setup;
  const setupSection = setup === undefined
    ? ""
    : `
玩家已提交开局配置，世界必须围绕它构建：
- 主角姓名：${setup.characterName}（player.name 必须原样返回，不得更改）
- 主角身份/职业：${setup.characterIdentity}（player.identity 必须原样返回）
${setup.characterProfile !== undefined && setup.characterProfile !== "" ? `- 主角背景（写入 player.backgroundSummary）：${setup.characterProfile}\n` : ""}- 世界观背景（world.summary/publicFacts/地点与 NPC 设定必须与之吻合）：${setup.worldPremise}
- 故事开端（起始地点、起始 NPC 与首个任务必须服务于这个开端）：${setup.storyOpening}
- 叙事风格：${setup.narrativeStyle}（所有文本描述遵循该风格）
`;
  return `你是一个 RPG 世界设计师。生成完整游戏世界，返回严格 JSON（ID 为普通字符串，非品牌化）。
游戏类型：${input.gameType}
游戏长度：${input.gameLength}
种子：${input.seed}
${setupSection}
要求：
1. world：summary/tone/themes/publicFacts/hiddenFacts/tags
2. player：name/identity/backgroundSummary/startingLocationId/startingItemIds/baseStats
3. startAnchor：locationId/npcId/startQuestId/mainThreadId
4. locations：3-5 个互相连接（connectedLocationIds 可达网络）；起始地点（startAnchor.locationId）必须是 scale "town" 的小镇，其余地点 scale "scene"
5. npcs：3-6 个，knownFactIds/hiddenFactIds 必须且只能引用 world.publicFacts/hiddenFacts 中已定义的 fact id；所有文本中 NPC 名字必须与 npcs[].name 逐字一致，不得使用别名/简称/音近变体
6. items：1-3 个；每件物品必须布点：放入某个地点的 availableItemIds 或 player.startingItemIds；若任务含 obtain_item 目标，对应物品必须布在该幕可达地点
7. enemies：1-2 个，布置在非起始地点，供 defeat_enemy 目标与战斗玩法使用；stats 为小数值（hp 6-30、attack 2-8、defense 0-3）
8. quests：主线必须恰好覆盖 stage 1-${targetActs}，每幕一个可达主任务并逐幕解锁；另可有 0-2 支线；建议至少一个主线任务含 obtain_item 目标（对应物品按第 6 条布点）
9. endings：恰好 2 个结局；两者都只包含同一个终幕 quest_completed 条件和同一 NPC 的一个关系条件，关系条件必须分别为相邻的 at_most / at_least（例如 <=5 与 >=6），不得增加其他条件
10. openingBudget：各实体计数

必须严格使用以下字段名与嵌套结构（禁止改名、禁止用字符串数组替代结构化 objectives）：
{
  "world": { "summary": "...", "tone": "...", "themes": ["..."], "publicFacts": [{ "id": "fact_xxx", "text": "..." }], "hiddenFacts": [{ "id": "fact_yyy", "text": "..." }], "tags": [] },
  "player": { "name": "...", "identity": "...", "backgroundSummary": "...", "startingLocationId": "loc_xxx", "startingItemIds": [], "baseStats": { "hp": 100, "attack": 10, "defense": 5 } },
  "startAnchor": { "locationId": "loc_xxx", "npcId": "npc_xxx", "startQuestId": "quest_act1", "mainThreadId": "thread_main" },
  "locations": [{ "id": "loc_xxx", "name": "...", "description": "...", "kind": "main", "scale": "town", "connectedLocationIds": ["loc_yyy"], "npcIds": ["npc_xxx"], "availableItemIds": [], "tags": [] }],
  "npcs": [{ "id": "npc_xxx", "name": "...", "role": "...", "description": "...", "locationId": "loc_xxx", "isCompanion": false, "knownFactIds": [], "hiddenFactIds": [], "goals": [], "tags": [] }],
  "items": [{ "id": "item_xxx", "name": "...", "description": "...", "kind": "key", "tags": [] }],
  "enemies": [{ "id": "enemy_xxx", "name": "...", "tier": "normal", "stats": { "hp": 8, "attack": 4, "defense": 0 }, "locationId": "loc_xxx", "tags": [] }],
  "factions": [],
  "quests": [{ "id": "quest_act1", "name": "...", "description": "...", "kind": "main", "stage": 1, "objectives": [{ "kind": "talk_to_npc", "npcId": "npc_xxx" }], "onSuccess": { "kind": "unlock_quests", "questIds": ["quest_act2"], "locationIds": ["loc_yyy"] }, "onFailure": { "kind": "closed" }, "tags": ["main"] }],
  "endings": [{ "id": "ending_xxx", "name": "...", "description": "...", "requirements": [{ "kind": "quest_completed", "questId": "quest_act${targetActs}" }, { "kind": "npc_affinity_at_least", "npcId": "npc_xxx", "value": 6 }] }],
  "openingBudget": { "locationsCount": 3, "npcsCount": 4, "sideQuestsCount": 0, "endingsCount": 2, "townLocationsCount": 0 }
}
objectives 只允许：{ "kind": "talk_to_npc", "npcId" } / { "kind": "visit_location", "locationId" } / { "kind": "obtain_item", "itemId" } / { "kind": "defeat_enemy", "enemyId" }。
onSuccess 只允许：{ "kind": "unlock_quests", "questIds", "locationIds"? } 或终幕 { "kind": "reach_ending", "endingId" }。
最后一个主线任务（stage ${targetActs}）的 onSuccess 必须是 reach_ending；它之前的每个主线任务用 unlock_quests 解锁下一幕任务与地点。
确保 ID 唯一且互相引用正确。只返回 JSON，不要其他文字。`;
}
