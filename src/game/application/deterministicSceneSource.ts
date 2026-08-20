import type { SceneSource, SceneSourceResult, ScenePerformanceSegment, ScenePerformanceProposal } from "./sceneSource";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { NarrativeEmotion, NarrativeEventState } from "@/game/domain/narrative";
import type { Action, DialogueTopic } from "@/game/domain/action";
import { semanticSummaryOf } from "@/game/domain/approvedChoice";
import { asEnemyId, asLocationId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
import type { RelationshipTier } from "@/game/domain/relationship";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import { composeDirectNpcGreeting, normalizeNpcSpeech } from "@/game/domain/npcSpeech";

// ---------------------------------------------------------------------------
// 确定性 fallback 场景表演生成器（spec §7.6 安全降级模板）。
// 不调用 AI、不读时钟/随机数：sceneId 从 job 纯函数派生，
// 两次调用同样的 context 产出逐字节相同的提案。
// Task 6：产出与 approveScenePerformance 同一契约的表演提案（segments/
// npcLine/objectiveLink/choices），必须能通过同一审批——因此所有引用
// （节拍 ID、NPC 台词、目标链接、合法选项）都从服务端权威上下文派生。
// ---------------------------------------------------------------------------

/** 关系档位只决定回应政策；具体台词还必须读取本轮情境。 */
const TIER_EMOTIONS: Readonly<Record<RelationshipTier, NarrativeEmotion>> = {
  hostile: "angry",
  cold: "guarded",
  neutral: "neutral",
  friendly: "warm",
  trusted: "warm",
};

/** 强制 player_utterance 节拍 ID（无则空数组）。 */
export function answeredUtteranceBeatIds(context: SceneGenerationContext): readonly string[] {
  const beat = (context.mandatoryBeats ?? []).find((b) => b.kind === "player_utterance");
  return beat !== undefined ? [beat.beatId] : [];
}

/** 场景表演的合法选项候选（服务端权威）：审批、确定性源、live 提示词共用。 */
export type SceneChoiceCandidate = {
  readonly candidateId: string;
  readonly label: string;
  readonly action: Action;
};

/**
 * 当前 NPC 台词的结构化投影。选项生成只消费事实引用，不再扫描台词文本
 * 猜测“这是问路/告示/住店”等主题；旧的 string 入参仅为兼容历史测试/调用者。
 */
export type CurrentNpcLineContext = {
  readonly text: string;
  readonly usedFactIds?: readonly string[];
};

/**
 * 判断 live 是否把本回合之前生成的 deterministic talk label 原样带回来了。
 * 这是结构化候选文案的精确复用保护，不读取/匹配 NPC 台词关键词；只有在
 * 同一 NPC 的两个 talk 选项都完整复用旧候选文案时才命中。
 */
export function usesFallbackDialogueChoiceLabels(
  selectable: readonly SceneChoiceCandidate[],
  choices: readonly { readonly candidateId: string; readonly label: string }[],
): boolean {
  if (selectable.length < 2 || choices.length !== 2) return false;
  const selectableById = new Map(selectable.map((candidate) => [candidate.candidateId, candidate]));
  return choices.every((choice) => {
    const candidate = selectableById.get(String(choice.candidateId));
    return candidate !== undefined
      && candidate.action.type === "talk"
      && compactChoiceLabel(choice.label) === compactChoiceLabel(candidate.label);
  });
}

function compactChoiceLabel(label: string): string {
  return label.replace(/[\s“”"「」『』。！？!?，,；;：:、（）()]/gu, "");
}

/** 判断某行动是否推进/接近/搜集当前目标（objectiveTarget.entityId）。 */
export function actionTargetsObjective(action: Action, entityId: string): boolean {
  switch (action.type) {
    case "move": return String(action.locationId) === entityId;
    case "talk": return String(action.npcId) === entityId;
    case "take_item": return String(action.itemId) === entityId;
    case "investigate": return String(action.factId) === entityId;
    case "attack": return String(action.enemyId) === entityId;
    default: return false;
  }
}

/**
 * 从上下文投影服务端权威的可选候选（candidateId 与 approval 使用同一集合）：
 * - dialogue 事件 → 焦点 NPC 的固定 support/challenge 两选项；
 * - 其余事件 → legalActionCandidates 去重映射（candidate_1..N）。
 */
export function buildSelectableSceneCandidates(
  context: SceneGenerationContext,
  currentNpcLine?: string | CurrentNpcLineContext,
): readonly SceneChoiceCandidate[] {
  const event = buildEventState(context);
  // 结局对已经由规则铸造后，玩家必须以两个明确、互斥的对白方向作出
  // 最后决定。不能把“观察”或“挑战敌人”伪装成结局选择，更不能让任意
  // 后续行动自动触发结局。
  if (context.objectiveTransition.mode === "ready_for_ending") {
    const npc = focusNpc(context);
    if (npc === undefined) return [];
    return [
      {
        candidateId: "candidate_1",
        label: "我愿意和你一起把证据摊开，让该承担的人面对真相。",
        action: { type: "talk", npcId: npc.id, dialogueAct: "support", topic: dialogueTopicFor(context, false) },
      },
      {
        candidateId: "candidate_2",
        label: "我会核对每一份证据，在确认之前不会把结论交给任何人。",
        action: { type: "talk", npcId: npc.id, dialogueAct: "challenge", topic: dialogueTopicFor(context, true) },
      },
    ];
  }
  // ready scene 已经把当前主线目标 NPC 编排到当前地点。这个场景的真实
  // event 可以仍然是 travel/observe（用于表达“抵达/新线索出现”），但玩家
  // 进入目标 NPC 后需要直接拥有对该 NPC 的两项回应，而不是把场景里的
  // `与某人交谈` / `查看四周` 当成对话选项，再额外提交一次 talk。
  // 仅在 focusNpcContext 与主线目标一致时启用，避免玩家主动和旁 NPC 闲谈
  // 后把主线目标错误地投影成当前对话对象。
  const objectiveNpc = context.objectiveTarget !== null
    ? context.presentNpcs.find((entry) => String(entry.id) === context.objectiveTarget?.entityId)
    : undefined;
  const focusedObjectiveNpc = objectiveNpc !== undefined
    && context.focusNpcContext !== undefined
    && String(context.focusNpcContext.id) === String(objectiveNpc.id)
    ? objectiveNpc
    : undefined;
  const dialogueNpcId = event.kind === "dialogue" ? event.focusNpcId : focusedObjectiveNpc?.id;
  if (dialogueNpcId !== undefined) {
    const npc = context.presentNpcs.find((entry) => String(entry.id) === String(dialogueNpcId));
    if (npc === undefined) return [];
    const dialogueLabels = dialogueChoiceLabels(context, npc, currentNpcLine);
    const dialogueCandidate: SceneChoiceCandidate = {
      candidateId: "candidate_1",
      label: dialogueLabels.support,
      action: { type: "talk", npcId: npc.id, dialogueAct: "support", topic: dialogueTopicFor(context, false) },
    };
    if (event.kind === "dialogue") {
      // 已经由玩家主动点开的人物对话应保留完整的支持/质疑两项回应，
      // 即使当前主线正在等待调查或移动；旁支交谈不应被读模型降格成
      // 一次只有“与某人交谈”的空壳回合。
      return [
        dialogueCandidate,
        {
          candidateId: "candidate_2",
          label: dialogueLabels.challenge,
          action: { type: "talk", npcId: npc.id, dialogueAct: "challenge", topic: dialogueTopicFor(context, true) },
        },
      ];
    }
    const nonDialogueCandidate = context.legalActionCandidates
      .map((candidate) => ({ candidate, action: actionFromLegalCandidate(candidate) }))
      .filter((entry): entry is { candidate: SceneGenerationContext["legalActionCandidates"][number]; action: Action } =>
        entry.action !== null && entry.action.type !== "talk")
      .map(({ candidate, action }): SceneChoiceCandidate => ({
        candidateId: "candidate_2",
        label: nonDialogueChoiceLabel(action, candidate.label),
        action,
      }))[0];
    // 对话场景仍必须给出两种不同输入类型；buildChoiceMap 同源允许
    // explore，保证即使地点没有物品/敌人，玩家也能选择暂不回应而观察现场。
    return [
      dialogueCandidate,
      nonDialogueCandidate ?? {
        candidateId: "candidate_2",
        label: nonDialogueChoiceLabel({ type: "explore" }),
        action: { type: "explore" },
      },
    ];
  }
  const candidates: SceneChoiceCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of context.legalActionCandidates) {
    const action = actionFromLegalCandidate(candidate);
    if (action === null) continue;
    const key = semanticSummaryOf(action);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      candidateId: `candidate_${candidates.length + 1}`,
      label: action.type === "attack"
        ? nonDialogueChoiceLabel(action, candidate.label)
        : formatSceneChoiceLabel(action, candidate.label),
      action,
    });
  }
  return candidates;
}

