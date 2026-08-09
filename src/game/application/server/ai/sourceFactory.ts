import { createOpenAiCompatibleTransport, type AiMessage, type AiTransport, type AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import type { WorldGenerationSource } from "../../createGame";
import { parseWorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import type { SceneSource, SceneSourceResult } from "../../sceneSource";
import type { SceneGenerationContext } from "../../sceneGenerationContext";
import type { NarrativeEventState, NarrativeEmotion, NarrativeNpcLineState } from "@/game/domain/narrative";
import { NARRATIVE_EMOTIONS } from "@/game/domain/narrative";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createFixtureWorldSource } from "../../createGame";
import { createWorldGenerationSource as createValidatedWorldGenerationSource } from "./worldGenerationSource";
import { createDeterministicSceneSource } from "../../deterministicSceneSource";
import { createLiveExpansionSource } from "./liveExpansionSource";
import { createFixtureExpansionSource } from "./expansionSource";
import type { ExpansionSource } from "@/game/gameplay/rpg/expansion";
import type { ChoiceProposal } from "@/game/domain/approvedChoice";
import { actionFromLegalCandidate, buildChoiceProposals } from "../../deterministicSceneSource";

// ---------------------------------------------------------------------------
// AI source 工厂：根据运行时配置注入 live 或 fixture/deterministic source。
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
1. 生成 3-5 个互相连接的地点，所有地点 connectedLocationIds 形成可达网络
2. 生成 3-6 个 NPC，分布在各个地点，knownFactIds/hiddenFactIds 引用 world.publicFacts/hiddenFacts
3. 生成 1-3 个物品
4. 玩家有名字、身份、属性、起始物品
5. 世界观含公开事实（publicFacts）与隐藏事实（hiddenFacts）
6. 至少 1 个主线任务（kind=main, stage=1）+ 0-2 个支线（kind=side）
7. 至少 2 个语义不同的结局，每个 requirements 非空
8. startAnchor 指明起始地点/NPC/主线任务/main thread

返回严格 JSON（ID 全部为普通字符串，非品牌化），格式如下：
{
  "world": { "summary": "...", "tone": "...", "themes": ["..."], "publicFacts": [{ "id": "fact_xxx", "text": "..." }], "hiddenFacts": [{ "id": "fact_yyy", "text": "..." }], "tags": [] },
  "player": { "name": "...", "identity": "...", "backgroundSummary": "...", "startingLocationId": "loc_xxx", "startingItemIds": [], "baseStats": { "hp": 100, "attack": 10, "defense": 5 } },
  "startAnchor": { "locationId": "loc_xxx", "npcId": "npc_xxx", "startQuestId": "quest_main", "mainThreadId": "thread_main" },
  "locations": [{ "id": "loc_xxx", "name": "...", "description": "...", "kind": "main", "connectedLocationIds": ["loc_yyy"], "npcIds": ["npc_xxx"], "availableItemIds": [], "tags": [] }],
  "npcs": [{ "id": "npc_xxx", "name": "...", "role": "...", "description": "...", "locationId": "loc_xxx", "isCompanion": false, "knownFactIds": [], "hiddenFactIds": [], "goals": [], "tags": [] }],
  "items": [{ "id": "item_xxx", "name": "...", "description": "...", "kind": "key", "tags": [] }],
  "enemies": [],
  "factions": [],
  "quests": [{ "id": "quest_main", "name": "...", "description": "...", "kind": "main", "stage": 1, "objectives": [{ "kind": "talk_to_npc", "npcId": "npc_xxx" }], "onSuccess": { "kind": "reach_ending", "endingId": "ending_xxx" }, "onFailure": { "kind": "closed" }, "tags": ["main"] }],
  "endings": [{ "id": "ending_xxx", "name": "...", "description": "...", "requirements": [{ "kind": "quest_completed", "questId": "quest_main" }] }],
  "openingBudget": { "locationsCount": 3, "npcsCount": 4, "sideQuestsCount": 0, "endingsCount": 2, "townLocationsCount": 0 }
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
          logger?.warn("world_generation_ai_failed", { code: result.code });
          return fixture.generate(input);
        }

        const parsed = parseJsonResponse(result.content);
        if (parsed === null || typeof parsed !== "object") {
          logger?.warn("world_generation_parse_failed");
          return fixture.generate(input);
        }

        // Step 2.2：AI 原始 JSON 必须经 schema parser，禁止 `as never` 直接断言成 Entry。
        const candidateResult = parseWorldGenerationCandidate(parsed);
        if (!candidateResult.ok) {
          logger?.warn("world_generation_invalid_data", { code: candidateResult.code });
          return fixture.generate(input);
        }
        return candidateResult.value;
      } catch (error) {
        logger?.error("world_generation_error", { error: error instanceof Error ? error.message : "unknown" });
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
    async generateScene(context: SceneGenerationContext): Promise<SceneSourceResult> {
      try {
        const { job, currentLocation, presentNpcs, story } = context;
        const currentLocName = currentLocation.name;
        const npcsHere = presentNpcs;
        const firstNpc = npcsHere[0];
        const hasBattleCandidates = context.legalActionCandidates.some(
          (candidate) => candidate.kind === "battle_action",
        );
        const battleEnemyId = context.legalEventTargets.enemyIds[0];
        const event: NarrativeEventState = hasBattleCandidates && battleEnemyId !== undefined
          ? { kind: "battle", enemyId: battleEnemyId }
          : firstNpc !== undefined
            ? { kind: "dialogue", focusNpcId: firstNpc.id }
            : { kind: "observe", locationId: currentLocation.id };
        const selectable = buildSelectableChoiceProposals(context, event);
        if (selectable.length < 2) return fallback.generateScene(context);

        const systemPrompt = `你是一个 RPG 叙事设计师。根据当前游戏状态生成一个场景，返回 JSON 格式。

当前地点：${currentLocName}
地点描述：${currentLocation.description}
当前幕数：${story.currentAct}/${story.targetActs}
张力值：${story.tension}
节奏需要：${story.nextPacingNeed}
玩家行动类型：${job.resolvedEvent.eventKind}

在场 NPC：${npcsHere.map((n) => `${n.name}(${n.role})`).join("、") || "无"}

服务端候选：${JSON.stringify(selectable.map((entry) => ({ candidateId: entry.candidateId, label: entry.proposal.label })))}

返回严格 JSON，格式如下：
{
  "narration": "场景旁白文字（2-4句）",
  "npcLine": { "npcId": "在场NPC的ID", "text": "NPC说的台词", "emotion": "neutral" },
  "choices": [
    { "label": "选项1文字", "candidateId": "candidate_1" },
    { "label": "选项2文字", "candidateId": "candidate_2" }
  ]
}

choices 必须恰好 2 个，candidateId 必须从服务端候选中选择且不能重复。
只返回 JSON，不要其他文字。`;

        const messages: readonly AiMessage[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: job.actionId },
        ];

        const result = await transport.complete(config, messages, {
          timeoutMs: 120_000,
        });

        if (!result.ok) {
          logger?.warn("scene_generation_ai_failed", { code: result.code });
          return fallback.generateScene(context);
        }

        const parsed = parseJsonResponse(result.content);
        if (parsed === null || typeof parsed !== "object") {
          logger?.warn("scene_generation_parse_failed");
          return fallback.generateScene(context);
        }

        const data = parsed as Record<string, unknown>;
        const narration = typeof data.narration === "string" ? data.narration : "";
        const rawNpcLine = data.npcLine as { npcId: string; text: string; emotion: string } | null;
        const choices = Array.isArray(data.choices) ? data.choices as { label: string; candidateId: string }[] : [];

        if (narration === "" || choices.length !== 2) {
          logger?.warn("scene_generation_invalid_data");
          return fallback.generateScene(context);
        }

        // sceneId/turn 从 job 纯函数派生：不读时钟、不依赖 eventLedger 长度。
        const sceneId = `scene-${job.jobId}`;
        const turn = job.turnNumber;
        // AI 的 npcLine 必须归属在场 NPC 且 emotion 合法；无效时回退确定性台词。
        const resolvedLine = resolveLiveNpcLine(rawNpcLine, npcsHere);
        const npcLine: NarrativeNpcLineState | null = resolvedLine !== null
          ? { npcId: resolvedLine.npcId, text: resolvedLine.text, emotion: resolvedLine.emotion, usedFactIds: [] }
          : null;

        const choiceProposals = resolveSelectedChoiceProposals(selectable, choices);
        if (choiceProposals === null) {
          logger?.warn("scene_generation_invalid_choice_ids");
          return fallback.generateScene(context);
        }

        return {
          sceneId,
          turn,
          narration,
          event,
          source: "generated",
          npcLine,
          choiceProposals,
          eventProposals: [],
        };
      } catch (error) {
        logger?.error("scene_generation_error", { error: error instanceof Error ? error.message : "unknown" });
        return fallback.generateScene(context);
      }
    },
  };
}

