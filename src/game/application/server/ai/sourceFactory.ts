import { createOpenAiCompatibleTransport, type AiMessage, type AiTransport, type AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import type { OpeningGenerationSource } from "../../createGame";
import type { SceneSource, SceneSourceResult } from "../../sceneSource";
import type { SceneGenerationContext } from "../../sceneGenerationContext";
import type { NarrativeEventState, NarrativeEmotion, NarrativeNpcLineState } from "@/game/domain/narrative";
import { NARRATIVE_EMOTIONS } from "@/game/domain/narrative";
import { createOpeningGenerationSource as createValidatedOpeningGenerationSource } from "./openingGenerationSource";
import { createDeterministicSceneSource } from "../../deterministicSceneSource";
import { createLiveWorldEvolutionSource } from "./liveWorldEvolutionSource";
import { createDeterministicEvolutionSource } from "../../deterministicEvolutionSource";
import type { WorldEvolutionSource } from "../../worldEvolutionSource";
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
  presentNpcs: readonly { readonly id: TNpcId; readonly name?: string }[],
): { readonly npcId: TNpcId; readonly text: string; readonly emotion: NarrativeEmotion } | null {
  if (candidate === null || typeof candidate !== "object") return null;
  if (typeof candidate.npcId !== "string" || typeof candidate.text !== "string") return null;
  if (candidate.text.trim() === "") return null;
  // AI 可能把 ID 写成名字：先按 ID 精确匹配，再按名字回退匹配。
  const presentNpc = presentNpcs.find((npc) => String(npc.id) === candidate.npcId)
    ?? presentNpcs.find((npc) => npc.name !== undefined && npc.name === candidate.npcId);
  if (presentNpc === undefined) return null;
  const emotion = NARRATIVE_EMOTIONS.includes(candidate.emotion as NarrativeEmotion)
    ? (candidate.emotion as NarrativeEmotion)
    : "neutral";
  return { npcId: presentNpc.id, text: candidate.text.trim(), emotion };
}

export function createLiveSceneSource(
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
        // 焦点 NPC：talk 回合必须指向玩家实际交谈的 NPC（job.focusNpcId），
        // 不能固定取第一个在场 NPC，否则"与 B 交谈"永远生成 A 的对话。
        const talkTarget = job.actionSummary.kind === "talk" ? job.focusNpcId : undefined;
        const firstNpc = talkTarget !== undefined
          ? npcsHere.find((npc) => String(npc.id) === String(talkTarget)) ?? npcsHere[0]
          : npcsHere[0];
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

在场 NPC（npcLine.npcId 必须使用下列 ID 之一，不得自创）：${npcsHere.map((n) => `${n.id}=${n.name}(${n.role})`).join("、") || "无"}

服务端候选：${JSON.stringify(selectable.map((entry) => ({ candidateId: entry.candidateId, label: entry.proposal.label })))}

返回严格 JSON，格式如下：
{
  "narration": "场景旁白文字（2-4句）",
  "npcLine": { "npcId": "在场NPC的ID（必须原样使用上方列出的 ID）", "text": "NPC说的台词（符合其身份与当前情境，不要用招呼语敷衍）", "emotion": "neutral" },
  "choices": [
    { "label": "选项1文字", "candidateId": "candidate_1" },
    { "label": "选项2文字", "candidateId": "candidate_2" }
  ],
  "smallTalks": [
    { "npcId": "非焦点NPC的ID", "prompt": "闲聊选项文本（如'向韩征打个招呼'）", "response": "NPC的简短回应（1-2句，符合其身份和当前情境，但不推进剧情）" }
  ]
}

重要说明：
- choices 必须恰好 2 个，candidateId 必须从服务端候选中选择且不能重复。
- smallTalks 是可选的，为除焦点 NPC 之外的其他在场 NPC 提供闲聊选项。
- smallTalks 中的 npcId 必须是非焦点 NPC（即不等于 npcLine.npcId 的其他在场 NPC）。
- 闲聊的 response 应该简短、符合 NPC 身份，但不包含剧情关键信息。
- narration 与 npcLine 中出现的 NPC 名字必须与上方列出的名字逐字一致，不得使用别名或变体。
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
        const rawSmallTalks = Array.isArray(data.smallTalks) 
          ? data.smallTalks as Array<{ npcId: string; prompt: string; response: string }>
          : [];

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

        // 解析闲聊数据：只保留属于非焦点在场 NPC 的闲聊
        const focusNpcId = npcLine?.npcId;
        const smallTalks = new Map<string, { prompt: string; response: string }>();
        for (const talk of rawSmallTalks) {
          if (
            typeof talk.npcId === "string" &&
            typeof talk.prompt === "string" &&
            typeof talk.response === "string" &&
            talk.npcId !== String(focusNpcId) &&
            npcsHere.some((npc) => String(npc.id) === talk.npcId) &&
            talk.prompt.trim() !== "" &&
            talk.response.trim() !== ""
          ) {
            smallTalks.set(talk.npcId, {
              prompt: talk.prompt.trim(),
              response: talk.response.trim(),
            });
          }
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
          ...(smallTalks.size > 0 ? { smallTalks } : {}),
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

export function createOpeningGenerationSource(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
): OpeningGenerationSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "available") {
    logger?.info("opening_source_live", { model: runtime.config.model });
    // live 源带机械修复 + 校验 + 确定性 fallback 编排。
    return createValidatedOpeningGenerationSource({
      transport: createOpenAiCompatibleTransport(),
      config: runtime.config,
      logger,
    });
  }
  logger?.info("opening_source_fixture", { diagnostics: runtime.diagnostics });
  return createValidatedOpeningGenerationSource({});
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

// --- World Evolution Source Factory（Task 3） ---

/**
 * Task 3：按 AI 运行时配置选择 live / deterministic WorldEvolutionSource。
 * - AI 可用 → live 源（AI 提案 → 纯解析/校验/引用过滤，失败回退确定性源）。
 * - 无配置 → 确定性源（always materializes a completable next act）。
 * 生产唯一注入点：compositionRoot。
 */
export function createWorldEvolutionSource(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
): WorldEvolutionSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "available") {
    logger?.info("world_evolution_source_live", { model: runtime.config.model });
    return createLiveWorldEvolutionSource({
      transport: createOpenAiCompatibleTransport(),
      config: runtime.config,
      logger,
    });
  }
  logger?.info("world_evolution_source_fixture", { diagnostics: runtime.diagnostics });
  return createDeterministicEvolutionSource();
}