export function createDeterministicSceneSource(): SceneSource {
  return {
    async generateScene(context: SceneGenerationContext): Promise<SceneSourceResult> {
      const sceneId = `scene-${context.job.jobId}`;
      const npcLine = buildNpcLineState(context);
      return {
        sceneId,
        segments: buildSegments(context),
        npcLine,
        objectiveLink: buildObjectiveLink(context),
        choices: buildSceneChoices(context, npcLine === null ? undefined : npcLine),
        source: "fallback",
      };
    },
  };
}

/** 一段节拍对应一个 segment（强制节拍顺序即上下文顺序；atmosphere 可选放最后）。 */
function buildSegments(context: SceneGenerationContext): readonly ScenePerformanceSegment[] {
  const { job } = context;
  const npc = focusNpc(context);
  const segments: ScenePerformanceSegment[] = [];
  for (const beat of context.mandatoryBeats) {
    if (beat.beatId === ATMOSPHERE_BEAT_ID) {
      segments.push({ beatId: beat.beatId, text: buildAtmosphere(context) });
    } else if (beat.kind === "player_utterance") {
      const utterance = job.utterance?.trim() ?? "";
      segments.push({
        beatId: beat.beatId,
        text: npc !== undefined && utterance !== ""
          ? `${utteranceLead(context.story.stylePolicy.protagonistTraits)}你把关于眼前线索的疑问直截了当地抛给${npc.name}，等他给出能核查的回答。`
          : "你向对方提出了你的疑问。",
      });
    } else if (beat.kind === "item_obtained") {
      const item = context.beatSubjects.find((subject) =>
        subject.kind === "item" && beat.subjectIds.includes(subject.id),
      );
      const namedInInstruction = beat.instruction.match(/「([^」]+)」/u)?.[1];
      const itemName = item?.name ?? namedInInstruction ?? "那件证物";
      const itemDetail = item?.description.trim();
      segments.push({
        beatId: beat.beatId,
        text: itemDetail === undefined || itemDetail === ""
          ? `你将${itemName}仔细收好，准备在下一次交谈时拿它核对证词。`
          : `你将${itemName}仔细收好。${itemDetail}它足以让接下来的追问有了落脚处。`,
      });
    } else if (beat.kind === "battle_started") {
      const enemy = context.beatSubjects.find((subject) =>
        subject.kind === "enemy" && beat.subjectIds.includes(subject.id),
      );
      segments.push({
        beatId: beat.beatId,
        text: `${enemy?.name ?? "来敌"}拦住去路，${completeSceneSentence(beat.instruction)}`,
      });
    } else if (beat.kind === "battle_resolved") {
      segments.push({
        beatId: beat.beatId,
        text: `${completeSceneSentence(beat.instruction)}你收拢呼吸，重新确认眼前留下的线索。`,
      });
} else if (beat.kind === "fact_discovered") {
      // Task 3：调查发现的兜底旁白在事实文本（beat instruction）之后追加
      // 由 objectiveTarget 结构化的下一目标动线提示（复用 objectiveHandoffLine
      // 的派生，不扫描正文猜主题），保证离线兜底也回答"为什么去下一地点"。
      // Task 4：已结算的 approach 结果（investigate 主动选择）改为确定性组合
      // 旁白：采取方式 → 发现事实 → 证据质量/动静代价 → 下一目标。
      const resolved = context.resolvedInvestigation;
      if (resolved !== undefined) {
        const factLead = "发现了线索：";
        const trimmedInstruction = beat.instruction.trim();
        const factText = trimmedInstruction.startsWith(factLead)
          ? trimmedInstruction.slice(factLead.length)
          : beat.instruction;
        segments.push({
          beatId: beat.beatId,
          text: buildInvestigationOutcomeNarrative({
            approachLabel: resolved.approachLabel,
            evidenceQuality: resolved.evidenceQuality,
            factText,
            ...(context.objectiveTarget === null ? {} : { nextObjectiveLabel: context.objectiveTarget.entityName }),
          }),
        });
      } else {
        segments.push({
          beatId: beat.beatId,
          text: `${completeSceneSentence(beat.instruction)}${objectiveHandoffLine(context)}`,
        });
      }
    } else if (beat.kind === "quest_advanced" && context.objectiveTarget !== null) {
      // 幕边界：turn 时刻的下一个目标尚未具象化，节拍指令里没有实体名；
      // 场景装配的预览状态已具象化，此处保留自然语言交接，并用稳定
      // entityId 提供结构化 grounding；目标身份不再依赖旁白逐字匹配。
      segments.push({
        beatId: beat.beatId,
        text: `主线推进。当前目标：${context.objectiveTarget.entityName}（${context.objectiveTransition.after?.label ?? "新的线索"}）`,
        referencedEntityIds: [String(context.objectiveTarget.entityId)],
      });
    } else {
      segments.push({ beatId: beat.beatId, text: completeSceneSentence(beat.instruction) });
    }
  }
  // 服务端恒带 atmosphere 节拍；纯测试夹具无强制节拍时仍保底一段氛围。
  if (segments.length === 0) {
    segments.push({ beatId: ATMOSPHERE_BEAT_ID, text: buildAtmosphere(context) });
  }
  return segments;
}

