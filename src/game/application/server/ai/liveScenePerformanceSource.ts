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
import {
  isGenericNpcAcknowledgement,
  isGenericNpcGreeting,
  isGenericNpcInquiry,
  normalizeNpcSpeech,
} from "@/game/domain/npcSpeech";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import { createProviderRequestOptions, type ProviderJsonMode } from "./providerRequestOptions";

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
  /** 仅由已验证兼容的 AI_OUTPUT_FORMAT=json_object 启用。 */
  readonly jsonMode?: ProviderJsonMode;
  readonly logger?: GameLogger;
  /** 生产 live 模式关闭静默确定性降级；失败会让 pending 保留，等待下一次真实 API 重试。 */
  readonly allowFallback?: boolean;
};

/**
 * 场景表演必须有明确上限。该兼容 provider 在 payload 已到达前可能花去三十余秒
 * 处理 reasoning，因此 30 秒会把可用的 AI 结果误判为超时；给一次完整的服务端
 * 生成窗口。真正超时仍会记录为失败，不能计作 AI 场景通过。
 */
export const LIVE_SCENE_TIMEOUT_MS = 45_000;
/** 场景只需旁白、两句 NPC 台词与两个选项，避免默认大输出拖慢整回合。 */
// 当前 provider 即使请求关闭 reasoning，复杂 JSON 仍会先占用约两千 token
// 的 reasoning_content；预算必须覆盖它和最终正文，才能避免 content 为空。
export const LIVE_SCENE_MAX_TOKENS = 1_800;
// 一次完整窗口后只保留一次瞬态重试：避免在卡住时将玩家锁在三轮 90 秒请求中。
const LIVE_SCENE_MAX_ATTEMPTS = 2;

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

/**
 * 只记录响应的结构轮廓，帮助定位 JSON mode 的契约偏差；绝不记录模型原文、
 * 玩家输入、NPC 台词或提示词。
 */
