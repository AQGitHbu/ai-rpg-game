import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { WorldGenerationSource } from "../../createGame";
import type { WorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import { parseWorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import { validateWorldGenerationCandidate } from "@/game/gameplay/rpg/worldGeneration";
import { createFixtureWorldSource } from "../../createGame";

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
  const baseStats = {
    hp: typeof rawBase === "object" && rawBase !== null && !Array.isArray(rawBase) && typeof (rawBase as Record<string, unknown>).hp === "number"
      ? (rawBase as Record<string, unknown>).hp as number
      : (repaired = true, 0),
    attack: typeof rawBase === "object" && rawBase !== null && !Array.isArray(rawBase) && typeof (rawBase as Record<string, unknown>).attack === "number"
      ? (rawBase as Record<string, unknown>).attack as number
      : (repaired = true, 0),
    defense: typeof rawBase === "object" && rawBase !== null && !Array.isArray(rawBase) && typeof (rawBase as Record<string, unknown>).defense === "number"
      ? (rawBase as Record<string, unknown>).defense as number
      : (repaired = true, 0),
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
    locations: fixArray(record.locations),
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
        const result = await transport.complete(config, [
          { role: "system", content: buildWorldPrompt(input) },
          { role: "user", content: `生成游戏类型 ${input.gameType} / 长度 ${input.gameLength} / 种子 ${input.seed} 的世界。` },
        ], { timeoutMs: 120_000 });

        if (!result.ok) {
          logger?.warn("world_generation_ai_failed", { code: result.code });
          return fixture.generate(input);
        }
        const parsed = parseJsonResponse(result.content);
        if (parsed === null) {
          logger?.warn("world_generation_parse_failed");
          return fixture.generate(input);
        }

        // 机械修复（无创意）后走同一 schema parser + validator。
        const repaired = repairWorldGenerationCandidate(parsed);
        if (repaired.candidate === null) {
          logger?.warn("world_generation_repair_failed");
          return fixture.generate(input);
        }

        const validated = validateWorldGenerationCandidate(repaired.candidate);
        if (!validated.ok) {
          logger?.warn("world_generation_validation_failed");
          return fixture.generate(input);
        }
        return validated.validated;
      } catch (error) {
        logger?.warn("world_generation_transport_failed", { message: (error as Error)?.message });
        return fixture.generate(input);
      }
    },
  };
}

function buildWorldPrompt(input: { gameType: string; gameLength: string; seed: string }): string {
  return `你是一个 RPG 世界设计师。生成完整游戏世界，返回严格 JSON（ID 为普通字符串，非品牌化）。
游戏类型：${input.gameType}
游戏长度：${input.gameLength}
种子：${input.seed}

要求：
1. world：summary/tone/themes/publicFacts/hiddenFacts/tags
2. player：name/identity/backgroundSummary/startingLocationId/startingItemIds/baseStats
3. startAnchor：locationId/npcId/startQuestId/mainThreadId
4. locations：3-5 个互相连接（connectedLocationIds 可达网络）
5. npcs：3-6 个，knownFactIds/hiddenFactIds 引用 world facts
6. items：1-3 个
7. quests：≥1 主线（kind=main, stage=1）+ 0-2 支线（kind=side）
8. endings：≥2 个语义不同、requirements 非空的结局
9. openingBudget：各实体计数

只返回 JSON，不要其他文字。`;
}