/** 把规则节拍的短标签收束为可直接拼进场景旁注的完整句。 */
function completeSceneSentence(text: string): string {
  const trimmed = text.trim();
  return /[。！？]$/u.test(trimmed) ? trimmed : `${trimmed}。`;
}

/**
 * Task 4：已结算调查结果的确定性旁白包装。
 * 组合顺序：采取方式 → 发现事实 → 证据质量/动静代价 → 下一目标。
 * baseNarrative（Task 5 linearNarrativeQueue 提供的已结算叙事）存在时优先
 * 作为主体，approach/evidence/next 随后补充。
 */
export function buildInvestigationOutcomeNarrative(input: {
  readonly approachLabel: string;
  readonly evidenceQuality: "clean" | "noisy";
  readonly factText: string;
  readonly baseNarrative?: string;
  readonly nextObjectiveLabel?: string;
}): string {
  const trimmedBase = input.baseNarrative?.trim() ?? "";
  // Task 5：baseNarrative（已结算的队列叙事）作为主体时，仍需点名所选方式，
  // 让结果场景始终可读；无 baseNarrative 时沿用 Task 4 的组合句式。
  const base = trimmedBase !== ""
    ? `${trimmedBase}你按「${input.approachLabel}」的方式完成了查证。`
    : `你按「${input.approachLabel}」的方式仔细查证，${input.factText}`;
  const lead = /[。！？]$/u.test(base) ? base : `${base}。`;
  const outcome = input.evidenceQuality === "clean"
    ? "这次查证干净利落，没有惊动任何人。"
    : "翻找的动静不小，现场留下了动静。";
  const next = input.nextObjectiveLabel === undefined || input.nextObjectiveLabel.trim() === ""
    ? "接下来沿着这条线索继续核对。"
    : `接下来按主线继续核对：${input.nextObjectiveLabel}。`;
  return `${lead}${outcome}${next}`;
}