type SelectableChoiceProposal = {
  readonly candidateId: string;
  readonly proposal: ChoiceProposal;
};

function buildSelectableChoiceProposals(
  context: SceneGenerationContext,
  event: NarrativeEventState,
): readonly SelectableChoiceProposal[] {
  const proposals: readonly ChoiceProposal[] = event.kind === "dialogue"
    ? buildChoiceProposals(context, event)
    : context.legalActionCandidates.flatMap((candidate) => {
        const action = actionFromLegalCandidate(candidate);
        return action === null ? [] : [{ label: candidate.label, action }];
      });
  return proposals.map((proposal, index) => ({ candidateId: `candidate_${index + 1}`, proposal }));
}

export function resolveSelectedChoiceProposals(
  selectable: readonly SelectableChoiceProposal[],
  selected: readonly { readonly label: string; readonly candidateId: string }[],
): readonly [ChoiceProposal, ChoiceProposal] | null {
  if (selected.length !== 2 || selected[0]!.candidateId === selected[1]!.candidateId) return null;
  const resolved = selected.map((choice) => {
    const match = selectable.find((candidate) => candidate.candidateId === choice.candidateId);
    if (match === undefined || typeof choice.label !== "string" || choice.label.trim() === "") return null;
    return { label: choice.label.trim(), action: match.proposal.action } as ChoiceProposal;
  });
  return resolved[0] === null || resolved[1] === null ? null : [resolved[0], resolved[1]];
}

