import { createOpenAiCompatibleTransport, type AiMessage, type AiTransport, type AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import type { WorldGenerationSource } from "../../createGameV2";
import type { SceneSource, SceneSourceContext, SceneSourceResult } from "../../sceneSource";
import type { NarrativeSceneState, NarrativeChoiceState, NarrativeEventState, NarrativeEmotion, NarrativeNpcLineState } from "@/game/domain/narrative";
import { NARRATIVE_EMOTIONS, buildNpcDialoguePages, type NpcDialogueInScene } from "@/game/domain/narrative";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { LocationEntry, NpcEntry, ItemEntry } from "@/game/domain/worldState";
import type { GameTypeId, GameLength } from "@/game/domain/newGame";
import { asLocationId, asNpcId, asItemId } from "@/game/domain/scenarioBlueprint";
import { createFixtureWorldSource } from "../../createGameV2";
import { createDeterministicSceneSource } from "../../deterministicSceneSource";

// ---------------------------------------------------------------------------
// V2 AI source 工厂：根据 AI 运行时配置注入 live 或 fixture/deterministic source。
// 复用 V1 的 AI transport 和 config 解析（spec §13 AI 可注入与离线基线）。
// ---------------------------------------------------------------------------

function parseJsonResponse(text: string): unknown {
  // Try direct JSON parse first
  try {
    return JSON.parse(text);
  } catch {
    // Try extracting from ```json code fence
    const match = text.match(/```json\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        // fall through
      }
    }
    return null;
  }
}

// --- Live World Generation Source ---

function createLiveWorldGenerationSource(
  transport: AiTransport,
  config: AiTransportConfig,
  logger?: GameLogger,
): WorldGenerationSource {
  const fixture = createFixtureWorldSource();
  return {
    async generate(input) {
      try {
        const systemPrompt = `你是一个 RPG 世界设计师。根据以下要求生成一个完整的游戏世界，返回 JSON 格式。

游戏类型：${input.gameType}
游戏长度：${input.gameLength}
种子：${input.seed}

要求：
1. 生成 3-5 个互相连接的地点
2. 生成 3-6 个 NPC，分布在各个地点
3. 生成 1-3 个物品
4. 玩家有名字、身份、属性
5. 所有地点都要有 connectedLocationIds 形成可达网络

返回严格 JSON，格式如下：
{
  "locations": [{ "id": "loc_xxx", "name": "...", "description": "...", "kind": "main", "connectedLocationIds": ["loc_yyy"], "npcIds": ["npc_zzz"], "availableItemIds": [], "tags": [] }],
  "npcs": [{ "id": "npc_xxx", "name": "...", "role": "...", "description": "...", "locationId": "loc_xxx", "isCompanion": false, "tags": [], "met": false, "memory": { "npcId": "npc_xxx", "knownFactIds": [], "hiddenFactIds": [], "interactionHistory": [], "relationship": { "affinity": 0 }, "emotion": "neutral", "goals": [] } }],
  "items": [{ "id": "item_xxx", "name": "...", "description": "...", "kind": "key", "tags": [] }],
  "startingLocationId": "loc_xxx",
  "player": { "name": "...", "identity": "...", "stats": { "hp": 100, "attack": 10, "defense": 5 } }
}

确保 ID 唯一且互相引用正确。只返回 JSON，不要其他文字。`;

        const messages: readonly AiMessage[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: `请生成一个${input.gameType}类型的世界。` },
        ];

        const result = await transport.complete(config, messages, {
          timeoutMs: 120_000,
        });

        if (!result.ok) {
          logger?.warn("v2_world_generation_ai_failed", { code: result.code });
          return fixture.generate(input);
        }

        const parsed = parseJsonResponse(result.content);
        if (parsed === null || typeof parsed !== "object") {
          logger?.warn("v2_world_generation_parse_failed");
          return fixture.generate(input);
        }

        const data = parsed as Record<string, unknown>;
        const locations = Array.isArray(data.locations) ? data.locations as readonly LocationEntry[] : [];
        const npcs = Array.isArray(data.npcs) ? data.npcs as readonly NpcEntry[] : [];
        const items = Array.isArray(data.items) ? data.items as readonly ItemEntry[] : [];
        const startingLocationId = data.startingLocationId;
        const player = data.player as { name: string; identity: string; stats: { hp: number; attack: number; defense: number } };

        if (locations.length === 0 || !startingLocationId || !player) {
          logger?.warn("v2_world_generation_invalid_data");
          return fixture.generate(input);
        }

        return {
          locations: locations.map((l) => ({
            ...l,
            id: asLocationId(String(l.id)),
            connectedLocationIds: (l.connectedLocationIds ?? []).map((id: unknown) => asLocationId(String(id))),
            npcIds: (l.npcIds ?? []).map((id: unknown) => asNpcId(String(id))),
            availableItemIds: (l.availableItemIds ?? []).map((id: unknown) => asItemId(String(id))),
          })),
          npcs: npcs.map((n) => ({
            ...n,
            id: asNpcId(String(n.id)),
            locationId: asLocationId(String(n.locationId)),
            memory: n.memory ?? { npcId: n.id, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
          })),
          items: items.map((i) => ({
            ...i,
            id: asItemId(String(i.id)),
          })),
          startingLocationId: asLocationId(String(startingLocationId)),
          player,
        };
      } catch (error) {
        logger?.error("v2_world_generation_error", { error: error instanceof Error ? error.message : "unknown" });
        return fixture.generate(input);
      }
    },
  };
}

// --- Live Scene Source ---

export type LiveNpcLineCandidate = {
  readonly npcId: string;
  readonly text: string;
  readonly emotion: string;
};

/**
 * 归一化 AI 返回的 npcLine：npcId 必须真实存在于在场 NPC、text 非空、
 * emotion 收敛到合法枚举，否则返回 null（调用方用确定性兜底）。
 * 纯函数：零 AI / IO / 随机。
 */
export function resolveLiveNpcLine<TNpcId>(
  candidate: LiveNpcLineCandidate | null,
  presentNpcs: readonly { readonly id: TNpcId }[],
): { readonly npcId: TNpcId; readonly text: string; readonly emotion: NarrativeEmotion } | null {
  if (candidate === null || typeof candidate !== "object") return null;
  if (typeof candidate.npcId !== "string" || typeof candidate.text !== "string") return null;
  if (candidate.text.trim() === "") return null;
  const presentNpc = presentNpcs.find((npc) => String(npc.id) === candidate.npcId);
  if (presentNpc === undefined) return null;
  const emotion = NARRATIVE_EMOTIONS.includes(candidate.emotion as NarrativeEmotion)
    ? (candidate.emotion as NarrativeEmotion)
    : "neutral";
  return { npcId: presentNpc.id, text: candidate.text.trim(), emotion };
}

function createLiveSceneSource(
  transport: AiTransport,
  config: AiTransportConfig,
  logger?: GameLogger,
): SceneSource {
  const fallback = createDeterministicSceneSource();
  return {
    async generateScene(context: SceneSourceContext): Promise<SceneSourceResult> {
      try {
        const { worldState: ws, storyState: ss, resolvedEvent } = context;
        const currentLoc = ws.locations.find((l) => l.id === ws.currentLocationId);
        const npcsHere = ws.npcs.filter((n) => n.locationId === ws.currentLocationId);

        const systemPrompt = `你是一个 RPG 叙事设计师。根据当前游戏状态生成一个场景，返回 JSON 格式。

当前地点：${currentLoc?.name ?? "未知"}
地点描述：${currentLoc?.description ?? ""}
当前幕数：${ss.currentAct}/${ss.targetActs}
张力值：${ss.tension}
节奏需要：${ss.nextPacingNeed}
玩家行动类型：${resolvedEvent.actionId}

在场 NPC：${npcsHere.map((n) => `${n.name}(${n.role})`).join("、") || "无"}

可移动地点：${ws.locations
  .filter((l) => currentLoc?.connectedLocationIds.includes(l.id))
  .map((l) => l.name)
  .join("、") || "无"}

返回严格 JSON，格式如下：
{
  "narration": "场景旁白文字（2-4句）",
  "npcLine": { "npcId": "在场NPC的ID", "text": "NPC说的台词", "emotion": "neutral" },
  "choices": [
    { "label": "选项1文字", "actionKey": "explore" },
    { "label": "选项2文字", "actionKey": "move:目标地点ID" }
  ]
}

choices 必须恰好 2 个。actionKey 可以是 "explore"、"move:地点ID"、"talk:NPC_ID" 等。
只返回 JSON，不要其他文字。`;

        const messages: readonly AiMessage[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: resolvedEvent.actionId },
        ];

        const result = await transport.complete(config, messages, {
          timeoutMs: 120_000,
        });

        if (!result.ok) {
          logger?.warn("v2_scene_generation_ai_failed", { code: result.code });
          return fallback.generateScene(context);
        }

        const parsed = parseJsonResponse(result.content);
        if (parsed === null || typeof parsed !== "object") {
          logger?.warn("v2_scene_generation_parse_failed");
          return fallback.generateScene(context);
        }

        const data = parsed as Record<string, unknown>;
        const narration = typeof data.narration === "string" ? data.narration : "";
        const rawNpcLine = data.npcLine as { npcId: string; text: string; emotion: string } | null;
        const choices = Array.isArray(data.choices) ? data.choices as { label: string; actionKey: string }[] : [];

        if (narration === "" || choices.length < 2) {
          logger?.warn("v2_scene_generation_invalid_data");
          return fallback.generateScene(context);
        }

        const sceneId = `scene-${ws.eventLedger.length}-${Date.now()}`;
        const turn = ws.eventLedger.length;
        const firstNpc = npcsHere[0];

        // AI 的 npcLine 必须归属在场 NPC 且 emotion 合法；无效时回退确定性台词。
        const resolvedLine = resolveLiveNpcLine(rawNpcLine, npcsHere);
        const npcLine: NarrativeNpcLineState | null = resolvedLine !== null
          ? { npcId: resolvedLine.npcId, text: resolvedLine.text, emotion: resolvedLine.emotion, usedFactIds: [] }
          : null;

        // 焦点 NPC 与有效 npcLine 对齐，避免 event 与台词指向不同的 NPC。
        const event: NarrativeEventState | undefined = firstNpc !== undefined
          ? { kind: "dialogue", focusNpcId: resolvedLine?.npcId ?? firstNpc.id }
          : { kind: "observe", locationId: ws.currentLocationId };
        const npcDialogues: readonly NpcDialogueInScene[] = npcsHere.length > 0
          ? buildNpcDialoguePages(npcsHere, {
              focusNpcId: resolvedLine?.npcId,
              focusSpeech: resolvedLine?.text,
            })
          : [];
        const scene: NarrativeSceneState = {
          sceneId,
          turn,
          narration,
          event,
          usedFactIds: [],
          source: "generated",
          npcLine,
          ...(npcsHere.length > 0 ? { npcDialogues } : {}),
          choices: [
            {
              choiceToken: `choice_${sceneId}_0`,
              label: choices[0]?.label ?? "探索",
              actionKey: choices[0]?.actionKey ?? "explore",
            },
            {
              choiceToken: `choice_${sceneId}_1`,
              label: choices[1]?.label ?? "查看四周",
              actionKey: choices[1]?.actionKey ?? "explore",
            },
          ] as readonly [{ choiceToken: string; label: string; actionKey: string }, { choiceToken: string; label: string; actionKey: string }],
        };

        return {
          scene,
          eventProposals: [],
          source: "generated",
        };
      } catch (error) {
        logger?.error("v2_scene_generation_error", { error: error instanceof Error ? error.message : "unknown" });
        return fallback.generateScene(context);
      }
    },
  };
}

// --- Factory ---

export function createV2WorldGenerationSource(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
): WorldGenerationSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "available") {
    logger?.info("v2_world_source_live", { model: runtime.config.model });
    return createLiveWorldGenerationSource(
      createOpenAiCompatibleTransport(),
      runtime.config,
      logger,
    );
  }
  logger?.info("v2_world_source_fixture", { diagnostics: runtime.diagnostics });
  return createFixtureWorldSource();
}

export function createV2SceneSource(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
): SceneSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "available") {
    logger?.info("v2_scene_source_live", { model: runtime.config.model });
    return createLiveSceneSource(
      createOpenAiCompatibleTransport(),
      runtime.config,
      logger,
    );
  }
  logger?.info("v2_scene_source_deterministic", { diagnostics: runtime.diagnostics });
  return createDeterministicSceneSource();
}