/** 氛围描写：当前地点的最小安全文本；dark 呈现克制的暗色意象（纯函数）。 */
function buildAtmosphere(context: SceneGenerationContext): string {
  const { currentLocation } = context;
  const base = `你身处${currentLocation.name}，${currentLocation.description}`;
  if (context.story.stylePolicy.intensity === "dark") {
    return `${base}。阴影里似乎有什么在注视着这里。`;
  }
  return `${base}。`;
}

/** 性格标签 → 玩家原话 segment 的确定性前缀（只影响措辞，纯函数）。 */
function utteranceLead(traits: readonly string[]): string {
  if (traits.includes("冲动")) return "你几乎没多想，便";
  if (traits.includes("寡言")) return "你沉默了片刻，才";
  if (traits.includes("幽默")) return "你带着轻松的笑意，仍";
  if (traits.includes("多疑")) return "你打量着对方，随后";
  return "";
}

/** 焦点 NPC：talk job 优先使用 job.focusNpcId，否则第一个在场 NPC。 */
function focusNpc(context: SceneGenerationContext): SceneGenerationContext["presentNpcs"][number] | undefined {
  const { job, presentNpcs } = context;
  if (context.focusNpcContext !== undefined) {
    const contextFocus = presentNpcs.find((n) => String(n.id) === String(context.focusNpcContext?.id));
    if (contextFocus !== undefined) return contextFocus;
  }
  const talkTarget = job.actionSummary.kind === "talk" ? job.focusNpcId : undefined;
  if (talkTarget !== undefined) {
    const match = presentNpcs.find((n) => String(n.id) === String(talkTarget));
    if (match !== undefined) return match;
  }
  return presentNpcs[0];
}

