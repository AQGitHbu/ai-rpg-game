import { storyConsequenceBindingPrompt } from "../storyConsequenceBindingPrompt";
import { storyInteractionPrompt } from "../storyInteractionPrompt";
import { NARRATIVE_PROGRESS_CONTRACT } from "../narrativeProgressContract";
import { renderNarrativeCandidateRevision } from "../narrativeCandidateRevisionPrompt";
import { dialogueTopicKey, type Action } from "@/game/domain/action";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import type { NarrativeSceneState } from "@/game/domain/narrative";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { NarrativeMemoryContext } from "@/game/domain/narrativeMemoryContext";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { entitiesOfKind, projectEntityStore, type EntityId } from "@/game/domain/entity";
import { buildStylePolicy } from "@/game/application/stylePolicy";
import { buildEntityContextProjection, buildWorldDeltaEntityContextClosure, type EntityContextProjection } from "@/game/application/entityContextProjection";
import { buildNpcSpeechAuthority } from "@/game/application/npcSpeechAuthority";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

import type {
  NarrativeBundleRepair,
  NarrativeAuthorDraftRevision,
  NarrativeCandidateRevision,
} from "@/game/application/narrativeBundleSource";
import { compileNarrativeContext } from "./compileNarrativeContext";
import {
  type NarrativeContextBlock,
  type NarrativePromptCompilation,
} from "./contextBlock";
import { createNarrativePromptCompilation } from "./renderNarrativeContext";
import {
  renderNarrativeMemory,
  retrieveNarrativeMemory,
  retrieveStoryEvidence,
} from "@/game/gameplay/rpg/narrativeMemory";
import { renderAiRepairFeedback } from "../../../aiGenerationRetry";
import { buildOpeningHandoffContext } from "./openingHandoffContext";
import { projectNarrativeDraft } from "../narrativeDraftProjection";
import { deriveStructuralEvolutionNeed } from "@/game/gameplay/rpg/worldEvolution";
import { isStoryDeliveryComplete } from "@/game/gameplay/rpg/storyDelivery";
import { availableInvestigations } from "@/game/gameplay/rpg/investigation";
import { projectStoryConsequences } from "@/game/application/storyConsequenceContext";
import { previewNarrativeDisclosure } from "@/game/application/approveNarrativeBundle";
import { parseNarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import { isStoryConsequenceBindingsProposal } from "@/game/domain/storyConsequenceBindings";

// P1 live journeys may run in provider thinking mode, whose effective input
// budget is provider-specific. Keep the compiler's bounded mode available for
// other callers, but do not reject a narrative bundle locally on an arbitrary
// 8,000-token estimate.
export const NARRATIVE_BUNDLE_CONTEXT_MAX_ESTIMATED_TOKENS = Number.MAX_SAFE_INTEGER;

type DecisionNarrativeContextInput = Readonly<{
  consumer?: "author" | "reviewer";
  worldState: WorldState;
  storyState: StoryState;
  job: PendingNarrativeJob;
  contentRepair?: NarrativeBundleRepair;
  candidateRevision?: NarrativeCandidateRevision;
  authorDraftRevision?: NarrativeAuthorDraftRevision;
  npcOutward?: readonly import("../../../npcSpeechAuthority").NpcDeliberationOutwardProjection[];
  memoryContext?: NarrativeMemoryContext;
  maxEstimatedTokens?: number;
}>;

function block(input: NarrativeContextBlock): NarrativeContextBlock {
  return input;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "（无）" : values.join("、");
}

function candidateActionProjection(action: Action): string {
  switch (action.type) {
    case "talk": return JSON.stringify({ type: action.type, npcId: String(action.npcId), dialogueAct: action.dialogueAct, topic: dialogueTopicKey(action.topic), interactionId: action.interactionId ?? null });
    case "move": return JSON.stringify({ type: action.type, locationId: String(action.locationId) });
    case "investigate": return JSON.stringify({ type: action.type, factId: String(action.factId), approachId: action.approachId ?? null });
    case "give_item": return JSON.stringify({ type: action.type, itemId: String(action.itemId), npcId: String(action.npcId) });
    case "abandon_quest": return JSON.stringify({ type: action.type, questId: String(action.questId) });
    case "take_item": return JSON.stringify({ type: action.type, itemId: String(action.itemId) });
    case "attack": return JSON.stringify({ type: action.type, enemyId: String(action.enemyId) });
    case "battle_action": return JSON.stringify({ type: action.type, action: action.action });
    case "explore":
    case "ack_prologue":
    case "freeform":
      return JSON.stringify({ type: action.type });
  }
}

function candidateProjection(candidate: { readonly candidateId: string; readonly action: Action }): string {
  return `${candidate.candidateId} => ${candidateActionProjection(candidate.action)}`;
}

function occupiedNamesSection(context: EntityContextProjection): string {
  return [
    `- 地点：${list(context.occupiedNames.location)}`,
    `- NPC：${list(context.occupiedNames.npc)}`,
    `- 物品：${list(context.occupiedNames.item)}`,
    `- 敌人：${list(context.occupiedNames.enemy)}`,
    `- 任务：${list(context.occupiedNames.quest)}`,
  ].join("\n");
}

function itemStateSection(context: EntityContextProjection): string {
  const items = [...context.mandatory, ...context.optional].filter((entity) => entity.kind === "item");
  return items.length === 0
    ? "（当前闭包无相关物品）"
    : items.map((item) => `- ${item.name}（${item.id}）：${item.summary}`).join("\n");
}

function sourceLinkedMemoryText(memory: NarrativeMemoryContext): string {
  if (memory.observerId !== PLAYER_ENTITY_ID) throw new Error("AUTHOR_MEMORY_OBSERVER_MISMATCH");
  const renderEntry = (entry: NarrativeMemoryContext["uncovered"][number]): string =>
    `historyId=${entry.id}; sequence=${entry.sequence}; turn=${entry.turnNumber}; kind=${entry.kind}; speaker=${entry.speakerId === null ? "旁白" : entry.speakerId}; audience=[${entry.audienceIds.join(", ")}]; text=${entry.text}`;
  const entries = [...memory.uncovered, ...memory.recalled]
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .map(renderEntry);
  const renderEvent = (event: NarrativeMemoryContext["requiredEvents"][number]) =>
    `eventId=${event.eventId}; sequence=${event.sequence}; turn=${event.turnNumber}; kind=${event.kind}; outcome=${event.outcome}; payload=${JSON.stringify(event.payload)}`;
  const events = memory.requiredEvents.map(renderEvent);
  const requiredIds = new Set(memory.requiredEvents.map(event => event.eventId));
  const overviewEvents = (memory.overviewEvents ?? []).filter(event => !requiredIds.has(event.eventId)).map(renderEvent);
  return [
    "以下内容是同一 observer 的来源可追溯长期记忆包；原话只能按 speaker/audience 理解，不能把玩家选项当成 NPC 亲口说过的话。",
    `observer=${memory.observerId}; coveredThroughSequence=${memory.coveredThroughSequence}`,
    `必需事件：\n${events.join("\n") || "（无）"}`,
    `来源原文：\n${entries.map((entry) => `- ${entry}`).join("\n") || "（无）"}`,
    `概览中的当时事件（不是当前状态）：\n${overviewEvents.join("\n") || "（无额外事件）"}`,
  ].join("\n");
}

function repairInstruction(repair: NarrativeBundleRepair, requiresWorldDelta: boolean): string {
  const duplicateEntries = repair.detail?.startsWith("duplicate_name:")
    ? repair.detail.slice("duplicate_name:".length).split("|")
      .map((entry) => entry.match(/^(npc|location|item|enemy|quest):(.+)$/u))
      .filter((entry): entry is RegExpMatchArray => entry !== null)
    : [];
  const duplicateInstruction = duplicateEntries.map((entry) =>
    `- 上一轮新${entry[1]}名称“${entry[2]}”已与世界中现有实体重复；本轮必须另起一个未占用名称，不能沿用或仅加“新”“另一个”等前缀。`,
  ).join("\n");
  const reviewDefectCodes = new Set(
    (repair.detail ?? "").split(" | ").map((entry) => entry.slice(0, entry.indexOf(":"))),
  );
  const semanticRepairInstructions = [
    reviewDefectCodes.has("BROKEN_CAUSALITY")
      ? "- 上一轮有 BROKEN_CAUSALITY：current 槽只写本轮 action 已结算的回应；若合法图包含 move:<locationId>，currentScene 不得写玩家已经抵达该地点、见到该 NPC、完成调查或完成交付。抵达、见面和该移动后的 settledOutcome 只能写在对应 continuationScenes[stepKey]，并只能按该槽的展示时点成立。"
      : "",
    reviewDefectCodes.has("UNSUPPORTED_FACT")
      ? "- 上一轮有 UNSUPPORTED_FACT：worldDelta.beatSummary、currentScene/continuationScenes/endingOutcomes 的旁白和 NPC 台词都只能使用当前 job/action 已提交事件、获准事实和本槽已结算结果的最小因果概括；事实公开不等于传播已发生，不得写“托人问、转述、传讯、扩散、有人带话、双方到场”或其他没有真实 event 依据的新传播、委托、抵达、知情或结果。没有新增可证实因果时使用中性摘要/回应，不要用任何场景字段叙述未来续接。"
      : "",
    reviewDefectCodes.has("DISCLOSURE")
      ? "- 上一轮有 DISCLOSURE：所有 currentScene、continuationScenes 和 endingOutcomes 的 NPC 台词都只能使用该槽位该说话人的逐受众获准事实，不能把其他 NPC/槽位的 allowedFactIds 或调查结果复制过来；所有 choice label 只能表达玩家下一步要执行的意图（询问、核对、前往、调查或作出选择），不能泄露尚未触发的调查结果、NPC 立场、隐藏事实、证据结论或成功后果；把“已经查明/已经确认/对方会……”改成“去核对/询问是否/尝试查明”。"
      : "",
    reviewDefectCodes.has("ACTION_MISMATCH")
      ? "- 上一轮有 ACTION_MISMATCH：逐项复制 legal graph 的 candidateId、绑定 action 和 choiceCount，不要让 choice label 承诺其绑定 action 不会执行的移动、调查、交付或其他效果。若 projection.expectedChoices 是终幕立场，currentScene.choices 必须恰好保留 candidateId=ending_stance_support 与 ending_stance_challenge 的两个可执行选择；endingOutcomes 两个结果 scene 的 choices 必须为空，且只能描述各自 action preview 已列出的后果，不得提前写额外登册、用印、传播或地点变化。"
      : "",
  ].filter(Boolean).join("\n");
  const contractRepairInstructions = [
    repair.detail?.includes("ending_pair_invalid:pair_only_at_ending")
      ? "- 上一轮在非终局回合错误输出了 worldDelta.endingPair；本轮必须将 endingPair 设为 null。只有 current_resolution 明确要求生成终局且 terminal 为 ending 时才允许提供 endingPair，不能用下一幕、抵达或交付前置包提前生成结局。"
      : "",
    repair.detail?.includes("p3_investigation_required")
      ? "- 上一轮 P3 能力未落地：当前已进入第二幕且仍没有正式 investigation 事实。本轮必须在 worldDelta.newFact 创建未发现 scene 事实，并在同一 worldDelta.consequenceBindings 使用 factRef=@new.fact、discoveryMode=investigation 和恰好 2–3 条 approaches；不能只写普通对话、investigationApproaches 或 automatic 事实。"
      : "",
    repair.detail?.includes("DISCLOSURE:")
      ? "- 上一轮违反了逐受众披露权限：所有 currentScene.npcLine、npcDialogues 和 continuation 场景 NPC 台词都只能陈述该说话人在该槽位当前 context 明确获准披露、且在 usedFactIds 中逐项声明的事实；不同 NPC、不同槽位的 allowedFactIds 不能互相借用或复制。若被拒绝事实不在该说话人的 allowedFactIds 中，禁止把它补进 usedFactIds、existingFactIds 或 publicExistingFacts；必须从该 NPC 的所有台词中删除该事实及其来源归属的改写，不要再提被拒绝事实的名称、簿册、旧例或结论，改成中性询问/回应。"
      : "",
    repair.detail?.includes("ACTION_MISMATCH:")
      ? "- 上一轮把尚未由本轮 action 结算的抵达、返回、调查或完成结果写进了当前场景或续接选项。current 槽只回应本轮已提交 action；未来 move/调查/交付只能写对应 continuation 槽，不能在 NPC 台词、旁白或任何 continuation choice label 中预设已发生，也不要写“上回曾……/已经……/已向玩家……”等完成前提；choice label 只表达玩家下一步要执行的意图，并且必须与其 candidateId 绑定的 action 类型一致：talk 只能表达交谈/询问/回应，不能承诺移动、调查、交付或领取；move 只能表达前往，investigate 只能表达查验，give_item/take_item 只能表达对应物品操作。若错误指出 player_0 的实际地点没有规则依据，则从 currentScene、continuationScenes 和 endingOutcomes 的旁白/台词中删除玩家抵达、返回、在某地或已见到某人的断言；除非该槽明确由对应 move action 结算，否则使用不带地点变化的中性表达。"
      : "",
    repair.detail?.includes("npc_knowledge")
      ? "- 上一轮把 NPC 尚未知晓的事实用于 request_verification。share_known_fact 只有在玩家实际选择并结算后才会把事实加入 NPC 知识；同一 proposal 包内不能同时依赖这次尚未结算的分享再提出 request_verification。本轮只保留当前可执行的 share_known_fact，删除同一事实的 request_verification 及其 choice，待分享实际结算后的下一回合再提出核验。"
      : "",
    repair.detail?.includes("p3_share_requires_evidence")
      ? "- 上一轮 P3 的 share_known_fact 没有绑定调查证据。本轮先查看当前 context 的真实 event ledger：share_known_fact.evidenceEventIds 必须包含已提交、成功且 payload.type=fact_discovered 的真实 eventId，并且该事件的 factId 必须与 proposal.factIds 中的事实一致；不能留空，不能根据当前/下一 action 编号拼造 eventId（例如不能把 private-action-4:fact_discovered 当作尚未发生的事件），不能引用待发生事件，也不能只靠台词声称已查证。若当前 ledger 没有匹配事件，必须删除 share_known_fact 及其 choice，先让调查 action 单独结算，下一回合再提出分享。"
      : "",
  ].filter(Boolean).join("\n");
  const rejectionSpecificInstruction = repair.rejectionCode === "invented_beat_id"
    ? "- currentScene.segments 的 beatId 只能逐字复制 current_resolution 列出的节拍 ID；本轮不要使用 dialogue、narration、response 等自造 beatId。若列表只有 atmosphere，就省略 segments 或只使用 beatId=atmosphere。"
    : repair.reason === "invalid_schema" && repair.detail?.startsWith("world_delta_invalid")
      ? !requiresWorldDelta ? "- 本回合 worldDelta 必须为 null，不生成 beatSummary 或任何世界增量字段；不要修补该对象，直接返回 null。" : "- worldDelta 结构校验失败；按错误路径检查该对象，不能假定错误来自 newFact。worldDelta.beatSummary 必须是非空字符串；结局 endingPair 必须与 beatSummary 同置于 worldDelta 内，不能放到顶层。"
      : "";
  return `${renderAiRepairFeedback(repair)}
本轮只需修正被拒绝的那一项，其余中文叙事文本可以沿用你自己的写法。硬性要求：
- sceneDrafts 必须与服务端场景槽一一对应：不得新增、重复或漏槽。
- 选择槽必须有两个合法 candidateId 和中文 label；其他槽 choices=[]。terminal 和 step 包装由服务器生成。
- 新地点/NPC/物品/敌人/任务的名称不得与“已占用实体名称”中的任何一项重复。
- 若输出 worldDelta.newFact，investigationApproaches 必须是恰好 2–3 条且每条字段合法；若无法提供完整 2–3 条，直接将 newFact 设为 null，不要输出单条或不完整列表。
${duplicateInstruction}
${semanticRepairInstructions}
${contractRepairInstructions}
${rejectionSpecificInstruction}`;
}

function recentScene(storyState: StoryState): NarrativeSceneState | null {
  const narrative = storyState.narrative;
  if (narrative.status === "ready") return narrative.currentScene;
  return narrative.lastPresentedScene;
}

function clipText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}……`;
}

function actionSummaryEntityIds(action: PendingNarrativeJob["actionSummary"]): readonly string[] {
  switch (action.kind) {
    case "talk": return [String(action.npcId)];
    case "move": return [String(action.locationId)];
    case "investigate": return [String(action.factId)];
    case "take_item": return [String(action.itemId)];
    case "give_item": return [String(action.itemId), String(action.npcId)];
    case "abandon_quest": return [String(action.questId)];
    case "attack": return [String(action.enemyId)];
    case "explore":
    case "battle_action":
    case "ack_prologue":
    case "freeform":
      return [];
  }
}

function focusNpcContent(worldState: WorldState, job: PendingNarrativeJob): string {
  const focusNpc = job.focusNpcId === undefined
    ? undefined
    : entitiesOfKind(worldState.entityStore, "npc").find((npc) => String(npc.core.id) === String(job.focusNpcId));
  if (focusNpc === undefined) return "本回合没有焦点 NPC；currentScene.npcLine 仅在权威图明确要求时出现。";

  const authority = buildNpcSpeechAuthority({
    store: worldState.entityStore,
    speakerNpcId: focusNpc.core.id,
    eventLedger: worldState.eventLedger,
    sceneVisibleFactIds: entitiesOfKind(worldState.entityStore, "fact")
      .filter((fact) => fact.fact.discovered)
      .map((fact) => fact.core.id),
    targetContext: { targetId: PLAYER_ENTITY_ID, currentEventIds: job.domainEventIds },
  });
  if (authority === null) return "本回合没有焦点 NPC；currentScene.npcLine 仅在权威图明确要求时出现。";

  const speakableFacts = authority.allowedFactCards.map((fact) => `${fact.factId}=${fact.text}`);
  const interactions = authority.recentInteractions.map((interaction) =>
    `${interaction.eventId}：dialogueAct=${interaction.dialogueAct}；topic=${interaction.topicSummary}；outcome=${interaction.outcome}；summary=${interaction.summary}`,
  );
  const thisTurn = authority.recentInteractions.find((interaction) => interaction.actionId === job.actionId);

  return [
    `本回合对话焦点 NPC：${focusNpc.core.name}（${focusNpc.core.id}，${focusNpc.identity.role}）`,
    `公开档案=${focusNpc.identity.description}`,
    `关系档位=${authority.responseTier}；回应语气仅由当前关系档位决定；主动性仅由当前关系档位决定。`,
    `当前情绪=${focusNpc.dynamicState.emotion}；目标=${list(authority.activeGoals)}`,
    `本轮关系信号=${thisTurn === undefined ? "neutral" : thisTurn.outcome}`,
    `允许披露事实=${list(speakableFacts)}`,
    "当前场景中该 focus NPC 的 npcLine.usedFactIds 只能引用上述事实 ID；其他场景和说话人必须使用其自身获批知识与逐受众权限。npcLine.usedEventIds 只能引用下列已授权证据 Event ID；没有引用时必须输出显式空数组。",
    `已授权证据 Event ID=${list(authority.allowedEventIds.map(String))}`,
    `最近五条结构化交互：\n${interactions.length === 0 ? "（无）" : interactions.map((entry) => `- ${entry}`).join("\n")}`,
    "私密事实正文与未授权知识不在本上下文中；不得自行补全。",
  ].join("\n");
}

function expectedBundleProjection(worldState: WorldState, storyState: StoryState, job: PendingNarrativeJob, includeDeliveryReturn?: boolean, includeObjectiveReturn?: boolean) {
  const draft = projectNarrativeDraft({ worldState, storyState, job, includeDeliveryReturn, includeObjectiveReturn });
  const { descriptorGraph, nextActProjection } = draft;
  const expectedChoices = draft.slots[0]!.choiceCount === 0 || descriptorGraph.currentChoiceCandidates.length === 0
    ? "当前场景不允许 choices；终点步骤的 choices 必须使用下方对应候选。"
    : descriptorGraph.currentChoiceCandidates.map(candidateProjection).join("；");
  const expectedSteps = draft.terminal.kind === "ending" ? "无 continuation step。" : nextActProjection !== null
    ? draft.slots.slice(1).map((slot, index) => {
      const arrivalNpcId = draft.nextActStepNpcIds[index] ?? nextActProjection.npcId;
      return `- ${slot.slotKey}；展示时规则结果：${JSON.stringify(slot.resolution)}；choices: ${slot.choiceCount === 0 ? "无" : `${slot.slotKey}_choice_1 => ${candidateActionProjection({ type: "talk", npcId: arrivalNpcId as never, dialogueAct: "support" })}；${slot.slotKey}_choice_2 => ${candidateActionProjection({ type: "talk", npcId: arrivalNpcId as never, dialogueAct: "challenge" })}`}；到达 NPC: ${arrivalNpcId}；scene.npcLine 必须是该 NPC 的直接对白，不能为 null。${slot.choiceCount === 0 ? "这是交付前的抵达步骤，不能提前写成已交付。" : "这是终点步骤。"}`;
    }).join("\n")
    : descriptorGraph.steps.length === 0
      ? "无 continuation step。"
      : descriptorGraph.steps.map((step) => {
          const choices = step.choiceCandidates.map(candidateProjection).join("；") || "无";
          const terminalArrivalRequirement = descriptorGraph.terminal.kind === "next_decision"
            && descriptorGraph.terminal.target.kind === "continuation_step"
            && descriptorGraph.terminal.target.stepKey === step.stepKey
            && step.arrivalNpc !== undefined
            ? `；这是终点步骤，scene.npcLine 必须是到达 NPC ${step.arrivalNpc.id} 的直接开场对白，不能为 null`
            : "";
          return `- ${step.stepKey}；展示时规则结果：${JSON.stringify(draft.slots.find(slot => slot.slotKey === step.stepKey)?.resolution)}；choices: ${choices}${terminalArrivalRequirement}`;
        }).join("\n");
  const expectedTerminal = draft.terminal;
  const currentTalkNpcIds = descriptorGraph.terminal.kind === "next_decision"
    && descriptorGraph.terminal.target.kind === "current_scene"
    ? descriptorGraph.currentChoiceCandidates
        .map((candidate) => candidate.action)
        .filter((action): action is Extract<Action, { readonly type: "talk" }> => action.type === "talk")
        .map((action) => String(action.npcId))
    : [];
  const dialogueFocusNpc = descriptorGraph.currentChoiceCandidates.length === 2
    && currentTalkNpcIds.length === 2
    && currentTalkNpcIds[0] === currentTalkNpcIds[1]
    ? worldState.npcs.find((npc) => String(npc.id) === currentTalkNpcIds[0])
    : undefined;
  return { descriptorGraph, nextActProjection, nextActStepNpcIds: draft.nextActStepNpcIds, expectedChoices, expectedSteps, expectedTerminal, dialogueFocusNpc, slots: draft.slots, endingResolutions: draft.endingResolutions };
}

export function buildDecisionNarrativeContextBlocks(
  input: DecisionNarrativeContextInput,
): readonly NarrativeContextBlock[] {
  let { storyState, job } = input;
  const { contentRepair } = input;
  const reviewing = input.consumer === "reviewer";
  // Prompt facts must exclusively originate from the authoritative store. The
  // legacy arrays are a compatibility read model and may never repair a
  // missing/inconsistent store projection here.
  let worldState = { ...input.worldState, ...projectEntityStore(input.worldState.entityStore) };
  // A repair of a legal disclosure receives its resulting routing, while the
  // frozen memory remains the original job package. Recompute from the same
  // candidate, never from prose or a previous failed candidate's world state.
  const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const raw = object(input.authorDraftRevision?.draft);
  const draftScenes = raw?.sceneDrafts;
  const currentDraft = Array.isArray(draftScenes) ? object(draftScenes.find(entry => object(entry)?.slotKey === "current"))?.scene : undefined;
  const candidate = input.candidateRevision?.proposal;
  const current = candidate?.currentScene ?? currentDraft;
  const parsed = current === undefined ? null : parseNarrativeBundleProposal({ worldDelta: null, currentScene: { ...object(current), choices: [] }, continuationScenes: [], terminal: { kind: "ending" } });
  const topBindings = (candidate !== undefined && "consequenceBindings" in candidate ? candidate.consequenceBindings : undefined) ?? raw?.consequenceBindings ?? [];
  const deltaBindings = object(candidate !== undefined && "worldDelta" in candidate ? candidate.worldDelta : raw?.worldDelta)?.consequenceBindings ?? [];
  const rawBindings = Array.isArray(topBindings) && Array.isArray(deltaBindings) ? [...deltaBindings, ...topBindings] : null;
  if (parsed?.ok && isStoryConsequenceBindingsProposal(rawBindings)) {
    const preview = previewNarrativeDisclosure({ scene: parsed.proposal.currentScene, worldState, storyState,
      transition: job.objectiveTransition, source: { actionId: job.actionId, turnId: job.turnId, turnNumber: job.turnNumber },
      currentEventIds: job.domainEventIds, bindings: rawBindings });
    if (preview.ok) {
      worldState = preview.worldState;
      storyState = preview.storyState;
      job = { ...job, objectiveTransition: preview.transition };
    }
  }
  const entityContext = buildEntityContextProjection({
    worldState,
    storyState,
    job,
    memoryEntityIds: input.memoryContext?.referencedEntityIds,
  });
  const projection = expectedBundleProjection(worldState, storyState, job);
  const returnProjection = storyState.evolution.status === "needs_next_act"
    ? null : expectedBundleProjection(worldState, storyState, job, true);
  const delivery = storyState.delivery;
  const optionalReturnGraph = delivery !== undefined && returnProjection !== null
    && returnProjection.descriptorGraph.steps.length === 1
    && returnProjection.descriptorGraph.steps[0]?.stepKey === `give_item:${delivery.itemId}:${delivery.giverNpcId}`
    ? reviewing
      ? `\n合法归还图仅适用于玩家明确要求归还委托物；不得替玩家决定归还或将其视为放弃任务。terminal=${JSON.stringify(returnProjection.expectedTerminal)}；currentScene choices=${returnProjection.expectedChoices}；continuationScenes:\n${returnProjection.expectedSteps}`
      : `\n可选归还图：仅当本轮玩家明确要求把委托物归还委托人时，整体使用以下图替代默认图；不得把两图拼接，不得因存在此图就替玩家决定归还。归还只变更物品归属，放弃任务仍须玩家后续选择。\n- 选择本图时输出 graph="return_delivery"，其场景槽=${JSON.stringify(returnProjection.slots)}\n- 服务端终点（只读，不输出）：${JSON.stringify(returnProjection.expectedTerminal)}\n- currentScene choices: ${returnProjection.expectedChoices}\n- continuationScenes:\n${returnProjection.expectedSteps}`
    : "";
  const currentLocation = worldState.locations.find((location) => location.id === worldState.currentLocationId);
  const objectiveReturn = expectedBundleProjection(worldState, storyState, job, false, true);
  const optionalObjectiveReturnGraph = JSON.stringify(objectiveReturn.slots) !== JSON.stringify(projection.slots)
    ? `\n可选原任务返程图：当前回应已结束、准备继续未完成任务时可整体替代默认图，不与其他图拼接。只准备到已访问相邻地点的目标 NPC 的移动，玩家仍须实际选择移动才发生，不自动完成任务。若仍需在当前 NPC 处告知或合作，继续默认图。${reviewing ? "" : '\n- 选择本图时输出 graph="objective_return"。'}\n- 场景槽=${JSON.stringify(objectiveReturn.slots)}\n- terminal=${JSON.stringify(objectiveReturn.expectedTerminal)}\n- currentScene choices: ${objectiveReturn.expectedChoices}\n- continuationScenes:\n${objectiveReturn.expectedSteps}`
    : "";
  const availableInvestigationMethods = availableInvestigations({ worldState, storyState }).map((opportunity) => ({
    factId: String(opportunity.factId),
    approachId: opportunity.approachId,
    label: opportunity.label,
    ...(opportunity.hint === undefined ? {} : { hint: opportunity.hint }),
  }));
  const storyConsequences = projectStoryConsequences({
    worldState,
    storyState,
    observerId: PLAYER_ENTITY_ID,
    eventIds: job.domainEventIds,
  });
  const focusNpc = job.focusNpcId === undefined
    ? undefined
    : worldState.npcs.find((npc) => String(npc.id) === String(job.focusNpcId));
  const previousScene = recentScene(storyState);
  const privateFactIds = new Set(worldState.npcs.flatMap((npc) => npc.memory.hiddenFactIds.map(String)));
  const visibleFacts = worldState.worldFacts.filter((fact) =>
    fact.discovered && !privateFactIds.has(String(fact.factId)),
  );
  const activeQuest = worldState.quests.find((quest) => quest.status === "active" && quest.kind === "main");
  const openingHandoff = buildOpeningHandoffContext({ worldState, job });
  const storyEvidence = input.memoryContext !== undefined ? {
    entityIds: input.memoryContext.referencedEntityIds, eventIds: [], historyIds: [],
    ambiguousEntityIds: input.memoryContext.ambiguousEntityIds, manifest: [],
  } : retrieveStoryEvidence({
    worldState,
    storyState,
    observerId: PLAYER_ENTITY_ID,
    text: job.utterance ?? job.selectedDialogue?.label ?? "",
    actionEntityIds: actionSummaryEntityIds(job.actionSummary) as readonly EntityId[],
    focusEntityIds: job.focusNpcId === undefined ? [] : [job.focusNpcId],
  });
  const narrativeMemory = renderNarrativeMemory({
    retrieved: retrieveNarrativeMemory({
      memory: storyState.memory,
      ledger: worldState.eventLedger,
      requiredEventIds: [...job.domainEventIds, ...(openingHandoff?.requiredEventIds ?? [])],
      beforeSequenceExclusive: Math.min(worldState.eventLedger.length, ...worldState.eventLedger
        .filter((event) => job.domainEventIds.includes(event.eventId)).map((event) => event.sequence)),
      relevantEntityIds: [
        String(worldState.currentLocationId),
        ...actionSummaryEntityIds(job.actionSummary),
        ...job.mandatoryBeats.flatMap((beat) => beat.subjectIds),
        ...(job.focusNpcId === undefined ? [] : [String(job.focusNpcId)]),
        ...(activeQuest === undefined ? [] : [String(activeQuest.id)]),
      ],
      relevantQuestIds: [
        ...(job.objectiveTransition.before === null ? [] : [job.objectiveTransition.before.questId]),
        ...job.objectiveTransition.completed.map((entry) => entry.questId),
        ...(job.objectiveTransition.after === null ? [] : [job.objectiveTransition.after.questId]),
      ],
      relevantFactIds: job.resolvedEvent.facts.map((entry) => entry.factId),
      currentLocationId: worldState.currentLocationId,
      focusNpcId: job.focusNpcId,
      storyEvidence,
      history: storyState.history,
    }),
    entityStore: worldState.entityStore,
  });
  const openingHandoffEventIds = new Set((openingHandoff?.requiredEventIds ?? []).map(String));
  const packetEventIds = new Set([...(input.memoryContext?.requiredEvents ?? []), ...(input.memoryContext?.overviewEvents ?? [])].map(event => String(event.eventId)));
  const currentRequiredEventsText = narrativeMemory.requiredEventsText
    .split("\n")
    .filter((line) => ![...openingHandoffEventIds, ...packetEventIds].some((eventId) => line.startsWith(`eventId=${eventId};`)))
    .join("\n");
  const style = buildStylePolicy(worldState.generation.setup);
  const expectedObjectiveLink = job.objectiveTransition.after === null
    ? "null"
    : JSON.stringify({
        questId: job.objectiveTransition.after.questId,
        objectiveIndex: job.objectiveTransition.after.objectiveIndex,
        mode: "progress",
      });
  const narrativeBeats = job.mandatoryBeats.filter((beat) => beat.beatId !== ATMOSPHERE_BEAT_ID);
  const structuralEvolutionNeed = deriveStructuralEvolutionNeed(worldState, storyState);
  const beatLines = job.mandatoryBeats.map((beat) => {
    const requirement = beat.beatId === ATMOSPHERE_BEAT_ID
      ? "可选，可省略；若写，必须放在所有 segments 最后"
      : "必须覆盖，恰好一次";
    return `- beatId="${beat.beatId}"（${beat.kind}，${requirement}）：${beat.instruction}`;
  }).join("\n");
  // 仅当「强制节拍只有可选 atmosphere」时收紧为单段契约；mandatoryBeats 为空不属于该场景。
  const atmosphereOnly = narrativeBeats.length === 0
    && job.mandatoryBeats.some((beat) => beat.beatId === ATMOSPHERE_BEAT_ID);
  const segmentContract = atmosphereOnly
    ? `本回合没有其他强制叙事节拍。currentScene.segments 可以省略；若返回，必须且只能包含一条氛围段，固定使用 beatId="${ATMOSPHERE_BEAT_ID}"；不得出现 dialogue、narration、response、player_utterance 或任何其他自造 beatId。`
    : `本回合强制叙事节拍（currentScene.segments 的 beatId 只能是下列之一）：\n${beatLines || "（无；只允许可选 atmosphere）"}`;
  const utteranceBeat = job.mandatoryBeats.find((beat) => beat.kind === "player_utterance");
  const resultBoundarySummary = job.resultBoundaryProof?.kind === "investigation_result"
    ? `本轮是已提交的主动调查结果：事实=${String(job.resultBoundaryProof.factId)}；方式=${job.resultBoundaryProof.approachId}；依据事件=${job.resultBoundaryProof.sourceEventIds.map(String).join(",")}。只表现已结算结果，不重新选择方式或再次执行调查；currentScene 可以没有 NPC。`
    : job.resultBoundaryProof?.kind === "changed_revisit"
      ? `本轮是已提交的变化回访：地点=${String(job.resultBoundaryProof.locationId)}；上次场景事件=${String(job.resultBoundaryProof.previousSceneEventId)}；变化依据事件=${job.resultBoundaryProof.sourceEventIds.map(String).join(",")}。只表现已结算变化，不把普通移动或未知秘密写成提示；currentScene 可聚焦当前已释放且在场角色。`
      : undefined;
  const actionSummary = resultBoundarySummary
    ?? (job.utterance !== undefined
    ? `玩家自定义输入：${job.utterance}`
    : job.selectedDialogue?.label !== undefined
      ? `玩家选择了选项：“${job.selectedDialogue.label}”\n本次所选结构化意图：dialogueAct=${job.selectedDialogue.dialogueAct}；topic=${dialogueTopicKey(job.selectedDialogue.topic)}。若是 ask，已批准事实只代表当前已知材料，不代表其中已经含有问题的精确答案；NPC 可回答已知部分，并明确哪些部分仍待核对。`
      : job.actionSummary.kind === "abandon_quest"
        ? `玩家明确放弃主线任务：${String(job.actionSummary.questId)}。这是一次正式退出，不是普通移动或对话；请生成无 NPC、无 choices 的退出收束。`
      : `玩家行动：${job.actionSummary.kind}`);
  const evolutionRequirement = structuralEvolutionNeed.kind === "next_act"
    ? `本回合已进入第 ${storyState.currentAct} 幕：worldDelta 绝不能为 null，必须提供 newLocation、newNpc、${storyState.contract.delivery === undefined ? "newItem、newEnemy、" : ""}nextMainQuest；其余字段可为 null。${storyState.contract.delivery === undefined ? "" : "递送主线只需服务同一交付的地点、NPC 与任务；newItem/newEnemy 默认 null，不为凑目标链增加无关物品或战斗。"}${storyState.currentAct >= storyState.targetActs ? `这是最终幕：新地点、新 NPC、nextMainQuest 及抵达场景必须共同承接中心冲突“${storyState.contract.centralConflict}”的实际处理，现有目标必须在本幕可执行完成，不能继续引荐或转交给不存在的下一幕；当前只建立终幕处理场景与任务，不提前替玩家完成或选择结果。` : "这是非最终幕：继续推进中心冲突，不提前完成或宣告结局。"}`
    : structuralEvolutionNeed.kind === "ending_pair"
      ? `本回合需要结局：worldDelta 绝不能为 null，且必须在 worldDelta 内同时提供非空 beatSummary 和 trust/doubt endingPair（例如 {"beatSummary":"本轮终局节拍摘要","endingPair":[...]}）；这两个字段都不能置于顶层；不能创建地点、NPC、物品、敌人、任务；currentScene 停在玩家对中心冲突作出最终立场选择之前；${reviewing ? "terminal.kind=ending，并包含 endingOutcomes 两个条件结果。" : "另输出 endingOutcomes，恰好包含 trust/doubt 两项，每项只有 themeKey、玩家可见 choiceLabel 与 choices=[] 的完整结果 scene；结果 scene 明确处理中心冲突及相应后果，不规划下一幕。终点由服务端编译为 ending。"}`
      : job.actionSummary.kind === "abandon_quest"
        ? `本回合是正式退出：worldDelta 必须为 null；不能创建实体、修改任务或承诺；${reviewing ? "currentScene 是唯一场景，terminal.kind=ending，currentScene.choices" : "仅输出 current 槽，终点由服务端编译为 ending，current 槽 choices"} 必须为 [] 且 npcLine 必须为 null。`
      : "本回合不需要世界演化：worldDelta 必须为 null。";
  const arrivalSkeleton = reviewing || projection.nextActProjection === null
    ? ""
    : `下一幕场景骨架（逐槽填写正文，不改变选择数量）：${JSON.stringify(projection.slots.slice(1).map((slot, index) => ({ slotKey: slot.slotKey, scene: { segments: [{ beatId: "atmosphere", text: slot.resolution?.settledOutcome }], npcLine: { npcId: projection.nextActStepNpcIds[index] ?? projection.nextActProjection!.npcId, text: "到达 NPC 的第一人称对白", emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] }, objectiveLink: null, choices: slot.choiceCount === 0 ? [] : [{ candidateId: `${slot.slotKey}_choice_1`, label: "..." }, { candidateId: `${slot.slotKey}_choice_2`, label: "..." }] } })))}。`;
  const genreRequirement = worldState.generation.gameType === "wuxia"
    ? "武侠写实约束：角色、冲突与叙述只能采用江湖、人事、武学、机关等武侠元素；禁止鬼魂、幽灵、灵魂、超自然、魔法、法术、咒语、法阵、圣光、精灵、异界等玄幻/西幻元素。"
    : "叙述必须严格贴合当前题材，不混入其他题材的设定。";

  const choiceActionContract = "选项 label 必须忠于其服务端 Action：talk 只能写玩家对 NPC 说出的对话意图，不得写成转身、推门、调出设备、接通通信、拿取物品、移动或其他物理动作；move 只能写玩家准备前往目标地点的意图；investigate 只能写准备采用方法的意图；give_item 只能写准备交付的意图；任何类型都不得在 label 中假定尚未发生的事实、承诺或结果。尤其 continuation choice 不能泄露尚未触发的调查结果、证据结论、NPC 立场或抵达后的成功后果。";
  const declarableExistingFactIds = buildWorldDeltaEntityContextClosure({ worldState, storyState, job }).declarableExistingFactIds ?? [];
  const deliveryItem = delivery === undefined ? undefined : entitiesOfKind(worldState.entityStore, "item").find(item => item.core.id === delivery.itemId);
  const deliveryEvidence = delivery === undefined ? null : {
    action: { type: "give_item", itemId: delivery.itemId, npcId: delivery.recipientNpcId },
    giverNpcId: delivery.giverNpcId,
    owner: deliveryItem?.possession.owner ?? null,
    completed: isStoryDeliveryComplete(worldState, storyState),
    successfulTransferEventIds: worldState.eventLedger.filter(event => event.outcome === "success"
      && event.actorIds.includes(PLAYER_ENTITY_ID) && event.payload.type === "item_given"
      && event.payload.itemId === delivery.itemId && event.payload.npcId === delivery.recipientNpcId).map(event => String(event.eventId)),
    publicExistingFacts: visibleFacts.filter(fact => declarableExistingFactIds.includes(String(fact.factId))).map(fact => ({ factId: String(fact.factId), text: fact.text })),
  };
  const investigationEvidence = worldState.eventLedger.flatMap(event => {
    if (event.outcome !== "success" || event.payload.type !== "fact_discovered" || event.payload.evidenceQuality === undefined) return [];
    return [{ factId: String(event.payload.factId), eventId: String(event.eventId) }];
  }).slice(-3);
  const evidenceFactIds = new Set(investigationEvidence.map(entry => entry.factId));
  const evidenceClosureNpcId = delivery?.giverNpcId ?? null;
  const evidenceWasShared = worldState.eventLedger.some(event => event.outcome === "success"
    && event.payload.type === "story_interaction_resolved" && event.payload.operation === "share_known_fact"
    && event.payload.npcId === evidenceClosureNpcId
    && event.payload.factIds.some(factId => evidenceFactIds.has(String(factId))));
  const evidenceWasVerified = worldState.eventLedger.some(event => event.outcome === "success"
    && event.payload.type === "story_interaction_resolved" && event.payload.operation === "request_verification"
    && event.payload.npcId === evidenceClosureNpcId
    && event.payload.factIds.some(factId => evidenceFactIds.has(String(factId))));
  const evidenceClosurePending = deliveryEvidence !== null && !deliveryEvidence.completed && investigationEvidence.length > 0
    && (!evidenceWasShared || !evidenceWasVerified);
  const evidenceClosureContract = deliveryEvidence !== null && !deliveryEvidence.completed && investigationEvidence.length > 0
    ? `当前已有真实调查证据=${JSON.stringify(investigationEvidence)}，且递送尚未完成。玩家契约要求先回访原委托人 ${String(evidenceClosureNpcId ?? "")} 完成告知与核验，再前往绑定接应人 ${String(delivery?.recipientNpcId ?? "")} 交付。${evidenceClosurePending && String(job.focusNpcId ?? "") === String(evidenceClosureNpcId ?? "")
      ? `${evidenceWasShared ? "告知已结算，本轮必须提出唯一 request_verification；" : "本轮必须提出唯一 share_known_fact；"}复制上述真实 factId/eventId；share_known_fact 的 audienceIds 只填同场目标 NPC，request_verification 的 audienceIds 固定填 [player_0]（npcId 是被请求的 NPC，不是听众）；并让 current 槽 choices 包含对应 interaction:proposalKey；不得只写普通 talk 文案。当前证据互动尚未完成时，禁止输出 graph=return_delivery、give_item continuation 或把交付作为本回合终点；先让玩家实际选择该 interaction。`
      : evidenceClosurePending
        ? `当前焦点不是原委托人，不得远程提出该互动；应先提供合法 move/现有 interaction 继续到原委托人所在场景。`
        : "核验已结算，不要重复提出；可继续前往绑定接应人并准备真实交付。"}核验的 factIds/evidenceEventIds 必须引用上述真实证据，不能自证未来事件。`
    : "";
  const worldDeltaContract = structuralEvolutionNeed.kind === "none"
    ? "- 本回合 worldDelta 必须为 null；不生成 beatSummary，也不输出世界增量对象。"
    : `- 若要求 worldDelta，严格使用 {\"beatSummary\":\"...\",\"newLocation\":{\"name\":\"...\",\"description\":\"...\",\"scale\":\"scene\",\"placement\":\"world\",\"connectFromLocationId\":\"现有地点 ID\"},\"newNpc\":{\"name\":\"...\",\"role\":\"...\",\"description\":\"...\",\"locationRef\":{\"kind\":\"new_location\"},\"anchors\":{\"selfConcept\":\"...\",\"values\":[\"...\"],\"speechStyle\":\"...\",\"capabilityBoundaries\":[\"...\"],\"taboos\":[]},\"goals\":[{\"horizon\":\"short\",\"description\":\"...\",\"priority\":3,\"reason\":\"...\"}],\"relationshipSeeds\":[{\"targetNpcId\":\"既有 active NPC ID\",\"stance\":\"ally|protective_of|indebted_to|rival|wary\",\"reason\":\"...\"}]},\"newItem\":null或{\"name\":\"...\",\"description\":\"...\",\"locationRef\":\"new_location\"},\"newEnemy\":null或{\"name\":\"...\",\"tier\":\"normal\",\"locationRef\":\"new_location\"},\"newFact\":null或{\"text\":\"...\",\"visibility\":\"public或npc_private（provider 也可写 private，服务端会归一化）\",\"investigationLabel\":\"主动调查时必填非空，其余可选\",\"investigationApproaches\":[{\"approachId\":\"...\",\"label\":\"...\",\"hint\":\"可选\",\"evidenceQuality\":\"clean或noisy\",\"tensionDelta\":-5到20}]},\"nextMainQuest\":{\"name\":\"...\",\"description\":\"...\",\"objectiveText\":\"...\"},\"consequenceBindings\":[],\"endingPair\":null或[{\"themeKey\":\"trust\",\"name\":\"...\",\"description\":\"...\"},{\"themeKey\":\"doubt\",\"name\":\"...\",\"description\":\"...\"}]}；anchors 五个字段都必需，goals 至少 1 条且最多 4 条；relationshipSeeds 最多 4 条，每项只能包含 targetNpcId、stance、reason，targetNpcId 只能引用实体规则闭包中的既有 active NPC，stance 只能使用上述定性枚举，reason 必须非空且≤200字；不得提交 affinity、stage、evidence 或 actionId；goalId/status 由服务端生成，禁止输出。consequenceBindings 按可选数组契约省略或 []；其他未要求字段必须为 null。`;
  const blocks: NarrativeContextBlock[] = [
    block({
      id: "bundle:consequence-bindings", slot: "output_contract", title: "可选规则绑定契约",
      authority: "rule", retention: "mandatory", priority: 990,
      source: { kind: "story_consequence_binding_contract", refs: [] },
      content: storyConsequenceBindingPrompt("decision"),
    }),
    block({
      id: "bundle:disclosure-consequences", slot: "system_rules", title: "本场披露与后果预览",
      authority: "rule", retention: "mandatory", priority: 1000,
      source: { kind: "narrative_bundle_contract", refs: [String(job.jobId)] },
      content: "current 槽可使用有序 expressions：narration={kind,beatId,text,referencedEntityIds}；npc_line={kind,npcId,audienceIds,text,emotion,answeredBeatIds,usedFactIds,usedEventIds}。实际在场 NPC 听众收到合法 usedFactIds 后才形成知识后果；公开目录或未来续接不代表本人获知。程序在编译槽位前归约本场知识、目标、Quest、reveal 和最多当前一幕推进。下列槽位是未披露或当前修订稿的预览；若你改变本场披露，必须按新后果提供完整槽位、选择及必要的 nextMainQuest/endingPair；缺少内容会沿当前候选额度给出修订依据，不发布半成品。不得用未来续接完成本场目标，终局仍等玩家选择。",
    }),
    block({
      id: "bundle:progress-contract", slot: "system_rules", title: "推进与有限收束",
      authority: "rule", retention: "mandatory", priority: 1000,
      source: { kind: "narrative_bundle_contract", refs: [] }, content: NARRATIVE_PROGRESS_CONTRACT,
    }),
    block({
      id: "bundle:rules", slot: "system_rules", title: "规则与事实优先级",
      authority: "rule", retention: "mandatory", priority: 1000,
      source: { kind: "narrative_bundle_contract", refs: [String(job.jobId)] },
      content: `${reviewing ? "本上下文用于审阅服务端已编译的 NarrativeBundleProposal。只返回审阅结论，候选内容尚未提交。" : "你是 RPG 的叙事 AI。一次响应生成完整叙事包，只输出 JSON，不能有解释或 Markdown。"}规则、已提交状态、已结算节拍、服务端图与输出契约高于历史文本和当前提案；不得改写规则结果、发明实体 ID 或扩大未来步骤。\n${genreRequirement}\n战斗失败会恢复到战斗前检查点，不生成战败或撤退的永久剧情分支。`,
    }),
    block({
      id: "bundle:world-canon", slot: "world_canon", title: "世界与题材",
      authority: "lore", retention: "optional", priority: 500,
      source: { kind: "generation_metadata", refs: [] },
      content: `游戏类型=${worldState.generation.gameType}；世界前提=${worldState.generation.setup?.worldPremise ?? "沿用当前世界"}；故事开端=${worldState.generation.setup?.storyOpening ?? "沿用当前主线"}。`,
    }),
    block({
      id: "bundle:story-contract", slot: "story_contract", title: "故事契约",
      authority: "plan", retention: "mandatory", priority: 850,
      source: { kind: "story_contract", refs: [] },
      content: `中心冲突=${storyState.contract.centralConflict}；结局方向=${storyState.contract.endingDirections.map((direction) => `${direction.key}=${direction.theme}`).join("；")}。故事契约不定义当前幕数，以当前剧情状态为准。`
        + (storyState.contract.delivery === undefined ? "" : `递送契约=${JSON.stringify(storyState.contract.delivery)}；当前角色绑定=${JSON.stringify(storyState.delivery)}。最终幕主线的 talk_to_npc 目标由规则绑定为 recipientKey 对应的接应人；此前人物不能冒充最终接应人，禁止另造或替换信物。必须准备对该接应人的显式 give_item；保密、引荐和核验均不等于交付。`),
    }),
    block({
      id: "bundle:player-story-opening", slot: "story_contract", title: "玩家本局故事开端",
      authority: "plan", retention: "mandatory", priority: 995,
      source: { kind: "generation_metadata", refs: [] },
      content: `本局玩家故事开端（不可降级的玩法要求）=${worldState.generation.setup?.storyOpening ?? "沿用当前主线"}。这不是背景润色，而是本局玩家要求实际兑现的能力契约：不能只在 scene 文本、选项 label 或 investigationApproaches 中提及要求后宣称完成。若要求在后续独立 scene 提供主动调查，必须在到达该合法场景时实际创建未发现 scene 事实、提供非空 investigationLabel、提供恰好 2–3 条方法，并用 discoveryMode=investigation 的 bind_investigation 绑定；不能用 automatic 事实替代。若当前回合尚未到可兑现时点，应继续推进到合法承载场景，不得把未执行能力写成已完成。若当前幕已从开场推进到 currentAct>=2 且仍没有 discoveryMode=investigation 的事实，当前包必须在 worldDelta 中创建该事实并绑定 bind_investigation；普通 talk/travel 包会被规则层拒绝为 p3_investigation_required:bind_investigation_on_scene_fact。`,
    }),
    ...(deliveryEvidence === null ? [] : [block({
      id: "bundle:delivery-endpoint", slot: "story_contract", title: "递送中心结果与幕职责",
      authority: "rule", retention: "mandatory", priority: 950,
      source: { kind: "story_delivery", refs: [String(delivery!.itemId), String(delivery!.giverNpcId), ...(delivery!.recipientNpcId === null ? [] : [String(delivery!.recipientNpcId)])] },
      content: `作者与审阅共用的交付依据=${JSON.stringify(deliveryEvidence)}。完成只由绑定接应人当前持有同一物品且存在玩家成功 item_given 事件共同证明；接受委托、抵达、普通 talk、引荐、核验和终幕立场均不完成交付。recipient 尚为 null 时，最终幕首个主线 talk NPC 将由具象化绑定，不能靠称呼另行换人。\n第一幕职责：明确委托、公开交付约定和去向，通过现有规则取得唯一物品。中间幕职责：提供实际路线或处置依据，角色可有不同意见，但只推进同一次交付。最终幕职责：主线保留与绑定接应人的 talk 边界，先抵达，再由玩家选择真实 give_item，交付后再作终幕立场；不能把收束转给不存在的下一幕或写成修理、付款等规则没有执行的中心结果。\n公开约定足以作为 verificationFactKeys 依据，可在普通对话中说明，不强制增加身份谜题、秘密或核验状态。publicExistingFacts 只是现有可声明公开依据，不授予任何 NPC 知识；后续 newNpc 若要陈述其中事实，必须在 existingFactIds 显式列出该 ID，未声明就不能声称知情。保密等既有显式权限仍按原条件执行。生成快照 owner 是交付前状态；give_item 续接槽只在转移成功后展示，正文必须按槽 resolution 承接接应人已收到物品。\n${evidenceClosureContract}`,
    })]),
    block({
      id: "bundle:current-state", slot: "current_state", title: "当前剧情状态",
      authority: "state", retention: "mandatory", priority: 900,
      source: { kind: "story_state_projection", refs: [String(job.jobId)] },
      content: `currentAct=${storyState.currentAct}；targetActs=${storyState.targetActs}；storyProgress=${storyState.storyProgress}；tension=${storyState.tension}；nextPacingNeed=${storyState.nextPacingNeed}；remainingBudget=locations:${Math.max(0, storyState.budget.locations.max - storyState.budget.locations.expanded)},npcs:${Math.max(0, storyState.budget.npcs.max - storyState.budget.npcs.expanded)},quests:${Math.max(0, storyState.budget.quests.max - storyState.budget.quests.expanded)},events:${Math.max(0, storyState.budget.events.max - storyState.budget.events.expanded)}；unresolvedThreads=${list(storyState.unresolvedThreads)}；activeQuest=${activeQuest === undefined ? "无" : `${activeQuest.name}（${activeQuest.id}，${activeQuest.status}）：${activeQuest.description}`}`,
    }),
    block({
      id: "bundle:story-consequences", slot: "current_state", title: "本轮已结算后果引用",
      authority: "rule", retention: "mandatory", priority: 910,
      source: { kind: "story_consequence_context", refs: [
        ...storyConsequences.requiredEventIds.map(String),
        ...storyConsequences.activeThreadIds,
      ] },
      content: `后果上下文只来自本轮已提交事件：requiredEventIds=${JSON.stringify(storyConsequences.requiredEventIds.map(String))}；activeThreadIds=${JSON.stringify(storyConsequences.activeThreadIds)}；当前可用的已批准互动 ID=${JSON.stringify(storyConsequences.availableInteractionIds)}。NPC 私密 goal 描述、理由和未授权条件不属于公开作者上下文；只能依据当前合法 Action 与公开证据表现后果，不能从引用 ID 推测秘密。`,
    }),
    block({
      id: "bundle:player", slot: "current_state", title: "玩家档案",
      authority: "state", retention: "mandatory", priority: 900,
      source: { kind: "world_state_projection", refs: [] },
      content: `玩家=${worldState.player.name}（${worldState.player.identity}）。不得给玩家改名、增加未经状态批准的身份或宣称未结算的持有物。`,
    }),
    block({
      id: "bundle:visible-facts", slot: "current_state", title: "当前可见事实",
      authority: "state", retention: "mandatory", priority: 875,
      source: { kind: "public_fact_projection", refs: visibleFacts.map((fact) => String(fact.factId)) },
      content: `允许叙述的已发现公开事实：${list(visibleFacts.map((fact) => `${fact.factId}=${fact.text}`))}。其他 NPC 的私密事实正文未提供，不得自行补全。`,
    }),
    block({
      id: "bundle:resolution", slot: "current_resolution", title: "当前已结算结果",
      authority: "state", retention: "mandatory", priority: 950,
      source: { kind: "pending_narrative_job", refs: [String(job.jobId)] },
      content: `${segmentContract}\ncurrentScene.objectiveLink 必须严格为 ${expectedObjectiveLink}。${utteranceBeat === undefined ? "" : `\n存在 player_utterance 节拍：npcLine 必须为 npcId=\"${utteranceBeat.subjectIds[0] ?? ""}\" 的直接回应，answeredBeatIds 必须包含 \"${utteranceBeat.beatId}\"。`}${job.actionSummary.kind === "talk" && focusNpc !== undefined ? `\ncurrentScene.npcLine 必须是 ${focusNpc.name} 对本轮行动的第一人称直接回应，不能为 null。` : ""}${projection.dialogueFocusNpc === undefined ? "" : `\n当前决策点是 ${projection.dialogueFocusNpc.name} 的对话，currentScene.npcLine 必须提供其直接对白。`}`,
    }),
    block({
      id: "bundle:location", slot: "current_location", title: "当前地点",
      authority: "state", retention: "mandatory", priority: 900,
      source: { kind: "world_state_projection", refs: currentLocation === undefined ? [] : [String(currentLocation.id)] },
      content: currentLocation === undefined
        ? "当前地点缺失；不得猜测地点。"
        : `玩家当前位置：${currentLocation.name}（${currentLocation.id}）：${currentLocation.description}；已连接地点=${list(currentLocation.connectedLocationIds.map(String))}。`,
    }),
    block({
      id: "bundle:available-investigations", slot: "legal_actions", title: "合法主动调查方法",
      authority: "rule", retention: "mandatory", priority: 925,
      source: { kind: "world_state_projection", refs: availableInvestigationMethods.map((entry) => entry.factId) },
      content: availableInvestigationMethods.length === 0
        ? "当前没有可提交的主动调查方法。不能自行发明调查方式，也不能把未发现事实正文写进当前回应。"
        : `当前地点仅允许玩家从以下已批准方法中选择主动调查：${JSON.stringify(availableInvestigationMethods)}。不能自行发明调查方式、替换 approachId、提前写出事实正文或把调查当作已经执行；方法选择仍由玩家通过地点 read model 的 opaque choiceToken 提交。`,
    }),
    block({
      id: "bundle:focus-npc", slot: "focus_character", title: "焦点角色",
      authority: "state", retention: "mandatory", priority: 875,
      source: { kind: "focus_npc_projection", refs: focusNpc === undefined ? [] : [String(focusNpc.id)] },
      content: focusNpcContent(worldState, job),
    }),
    block({
      id: "bundle:entity-index", slot: "current_state", title: "已批准实体索引",
      authority: "state", retention: "mandatory", priority: 825,
      source: { kind: "world_entity_index", refs: entityContext.mandatory.map((entity) => entity.id) },
      content: `已占用实体名称（新实体不得与下列任何名称重复）：\n${occupiedNamesSection(entityContext)}\n世界内实体名称唯一，新实体必须避开以上全局名称。\n规则闭包：\n${entityContext.mandatory.map((entity) => `- ${entity.kind}:${entity.id}=${entity.name}；${entity.summary}${entity.goalBindings === undefined ? "" : `；goalBindings=${JSON.stringify(entity.goalBindings)}`}`).join("\n") || "（无）"}\n一跳相关实体：\n${entityContext.optional.map((entity) => `- ${entity.kind}:${entity.id}=${entity.name}；${entity.summary}${entity.goalBindings === undefined ? "" : `；goalBindings=${JSON.stringify(entity.goalBindings)}`}`).join("\n") || "（无）"}\n只有规则闭包和一跳相关实体中的 ID 可作为当前场景既有实体引用；全局名称表只用于防撞名。`,
    }),
    block({
      id: "bundle:item-state", slot: "current_state", title: "物品权威状态",
      authority: "state", retention: "mandatory", priority: 875,
      source: { kind: "possession_projection", refs: [...entityContext.mandatory, ...entityContext.optional].filter((entity) => entity.kind === "item").map((entity) => entity.id) },
      content: `${itemStateSection(entityContext)}\n尚未拾取的物品只能被观察、发现或拾取；规则动作完成前，不得写成玩家已经持有、拿出或使用，也不得让选项假定玩家已经持有。`,
    }),
    block({
      id: "bundle:director-guidance", slot: "director_guidance", title: "导演与风格",
      authority: "plan", retention: "mandatory", priority: 825,
      source: { kind: "style_policy", refs: [] },
      content: `${style.narrationInstruction} ${style.intensityInstruction}\ncurrentScene 必须直接承接上一场景与玩家本轮行动，不得回到更早情节、重复上一场景开场或把玩家写回已经离开的旧地点。若玩家本轮是在询问，NPC 必须先直接回答或明确承认自己不知道、无权确认，再继续回应；不能用格言、反问或重复问题代替答复。任何台词、旁白与选项都不能补写状态中没有的既成事实、先前承诺、已完成动作、持有物或具体病情/记录。`,
    }),
    block({
      id: "bundle:player-action", slot: "player_action", title: "玩家本轮行动",
      authority: "state", retention: "mandatory", priority: 925,
      source: { kind: "pending_narrative_job", refs: [String(job.actionId)] },
      content: actionSummary,
    }),
    block({
      id: "bundle:legal-graph", slot: "legal_actions", title: "合法续接图",
      authority: "rule", retention: "mandatory", priority: 925,
      source: { kind: "narrative_bundle_descriptors", refs: [String(job.jobId)] },
      content: reviewing
        ? `合法编译图：currentScene 对应当前已结算回应；continuationScenes 的 stepKey 与场景必须逐一对应下列步骤。终点与 choice 数量由服务端确定，新增互动只能绑定同包 interaction:proposalKey。${choiceActionContract}\n- terminal=${JSON.stringify(projection.expectedTerminal)}\n- currentScene choices: ${projection.expectedChoices}\n- continuationScenes:\n${projection.expectedSteps}${optionalReturnGraph}${optionalObjectiveReturnGraph}`
        : `符号引用白名单：@current.location、@current.focus_npc、@new.location、@new.npc、@new.item、@new.enemy、@new.fact、@new.quest、@ending.trust、@ending.doubt。\nsceneDrafts 必须与本节槽位投影完全一致，不得投影之外自行规划未来步骤。${choiceActionContract}\n以下是服务端重建的默认合法图，步骤 key 就是 sceneDrafts 的 slotKey；candidateId 使用已列图 ID 或同包 interaction:proposalKey，禁止其他自造 ID、遗漏、重复或继续规划未来：\n- 默认场景槽（choiceCount 是必须的选择数）：${JSON.stringify(projection.slots)}\n- 服务端终点（只读，不输出）：${JSON.stringify(projection.expectedTerminal)}\n- currentScene choices: ${projection.expectedChoices}\n- continuationScenes:\n${projection.expectedSteps}${optionalReturnGraph}${optionalObjectiveReturnGraph}`,
    }),
    block({
      id: "bundle:temporal-scope", slot: "legal_actions", title: "同包内容的生效时点",
      authority: "rule", retention: "mandatory", priority: 925,
      source: { kind: "narrative_bundle_descriptors", refs: [String(job.actionId)] },
      content: `以下范围对作者、修订和审阅共同生效：${JSON.stringify({
        current: { fields: structuralEvolutionNeed.kind === "none" ? ["currentScene"] : ["currentScene", "worldDelta.beatSummary"], authorSlotKey: "current", basisKey: `action:${job.actionId}`, action: job.actionSummary, playerLocationId: String(worldState.currentLocationId) },
        conditionalContinuations: projection.slots.filter(slot => slot.slotKey !== "current").map(slot => ({ basisKey: `step:${slot.slotKey}`, slotKey: slot.slotKey, resolution: slot.resolution })),
        conditionalEndings: projection.endingResolutions.map(resolution => resolution.basisKey),
      })}。\n仅当本回合要求 worldDelta 时，beatSummary 才存在，并且只概括当前已提交行动及 current 场景中的回应，不概括整个生成包或下一幕剧情。当前幕编号变化、创建新地点/NPC/任务或预写续接正文，都不表示玩家已经移动、会面、交付或完成新任务。新地点和人物可作为下一步去向介绍，不能把那里的遭遇写进当前经历。\n续接场景仅在各自成功 trigger 之后展示，其 settledOutcome 只在该槽及后续已触发的槽成立；条件结局只在对应立场行动后成立，两个结果不同时发生。不能将这些条件结果回填到 currentScene 或 beatSummary。任何 continuation choice label 只写触发该槽后玩家准备执行的动作意图，不写该动作的结果、调查结论或尚未公开的事实。修订任一未来场景后仍按本范围核对摘要，不能沿用上一版越界摘要。`,
    }),
    ...(projection.endingResolutions.length === 0 ? [] : [block({
      id: "bundle:ending-resolution", slot: "legal_actions", title: "条件结局行动与后果依据",
      authority: "rule", retention: "mandatory", priority: 925,
      source: { kind: "narrative_bundle_descriptors", refs: [String(job.jobId)] },
      content: `服务端条件槽依据（choiceLabel、scene 与 endingPair 的 name/description 共用）：${JSON.stringify(projection.endingResolutions)}。审阅发现超出真实行动的因果后果时，按实际 endingOutcomes 或 worldDelta.endingPair 数组索引定位 choiceLabel、scene 正文字段或 name/description，并引用对应主题的 ending:trust 或 ending:doubt ruleBasis，不按数组顺序猜主题。`,
    })]),
    block({
      id: "bundle:world-evolution", slot: "director_guidance", title: "世界演化要求",
      authority: "state", retention: "mandatory", priority: 900,
      source: { kind: "story_evolution_state", refs: [] },
      content: `${evolutionRequirement}${arrivalSkeleton === "" ? "" : `\n${arrivalSkeleton}`}`,
    }),
    block({
      id: "bundle:new-npc-existing-facts", slot: "output_contract", title: "新 NPC 既有事实声明",
      authority: "rule", retention: "mandatory", priority: 1000,
      source: { kind: "narrative_bundle_schema", refs: declarableExistingFactIds },
      content: `newNpc 可省略 existingFactIds（等于 []），或提供无重复的既有事实 ID 数组。只能引用此列表：${JSON.stringify(declarableExistingFactIds)}。声明只建立该新 NPC 的 public initial_world 知识；未声明事实不因玩家已发现、角色描述、目标或台词而获授权。逐个检查该 NPC 在 current/continuation 场景中的 npcLine：usedFactIds 以及台词中的具体事实断言必须都属于它的 existingFactIds 或本场已合法产生的 @new.fact；不能只省略 usedFactIds 后仍在对白里说出未声明事实。特别是新 NPC 的抵达台词不得预设“玩家受谁委托、替谁送物、为何来到此处”或其他委托/传播关系；这些不是从玩家携带物品、NPC 的 role/goal、relationshipSeeds 或 publicExistingFacts 自动得到的知识。若 existingFactIds 未明确包含相应事实，禁止使用“替罗家送契”“受某人托付”“你是来办某事的”等同义断言，也不要用问句偷渡该前提；请改为中性迎客/询问，等玩家在合法 interaction 中主动说明。无法确认来源时删掉该事实断言，不要扩大 existingFactIds。`,
    }),
    block({
      id: "bundle:output-contract", slot: "output_contract", title: "输出契约",
      authority: "rule", retention: "mandatory", priority: 1000,
      source: { kind: "narrative_bundle_schema", refs: [] },
      content: reviewing
        ? `proposal 是服务端已编译的 NarrativeBundleProposal：{worldDelta,consequenceBindings?,currentScene,continuationScenes:[{stepKey,scene}],endingOutcomes?,terminal,interactionProposals?,npcOutwardProposals?}。npcOutwardProposals 是服务端随候选携带的获准 NPC 对外方案，结构为 {npcId,response,evidenceEventIds,discloseFactIds,interactionProposals}；它不是已执行行动或披露。terminal 为 {kind:"ending"} 或 {kind:"next_decision",target:{kind:"current_scene"}} 或 {kind:"next_decision",target:{kind:"continuation_step",stepKey}}。candidateHash 绑定此完整 compiled proposal，审阅路径直接定位该对象。结构预检已完成；检查各场景正文、引用、选择与权限和合法图的语义一致性。endingOutcomes 是仅在实际规则结局匹配后发布的条件内容，审阅两项时不得当作同时发生；每项必须承接中心冲突、对应选择与后果，不能发明规则未结算的行动。\n场景保留 segments、npcLine、objectiveLink、choices，也可包含 expressions、npcDialogues、handoffAcknowledgement；这些是场景表达，不能增加规则结果。终点决策场景恰好两个 choices，其他场景 choices=[]；ending 没有续接场景。下一幕抵达场景必须有抵达 NPC 的直接对白。\n${storyInteractionPrompt(false)}\n${worldDeltaContract}\n所有玩家可见文本必须为中文。`
        : `返回一个 JSON 对象，顶层必须有 worldDelta、sceneDrafts，可额外有 consequenceBindings、endingOutcomes、interactionProposals 和 graph。graph 省略或 default 使用默认图；只有明确选择合法归还图才填 return_delivery；选择下方合法原任务返程图才填 objective_return。不得输出 currentScene、continuationScenes 或 terminal，服务器按槽投影组装它们。${storyInteractionPrompt(false)}\n- 每个 scene={segments:[{beatId,text}],npcLine:null或{npcId,text,emotion,answeredBeatIds,usedFactIds,usedEventIds},objectiveLink:null或{questId,objectiveIndex,mode},choices:[{candidateId,label}]}。\n- sceneDrafts=[{slotKey:"current",scene:{...}},{slotKey:"精确服务端步骤key",scene:{...}}]；必须提供下列全部槽位，slotKey 不重复；对象的数组顺序不用于猜测归属。\n- 终点决策点恰好两个 choices，candidateId 复制合法图或同包 interaction:proposalKey；其余步骤 choices=[]。正式 trust/doubt 结局回合另提供 endingOutcomes=[{themeKey:"trust",choiceLabel:"...",scene:{...}},{themeKey:"doubt",choiceLabel:"...",scene:{...}}]，两结果 scene 的 choices=[]；正式退出不得提供。\n- npcLine 不能是字符串，npcId 与 text 必须由作者提供；仅 emotion、answeredBeatIds、usedFactIds、usedEventIds 可省略，编译器分别补 neutral 与 []。显式 null 或非法值不会替换；emotion 若提供只能是 neutral|warm|guarded|afraid|angry|sad。需要回答节拍或引用依据时必须提供真实数组，省略不免除审批；该默认仅适用于 npcLine，不适用于 npcDialogues。\n${worldDeltaContract}\n- nextMainQuest 回合 current 槽 choices=[]，抵达与交付槽必须使用对应场景骨架。所有玩家可见文本必须为中文。`,
    }),
    block({
      id: "bundle:item-acquisition", slot: "output_contract", title: "物品获取方式",
      authority: "rule", retention: "mandatory", priority: 1000,
      source: { kind: "narrative_bundle_schema", refs: [] },
      content: "worldDelta.newItem 可额外包含 acquisition，只能是 scene 或 npc_gift，省略时按 scene。scene 物品放在场景中，由玩家点击拾取；npc_gift 物品由同包 newNpc 持有，在该 NPC 的约定对话完成后由规则交给玩家。npc_gift 必须同时提供同地点 newNpc 和 nextMainQuest；不能提交 giver ID、giftFromNpcId、任意奖励或直接修改背包。不要在抵达或尚未完成的对话中提前叙述赠予成功，current 槽只有本回合已结算的 item_obtained 节拍才可写已获得。续接槽则在该 slot 的 trigger 成功后才展示：take_item 槽必须承接玩家已经拾取，give_item 槽必须承接已经交付；生成时的背包快照不能覆盖展示时该触发器已结算的结果。此前 current 或抵达槽仍不得提前写获得。NPC 给予后不再要求场景拾取。",
    }),
    block({
      id: "bundle:world-delta-investigation-contract", slot: "output_contract", title: "事实调查方式契约",
      authority: "rule", retention: "mandatory", priority: 1000,
      source: { kind: "narrative_bundle_schema", refs: [] },
      content: "若 worldDelta.newFact 非 null，investigationApproaches 必须恰好包含 2–3 条合法条目；若无法提供完整列表就输出 newFact:null，绝不能输出只有 1 条或不完整的列表。若当前主线要求玩家先选择主动调查方法时，必须有获准的主动调查事实，不能用 automatic 事实或仅在文字中提供 approaches 代替。若本包新建主动调查事实，须创建未发现且有非空 investigationLabel 的独立 scene 事实，并在 worldDelta.consequenceBindings（或顶层 consequenceBindings）提供 bind_investigation，factRef 使用 @new.fact，discoveryMode 固定为 investigation，并在 approaches 中复制同一组方法。对上下文内已有的合法未发现 scene 事实首次绑定，使用其正式 factId 和已有非空 investigationLabel，无需重建 newFact 或 newLocation，worldDelta=null 时绑定放顶层。仅提供 investigationApproaches 不会开启调查，事实抵达时仍会按 automatic 路径揭示。",
    }),
  ];

  if (openingHandoff !== null) {
    blocks.push(block({
      id: "bundle:opening-handoff", slot: "relevant_events", title: "开局背景与本次回应",
      authority: "event", retention: "mandatory", priority: 985,
      source: { kind: "committed_event", refs: openingHandoff.requiredEventIds.map(String) },
      content: openingHandoff.publicText,
    }));
  }

  if (currentRequiredEventsText !== "") {
    blocks.push(block({
      id: "bundle:required-events", slot: "relevant_events", title: "本回合已提交事件",
      authority: "event", retention: "mandatory", priority: 980,
      source: { kind: "committed_event", refs: narrativeMemory.manifestRefs.eventIds.map(String).filter((eventId) => !openingHandoffEventIds.has(eventId)) },
      content: currentRequiredEventsText,
    }));
  }
  if (input.memoryContext !== undefined) {
    const memory = input.memoryContext;
    const mandatoryRefs = new Set(memory.manifest.filter(entry => entry.mandatory).map(entry => entry.ref));
    const optionalRecalled = memory.recalled.filter(entry => !mandatoryRefs.has(entry.id));
    blocks.push(block({
      id: "bundle:source-linked-memory", slot: "relevant_events", title: "来源可追溯长期记忆",
      authority: "event", retention: "mandatory", priority: 975,
      source: { kind: "narrative_memory_context", refs: memory.manifest.filter(entry => entry.mandatory).map(entry => entry.ref) },
      content: sourceLinkedMemoryText({ ...memory, recalled: memory.recalled.filter(entry => mandatoryRefs.has(entry.id)) }),
    }));
    for (const entry of optionalRecalled) blocks.push(block({
      id: `bundle:memory-recall:${entry.id}`, slot: "relevant_events", title: "相关旧事原文",
      authority: "event", retention: "optional", priority: 720,
      source: { kind: "narrative_history", refs: [entry.id] },
      content: `historyId=${entry.id}; turn=${entry.turnNumber}; kind=${entry.kind}; speaker=${entry.speakerId}; text=${entry.text}`,
    }));
  }
  if (narrativeMemory.relevantEpisodesText !== "") {
    blocks.push(block({
      id: "bundle:episodic-memory", slot: "relevant_events", title: "相关历史经历",
      authority: "memory", retention: "optional", priority: 700,
      source: { kind: "episodic_memory", refs: narrativeMemory.manifestRefs.episodeIds.map(String) },
      content: narrativeMemory.relevantEpisodesText,
    }));
  }
  if (narrativeMemory.historyText !== undefined && narrativeMemory.historyText !== "") {
    blocks.push(block({
      id: "bundle:historical-expressions", slot: "relevant_events", title: "可引用的历史原话",
      authority: "event", retention: "mandatory", priority: 965,
      source: { kind: "narrative_history", refs: narrativeMemory.manifestRefs.historyIds ?? [] },
      content: narrativeMemory.historyText ?? "",
    }));
  }
  if (narrativeMemory.recentScenesText !== "") {
    blocks.push(block({
      id: "bundle:recent-scenes", slot: "recent_scenes", title: "近期场景节拍",
      authority: "memory", retention: "optional", priority: 680,
      source: { kind: "episodic_memory", refs: narrativeMemory.manifestRefs.sceneEventIds.map(String) },
      content: narrativeMemory.recentScenesText,
    }));
  }

  if (previousScene !== null) {
    blocks.push(block({
      id: "bundle:previous-scene", slot: "recent_scenes", title: "上一场景",
      authority: "event", retention: "mandatory", priority: 875,
      source: { kind: "narrative_runtime", refs: [] },
      content: `上一场景旁白：${clipText(previousScene.narration, 500)}${previousScene.npcLine === null ? "" : `\n上一场景台词：${clipText(previousScene.npcLine.text, 200)}`}`,
    }));
  }
  if (contentRepair !== undefined && !reviewing) {
    blocks.push(block({
      id: "bundle:repair", slot: "current_resolution", title: "上一轮拒绝与内容修复",
      authority: "state", retention: "mandatory", priority: 950,
      source: { kind: "narrative_bundle_repair", refs: [String(job.jobId)] },
      content: repairInstruction(contentRepair, structuralEvolutionNeed.kind !== "none"),
    }));
  }
  for (const entity of entityContext.optional) {
    blocks.push(block({
      id: `bundle:entity:${entity.kind}:${entity.id}`, slot: "current_state", title: "一跳相关实体",
      authority: "state", retention: "optional", priority: 500,
      source: { kind: "entity_context_projection", refs: [entity.id, ...(entity.locationId === undefined ? [] : [entity.locationId])] },
      content: `${entity.kind}:${entity.id}=${entity.name}；${entity.summary}${entity.goalBindings === undefined ? "" : `；goalBindings=${JSON.stringify(entity.goalBindings)}`}。`,
    }));
  }
  return blocks;
}

