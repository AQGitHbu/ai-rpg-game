import type { AiMessage, AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { SceneSource, ScenePerformanceProposal, ScenePerformanceSegment } from "../../sceneSource";
import type { SceneGenerationContext } from "../../sceneGenerationContext";
import {
  createDeterministicSceneSource,
  buildSelectableSceneCandidates,
  type SceneChoiceCandidate,
} from "../../deterministicSceneSource";
import { NARRATIVE_EMOTIONS, type NarrativeEmotion } from "@/game/domain/narrative";
import { isGenericNpcAcknowledgement, isGenericNpcGreeting, normalizeNpcSpeech } from "@/game/domain/npcSpeech";

// ---------------------------------------------------------------------------
// live 场景表演源（Task 6，取代 liveSceneSource）。
//
// 编排：AI 原始 JSON → 纯解析/校验（非法字段、越权引用直接丢弃）→ 失败/异常
// 回退确定性 source。source 只做"提案"，不做审批/铸造 token/写状态
// （那些是 approveScenePerformance 纯函数职责）。sensitive 配置绝不进日志。
// 提示词只含安全段落：风格政策、玩家本轮原话、已解决规则结果节拍、目标转换、
// 当前地点、最近故事节拍、预算/节奏、已批准实体、焦点 NPC 上下文、合法选项 ID、
// 输出 schema；绝不序列化完整 record/事件账本/全部 NPC 上下文/私密事实正文。
// ---------------------------------------------------------------------------

export type LiveScenePerformanceDeps = {
  readonly transport: AiTransport;
  readonly config: AiTransportConfig;
  readonly logger?: GameLogger;
};

/** 场景表演必须有明确上限；超时后使用同轨确定性 fallback，避免卡住整局。 */
export const LIVE_SCENE_TIMEOUT_MS = 12_000;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

// --- NPC 台词解析（迁移自 liveSceneSource） ---

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
  const presentNpc = presentNpcs.find((npc) => String(npc.id) === candidate.npcId)
    ?? presentNpcs.find((npc) => npc.name !== undefined && npc.name === candidate.npcId);
  if (presentNpc === undefined) return null;
  const text = normalizeNpcSpeech(candidate.text, presentNpc.name);
  if (text === "") return null;
  // 这句没有身份、地点或线索承接，AI 在新幕里返回它会把角色演绎
  // 退化成同一个模板。整场回退到同轨角色化台词，避免玩家看到假上下文。
  if (isGenericNpcGreeting(text)) return null;
  const emotion = NARRATIVE_EMOTIONS.includes(candidate.emotion as NarrativeEmotion)
    ? (candidate.emotion as NarrativeEmotion)
    : "neutral";
  return { npcId: presentNpc.id, text, emotion };
}

/** 把 AI 选择的两个合法 candidateId 映射为表演提案的 choices；非法/重复 → null。 */
export function resolvePerformanceChoices(
  selectable: readonly SceneChoiceCandidate[],
  selected: unknown,
): ScenePerformanceProposal["choices"] | null {
  if (!Array.isArray(selected) || selected.length !== 2) return null;
  const [x, y] = selected as readonly unknown[];
  if (!isRecord(x) || !isRecord(y)) return null;
  if (typeof x.candidateId !== "string" || typeof y.candidateId !== "string") return null;
  if (String(x.candidateId) === String(y.candidateId)) return null;
  const cx = selectable.find((c) => c.candidateId === String(x.candidateId));
  const cy = selectable.find((c) => c.candidateId === String(y.candidateId));
  if (cx === undefined || cy === undefined) return null;
  if (typeof x.label !== "string" || x.label.trim() === "" || typeof y.label !== "string" || y.label.trim() === "") return null;
  return [
    { candidateId: cx.candidateId, label: x.label.trim() },
    { candidateId: cy.candidateId, label: y.label.trim() },
  ];
}