function buildNpcLineState(context: SceneGenerationContext): ScenePerformanceProposal["npcLine"] {
  const { job } = context;
  const npc = focusNpc(context);
  if (npc === undefined) return null;

  const policy = context.focusNpcContext?.responsePolicy;
  // 回退台词也必须从当前玩家话语/交谈情境生成，不能用脱离上下文的固定确认句。
  const text = policy !== undefined
    ? buildContextualTierLine(context, policy.tier)
    : buildStatusLine(job.resolvedEvent);
  const emotion = policy !== undefined ? TIER_EMOTIONS[policy.tier] : "neutral";

  return {
    npcId: String(npc.id),
    text: normalizeNpcSpeech(text, npc.name),
    emotion,
    usedFactIds: [],
    usedInteractionActionIds: [],
    answeredBeatIds: answeredUtteranceBeatIds(context),
  };
}

type DialogueChoiceLabels = {
  readonly support: string;
  readonly challenge: string;
};

/**
 * 选项 fallback 只从结构化剧情状态生成：当前任务、NPC 可说事实、上一轮
 * 的结构化回应状态。它不读取 NPC 台词文本，也不按角色名/关键词分类。
 * 正常 live 路径会在同一份上下文上生成自然措辞；candidateId/action 仍由
 * 服务端保留，因而 AI 不能借措辞越权改变剧情动作。
 */
function dialogueChoiceLabels(
  context: SceneGenerationContext,
  npc: SceneGenerationContext["presentNpcs"][number],
  currentNpcLine?: string | CurrentNpcLineContext,
): DialogueChoiceLabels {
  const lineContext = typeof currentNpcLine === "string"
    ? { text: currentNpcLine, usedFactIds: [] as readonly string[] }
    : currentNpcLine;
  const focusFacts = context.focusNpcContext?.speakableFactCards ?? [];
  const sceneFacts = [...context.sceneVisibleFacts, ...context.publicWorldFacts];
  const factsById = new Map<string, FactCardLike>();
  for (const fact of [...focusFacts, ...sceneFacts]) factsById.set(String(fact.factId), fact);
  const referencedFacts = lineContext?.usedFactIds
    ?.map((factId) => factsById.get(String(factId)))
    .filter((fact): fact is FactCardLike => fact !== undefined) ?? [];
  const groundingFacts = referencedFacts.length > 0 ? referencedFacts : focusFacts;
  const hasGrounding = groundingFacts.length > 0;
  const hasQuest = context.story.activeQuest !== undefined;
  const previousAct = context.previousDialogue?.selectedChoice?.dialogueAct;

  // 历史回应优先于当前事实池：同一 NPC 的第二轮必须先承接玩家上一轮
  // 的立场，再引出下一处核验点；事实卡只决定可谈范围，不覆盖对话状态。
  const hasCurrentLineGrounding = lineContext !== undefined && referencedFacts.length > 0;
  if (previousAct === "challenge" && !hasCurrentLineGrounding) {
    return {
      support: "你先逐点回应刚才的疑问，再把能核对的下一步说清楚。",
      challenge: "刚才的疑点还没有解开；请指出一件能让我们当场核对的证物。",
    };
  }
  if (previousAct === "support" && !hasCurrentLineGrounding) {
    return {
      support: "既然你愿意继续说，就把下一步和能够核对的凭据交代清楚。",
      challenge: "我可以继续听，但每个判断都要有能落到实处的证物支撑。",
    };
  }
  if (hasGrounding) {
    const variants: readonly DialogueChoiceLabels[] = [
      {
        support: "请把你刚才提到的这条线索的来历、时间和地点说清楚，我好按眼前的主线核对。",
        challenge: "这条线索还不能直接下结论；哪一件原始证物能把它和眼前的主线联系起来？",
      },
      {
        support: "把这条线索的来历、时间和地点交代清楚，我会按眼前的主线逐一核对。",
        challenge: "这还只是一个线索；请指出能把它和眼前主线对上的原件或证物。",
      },
    ];
    return variants[dialogueChoiceVariantIndex(context, npc, variants.length)] ?? variants[0]!;
  }
  if (hasQuest) {
    return {
      support: "先把眼前主线下一步要核对的人、地点或物证说清楚，我就按它查下去。",
      challenge: "眼前的主线还不能只凭传闻下结论；哪一件原件能证明你的说法？",
    };
  }
  // 只剩通用结构化兜底，不尝试从角色名或 NPC 台词猜主题。
  const variants: readonly DialogueChoiceLabels[] = [
    {
      support: "请把这件事的来历和下一步说清楚，我按能核对的线索查下去。",
      challenge: "这还不足以下结论；请指出一件能当场核对的原件或证物。",
    },
    {
      support: "先交代清楚你掌握的事实，以及我接下来该去核对什么。",
      challenge: "我不会只凭一句话判断；什么证据能证明你的说法？",
    },
  ];
  const variant = variants[dialogueChoiceVariantIndex(context, npc, variants.length)] ?? variants[0]!;
  return variant;
}