export function compileDecisionNarrativeContext(
  input: DecisionNarrativeContextInput,
): NarrativePromptCompilation {
  return createNarrativePromptCompilation(compileNarrativeContext({
    maxEstimatedTokens: input.maxEstimatedTokens ?? NARRATIVE_BUNDLE_CONTEXT_MAX_ESTIMATED_TOKENS,
    blocks: [...buildDecisionNarrativeContextBlocks(input), ...(input.npcOutward === undefined ? [] : [block({
      id: "bundle:npc_outward", slot: "current_resolution", title: "角色获准对外回应",
      authority: "state", retention: "mandatory", priority: 950,
      source: { kind: "npc_outward", refs: input.npcOutward.map((entry) => String(entry.npcId)) },
      content: `以下仅是通过权限审查的 NPC 对外方案，不含私下推理。回应须符合 response；discloseFactIds 只引用已提供正文的事实，不得凭 ID 补写秘密。方案本身不是已经发生的行动或知识转移。interactionProposals 中 factIds、condition 和 confidentiality.protectedFactIds 的正式 ID 已通过服务端存在性与引用许可检查；未列在公开事实正文中不表示 ID 不存在。获准引用和当前披露正文是独立权限，严禁因提案包含 ID 就补写秘密正文。\n角色提出的条件必须成为玩家能执行的行动：response=offer_condition 且有 interactionProposals 时，终点的两个 choices 中至少一个 candidateId 必须使用所提供的 interaction:proposalKey，label 写玩家作出该行动的真实表达，另一项可保留合法的追问或拒绝。不能让“我答应保密”仍绑定普通 talk，也不能只在台词中提出无法选择的条件。将对应原提案逐字段并入顶层 interactionProposals；服务端也会按选项引用携带原提案，不允许改写条款。未获选择的条件不算成立，不得提前给出承诺后才允许提供的引荐、秘密或成功后果。其他 response 的提案按实际回应选用，仍需规则批准。\n${JSON.stringify(input.npcOutward)}`,
    })]), ...((input.candidateRevision === undefined && input.authorDraftRevision === undefined) || input.consumer === "reviewer" ? [] : [block({
      id: "bundle:candidate_revision", slot: "current_resolution", title: "未提交候选修订",
      authority: "state", retention: "mandatory", priority: 950,
      source: { kind: "narrative_bundle_repair", refs: [String(input.job.jobId)] },
      content: input.authorDraftRevision === undefined
        ? renderNarrativeCandidateRevision(input.candidateRevision)
        : `\n# 同一次作者原稿的结构修订\n下面是同一 job/epoch 中刚被严格结构校验拒绝的作者原始 draft 与累计反馈。它未经编译、审批或授权，不是事实、History 或 compiled proposal。逐项修复结构错误并返回完整 draft；保留无冲突的显式声明与正文，但不得假定服务端会自动继承任何字段。\n${JSON.stringify(input.authorDraftRevision)}`,
    })])],
  }));
}