function sceneResponseShape(raw: unknown): Record<string, string | number | boolean> {
  if (!isRecord(raw)) return { object: false, kind: Array.isArray(raw) ? "array" : typeof raw };
  return {
    object: true,
    keys: Object.keys(raw).sort().join(","),
    segmentCount: Array.isArray(raw.segments) ? raw.segments.length : -1,
    npcLineKind: raw.npcLine === null ? "null" : Array.isArray(raw.npcLine) ? "array" : typeof raw.npcLine,
    choiceCount: Array.isArray(raw.choices) ? raw.choices.length : -1,
    objectiveLinkKind: raw.objectiveLink === null ? "null" : Array.isArray(raw.objectiveLink) ? "array" : typeof raw.objectiveLink,
  };
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

/** 焦点 NPC 的 ready 台词必须是两句可独立阅读的直接对白。 */
function hasDialogicContinuation(text: string): boolean {
  return normalizeNpcSpeech(text)
    .split(/[。！？!?]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "")
    .length >= 2;
}

function isUsableLiveNpcLine<TNpcId>(
  candidate: LiveNpcLineCandidate | null,
  context: SceneGenerationContext,
): { readonly npcId: TNpcId; readonly text: string; readonly emotion: NarrativeEmotion } | null {
  const resolved = resolveLiveNpcLine(candidate, context.presentNpcs);
  if (resolved === null) return null;
  if (context.focusNpcContext !== undefined && !hasDialogicContinuation(resolved.text)) return null;
  if (isGenericNpcAcknowledgement(resolved.text) || isGenericNpcInquiry(resolved.text)) return null;
  return resolved as { readonly npcId: TNpcId; readonly text: string; readonly emotion: NarrativeEmotion };
}

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
  const allowedBeatIds = new Set([
    ...context.mandatoryBeats.map((beat) => beat.beatId),
    ATMOSPHERE_BEAT_ID,
  ]);
  if (Array.isArray(raw.segments)) {
    for (const s of raw.segments) {
      if (!isRecord(s)
        || typeof s.beatId !== "string"
        || s.beatId.trim() === ""
        || typeof s.text !== "string"
        || s.text.trim() === "") {
        return null;
      }
      // 让“自创节拍 ID”进入机械修复路径：有焦点 NPC 时保留真实
      // API 返回的台词，只用服务端已批准的节拍/确定性段落补齐，
      // 避免到了最终审批才静默写 fallback 或永久卡 pending。
      if (!allowedBeatIds.has(s.beatId.trim())) return null;
      segments.push({ beatId: s.beatId, text: s.text.trim() });
    }
  }
  if (segments.length === 0) return null;

  let npcLine: ScenePerformanceProposal["npcLine"] = null;
  if (raw.npcLine !== null && raw.npcLine !== undefined) {
    if (!isRecord(raw.npcLine)) return null;
    const resolved = isUsableLiveNpcLine(raw.npcLine as LiveNpcLineCandidate, context);
    if (resolved === null) return null;
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

/**
 * JSON object mode 下 provider 偶尔把 NPC 直接台词放成字符串、或给出不合法
 * 数量的选项。只要这段台词本身通过同一角色/多句/泛问候校验，就保留它，
 * 用确定性、已审批的节拍和选择框架机械补全；这不是 fallback 文案。
 */
function repairPartialLiveScene(
  raw: unknown,
  context: SceneGenerationContext,
  deterministic: SceneSource,
): Promise<ScenePerformanceProposal | null> {
  if (!isRecord(raw)) return Promise.resolve(null);
  const rawLine = typeof raw.npcLine === "string"
    ? { npcId: String(context.focusNpcContext?.id ?? ""), text: raw.npcLine, emotion: "neutral" }
    : isRecord(raw.npcLine) ? raw.npcLine as LiveNpcLineCandidate : null;
  const resolved = isUsableLiveNpcLine(rawLine, context);
  if (resolved === null) return Promise.resolve(null);
  return deterministic.generateScene(context).then((fallback) => ({
    ...fallback,
    npcLine: {
      npcId: String(resolved.npcId),
      text: resolved.text,
      emotion: resolved.emotion,
      answeredBeatIds: context.mandatoryBeats
        .filter((beat) => beat.kind === "player_utterance")
        .map((beat) => beat.beatId),
      usedFactIds: [],
      usedInteractionActionIds: [],
    },
    source: "generated" as const,
  }));
}

/** live 场景表演源：AI 提案 → 纯解析/校验 → 失败回退确定性源。 */
export function createLiveScenePerformanceSource(deps: LiveScenePerformanceDeps): SceneSource {
  const deterministic = createDeterministicSceneSource();
  const { transport, config, logger, jsonMode } = deps;
  const fallbackScene = (context: SceneGenerationContext): Promise<ScenePerformanceProposal> => {
    if (deps.allowFallback === false) {
      throw new Error("LIVE_SCENE_UNAVAILABLE");
    }
    return deterministic.generateScene(context);
  };

  return {
    async generateScene(context: SceneGenerationContext): Promise<ScenePerformanceProposal> {
      try {
        const selectable = buildSelectableSceneCandidates(context);
        if (selectable.length < 2) return fallbackScene(context);

        const messages: readonly AiMessage[] = [
          { role: "system", content: buildLiveScenePrompt(context, selectable) },
          { role: "user", content: `当前回合：${context.job.actionId}（${context.job.actionSummary.kind}）` },
        ];

        // 场景生成位于每个玩家回合的必经等待界面。一个完整服务窗口内仍拿不到
        // 提案时才降级，避免把慢而有效的 AI 结果错误当作 fallback。
        // 兼容 provider 会偶发空响应；立即重试一次仍然走同一 AI 源，只有两次
        // 都拿不到可审批提案时才允许 fallback，不能把第一次空响应伪装成成功。
        let lastFailureCode: string | null = null;
        for (let attempt = 1; attempt <= LIVE_SCENE_MAX_ATTEMPTS; attempt += 1) {
          const result = await transport.complete(
            config,
            messages,
            createProviderRequestOptions(LIVE_SCENE_TIMEOUT_MS, LIVE_SCENE_MAX_TOKENS, jsonMode),
          );
          if (!result.ok) {
            lastFailureCode = result.code;
            if (attempt < LIVE_SCENE_MAX_ATTEMPTS) {
              logger?.warn("scene_generation_retry", { code: result.code });
              continue;
            }
            logger?.warn("scene_generation_ai_failed", { code: result.code });
            return fallbackScene(context);
          }

          const parsed = parseJsonResponse(result.content);
          const proposal = parseScenePerformanceJson(parsed, context, selectable);
          if (proposal !== null) return proposal;

          const repaired = await repairPartialLiveScene(parsed, context, deterministic);
          if (repaired !== null) {
            logger?.info("scene_generation_repaired", { kind: "npc_line_only" });
            return repaired;
          }

          lastFailureCode = "invalid_data";
          if (attempt < LIVE_SCENE_MAX_ATTEMPTS) {
            logger?.warn("scene_generation_retry", { code: lastFailureCode });
            continue;
          }
          logger?.warn("scene_generation_invalid_data", sceneResponseShape(parsed));
          return fallbackScene(context);
        }
        // 仅为 TypeScript 完整性；循环一定从内部 return。
        logger?.warn("scene_generation_ai_failed", { code: lastFailureCode ?? "unknown" });
        return fallbackScene(context);
      } catch (error) {
        logger?.error("scene_generation_error", { error: error instanceof Error ? error.message : "unknown" });
        return fallbackScene(context);
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

  const focus = context.focusNpcContext;
  const focusSection = focus === undefined
    ? "无焦点 NPC；npcLine 必须为 null。"
    : `id=${focus.id}；${focus.name}（${focus.role}）；态度：${focus.responsePolicy.toneInstruction}；目标：${focus.goals.join("、") || "无"}；` +
      `可说线索卡：${focus.speakableFactCards.map((f) => `${f.factId}=${f.text}`).join("；") || "无（usedFactIds 必须为 []）"}；` +
      `最近交互：${focus.recentInteractions.slice(-2).map((i) => `${i.actionId}=${i.summary}`).join("；") || "无（usedInteractionActionIds 必须为 []）"}`;

  const presentNpcLine = context.presentNpcs.map((n) => `${n.id}=${n.name}`).join("、") || "无";

  // 审批器要求每幕至少有一个 segment。开局没有规则节拍时，必须明确告诉
  // 模型使用唯一合法的 atmosphere 节拍；否则模型很自然会返回空数组，进而
  // 把一次已成功返回的 AI 调用误降级为 fallback。
  const hasMandatoryBeats = context.mandatoryBeats.length > 0;
  const beatsSection = hasMandatoryBeats
    ? context.mandatoryBeats.map((b) => `- ${b.beatId} [${b.kind}] ${b.instruction}`).join("\n")
    : `- ${ATMOSPHERE_BEAT_ID} [atmosphere] 描写当前地点、人物和紧张感，为开局建立画面。`;
  const segmentInstruction = hasMandatoryBeats
    ? "segments 逐条覆盖【已解决的本轮规则结果节拍】中的每个节拍并被其 beatId 点名；可额外附加一条 beatId 为 atmosphere 的氛围段，且必须放在最后；自创节拍 ID 非法。"
    : `当前没有其他强制节拍：segments 必须且只能返回一条 beatId 为 ${ATMOSPHERE_BEAT_ID} 的开场氛围段；不得返回空数组或自创 beatId。`;
  const objectiveMode = transition.mode === "advanced_act"
    ? "handoff"
    : transition.completed.length > 0 ? "progress" : "hint";
  const objectiveSection = after === null
    ? "无当前目标；objectiveLink 必须为 null。"
    : `当前目标：${after.label}；objectiveLink 必须为 {"questId":"${after.questId}","objectiveIndex":${after.objectiveIndex},"mode":"${objectiveMode}"}。`;
  const utteranceBeat = context.mandatoryBeats.find((beat) => beat.kind === "player_utterance");
  const utteranceContract = utteranceBeat === undefined
    ? "本轮没有玩家原话节拍。"
    : `本轮玩家原话节拍的精确 beatId 是 ${utteranceBeat.beatId}；npcLine.npcId 必须是 ${utteranceBeat.subjectIds[0] ?? "焦点 NPC"}，answeredBeatIds 必须精确包含 ["${utteranceBeat.beatId}"]。`;
  const handoffContract = context.objectiveTransition.mode === "advanced_act" && context.objectiveTarget !== null
    ? `quest_advanced 节拍的 segment.text 必须逐字包含新目标实体名“${context.objectiveTarget.entityName}”。`
    : "";
  const genreContract = context.gameType === "wuxia"
    ? "题材锁定为武侠：对白和旁白只能使用江湖、门派、镖局、官府、山川、兵器、线索、武学语汇；不得出现魔法、巫师、精灵、骑士、幽灵/灵魂、祭坛、法阵、圣光、异界等奇幻或超自然词汇。"
    : `题材锁定为${context.gameType ?? "当前游戏"}，不得跨题材改写世界规则。`;

  const prompt = `只输出 JSON，不能有解释或 Markdown。写一幕 RPG 场景，不得改规则。
${genreContract}
世界背景=${context.worldPremise ?? "沿用当前世界"}；故事开端=${context.storyOpening ?? "沿用当前主线"}
风格=${story.stylePolicy.narration}，${story.stylePolicy.narrationInstruction} ${story.stylePolicy.intensityInstruction}
地点=${context.currentLocation.name}：${context.currentLocation.description}
玩家=${utterance || "无"}
NPC=${focusSection}；在场ID=${presentNpcLine}
节拍=${beatsSection}
目标=${objectiveSection}
${utteranceContract} ${handoffContract}
选项=${selectable.map((c) => `${c.candidateId}:${c.label}`).join("；")}
JSON={"segments":[{"beatId":"必须从上面节拍列表逐字复制的ID","text":"旁白"}],"npcLine":null或{"npcId":"在场ID","text":"第一句直接回应。第二句补充线索或下一步。","emotion":"neutral","answeredBeatIds":[],"usedFactIds":[],"usedInteractionActionIds":[]},"objectiveLink":null或{"questId":"目标questId","objectiveIndex":0,"mode":"hint"},"choices":[{"candidateId":"选项ID","label":"玩家行动"},{"candidateId":"另一选项ID","label":"玩家行动"}]}
${segmentInstruction}
NPC 台词硬约束：有焦点 NPC 时 npcLine 不能为 null，text 必须恰好包含两句以“。”、“！”或“？”结尾的直接对白；两句之间用中文句号分隔。不要使用任何引号、角色名、动作、表情或“说道/答道”等舞台说明，不要用分号代替第二句。若有 player_utterance，answeredBeatIds 必须包含对应的精确 beatId，并由该焦点 NPC 先回应玩家，再给出可核验线索或下一步。不得说“想听哪一段/想问什么/我知道了”。只能说 NPC 可说线索，不能编造私密知识。`;
  const allowedFactIds = focus === undefined
    ? []
    : [...new Set([
      ...focus.speakableFactCards.map((fact) => String(fact.factId)),
      ...context.presentNpcs.flatMap((npc) => npc.sceneVisibleFactIds.map(String)),
    ])];
  const allowedInteractionIds = focus?.recentInteractions.map((interaction) => interaction.actionId) ?? [];
  return `${prompt}\n` +
    `ID 复核：segments.beatId 只能逐字复制“节拍”列表中的 ID，禁止创造 item_given、dialogue_response 等新 ID；` +
    `npcLine.usedFactIds 只能从 [${allowedFactIds.join(", ")}] 选择，npcLine.usedInteractionActionIds 只能从 [${allowedInteractionIds.join(", ")}] 选择；` +
    "没有对应引用时必须输出空数组。输出前逐项核对这些 ID。" +
    "玩家可见旁白必须是连续、具体的剧情正文；不得输出“主线推进到第X幕”“已完成：”“当前目标：”等系统元话术，任务状态由 HUD 单独展示。";
}