type FactCardLike = { readonly factId: string; readonly text: string };

function dialogueTopicFor(context: SceneGenerationContext, secondary: boolean): DialogueTopic {
  if (!secondary) return { kind: "general" };
  const threadId = context.story.unresolvedThreadSummaries[0];
  if (threadId !== undefined && threadId.trim() !== "") return { kind: "thread", threadId };
  const questId = context.objectiveTransition.after?.questId;
  if (questId !== undefined) return { kind: "quest", questId: asQuestId(String(questId)) };
  return { kind: "general" };
}

function dialogueChoiceVariantIndex(
  context: SceneGenerationContext,
  npc: SceneGenerationContext["presentNpcs"][number],
  variantCount: number,
): number {
  if (variantCount <= 1) return 0;
  const recentInteractions = context.focusNpcContext?.recentInteractions ?? [];
  // 旧的最小测试/旧存档上下文没有 generationSeed，也没有可用历史时，保持
  // 第一组基础文案；真实上下文由 buildSceneGenerationContext 注入本局 seed，
  // 因此不会牺牲新开局之间的多样性。
  if (context.generationSeed === undefined && recentInteractions.length === 0) return 0;
  const seed = [
    context.generationSeed ?? "",
    String(npc.id),
    npc.name,
    npc.role,
    String(context.currentLocation.id),
    context.objectiveTarget?.entityId ?? "",
    context.job.actionSummary.kind,
    String(context.story.currentAct),
    context.story.nextPacingNeed,
  ].join("|");
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  // 回合号 + 已有交互条数是“同一 NPC 连续交谈”的序列游标；它让相邻
  // 正式回合不会因为 actionId 的散列碰撞又回到同一组文案；当前地点、
  // 目标、行动类型、幕次和节奏则为不同剧情分支提供不同起点。
  const sequenceOffset = context.job.turnNumber + recentInteractions.length;
  return (hash % variantCount + sequenceOffset) % variantCount;
}

/** 同一档位的回退台词也必须承接当前话语，且只使用 NPC 第一人称。 */
function buildContextualTierLine(context: SceneGenerationContext, tier: RelationshipTier): string {
  if ((context.job.utterance?.trim() ?? "") === "") {
    const fixedReply = structuredDialogueReply(context, context.previousDialogue?.selectedChoice?.dialogueAct === "challenge");
    if (fixedReply !== null) return fixedReply;
    if (context.focusNpcContext !== undefined && ["neutral", "friendly", "trusted"].includes(tier)) {
      return composeDirectNpcGreeting(context.focusNpcContext.role, context.focusNpcContext.name);
    }
    switch (tier) {
      case "hostile": return "有事就直说，但别指望我什么都回答。真想查下去，先拿能对上的证据来。";
      case "cold": return "有事就直说，我只回答我确定的部分。其余的，等你拿出证据再谈。";
      case "neutral": return "你是来打听事情的吧？想知道什么，直接问我。别把传闻当成证据。";
      case "friendly": return "有什么想问的尽管说，我能帮你的会尽量帮。先把你知道的那一段讲清楚。";
      case "trusted": return "不用绕弯子，你想知道什么就问吧。我会把我知道的都告诉你。";
    }
  }

  // 玩家原话是生成约束而不是 NPC 应逐字复读的稿子。确定性 fallback 只引用
  // 服务端已解析的当前目标，不按角色名猜测证物或地点，避免 NPC 平白知道
  // 一组尚未在故事中出现的细节。
  const directReply = objectiveDialogueReply(context, false);
  switch (tier) {
    case "hostile": return `这不关你的事，我不会替任何人担保。${directReply}再逼问，我只会把门关上。`;
    case "cold": return `我只说亲眼见过的部分。${directReply}其余的，等你拿出能对上的证据再谈。`;
    case "neutral": return `${directReply}这条线索够你先走一步，别急着替谁下结论。`;
    case "friendly": return `${directReply}你把手里的证据带上，我们可以把前后两段对起来。`;
    case "trusted": return `${directReply}我会把能证明这件事的东西交给你，一起把来龙去脉查清。`;
  }
}

