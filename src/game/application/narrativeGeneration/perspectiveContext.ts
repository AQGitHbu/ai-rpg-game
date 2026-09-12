// 单角色 / 玩家视角的安全上下文投影（Spec 2026-09-09 / Plan Task 4）。
//
// projectUnitContext 把已审批计划投影成某一类表达单元（旁白/角色/选项）可以
// 看到的 SafeContext：人格只保留结构化公开面，可说事实 = 说话人可知 ∩ 对受众
// 可披露（复用 buildNpcSpeechAuthority 这把唯一的披露门尺），前文只含依赖单元
// 的已批准表达。无法证明安全的自由文本（legacy 导入的锚点正文、目标 reason、
// 描述、任务名、隐藏事实）一律不进入 DTO——不是删敏感词，而是按来源放行。
// 秘密用唯一 sentinel 断言（见测试），fail-closed：未知单元/未知说话人直接拒绝。

import { projectExpressionTask } from "./expressionTask";
import { approveUnit } from "./approveUnit";
import {
  fail,
  type Check,
  type CosmeticAction,
  type EvidenceRef,
  type SafeBeat,
  type TextPart,
  type Unit,
  type UnitOutput,
} from "@/game/domain/narrativeUnit";
import type { DialogueAct } from "@/game/domain/action";
import type { NarrativeEmotion } from "@/game/domain/narrative";
import { PLAYER_ENTITY_ID, asFactId } from "@/game/domain/worldEntity";
import {
  getEntity,
  type EntityRecord,
  type FactEntityRecord,
  type NpcEntityRecord,
} from "@/game/domain/entity";
import type { WorldState } from "@/game/domain/worldState";
import type { ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import { observationsForUnit, sceneSnapshot } from "@/game/gameplay/rpg/narrativePlanning";
import {
  buildNpcSpeechAuthority,
  type NpcSpeechAuthority,
} from "@/game/application/npcSpeechAuthority";
import { buildStylePolicy, PERSONALITY_TRAIT_OPTIONS, type StylePolicy } from "@/game/application/stylePolicy";
import type { ExpressionTask } from "@/game/domain/expressionTask";

function isFactRecord(record: EntityRecord | undefined): record is FactEntityRecord {
  return record !== undefined && record.core.kind === "fact";
}

function isNpcRecord(record: EntityRecord | undefined): record is NpcEntityRecord {
  return record !== undefined && record.core.kind === "npc";
}

// ---------------------------------------------------------------------------
// 安全 DTO 类型
// ---------------------------------------------------------------------------

/**
 * 人格的公开投影：只含结构化身份（name/role/emotion/关系档位）与受控行为。
 * anchors/goals 没有逐项公开证据，保持为空；长期禁区（taboos）整组不回传——
 * 「不能谈什么」转为受控 behavior，不携带原文。
 */
export type SafePersona = Readonly<{
  publicName: string;
  publicRole: TextPart;
  anchors: readonly TextPart[];
  goals: readonly TextPart[];
  emotion: NarrativeEmotion;
  relationshipTier: string;
  behavior: readonly ("answer_directly" | "withhold_source" | "express_uncertainty")[];
  delivery?: Readonly<{
    sentenceLength: "short" | "neutral" | "long";
    register: "conversational" | "neutral" | "formal";
    tone: "restrained" | "neutral" | "humorous";
  }>;
}>;

export type SafeFact = Readonly<{
  id: string;
  text: string;
  certainty: "known" | "suspected";
  sources: readonly EvidenceRef[];
}>;

export type SafeOption = Readonly<{
  candidateId: string;
  dialogueAct: DialogueAct;
  publicIntent: TextPart;
  inquiries?: NonNullable<ExpressionTask["inquiries"]>;
  prerequisiteFactIds?: readonly string[];
}>;

/**
 * 本单元必须披露的观察的安全投影：只给观察键与它引用的事实键/certainty，
 * 不含受众、来源细节或任何隐藏事实。角色 prompt 靠它声明披露义务，
 * 与 collectDisclosures 的判定同源。
 */
export type SafeObservation = Readonly<{
  key: string;
  factId: string;
  certainty: "known" | "suspected";
}>;

export type SafeContext = Readonly<{
  unit: Unit;
  draft?: UnitOutput;
  persona: SafePersona | null;
  visibleFacts: readonly SafeFact[];
  priorText: readonly TextPart[];
  allowedActions: readonly CosmeticAction[];
  options: readonly SafeOption[];
  playerUtterance: string | null;
  /** 当前生成对白的身份，不从前文的称呼推断。choices 的 speaker 永远是玩家。 */
  dialogue?: Readonly<{ speakerId: string; speakerName: string; addresseeId: string; addresseeName: string; addresseeRole?: string }>;
  scene?: Readonly<{ locationId: string; locationName: string; playerName: string; speakers: readonly { id: string; name: string }[] }>;
  style: string;
  stylePolicy?: StylePolicy;
  taskInstruction?: string;
  requiredBeats: readonly SafeBeat[];
  requiredObservations: readonly SafeObservation[];
  choiceKind: "ordinary" | "ending" | null;
  /** 只投影同 NPC 当前场景的上一轮实际对白；不是新的知识来源。 */
  previousReply?: string;
  previousChoices?: readonly string[];
  /** 仅当前决策旁白的排版约束，不包含其他单元的文本或知识。 */
  narrationLayout?: Readonly<{ allowAtmosphere: boolean }>;
}>;

// ---------------------------------------------------------------------------
// 投影原语
// ---------------------------------------------------------------------------

/** 玩家视角的可见事实：discovered 全集（旁白与选项单元的可见面）。 */
function discoveredFacts(ws: WorldState): readonly SafeFact[] {
  const receipts = new Map<string, { certainty: "known" | "suspected"; eventId: string }>();
  for (const event of ws.eventLedger) {
    if (event.payload.type !== "narrative_observed" || event.payload.audienceId !== String(PLAYER_ENTITY_ID)) continue;
    const { factId, certainty } = event.payload;
    if (receipts.get(String(factId))?.certainty === "known" && certainty === "suspected") continue;
    receipts.set(String(factId), { certainty, eventId: String(event.eventId) });
  }
  return ws.entityStore.records
    .filter((record): record is FactEntityRecord => isFactRecord(record) && (record.fact.discovered || receipts.has(String(record.core.id))))
    .map((record) => ({
      id: String(record.core.id),
      text: record.fact.text,
      certainty: record.fact.discovered ? "known" as const : receipts.get(String(record.core.id))!.certainty,
      sources: receipts.has(String(record.core.id)) ? [{ kind: "committed" as const, eventId: receipts.get(String(record.core.id))!.eventId }] : [] as readonly EvidenceRef[],
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** 角色视角的可见事实：authority.allowedFactIds（可知 ∩ 对受众可披露）。 */
function speakerVisibleFacts(
  ws: WorldState,
  speaker: NpcEntityRecord,
  authority: NpcSpeechAuthority,
): readonly SafeFact[] {
  const allowed = new Set(authority.allowedFactIds.map(String));
  return speaker.knowledge.entries
    .filter((entry) => allowed.has(String(entry.factId)))
    .map((entry) => {
      const record = getEntity(ws.entityStore, String(entry.factId));
      const sources: readonly EvidenceRef[] = entry.source.kind === "action"
        ? [{ kind: "committed", eventId: String(entry.source.eventId) }]
        : [];
      return {
        id: String(entry.factId),
        text: isFactRecord(record) ? record.fact.text : "",
        certainty: entry.certainty,
        sources,
      };
    });
}

/** 规划阶段可预检的已提交事实来源；条件观察仍须等待上游实际输出。 */
export function committedBeatEvidenceIds(world: WorldState, unit: Unit): ReadonlySet<string> {
  const sources = unit.stage === "character"
    ? (() => {
      const speaker = getEntity(world.entityStore, unit.speakerId ?? "");
      return isNpcRecord(speaker) ? speaker.knowledge.entries.flatMap(entry =>
        entry.source.kind === "action" ? [String(entry.source.eventId)] : []) : [];
    })()
    : discoveredFacts(world).flatMap(fact => fact.sources.flatMap(source =>
      source.kind === "committed" ? [source.eventId] : []));
  return new Set(sources);
}

/**
 * 人格投影：公开身份 + 受控行为。所有未经逐项授权的锚点均不携带正文；
 * taboos 整组转 behavior。
 *
 * goals 的 description/reason 都是自由文本且没有可核验的公开依据（reason 本身
 * 可被篡改成任意值，不能作为放行凭据），因此 fail-closed：不回传目标正文，
 * 敏感动机由受控 behavior（withhold_source 等）表达。
 */
function controlledMatch<T extends string>(text: string, choices: readonly { value: T; phrases: readonly string[] }[], neutral: T): T {
  const hasNegatedPhrase = choices.some(choice => choice.phrases.some(phrase =>
    new RegExp(`(?:不|勿|别|避免|拒绝|不要)[^，。；]{0,4}${phrase}`).test(text)));
  if (hasNegatedPhrase) return neutral;
  const matched = choices.filter(choice => choice.phrases.some(phrase => text.includes(phrase))).map(choice => choice.value);
  return new Set(matched).size === 1 ? matched[0]! : neutral;
}

function personaOf(speaker: NpcEntityRecord, authority: NpcSpeechAuthority): SafePersona {
  const behavior: ("answer_directly" | "withhold_source" | "express_uncertainty")[] = ["answer_directly"];
  if (speaker.knowledge.entries.some((entry) => entry.disclosure === "secret")) {
    behavior.push("withhold_source");
  }
  if (speaker.knowledge.entries.some((entry) => entry.certainty === "suspected")) {
    behavior.push("express_uncertainty");
  }
  return {
    publicName: speaker.core.name,
    publicRole: { text: speaker.identity.role, facts: [], evidence: [], beatIds: [] },
    anchors: [], // 原始锚点没有逐项公开来源，非 legacy 也不能作为放行证明。
    goals: [],
    emotion: speaker.dynamicState.emotion,
    relationshipTier: authority.responseTier,
    behavior,
    delivery: {
      sentenceLength: controlledMatch(speaker.identity.anchors.speechStyle, [
        { value: "short", phrases: ["短句", "简短", "简洁"] },
        { value: "long", phrases: ["长句", "铺陈", "详尽"] },
      ], "neutral"),
      register: controlledMatch(speaker.identity.anchors.speechStyle, [
        { value: "conversational", phrases: ["口语", "随和", "自然交谈"] },
        { value: "formal", phrases: ["正式", "郑重", "书面"] },
      ], "neutral"),
      tone: controlledMatch(speaker.identity.anchors.speechStyle, [
        { value: "restrained", phrases: ["克制", "沉稳", "严肃"] },
        { value: "humorous", phrases: ["幽默", "风趣", "诙谐"] },
      ], "neutral"),
    },
  };
}

/** 前文 = 依赖单元的已批准可见表达，按 ScenePoint 顺序拼接。 */
function priorTextOf(
  plan: ApprovedPlan,
  unit: Unit,
  approved: ReadonlyMap<string, UnitOutput>,
  visibleFacts: readonly SafeFact[],
  allowMissing = false,
): Check<readonly TextPart[]> {
  const parts: TextPart[] = [];
  const dependencies = unit.dependencies
    .map((key) => plan.units.find((candidate) => candidate.key === key))
    .filter((candidate): candidate is Unit => candidate !== undefined)
    .sort((left, right) =>
      left.point.stepKey === right.point.stepKey
        ? left.point.order - right.point.order
        : left.point.stepKey < right.point.stepKey ? -1 : 1);
  for (const dependency of dependencies) {
    const output = approved.get(dependency.key);
    if (output === undefined) {
      if (allowMissing) continue;
      return fail("dependency_output_missing");
    }
    if (output.stage === "choices") continue;
    // 跨场景依赖只保证执行顺序；认知由 snapshot 的观察回执传播，不能继承整段旧对白。
    if (dependency.point.stepKey !== unit.point.stepKey) continue;
    if (unit.stage === "choices" && dependency.stage === "character"
      && dependency.speakerId !== plan.choiceExpression?.npcId) continue;
    if (unit.stage !== "character" || dependency.speakerId === unit.speakerId) {
      // 一次表达作为整体保留，避免留下失去前句与指代对象的尾句。
      if (!output.parts.every(part => part.facts.every(fact => visibleFacts.some(visible => visible.id === fact.factId)))) continue;
      parts.push(...output.parts
        .map(part => unit.stage === "character" ? part : { ...part, text: `${dependency.stage === "narration" ? "旁白"
          : `NPC ${getEntity(plan.world.entityStore, dependency.speakerId ?? "")?.core.name ?? dependency.speakerId}`}：${part.text}` }));
      continue;
    }
    // DAG 依赖仅表示生成顺序，不等于角色听见前文。其他视角的原文没有
    // 句段级受众证明时不转发；只给该角色已知、且有现场观察依据的事实正文。
    for (const part of output.parts) {
      for (const fact of part.facts) {
        const visible = visibleFacts.find(candidate => candidate.id === fact.factId);
        const witnessed = plan.proposal.observations.some(observation =>
          observation.point.stepKey === dependency.point.stepKey
          && observation.point.order <= dependency.point.order
          && observation.audienceIds.includes(unit.speakerId ?? "")
          && observation.fact.factId === fact.factId);
        if (visible !== undefined && witnessed) parts.push({
          text: visible.text, facts: [{ factId: visible.id, certainty: visible.certainty }],
          evidence: visible.sources, beatIds: [],
        });
      }
    }
  }
  return { ok: true, value: parts };
}

function optionsOf(plan: ApprovedPlan, prior: readonly TextPart[], facts: readonly SafeFact[]): ContextCheck<readonly SafeOption[]> {
  const expression = plan.choiceExpression;
  if (expression === null) return { ok: true, value: [] };
  const options: SafeOption[] = [];
  for (const option of expression.options) {
    let subject = "";
    let topicText = "";
    if ("topic" in option && option.topic.kind === "fact") {
      const topicFact = facts.find(fact => fact.id === String(option.topic.kind === "fact" ? option.topic.factId : ""));
      if (topicFact === undefined) return { ok: false, code: "choice_intent_authority_conflict",
        detail: JSON.stringify({ unavailableFactIds: [String(option.topic.factId)] }) };
      topicText = `；已知话题（${topicFact.certainty}）：${topicFact.text}`;
    }
    if ("topic" in option && option.topic.kind === "thread") {
      const threadId = option.topic.threadId;
      const thread = plan.world.eventLedger.find(event => event.payload.type === "opening_thread_established"
        && event.payload.threadId === threadId)?.payload;
      const fact = thread?.type === "opening_thread_established"
        ? facts.find(fact => fact.id === String(thread.questionFactId)) : undefined;
      if (fact === undefined) return { ok: false, code: "choice_intent_authority_conflict",
        detail: JSON.stringify({ unavailableFactIds: thread?.type === "opening_thread_established" ? [String(thread.questionFactId)] : [] }) };
      topicText = `；当前问题（${fact.certainty}）：${fact.text}`;
    }
    if ("target" in option && option.target !== null) {
      const target = option.target;
      const id = target.kind === "visit_location" ? target.locationId
        : target.kind === "talk_to_npc" ? target.npcId
        : target.kind === "obtain_item" ? target.itemId
        : target.kind === "discover_fact" ? target.factId : target.enemyId;
      const fact = facts.find(f => f.id === id);
      const entity = getEntity(plan.world.entityStore, id);
      // 不以规划 publicIntent 的自报 facts 为证据。实体名须已在玩家公开视图中，
      // 延迟地点则须先由获批表达明确提及，不能把隐藏路线名称抢先塞进选项。
      const name = entity?.core.name ?? option.deferredLocation?.name;
      const disclosed = [...prior.map(p => p.text), ...facts.map(f => f.text)];
      if (fact !== undefined) subject = fact.text;
      else if (name !== undefined && (plan.world.locations.some(l => String(l.id) === id)
        || plan.world.npcs.some(n => String(n.id) === id && (n.met || n.locationId === plan.world.currentLocationId))
        || disclosed.some(text => text.includes(name)))) subject = name;
      else return { ok: false, code: "choice_intent_authority_conflict",
        detail: JSON.stringify({ unavailableTargetName: name }) };
    }
    if (plan.units.some(unit => unit.stage === "choices" && unit.draft !== undefined)) {
      const part = option.publicIntent;
      const invalidFact = part.facts.some(ref => !facts.some(fact => fact.id === ref.factId
        && (ref.certainty === "suspected" || fact.certainty === "known")));
      const invalidEvidence = part.evidence.some(ref => !facts.some(fact => fact.sources.some(source =>
        source.kind === ref.kind && (source.kind === "committed" && ref.kind === "committed"
          ? source.eventId === ref.eventId : source.kind === "conditional" && ref.kind === "conditional"
            && source.observationKey === ref.observationKey))));
      if (invalidFact || invalidEvidence || part.beatIds.length > 0) return fail("choice_intent_authority_conflict");
      options.push({ candidateId: option.candidateId, dialogueAct: option.dialogueAct,
        publicIntent: { ...part, text: "" } });
      continue;
    }
    if ("task" in option && option.task !== undefined && option.task.intent !== option.dialogueAct) {
      return fail("plan_task_intent_mismatch");
    }
    const task = "task" in option && option.task !== undefined ? projectExpressionTask(option.task, facts) : undefined;
    if (task?.ok === false) return task;
    options.push({
    candidateId: option.candidateId,
    dialogueAct: option.dialogueAct,
    publicIntent: {
      text: `${task?.ok ? task.value : intentByAct[option.dialogueAct]}${subject === "" ? "" : `；讨论目标：${subject}`}${topicText}`,
      facts: [], evidence: [], beatIds: [],
    },
    inquiries: task?.ok && "task" in option && option.task?.inquiries !== undefined
      ? option.task.inquiries.map((inquiry) => ({ factId: inquiry.factId, aspects: [...inquiry.aspects] }))
      : [],
    prerequisiteFactIds: task?.ok && "task" in option ? [...(option.task?.prerequisiteFactIds ?? [])] : [],
    });
  }
  return { ok: true, value: options };
}

const intentByAct: Readonly<Record<DialogueAct, string>> = {
  ask: "询问并要求澄清", support: "支持对方的提议", challenge: "质疑对方的提议",
  threaten: "施压要求对方回应", deceive: "以试探性的说法探问", offer: "提出协助或交换条件",
  refuse: "拒绝对方的提议", reassure: "安抚对方的顾虑",
};

const instructionByKind: Readonly<Record<SafeBeat["kind"], string>> = {
  player_utterance: "回应当前玩家已说出的内容，不替玩家补充动机。",
  item_obtained: "说明已批准的物品获得事件。", fact_discovered: "表达授权事实，保留其确定程度。",
  quest_progress: "衔接已发生的任务进展。", quest_advanced: "衔接获批的任务变化。",
  battle_started: "呈现战斗开始。", battle_round: "呈现已裁决的战斗回合。",
  battle_resolved: "呈现已裁决的战斗结果。", entity_introduced: "介绍本场可见的实体。",
  atmosphere: "描写现场可感知的氛围，不新增隐藏事实。",
};

type ContextCheck<T> = Check<T> & { readonly detail?: string };

function safeBeats(unit: Unit, facts: readonly SafeFact[], plan: ApprovedPlan): ContextCheck<readonly SafeBeat[]> {
  const ids = new Set(facts.map(fact => fact.id));
  const events = new Set(facts.flatMap(fact => fact.sources.map(source => JSON.stringify(source))));
  for (const observation of observationsForUnit(unit, plan.proposal.observations)) {
    if (ids.has(observation.fact.factId)) events.add(JSON.stringify({ kind: "conditional", observationKey: observation.key }));
  }
  const beats: SafeBeat[] = [];
  for (const beat of unit.requiredBeats) {
    const beatEvents = new Set(events);
    if (unit.stage === "narration" && unit.point.stepKey === "current") {
      for (const eventId of plan.currentBeatEvidence?.[beat.beatId] ?? []) {
        beatEvents.add(JSON.stringify({ kind: "committed", eventId }));
      }
    }
    if (beat.factIds.some(id => !ids.has(id)) || beat.evidence.some(ref => !beatEvents.has(JSON.stringify(ref)))) {
      return { ok: false, code: "beat_authority_conflict", detail: JSON.stringify({
        unitKey: unit.key, stage: unit.stage, stepKey: unit.point.stepKey, speakerId: unit.speakerId,
        beatId: beat.beatId, unavailableFactIds: beat.factIds.filter(id => !ids.has(id)),
        allowedFactIds: [...ids], unavailableEvidence: beat.evidence.filter(ref => !beatEvents.has(JSON.stringify(ref))),
        repairInstruction: "由规划器重做本单元任务：只能要求表达可知且可披露的事实。玩家提问不等于 NPC 亲历；可安排 NPC 承认不知、询问或回应其已知部分，不自动授予知识、不编造来源。",
      }) };
    }
    beats.push({ beatId: beat.beatId, kind: beat.kind, factIds: [...beat.factIds],
      evidence: [...beat.evidence], instruction: `${instructionByKind[beat.kind]}${beat.factIds.map(id => {
        const fact = facts.find(fact => fact.id === id)!;
        return ` 必须承接的内容（${fact.certainty}）：${fact.text}`;
      }).join("")}` });
  }
  return { ok: true, value: beats };
}

/** 候选意图只投影给选项单元；旁白/角色单元的上下文不携带决策。 */
function choiceKindOf(plan: ApprovedPlan, unit: Unit): "ordinary" | "ending" | null {
  if (unit.stage !== "choices") return null;
  return plan.choiceExpression?.kind ?? null;
}

function allowedActionsOf(plan: ApprovedPlan, unit: Unit): readonly CosmeticAction[] {
  if (unit.stage === "character" && unit.speakerId !== null) {
    return plan.proposal.actions.filter((action) => action.actorId === unit.speakerId
      && action.point.stepKey === unit.point.stepKey && action.point.order <= unit.point.order);
  }
  if (unit.stage === "narration") {
    return plan.proposal.actions.filter((action) =>
      action.audienceIds.includes(String(PLAYER_ENTITY_ID))
      && action.point.stepKey === unit.point.stepKey && action.point.order <= unit.point.order);
  }
  return [];
}

/**
 * 重建 Unit：taskFactIds 只保留该视角可见的事实，requiredObservationKeys 只保留
 * 归属于本单元且确实存在的观察引用（与 collectDisclosures 同一归属规则）。
 */
function rebuildUnit(
  unit: Unit,
  visibleFactIds: ReadonlySet<string>,
  plan: ApprovedPlan,
): Unit {
  const authorizedObservationKeys = new Set(
    observationsForUnit(unit, plan.proposal.observations).map((observation) => observation.key),
  );
  return {
    ...unit,
    taskFactIds: unit.taskFactIds.filter((factId) => visibleFactIds.has(factId)),
    requiredObservationKeys: unit.requiredObservationKeys.filter((key) =>
      authorizedObservationKeys.has(key)),
  };
}

/**
 * 本单元必须披露的观察投影：与 collectDisclosures 共用归属规则，包含同序隐式观察。
 * 只输出键与事实键，不含受众与来源细节。missing 时 fail-closed（理论不可达：
 * rebuildUnit 已按同一归属规则过滤）。
 */
function requiredObservationsOf(
  unit: Unit,
  plan: ApprovedPlan,
  visibleFacts: readonly SafeFact[],
): Check<readonly SafeObservation[]> {
  const authorized = new Map(
    observationsForUnit(unit, plan.proposal.observations).map((observation) => [
      observation.key,
      observation,
    ]),
  );
  const out: SafeObservation[] = [];
  for (const key of unit.requiredObservationKeys) {
    if (!authorized.has(key)) return fail("observation_without_source");
  }
  for (const observation of authorized.values()) {
    if (!visibleFacts.some(fact => fact.id === observation.fact.factId)) return fail("observation_without_source");
    out.push({
      key: observation.key,
      factId: observation.fact.factId,
      certainty: observation.fact.certainty,
    });
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export type ProjectUnitContextInput = Readonly<{
  plan: ApprovedPlan;
  unit: Unit;
  approved: ReadonlyMap<string, UnitOutput>;
  /** Planning checks need no prose; all knowledge and task gates remain active. */
  purpose?: "planning";
}>;

/**
 * 投影某一表达单元的安全上下文。角色单元带 persona（未知说话人 fail-closed）；
 * 旁白与选项单元是玩家视角（persona 为 null）。选项候选从已审批
 * choiceExpression 投影（ending 臂不需要 RouteTarget）。
 */
export function narrationLayoutOf(plan: ApprovedPlan, unit: Unit): SafeContext["narrationLayout"] {
  if (plan.ruleSceneGraph === undefined || unit.stage !== "narration" || unit.point.stepKey !== "current") return undefined;
  return { allowAtmosphere: !plan.units.some(candidate => candidate.stage === "narration"
    && candidate.point.stepKey === "current" && candidate.point.order > unit.point.order) };
}

export function projectUnitContext(input: ProjectUnitContextInput): ContextCheck<SafeContext> {
  const { plan } = input;
  const unit = plan.units.find((candidate) => candidate.key === input.unit.key);
  if (unit === undefined) return fail("unknown_unit");
  const snapshot = sceneSnapshot({ plan, point: unit.point, approved: input.approved });
  if (!snapshot.ok) return snapshot;
  const ws = snapshot.value.world;

  let persona: SafePersona | null = null;
  let visibleFacts: readonly SafeFact[] = [];
  if (unit.stage === "character") {
    if (unit.speakerId === null) return fail("unknown_speaker");
    const speaker = getEntity(ws.entityStore, unit.speakerId);
    if (!isNpcRecord(speaker)) return fail("unknown_speaker");
    // 场景可见事实 = 玩家已发现全集；说话人可见 = 说话人知识 ∩ 场景可见 ∩ 可披露。
    const authority = buildNpcSpeechAuthority({
      store: ws.entityStore,
      speakerNpcId: speaker.core.id,
      targetContext: { targetId: PLAYER_ENTITY_ID },
      sceneVisibleFactIds: [...new Set([...discoveredFacts(ws).map(fact => asFactId(fact.id)),
        ...observationsForUnit(unit, plan.proposal.observations).map(observation => asFactId(observation.fact.factId))])],
    });
    if (authority === null) return fail("unknown_speaker");
    persona = personaOf(speaker, authority);
    visibleFacts = speakerVisibleFacts(ws, speaker, authority);
  } else {
    // 玩家视角（旁白/选项）：可见事实来自现场观察与玩家已知（discovered）。
    visibleFacts = discoveredFacts(ws);
  }

  const recipient = unit.speakerId ?? String(PLAYER_ENTITY_ID);
  for (const observation of snapshot.value.learned) {
    if (!observation.audienceIds.includes(recipient)) continue;
    // 表达均面向玩家：NPC 刚听到的私聊不自动变为可向玩家披露的信息。
    if (unit.stage === "character" && !observation.audienceIds.includes(String(PLAYER_ENTITY_ID))) continue;
    if (visibleFacts.some(fact => fact.id === observation.fact.factId)) continue;
    const record = getEntity(ws.entityStore, observation.fact.factId);
    if (!isFactRecord(record)) continue;
    visibleFacts = [...visibleFacts, { id: observation.fact.factId, text: record.fact.text,
      certainty: observation.fact.certainty, sources: [{ kind: "conditional", observationKey: observation.key }] }];
  }

  const currentDialogue = unit.point.stepKey === "current"
    && (unit.stage === "character" ? unit.speakerId === plan.currentUtterance?.npcId
      : unit.stage === "choices" && plan.choiceExpression?.npcId === plan.currentUtterance?.npcId);
  const task = unit.draft !== undefined || unit.task === undefined ? undefined : projectExpressionTask(unit.task, visibleFacts);
  if (task?.ok === false) return task;
  // 历史按完整视角权限判断，不能用本轮选题把上一轮对白裁成碎片。
  const historyFacts = visibleFacts;
  const priorText = priorTextOf(plan, unit, input.approved, historyFacts, input.purpose === "planning");
  if (!priorText.ok && priorText.code !== "dependency_output_missing") return priorText;
  // 新任务的可说内容局限于规划选定主题与必须表达的节拍/观察，不能遍历整个知识库另起话题。
  if ((unit.draft !== undefined || unit.task !== undefined) && unit.stage !== "choices") {
    const selected = new Set([...unit.taskFactIds, ...(unit.task?.focusFactIds ?? []), ...(unit.task?.prerequisiteFactIds ?? []),
      ...unit.requiredBeats.flatMap(beat => beat.factIds),
      ...observationsForUnit(unit, plan.proposal.observations).map(observation => observation.fact.factId)]);
    visibleFacts = visibleFacts.filter(fact => selected.has(fact.id));
  }
  const beats = safeBeats(unit, visibleFacts, plan);
  if (!beats.ok) return beats;
  if (!priorText.ok) return priorText;

  const rebuilt = rebuildUnit({ ...unit, requiredBeats: beats.value }, new Set(visibleFacts.map((fact) => fact.id)), plan);
  const requiredObservations = requiredObservationsOf(rebuilt, plan, visibleFacts);
  if (!requiredObservations.ok) return requiredObservations;
  const options = unit.stage === "choices" ? optionsOf(plan, priorText.value, visibleFacts)
    : { ok: true as const, value: [] };
  if (!options.ok) return options;
  // 选项润色只读取各自规划任务的事实；不提供整份玩家知识库供它重新选题。
  if (unit.stage === "choices" && unit.draft !== undefined) {
    const selected = new Set(options.value.flatMap(option => option.publicIntent.facts.map(fact => fact.factId)));
    visibleFacts = visibleFacts.filter(fact => selected.has(fact.id));
  }
  const choiceNpc = unit.stage === "choices"
    ? ws.npcs.find(npc => String(npc.id) === plan.choiceExpression?.npcId && npc.locationId === ws.currentLocationId)
    : undefined;
  if (unit.stage === "choices" && choiceNpc === undefined) return fail("choice_addressee_missing");
  const setup = ws.generation.setup;
  const allowedTraits = new Set<string>(PERSONALITY_TRAIT_OPTIONS);
  const stylePolicy = buildStylePolicy({
    personalityTags: setup?.personalityTags.filter(tag => allowedTraits.has(tag)) ?? [],
    narrativeStyle: setup?.narrativeStyle === "novel" || setup?.narrativeStyle === "cinematic"
      ? setup.narrativeStyle : "concise",
    contentIntensity: setup?.contentIntensity === "dark" ? "dark" : "normal",
  });

  const context: SafeContext = {
      unit: { key: rebuilt.key, stage: rebuilt.stage, point: rebuilt.point, speakerId: rebuilt.speakerId, dependencies: rebuilt.dependencies, taskFactIds: rebuilt.taskFactIds, requiredObservationKeys: rebuilt.requiredObservationKeys, requiredBeats: rebuilt.requiredBeats, ...(unit.draft === undefined && rebuilt.task !== undefined ? { task: rebuilt.task } : {}) },
      persona,
      visibleFacts,
      priorText: priorText.value,
      allowedActions: allowedActionsOf(plan, unit),
      options: options.value,
      ...((currentDialogue || (unit.stage === "narration" && unit.point.stepKey === "current")) ? {
        ...(plan.currentUtterance?.previousReply !== undefined
          && plan.currentUtterance.previousReply.factIds.every(id => historyFacts.some(fact => fact.id === id))
          ? { previousReply: plan.currentUtterance.previousReply.text } : {}),
        ...(unit.stage === "choices" ? { previousChoices: plan.currentUtterance?.previousChoices ?? [] } : {}),
      } : {}),
      ...(choiceNpc === undefined ? {} : { dialogue: {
        speakerId: String(PLAYER_ENTITY_ID), speakerName: ws.player.name,
        addresseeId: String(choiceNpc.id), addresseeName: choiceNpc.name, addresseeRole: choiceNpc.role,
      } }),
      playerUtterance: unit.point.stepKey === "current"
        && (unit.stage !== "character" || unit.speakerId === plan.currentUtterance?.npcId)
        ? plan.currentUtterance?.text ?? null : null,
      scene: {
        locationId: String(ws.currentLocationId),
        locationName: ws.locations.find(location => location.id === ws.currentLocationId)?.name ?? "",
        playerName: ws.player.name,
        speakers: ws.npcs.filter(npc => npc.locationId === ws.currentLocationId
          && plan.units.some(candidate => candidate.point.stepKey === unit.point.stepKey && candidate.speakerId === String(npc.id)))
          .map(npc => ({ id: String(npc.id), name: npc.name })),
      },
      style: ws.generation.gameType,
      stylePolicy,
      ...(task?.ok ? { taskInstruction: task.value } : {}),
      requiredBeats: beats.value,
      requiredObservations: requiredObservations.value,
      choiceKind: choiceKindOf(plan, unit),
      ...(narrationLayoutOf(plan, unit) === undefined ? {} : { narrationLayout: narrationLayoutOf(plan, unit) }),
  };
  if (unit.draft !== undefined) {
    const approvedDraft = approveUnit({ unit, context, output: unit.draft });
    if (!approvedDraft.ok) return approvedDraft;
    if (input.purpose !== "planning") return { ok: true, value: { ...context, draft: approvedDraft.value } };
  }
  return { ok: true, value: context };
}