/** 把 AI 返回的任意形状解析/校验为合法表演提案；非法返回 null（调用方走确定性兜底）。 */
export function parseScenePerformanceJson(
  raw: unknown,
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
): ScenePerformanceProposal | null {
  if (!isRecord(raw)) return null;

  const segments: ScenePerformanceSegment[] = [];
  if (Array.isArray(raw.segments)) {
    for (const s of raw.segments) {
      if (!isRecord(s)
        || typeof s.beatId !== "string"
        || s.beatId.trim() === ""
        || typeof s.text !== "string"
        || s.text.trim() === "") {
        return null;
      }
      segments.push({ beatId: s.beatId, text: s.text.trim() });
    }
  }
  if (segments.length === 0) return null;

  let npcLine: ScenePerformanceProposal["npcLine"] = null;
  if (raw.npcLine !== null && raw.npcLine !== undefined) {
    if (!isRecord(raw.npcLine)) return null;
    const resolved = resolveLiveNpcLine(raw.npcLine as LiveNpcLineCandidate, context.presentNpcs);
    if (resolved === null) return null;
    // 没有承接对象的“我知道了/好的”不能成为 ready scene 的 NPC 回应；
    // 调用方会沿同一生成链路回退到确定性上下文台词。
    if (isGenericNpcAcknowledgement(resolved.text)) return null;
    npcLine = {
      npcId: String(resolved.npcId),
      text: resolved.text,
      emotion: resolved.emotion,
      answeredBeatIds: strArray(raw.npcLine.answeredBeatIds),
      usedFactIds: strArray(raw.npcLine.usedFactIds),
      usedInteractionActionIds: strArray(raw.npcLine.usedInteractionActionIds),
    };
  }

  let objectiveLink: ScenePerformanceProposal["objectiveLink"] = null;
  if (raw.objectiveLink !== null && raw.objectiveLink !== undefined) {
    if (!isRecord(raw.objectiveLink)) return null;
    const mode = raw.objectiveLink.mode;
    if (typeof raw.objectiveLink.questId !== "string"
      || typeof raw.objectiveLink.objectiveIndex !== "number"
      || !["hint", "progress", "handoff"].includes(mode as string)) {
      return null;
    }
    objectiveLink = {
      questId: raw.objectiveLink.questId,
      objectiveIndex: raw.objectiveLink.objectiveIndex,
      mode: mode as "hint" | "progress" | "handoff",
    };
  }

  const choices = resolvePerformanceChoices(selectable, raw.choices);
  if (choices === null) return null;

  return {
    sceneId: `scene-${context.job.jobId}`,
    segments,
    npcLine,
    objectiveLink,
    choices,
    source: "generated",
  };
}

/** live 场景表演源：AI 提案 → 纯解析/校验 → 失败回退确定性源。 */
export function createLiveScenePerformanceSource(deps: LiveScenePerformanceDeps): SceneSource {
  const deterministic = createDeterministicSceneSource();
  const { transport, config, logger } = deps;

  return {
    async generateScene(context: SceneGenerationContext): Promise<ScenePerformanceProposal> {
      try {
        const selectable = buildSelectableSceneCandidates(context);
        if (selectable.length < 2) return deterministic.generateScene(context);

        const messages: readonly AiMessage[] = [
          { role: "system", content: buildLiveScenePrompt(context, selectable) },
          { role: "user", content: `当前回合：${context.job.actionId}（${context.job.actionSummary.kind}）` },
        ];

        // 场景生成位于每个玩家回合的必经等待界面。12 秒内拿不到提案时
        // 立即使用同轨确定性 source，避免存档长期停在 pending。
        const result = await transport.complete(config, messages, { timeoutMs: LIVE_SCENE_TIMEOUT_MS });
        if (!result.ok) {
          logger?.warn("scene_generation_ai_failed", { code: result.code });
          return deterministic.generateScene(context);
        }

        const parsed = parseJsonResponse(result.content);
        const proposal = parseScenePerformanceJson(parsed, context, selectable);
        if (proposal === null) {
          logger?.warn("scene_generation_invalid_data");
          return deterministic.generateScene(context);
        }
        return proposal;
      } catch (error) {
        logger?.error("scene_generation_error", { error: error instanceof Error ? error.message : "unknown" });
        return deterministic.generateScene(context);
      }
    },
  };
}