/**
 * 固定选择和自由输入共用同一条结构化 fallback。它只使用当前主线已经
 * 解析出的目标类型/实体，不从 NPC role 或对白文本匹配出“松脂/车辙”等
 * 额外证物；具体 NPC 事实由 live performer 从 speakableFactCards 生成。
 */
function structuredDialogueReply(context: SceneGenerationContext, questioning: boolean): string | null {
  if (context.job.actionSummary.kind !== "talk" || context.previousDialogue === undefined) return null;
  const interaction = context.focusNpcContext?.recentInteractions
    .find((entry) => entry.actionId === context.job.actionId);
  if (interaction?.dialogueAct !== "support" && interaction?.dialogueAct !== "challenge") return null;
  return objectiveDialogueReply(context, questioning);
}

function objectiveDialogueReply(context: SceneGenerationContext, questioning: boolean): string {
  const lead = questioning
    ? "你问得在理，我只说我能确认的部分。"
    : "既然你愿意继续查，我把眼前能确认的范围说清楚。";
  return `${lead}${objectiveHandoffLine(context)}`;
}

/** 当前任务交接只从结构化目标产生，不能由 NPC 身份或台词关键词推断。 */
function objectiveHandoffLine(context: SceneGenerationContext): string {
  const target = context.objectiveTarget;
  const kind = context.story.activeQuest?.objectiveKind;
  if (target === null || kind === undefined) {
    return "先把眼前这条线索核对清楚，再往下判断。";
  }
  switch (kind) {
    case "visit_location": return `接下来去${target.entityName}核对现场。`;
    case "talk_to_npc": return `接下来找${target.entityName}把这一环问清。`;
    case "obtain_item": return `接下来先找到${target.entityName}，拿实物核对。`;
    case "discover_fact": return `接下来查明${target.entityName}，不要只凭传闻判断。`;
    case "defeat_enemy": return `接下来先处理${target.entityName}，再追查后面的线索。`;
    default: return `接下来按主线核对${target.entityName}。`;
  }
}

function buildStatusLine(resolvedEvent: SceneGenerationContext["job"]["resolvedEvent"]): string {
  switch (resolvedEvent.status) {
    case "success":
      return "你想了解什么？我可以先说说我知道的。";
    case "partial_success":
      return "这件事我知道一些，但有些部分不方便现在全说。";
    case "failure":
      return "恐怕这件事我帮不上忙，你换个问题吧。";
    case "blocked":
      return "现在还不是做这件事的时候。";
    default:
      return "我还没弄清楚这件事，先别急着下结论。";
  }
}

/** 目标链接：与 objectiveTransition.after 精确一致；无 after 时为 null。 */
function buildObjectiveLink(context: SceneGenerationContext): ScenePerformanceProposal["objectiveLink"] {
  const after = context.objectiveTransition.after;
  if (after === null) return null;
  const mode = context.objectiveTransition.mode === "advanced_act"
    ? "handoff"
    : context.objectiveTransition.mode === "progressed"
      ? "progress"
      : "hint";
  return { questId: String(after.questId), objectiveIndex: after.objectiveIndex, mode };
}

/** 两个不同的合法选项：优先选择推进当前目标的行动，再保底任意合法候选。 */
export function buildSceneChoices(
  context: SceneGenerationContext,
  currentNpcLine?: string | CurrentNpcLineContext,
): ScenePerformanceProposal["choices"] {
  const selectable = buildSelectableSceneCandidates(context, currentNpcLine);
  if (selectable.length < 2) {
    throw new Error("scene fallback requires at least two legal action candidates");
  }
  const targetEntityId = context.objectiveTarget?.entityId;
  const ordered = [...selectable].sort((a, b) => {
    const aScore = targetEntityId !== undefined && actionTargetsObjective(a.action, targetEntityId) ? 1 : 0;
    const bScore = targetEntityId !== undefined && actionTargetsObjective(b.action, targetEntityId) ? 1 : 0;
    return bScore - aScore;
  });
  const distinct: SceneChoiceCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    const key = semanticSummaryOf(candidate.action);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(candidate);
    if (distinct.length === 2) break;
  }
  if (distinct.length !== 2) {
    throw new Error("scene fallback requires two distinct legal action candidates");
  }
  return [
    { candidateId: distinct[0]!.candidateId, label: distinct[0]!.label },
    { candidateId: distinct[1]!.candidateId, label: distinct[1]!.label },
  ];
}