// --- Factory ---

export function createWorldGenerationSource(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
): WorldGenerationSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "available") {
    logger?.info("world_source_live", { model: runtime.config.model });
    // Task 17：live 源带机械修复 + 校验 + 确定性 fallback 编排。
    return createValidatedWorldGenerationSource({
      transport: createOpenAiCompatibleTransport(),
      config: runtime.config,
      logger,
    });
  }
  logger?.info("world_source_fixture", { diagnostics: runtime.diagnostics });
  return createValidatedWorldGenerationSource({});
}

export function createSceneSource(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
): SceneSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "available") {
    logger?.info("scene_source_live", { model: runtime.config.model });
    return createLiveSceneSource(
      createOpenAiCompatibleTransport(),
      runtime.config,
      logger,
    );
  }
  logger?.info("scene_source_deterministic", { diagnostics: runtime.diagnostics });
  return createDeterministicSceneSource();
}

// --- Live Expansion Source Factory（Task 28） ---

/**
 * Task 28：按 AI 运行时配置选择 live / fixture ExpansionSource。
 * - AI 可用 → live 源（AI 提案 → 纯解析/校验/引用过滤，失败回退空提案）。
 * - 无配置 → 确定性 fixture 源（测试/离线）。
 * 生产唯一注入点：compositionRoot。禁止直接注入 createFixtureExpansionSource。
 */
export function createExpansionSource(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
): ExpansionSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "available") {
    logger?.info("expansion_source_live", { model: runtime.config.model });
    return createLiveExpansionSource({
      transport: createOpenAiCompatibleTransport(),
      config: runtime.config,
      logger,
    });
  }
  logger?.info("expansion_source_fixture", { diagnostics: runtime.diagnostics });
  return createFixtureExpansionSource();
}