/** 安全段落提示词：只含最小权限上下文（Task 6 Step 3）。 */
export function buildLiveScenePrompt(
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
): string {
  const { job, story } = context;
  const utterance = job.utterance?.trim() ?? "";
  const transition = context.objectiveTransition;
  const after = transition.after;

  const objectiveTransitionLine = after === null
    ? "无目标转换（当前无活动主线目标）"
    : `before：${transition.before?.label ?? "无"}；completed：${transition.completed.map((c) => c.label).join("、") || "无"}；after：${after.label}（mode ${transition.mode}）`;

  const focus = context.focusNpcContext;
  const focusSection = focus === undefined
    ? "【焦点NPC】无焦点NPC"
    : `【焦点NPC：${focus.name}（${focus.role}）】
- 关系档位：${focus.responsePolicy.tier}；态度：${focus.responsePolicy.toneInstruction}；主动性：${focus.responsePolicy.initiative}
- 本轮关系：delta ${focus.thisTurn.relationshipDelta}（${focus.thisTurn.outcome}）；情绪：${focus.emotion}
- 目标：${focus.goals.join("、") || "无"}
- 可写进台词的线索（仅以下正文可写）：${focus.speakableFactCards.map((f) => f.text).join("、") || "无"}
- 私密知识ID（只能含糊带过，正文绝不出现）：${focus.responsePolicy.privateKnowledgeIds.join("、") || "无"}
- 最近交互（仅该焦点NPC自己的结构化摘要）：${focus.recentInteractions.map((i) => `[${i.dialogueAct}/${i.topicSummary}] ${i.summary}`).join("；") || "无"}`;

  const presentNpcLine = context.presentNpcs.map((n) => `${n.id}=${n.name}`).join("、") || "无";

  const beatsSection = context.mandatoryBeats.length === 0
    ? "（无强制节拍）"
    : context.mandatoryBeats.map((b) => `- ${b.beatId} [${b.kind}] ${b.instruction}`).join("\n");

  return `你是 RPG 叙事场景表演者。服务端已给出本回合的权威规则结果节拍与目标；你只负责把每一节拍表演成一致的旁白，返回严格 JSON。

【风格政策】（Task 8：同一 StylePolicy 同时供给开场与场景表演；只影响呈现，不得改变规则数值）
- 叙事风格：${story.stylePolicy.narration}
- 角色标签：${story.stylePolicy.protagonistTraits.join("、") || "无"}
- 内容强度：${story.stylePolicy.intensity}
- 呈现指令：${story.stylePolicy.narrationInstruction}
- 强度指令：${story.stylePolicy.intensityInstruction}
- 节奏需要：${story.nextPacingNeed}；张力：${story.tension}；幕：${story.currentAct}/${story.targetActs}

【玩家本轮原话】${utterance === "" ? "（无）" : `"${utterance}"（焦点 NPC 必须直接回应这句话）`}

【已解决的本轮规则结果节拍】（每个节拍写成一个 segment，顺序保持一致；atmosphere 可选且放最后）
${beatsSection}

【目标转换】
${objectiveTransitionLine}
HUD 当前目标：${after?.label ?? "无"}
objectiveLink 必须与 above 一致（questId/objectiveIndex）；本回合推进则 mode=progress，幕推进交接则 mode=handoff，否则 hint。

【当前地点】${context.currentLocation.name}：${context.currentLocation.description}

【最近故事节拍】${context.recentBeats.map((b) => `(${b.turn}) ${b.summary}`).join("；") || "无"}

【预算/进度】剩余地点 ${story.remainingBudget.remainingLocations}、角色 ${story.remainingBudget.remainingNpcs}、事件 ${story.remainingBudget.remainingEvents}；未了线程：${story.unresolvedThreadSummaries.join("、") || "无"}

【已批准具象化实体】${context.beatSubjects.map((s) => `${s.kind}:${s.name}`).join("、") || "无"}

${focusSection}

【在场 NPC（npcLine.npcId 必须使用下列 ID 之一）】${presentNpcLine}

【服务端合法选项】（choices 必须选择两个不同 candidateId，label 可改写）
${selectable.map((c) => `${c.candidateId} = ${c.label}`).join("\n")}

【输出格式】
{
  "segments": [{ "beatId": "<强制节拍ID>", "text": "该节拍的旁白" }],
  "npcLine": null | { "npcId": "<在场NPC的ID>", "text": "焦点NPC的台词", "emotion": "neutral", "answeredBeatIds": ["player_utterance（若有）"], "usedFactIds": ["仅在可写线索中的factId"], "usedInteractionActionIds": ["仅该焦点NPC最近交互的actionId"] },
  "objectiveLink": null | { "questId": "<与HUD一致>", "objectiveIndex": 0, "mode": "hint" },
  "choices": [{ "candidateId": "<合法ID>", "label": "选项文字" }, { "candidateId": "<另一个合法ID>", "label": "选项文字" }]
}

要求：
- segments 逐条覆盖【已解决的本轮规则结果节拍】中的每个节拍并被其 beatId 点名；自创节拍 ID 非法。
- npcLine.text 只能是焦点 NPC 的第一人称直接台词；不要写 NPC 名称、动作、表情或“说道/答道”等叙述性前缀，并且必须明确承接玩家原话或当前情境，不能只回答“我知道了/好的/嗯”。
- 禁止使用“你是来打听事情的吧？想知道什么，直接问我。”或“欢迎光临”这类脱离角色身份的通用问候；必须承接焦点 NPC 的角色、当前地点、当前目标、可写线索或最近交互中的至少一项。
- 私密知识ID 的正文绝不出现在任何文本；只可提及【可写进台词的线索】正文。
- usedFactIds 只可从【可写进台词的线索】选择；usedInteractionActionIds 只可从【最近交互】选择。
- 只返回 JSON，不要其他文字。`;
}