/** 事件状态由 job 的真实 eventKind 派生：travel→travel，talk→dialogue 焦点 NPC，investigate→首条事实。 */
export function buildEventState(context: SceneGenerationContext): NarrativeEventState {
  const { job, currentLocation } = context;
  // 幕推进已经把权威目标交给下一名人物/地点；上一回合的 talk 只说明
  // “刚才发生了什么”，不能继续把旧 NPC 设为新一幕的焦点，否则会重新
  // 铸造同一组 support/challenge 选项。交接场景改用通用合法候选，并由
  // objectiveTarget 排序把真正的下一步放在前面。
  if (context.objectiveTransition.mode === "advanced_act") {
    return { kind: "observe", locationId: currentLocation.id };
  }
  switch (job.resolvedEvent.eventKind) {
    case "travel":
      return { kind: "travel", locationId: currentLocation.id };
    case "dialogue": {
      const focus = focusNpc(context);
      if (focus === undefined) return { kind: "observe", locationId: currentLocation.id };
      const objectiveNpc = context.objectiveTarget === null
        ? undefined
        : context.presentNpcs.find((npc) => String(npc.id) === context.objectiveTarget?.entityId);
      const latestDialogueAct = context.focusNpcContext?.recentInteractions.at(-1)?.dialogueAct;
      if (objectiveNpc !== undefined
        && String(objectiveNpc.id) !== String(focus.id)
        && latestDialogueAct !== "ask") {
        return { kind: "observe", locationId: currentLocation.id };
      }
      return { kind: "dialogue", focusNpcId: focus.id };
    }
    case "investigate": {
      const factChange = job.resolvedEvent.facts[0];
      return factChange !== undefined
        ? { kind: "investigate", factId: factChange.factId }
        : { kind: "observe", locationId: currentLocation.id };
    }
    default:
      return { kind: "observe", locationId: currentLocation.id };
  }
}

export function actionFromLegalCandidate(
  candidate: SceneGenerationContext["legalActionCandidates"][number],
): Action | null {
  switch (candidate.kind) {
    case "explore": return { type: "explore" };
    case "move": return candidate.targetId === undefined
      ? null
      : { type: "move", locationId: asLocationId(candidate.targetId) };
    case "talk": return candidate.targetId === undefined
      ? null
      : { type: "talk", npcId: asNpcId(candidate.targetId), dialogueAct: "ask" };
    case "attack": return candidate.targetId === undefined
      ? null
      : { type: "attack", enemyId: asEnemyId(candidate.targetId) };
    case "battle_action": return candidate.targetId === "attack"
      || candidate.targetId === "guard"
      || candidate.targetId === "flee"
      ? { type: "battle_action", action: candidate.targetId }
      : null;
  }
}

function nonDialogueChoiceLabel(action: Action, sourceLabel?: string): string {
  const label = (() => {
  switch (action.type) {
    case "explore": return "默默不作声，先观察四周";
    case "move": return "不再追问，离开这里";
    case "take_item": return "暂不回应，先拾取眼前物品";
    case "investigate": return "暂不回应，先调查现场";
    case "attack": {
      const target = sourceLabel?.replace(/^挑战/u, "").trim() || "眼前的敌人";
      return `（拔出兵器，向${target}发起攻击）`;
    }
    case "battle_action": return "暂不回应，先做好应战准备";
    default: return "暂不回应，先做自己的事";
  }
  })();
  return formatSceneChoiceLabel(action, label);
}

/**
 * 场景选项的可见文案契约：对白就是主角要说的话，行动用全角括号包裹。
 * 审批层也会调用它，避免 live source 用角色前缀或未包裹的行动文案绕过
 * 这个契约。
 */
export function formatSceneChoiceLabel(action: Action, label: string): string {
  const trimmed = label.trim();
  if (action.type === "talk") return stripDialoguePrefix(trimmed);
  if (/^（.*）$/u.test(trimmed)) return trimmed;
  const withoutAsciiWrapper = trimmed.match(/^\((.*)\)$/u)?.[1]?.trim() ?? trimmed;
  return `（${withoutAsciiWrapper}）`;
}

function stripDialoguePrefix(label: string): string {
  const withoutPrefix = label.replace(/^(?:回应|追问|质疑|询问)[^：:]{0,24}[：:]\s*/u, "").trim();
  if ((withoutPrefix.startsWith("“") && withoutPrefix.endsWith("”"))
    || (withoutPrefix.startsWith("\"") && withoutPrefix.endsWith("\""))) {
    return withoutPrefix.slice(1, -1).trim();
  }
  return withoutPrefix;
}
