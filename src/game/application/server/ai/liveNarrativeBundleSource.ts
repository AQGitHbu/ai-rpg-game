import type { AiMessage } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import { classifyAiFailure, transportFailureCodeToCategory } from "../../aiGenerationFailure";
import { parseStructuredJsonObject } from "@/game/core/json";
import { parseNarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import type {
  NarrativeBundleSource,
  NarrativeBundleSourceContext,
  NarrativeBundleSourceResult,
  NarrativeBundleRepairReason,
} from "../../narrativeBundleSource";
import { createRpgAiClient, RPG_AI_DEFAULT_POLICIES, type RpgAiClient } from "./rpgAiClient";
import type { ProviderJsonMode } from "./providerRequestOptions";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { EvolutionNeed } from "@/game/domain/worldDelta";

// ---------------------------------------------------------------------------
// Task 5：统一叙事生成包 live source。
// 一次 generate 调用 = 一次 aiClient.complete("narrative_bundle", ...) 调用。
// 只做 JSON 解析和提案校验，不做审批/铸造 ID/写状态。
// ---------------------------------------------------------------------------

export type LiveNarrativeBundleSourceDeps = {
  readonly aiClient?: RpgAiClient;
  readonly logger?: GameLogger;
  readonly jsonMode?: ProviderJsonMode;
};

const BUNDLE_TIMEOUT_MS = 240_000;
const BUNDLE_MAX_TOKENS = 8_000;

function failBundle(
  category: Parameters<typeof classifyAiFailure>[0]["category"],
  repairReason?: NarrativeBundleRepairReason,
): Extract<NarrativeBundleSourceResult, { readonly ok: false }> {
  const failure: AiGenerationFailure = classifyAiFailure({ phase: "scene", category });
  return repairReason === undefined
    ? { ok: false, failure }
    : { ok: false, failure, repairReason };
}

function buildDecisionPrompt(
  worldState: WorldState,
  storyState: StoryState,
  job: PendingNarrativeJob,
): string {
  const questSummary = worldState.quests.length > 0
    ? worldState.quests.map((q) => `- ${q.name}（${q.status}）: ${q.description}`).join("\n")
    : "（无活跃任务）";

  const locationSummary = worldState.locations
    .map((l) => `- ${l.name}（${l.id}）: ${l.description}`)
    .join("\n");

  const npcSummary = worldState.npcs
    .map((n) => `- ${n.name}（${n.id}）: ${n.role}`)
    .join("\n");

  const playerSummary = `玩家：${worldState.player.name}（${worldState.player.identity}）`;

  const storySummary = `第 ${storyState.currentAct} 幕 / 共 ${storyState.targetActs} 幕`;

  const actionSummary = job.utterance !== undefined
    ? `玩家自定义输入：${job.utterance}`
    : `玩家行动：${job.actionSummary.kind}`;

  return `你是武侠 RPG 的叙事 AI。你将在一次响应中生成完整的叙事生成包。

# 当前世界状态
${storySummary}
${playerSummary}

## 地点
${locationSummary}

## NPC
${npcSummary}

## 任务
${questSummary}

## 玩家本轮行动
${actionSummary}

# 输出要求

生成一个 JSON 对象，包含以下字段：
- worldDelta: 世界增量提案（可为 null）
- currentScene: 当前场景（segments 数组、npcLine、objectiveLink、choices）
- continuationScenes: 后续可消费场景数组
- terminal: 终点声明

## 规则

1. 符号引用白名单（只允许以下符号，不允许直接使用实体 ID 之外的引用）：
   - @current.location
   - @current.focus_npc
   - @new.location
   - @new.npc
   - @new.item
   - @new.enemy
   - @new.fact
   - @new.quest
   - @ending.trust
   - @ending.doubt

2. continuationScenes 最多 12 步。

3. terminal 有两种合法形式：
   - current_scene: 当前场景就是下一决策点（continuationScenes 必须为空）
   - continuation_step: 需要先消费线性步骤（continuationScenes 至少一步）

4. 终点必须有恰好两个选项（一个焦点 NPC 的两种正式回应）。

5. 战斗失败会恢复到战斗前检查点，因此不需要生成战斗失败/撤退的分支。

6. 所有文本必须是中文。

## JSON 格式

\`\`\`json
{
  "worldDelta": null,
  "currentScene": {
    "segments": [{ "beatId": "atmosphere", "text": "..." }],
    "npcLine": null,
    "objectiveLink": null,
    "choices": []
  },
  "continuationScenes": [],
  "terminal": { "kind": "next_decision", "target": { "kind": "current_scene" } }
}
\`\`\`
`;
}

export function createNarrativeBundleSource(
  deps: LiveNarrativeBundleSourceDeps = {},
): NarrativeBundleSource {
  const { logger, aiClient } = deps;

  return {
    async generate(context: NarrativeBundleSourceContext): Promise<NarrativeBundleSourceResult> {
      if (aiClient === undefined) {
        logger?.warn("narrative_bundle_source_unavailable");
        return failBundle("unavailable");
      }

      try {
        const prompt = context.kind === "decision"
          ? buildDecisionPrompt(context.worldState, context.storyState, context.job)
          : "开局叙事生成包";

        const messages: readonly AiMessage[] = [
          { role: "system", content: prompt },
          { role: "user", content: context.kind === "decision" ? "生成决策叙事包" : "生成开局叙事包" },
        ];

        const result = await aiClient.complete(
          "narrative_bundle",
          messages,
          {
            purpose: "narrative_bundle_generation",
            trigger: context.kind === "decision" ? "narrative_choice" : "new_game",
            gameId: context.kind === "decision" ? undefined : undefined,
            jobId: context.kind === "decision" ? String(context.job.jobId) : String(context.jobId),
            action: context.kind === "decision" ? context.job.actionSummary : undefined,
          },
        );

        if (!result.ok) {
          logger?.warn("narrative_bundle_ai_failed", { code: result.code });
          const category = transportFailureCodeToCategory(result.code);
          return result.code === "empty_response"
            ? failBundle(category, "invalid_json")
            : failBundle(category);
        }

        const parsed = parseStructuredJsonObject(result.content);
        if (parsed.ok && parsed.normalization === "json_fence") {
          logger?.warn("narrative_bundle_json_fence_normalized");
        }
        if (!parsed.ok) {
          logger?.warn("narrative_bundle_parse_failed", { reason: parsed.reason });
          return failBundle(
            parsed.reason === "root_not_object" ? "invalid_schema" : "invalid_json",
            parsed.reason === "root_not_object" ? "invalid_schema" : "invalid_json",
          );
        }

        const proposalResult = parseNarrativeBundleProposal(parsed.value);
        if (!proposalResult.ok) {
          logger?.warn("narrative_bundle_invalid_schema", { code: proposalResult.code });
          return failBundle("invalid_schema", "invalid_schema");
        }

        if (context.kind === "decision") {
          return { ok: true, kind: "decision", proposal: proposalResult.proposal };
        }
        // For opening, the proposal needs to carry the opening candidate;
        // this path will be completed in Task 6.
        return { ok: true, kind: "decision", proposal: proposalResult.proposal };
      } catch (error) {
        logger?.error("narrative_bundle_source_error", {
          error: error instanceof Error ? error.message : "unknown",
        });
        return failBundle("unknown");
      }
    },
  };
}
