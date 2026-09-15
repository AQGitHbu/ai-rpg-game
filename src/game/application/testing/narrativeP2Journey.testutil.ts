import { NARRATIVE_P2_TOPICS } from "./narrativeP2Topics";
import { fixtureNarrativeReviewPass } from "../server/ai/testing/narrativeReviewFixture.testutil";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGame } from "../createGame";
import { performTurn } from "../performTurn";
import { generatePendingNarrativeBundle } from "../generatePendingNarrativeBundle";
import { buildChoiceMap } from "../buildChoiceMap";
import { projectGameSessionView } from "../gameSessionView";
import type { NarrativeBundleSource, NarrativeBundleSourceContext } from "../narrativeBundleSource";
import { createNarrativeMemoryPackagePreparer } from "../prepareNarrativeMemoryPackage";
import { asGameId, type GameRecord } from "../server/persistence/gameRepository";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createSqliteGameRepository } from "../server/persistence/sqliteGameRepository";
import { createSqliteNarrativeMemorySummaryRepository } from "../server/persistence/sqliteNarrativeMemorySummaryRepository";
import { projectNarrativeDraft } from "../server/ai/narrativeDraftProjection";
import { createNarrativeBundleSource } from "../server/ai/liveNarrativeBundleSource";
import { createLiveNarrativeMemorySummarySource } from "../server/ai/liveNarrativeMemorySummarySource";
import { createLiveNpcDeliberationSource } from "../server/ai/liveNpcDeliberationSource";
import { createLiveNarrativeCandidateReview } from "../server/ai/liveNarrativeCandidateReview";
import type { AiTextAuditContext } from "../server/ai/textAuditTypes";
import { createNarrativeRequestClient } from "../server/ai/narrativeRequestClient";
import { DEFAULT_NARRATIVE_MEMORY_POLICY } from "../server/ai/narrativeMemoryPolicy";
import type { RpgAiClient } from "../server/ai/rpgAiClient";
import { asNpcId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { isStoryDeliveryComplete } from "@/game/gameplay/rpg/storyDelivery";
import { createTempleLetterBundleSource } from "./templeLetterJourney.testutil";

type Decision = Extract<NarrativeBundleSourceContext, { kind: "decision" }>;
type Opening = Extract<NarrativeBundleSourceContext, { kind: "opening" }>;
export const P2_OLD_QUOTE = "封口完好才交付，破损就先回来找我。";
export const P2_RECALL_QUESTION = "最初委托人对这封信说过什么？我想先回想原话，再决定是否交付。";

export async function buildOfflineP2Opening(context: Opening) {
  const result = await createTempleLetterBundleSource().generate(context);
  if (!result.ok || result.kind !== "opening") throw new Error("opening fixture unavailable");
  const opening = result.proposal.opening;
  return { ...result.proposal, opening: { ...opening,
    world: { ...opening.world, publicFacts: [{ key: "letter_route", text: "乡亲约定由邻村渡口的值守人收取这封公开家书。" }, { key: "letter_seal", text: "家书是普通报平安的来信。" }] },
    storyContract: { ...opening.storyContract, targetActs: context.input.gameLength === "medium" ? 5 : 3, centralConflict: "把乡亲的家书亲手送给约定的收信人。" },
    opening: { ...opening.opening, npc: { ...opening.opening.npc, privateFactKeys: [], knownFactKeys: ["letter_route", "letter_seal"] },
      firstScene: { ...opening.opening.firstScene!, npcLine: { ...opening.opening.firstScene!.npcLine, text: P2_OLD_QUOTE } } },
  }, currentScene: { ...result.proposal.currentScene, npcLine: { ...result.proposal.currentScene.npcLine!, text: P2_OLD_QUOTE } } };
}

/** Scripted prose for offline testing; production still owns the graph and approvals. */
export function buildOfflineP2Draft(context: Decision, compactReply?: string) {
  const { storyState, job } = context;
    const projection = projectNarrativeDraft(context);
    const next = projection.nextActProjection;
    const worldDelta = next !== null ? {
      beatSummary: "前往下一处交接地点。",
      newLocation: { name: `交接地点${storyState.currentAct}`, description: "村道旁的歇脚处。", scale: "scene", placement: "world", connectFromLocationId: String(context.worldState.currentLocationId) },
      newNpc: { name: `值守人${storyState.currentAct}`, role: "乡亲约定的值守人", description: "熟悉本地公开约定的村民。", locationRef: { kind: "new_location" }, existingFactIds: ["fact_0"],
        anchors: { selfConcept: "替乡亲照看信件", values: ["守约"], speechStyle: "直白", capabilityBoundaries: ["只谈村道与交接约定"], taboos: [] },
        goals: [{ horizon: "short", description: "说明家书的去向", priority: 3, reason: "乡亲约定需要兑现" }], relationshipSeeds: [] },
      newItem: null, newEnemy: null, newFact: null,
      nextMainQuest: { name: `家书路线${storyState.currentAct}`, description: "把家书送到约定地点。", objectiveText: "前往地点与值守人交谈" }, endingPair: null,
    } : projection.terminal.kind === "ending" && context.worldState.endings.length < 2 ? {
      beatSummary: "家书已送达，谈谈这次委托。", newLocation: null, newNpc: null, newItem: null, newEnemy: null, newFact: null, nextMainQuest: null,
      endingPair: [{ themeKey: "trust", name: "守约", description: "家书送到，认可这份托付。" }, { themeKey: "doubt", name: "留疑", description: "家书送到，仍对托付有所保留。" }],
    } : null;
    const sceneDrafts = projection.slots.map(slot => {
      const descriptor = projection.descriptorGraph.steps.find(step => step.stepKey === slot.slotKey);
      const npcId = slot.slotKey === "current" ? job.focusNpcId : next?.npcId ?? descriptor?.arrivalNpc?.id;
      const candidates = slot.choiceCount === 0 ? [] : next !== null
        ? [`${slot.slotKey}_choice_1`, `${slot.slotKey}_choice_2`]
        : (slot.slotKey === "current" ? projection.descriptorGraph.currentChoiceCandidates : descriptor!.choiceCandidates).map(candidate => candidate.candidateId);
      return { slotKey: slot.slotKey, scene: {
        segments: slot.slotKey === "current" ? job.mandatoryBeats.filter(beat => beat.beatId !== "atmosphere").map(beat => ({ beatId: beat.beatId, text: "你说明了自己的想法。" })) : [],
        npcLine: npcId === undefined ? null : { npcId: String(npcId), text: "乡亲约定由渡口值守人收信。这份约定我知道，我们接着谈。", emotion: "neutral", answeredBeatIds: slot.slotKey === "current" ? job.mandatoryBeats.filter(beat => beat.kind === "player_utterance").map(beat => beat.beatId) : [], usedFactIds: ["fact_0"], usedEventIds: [] },
        objectiveLink: slot.slotKey === "current" && next === null && job.objectiveTransition.after !== null ? { questId: String(job.objectiveTransition.after.questId), objectiveIndex: job.objectiveTransition.after.objectiveIndex, mode: "progress" } : null,
        choices: candidates.map((candidateId, index) => ({ candidateId, label: index === 0 ? "认可你的说法" : "对此仍有疑问" })),
      } };
    });
    const endingOutcomes = projection.terminal.kind === "ending" ? ["trust", "doubt"].map(themeKey => ({ themeKey, choiceLabel: themeKey === "trust" ? "认可这次托付" : "保留对托付的疑问", scene: { segments: [{ beatId: "atmosphere", text: "家书已经送达，这次托付结束了。" }], npcLine: null, objectiveLink: null, choices: [] } })) : undefined;
  const sceneDraftsWithDialogue = sceneDrafts.map(({ slotKey, scene }) => {
    if (scene.npcLine === null) return { slotKey, scene };
    const stage = Math.min(5, storyState.currentAct);
    const concerns = [
      ["乡亲多年在外，家中只等一句平安。", "信上没有买卖，也没有要你答应的交易。", "把普通的家事当作普通的家事办，已经不容易。", "问清楚去向，再决定是否接下这份托付。", "在渡口值守的人知道公开的约定。", "你可以保留疑问，不必替任何人许下额外诺言。", "信件的去向应由实际交接来确定。"],
      ["村道这一段有人照看，下一处交接也有值守人。", "走过一段路不等于已经把信送到。", "旁人的热心不能代替收信人的确认。", "听清约定，再选自己愿意承担的那一步。", "公开家书无需旁人替它编造隐情。", "我能说明本地约定，不能替远处的人作答。", "去向说清了，交接仍要按实际情况进行。"],
      ["走到这里，最初的托付仍然是同一封家书。", "路上的说法可以增加，约定的收信人不能随意换。", "疲惫时更该把来路和去向分清。", "若有疑问，可以先回想先前听见的话。", "我只说明自己知道的公开安排。", "别人早先的叮嘱需要原来的记录作凭据。", "继续走还是再问一句，由你自己决定。"],
      ["渡口渐近，现在适合确认最后的交接安排。", "赶路不是目的，亲手送达才是约定。", "不能因为接近终点，就把未做的事说成做完了。", "交出信件之前，你仍可以问清楚。", "值守人收信的约定没有改变。", "对托付的看法可以不同，实际结果必须分清。", "把最后一步留给真正的交接。"],
      ["家书到了约定的交接地方，是否交出要看实际行动。", "这份公开的托付不需要额外的秘密条件。", "收信是具体的一次交接，不是一句赞同。", "认可或保留意见，都不能改写已经发生的事。", "我只按自己参与的事情说明情况。", "应当记住的，是谁实际把信交到了谁手中。", "这段路有尽头，托付的后果也该说清楚。"],
    ][stage - 1]!;
    const expressions = [
      ...scene.segments.map(segment => ({ kind: "narration", ...segment, referencedEntityIds: [] })),
      ...(compactReply === undefined ? [scene.npcLine.text, ...concerns] : [slotKey === "current" ? compactReply : scene.npcLine.text]).map((text, index) => ({ kind: "npc_line", ...scene.npcLine!, audienceIds: [String(PLAYER_ENTITY_ID)], text,
        answeredBeatIds: index === 0 ? scene.npcLine!.answeredBeatIds : [] })),
    ];
    return { slotKey, scene: { expressions, objectiveLink: scene.objectiveLink, choices: scene.choices } };
  });
  return { worldDelta, sceneDrafts: sceneDraftsWithDialogue, ...(endingOutcomes === undefined ? {} : { endingOutcomes }) };
}

function visibleTokens(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => key === "choiceToken" && typeof child === "string" ? [child] : visibleTokens(child));
}

export async function runOfflineP2Story(input: { gameLength: "short" | "medium"; summaries: "enabled" | "disabled" | "fail"; compact?: boolean; skipTopicActs?: readonly number[] }) {
  const directory = mkdtempSync(join(tmpdir(), "rpg-p2-offline-"));
  const dbPath = join(directory, "journey.sqlite");
  const clientFactory = () => createSqliteClient(dbPath);
  const open = () => createSqliteGameRepository({ clientFactory, logError: (_context, error) => { throw error; } });
  let repository = open();
  let memoryRepository = createSqliteNarrativeMemorySummaryRepository({ clientFactory, gameRepository: repository });
  const now = () => "2026-09-14T00:00:00.000Z";
  let currentContext: NarrativeBundleSourceContext | undefined;
  let queryInFlight = false;
  let compactReply = "乡亲约定由渡口值守人收信，我只能说明本地的安排。";
  const topicIds: string[] = [];
  const publications: { jobId: string; watermark: number; act: number; beforeDelivery: boolean; sourceFingerprint: string }[] = [];
  let topicsPreservedProgress = true;
  let pendingTopic: { act: number; turns: number; npcId: string } | undefined;
  let preDeliveryHistory = 0;
  const replies = [
    "我想让家中知道在外的乡亲平安，送信能免去空等。", "等信的家人会继续担心；其他影响我不清楚。", "是否回信要由收信人决定，你不必代他答应。",
    "我是这段村道的值守人，负责说明当地交接安排。", "我赞成亲手交接，因为路过不等于收信人已收到。", "我的依据是本地公开约定，远处的情况我没有亲见。",
    "收信人按原约定不变，我的意见不能代替他的确认。", "交给旁人就无法由约定收信人当面确认；我没有别的可靠办法。", "我能说明本地去向，不能保证远处的人如何回应。",
    "我没有已知的新风险可报告，不能把猜测当作事实。", "我能核对的是公开交接约定，没有其他亲见证据。", "是否回复家书要由接收人回答，送达本身不能代他决定。",
    "送到这里能结束递送人的奔波，但家人的回应仍要另外安排。", "我愿按约定收信，其他人的回信意愿不能由我承诺。", "送达不等于家人已经读信，之后的回应仍未确定。",
  ];
  let oldQuoteInActualAuthorRequest = false;
  let oldQuoteLeakedToUninformedNpc = false;
  let npcRequestCount = 0;
  let summaryRequestCount = 0;
  const playerWatermarks = new Set<number>();
  let queried = false;
  let questionPreservedDecision = false;
  let questionAct = 0;
  let questionSessionTurns = 0;
  let reloadEqual = true;
  let actionsTaken = 0;
  let quoteTurn = 0;
  let queryTurn = 0;
  let oldQuoteId = "";
  let recallAudit: AiTextAuditContext | undefined;
  let recalledSourceVerified = false;
  let oldQuoteCoveredAtQuery = false;
  let oldQuoteOmittedFromOverview = false;
  const memoryAudits: AiTextAuditContext[] = [];
  const aiClient: RpgAiClient = {
    policy: () => ({ thinking: "on", reasoningEffort: "low", timeoutMs: 240_000, jsonMode: "prompt_only", maxAttempts: 2 }),
    async complete(_role, messages, audit, options) {
      if (options?.beforeTransportAttempt !== undefined && !(await options.beforeTransportAttempt())) return { ok: false, code: "aborted", retryable: false, latencyMs: 0 };
      const prompt = messages.map(message => message.content).join("\n");
      if (audit !== undefined) memoryAudits.push(audit);
      if (audit?.purpose === "narrative_candidate_review") return { ok: true, content: JSON.stringify(fixtureNarrativeReviewPass(messages)), latencyMs: 0 };
      if (audit?.purpose === "narrative_memory_summary") {
        summaryRequestCount += 1;
        if (input.summaries === "fail") return { ok: false, code: "network_error", retryable: false, latencyMs: 0 };
        const sources = JSON.parse(messages[1]!.content) as { history: { id: string; text: string }[]; events: { eventId: string }[] };
        // Keep context anchors but deliberately omit the exact old condition;
        // retrieval has to recover it from the untouched source History.
        const selected = sources.history.filter(entry => entry.text !== P2_OLD_QUOTE).slice(0, 1);
        return { ok: true, content: JSON.stringify({ historyIds: selected.map(entry => entry.id), eventIds: [] }), latencyMs: 0 };
      }
      if (audit?.purpose === "npc_deliberation") {
        npcRequestCount += 1;
        const envelope = JSON.parse(messages[1]!.content.split("\n\n只返回")[0]!) as { npc: { npcId: string } };
        if (envelope.npc.npcId !== "npc_0" && prompt.includes(P2_OLD_QUOTE)) oldQuoteLeakedToUninformedNpc = true;
        return { ok: true, content: JSON.stringify({ npcId: envelope.npc.npcId, goalIds: [], response: "question", evidenceEventIds: [], discloseFactIds: [], interactionProposals: [] }), latencyMs: 0 };
      }
      if (currentContext === undefined) throw new Error("missing provider context");
      if (currentContext.kind === "opening") return { ok: true, content: JSON.stringify(await buildOfflineP2Opening(currentContext)), latencyMs: 0 };
      if (queryInFlight) {
        oldQuoteInActualAuthorRequest ||= prompt.includes(P2_OLD_QUOTE);
        recallAudit = audit;
        recalledSourceVerified = currentContext.memoryContext?.recalled.some(entry => entry.id === oldQuoteId
          && entry.text === P2_OLD_QUOTE) === true && prompt.includes(oldQuoteId) && prompt.includes(P2_OLD_QUOTE);
      }
      return { ok: true, content: JSON.stringify(buildOfflineP2Draft(currentContext, input.compact ? compactReply : undefined)), latencyMs: 0 };
    },
  };
  const requestClient = createNarrativeRequestClient({ aiClient });
  const liveSource = createNarrativeBundleSource({ aiClient, requestClient });
  const source: NarrativeBundleSource = { generate: async context => { currentContext = context; return liveSource.generate(context); } };
  const summarySource = createLiveNarrativeMemorySummarySource({ requestClient });
  const npcSource = createLiveNpcDeliberationSource({ aiClient, requestClient });
  const reviewer = createLiveNarrativeCandidateReview({ aiClient, requestClient });
  const read = async (): Promise<GameRecord> => {
    const result = await repository.getCurrentGame();
    if (!result.ok || result.status !== "active") throw new Error("offline story missing");
    return result.record;
  };
  const observeSummary = async (record: GameRecord) => {
    const loaded = await memoryRepository.load({ gameId: record.gameId, generationId: record.worldState.generation.generationId, observerId: PLAYER_ENTITY_ID });
    if (loaded.state !== null) playerWatermarks.add(loaded.state.coveredThroughSequence);
  };
  try {
    await repository.initializeSchema();
    const created = await createGame({ gameId: asGameId(`p2_${input.gameLength}_${input.summaries}`), gameType: "wuxia", gameLength: input.gameLength, seed: "offline-p2" }, { repository, source, now, aiEnabled: false });
    if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created)}`);
    quoteTurn = (await read()).storyState.history.entries.find(entry => entry.text === P2_OLD_QUOTE)?.turnNumber ?? -1;
    for (let turn = 0; turn < 48; turn += 1) {
      let record = await read();
      if (record.storyState.narrative.status === "provider_pending") {
        const generated = await generatePendingNarrativeBundle({ repository, source, npcDeliberationSource: npcSource, reviewer, now,
          memorySummaryRepository: memoryRepository,
          prepareMemoryPackage: createNarrativeMemoryPackagePreparer({ repository: memoryRepository, source: summarySource,
            hooks: { reserve: async reservation => async settlement => {
              if (reservation.kind === "summary_batch" && reservation.observerId === String(PLAYER_ENTITY_ID)
                && settlement.published && settlement.state !== undefined) publications.push({ jobId: reservation.jobId,
                  watermark: settlement.state.coveredThroughSequence, act: record.storyState.currentAct,
                  beforeDelivery: !isStoryDeliveryComplete(record.worldState, record.storyState), sourceFingerprint: reservation.sourceFingerprint });
            } },
            policy: DEFAULT_NARRATIVE_MEMORY_POLICY, summaries: input.summaries === "disabled" ? "disabled" : "enabled" }),
        });
        record = await read();
        if (!generated.ok || record.storyState.narrative.status !== "ready") throw new Error(`generation failed act ${record.storyState.currentAct}: ${JSON.stringify({ generated, narrative: record.storyState.narrative })}`);
        if (pendingTopic !== undefined) {
          topicsPreservedProgress &&= record.storyState.currentAct === pendingTopic.act
            && record.storyState.narrative.dialogueSession?.npcId === pendingTopic.npcId
            && record.storyState.narrative.dialogueSession.turnCount === pendingTopic.turns;
          pendingTopic = undefined;
        }
        if (queryInFlight) {
          const questionView = projectGameSessionView(record.worldState, record.storyState, record.revision, "p2-offline");
          const questionMap = buildChoiceMap(record.worldState, record.storyState, record.revision);
          questionPreservedDecision = record.storyState.currentAct === questionAct
            && record.storyState.narrative.dialogueSession?.turnCount === questionSessionTurns
            && questionView.narrative.npcDialogues.some(entry => entry.freeInputEnabled)
            && visibleTokens(questionView).some(token => { const action = questionMap.get(token); return (action?.type === "talk" && action.dialogueAct !== "ask") || action?.type === "give_item"; });
        }
        queryInFlight = false;
        await observeSummary(record);
      }
      if (record.worldState.ending !== null) break;
      const map = buildChoiceMap(record.worldState, record.storyState, record.revision);
      const view = projectGameSessionView(record.worldState, record.storyState, record.revision, "p2-offline");
      const dialogue = view.narrative.npcDialogues.find(entry => entry.freeInputEnabled);
      const enoughSummary = input.summaries !== "enabled" || playerWatermarks.size >= 2;
      if (!queried && record.storyState.currentAct >= 3 && dialogue !== undefined && enoughSummary && !isStoryDeliveryComplete(record.worldState, record.storyState)) {
        const oldEntry = record.storyState.history.entries.find(entry => entry.text === P2_OLD_QUOTE);
        const summary = await memoryRepository.load({ gameId: record.gameId, generationId: record.worldState.generation.generationId, observerId: PLAYER_ENTITY_ID });
        oldQuoteId = oldEntry?.id ?? "";
        oldQuoteCoveredAtQuery = oldEntry !== undefined && summary.state !== null && oldEntry.sequence <= summary.state.coveredThroughSequence;
        oldQuoteOmittedFromOverview = oldEntry !== undefined && summary.state !== null && !summary.state.overview.historyIds.includes(oldEntry.id);
        const before = record;
        await memoryRepository.close();
        await repository.close();
        repository = open();
        memoryRepository = createSqliteNarrativeMemorySummaryRepository({ clientFactory, gameRepository: repository });
        await repository.initializeSchema();
        record = await read();
        reloadEqual &&= JSON.stringify(record) === JSON.stringify(before);
        const result = await performTurn({ gameId: record.gameId, actionId: `p2_query_${turn}`, expectedRevision: record.revision, choiceMap: map,
          interaction: { kind: "free_text", text: P2_RECALL_QUESTION, targetNpcId: asNpcId(dialogue.npcId) } }, { repository, now });
        if (!result.ok) throw new Error(`query failed: ${JSON.stringify(result)}`);
        queried = true;
        questionAct = record.storyState.currentAct;
        questionSessionTurns = record.storyState.narrative.dialogueSession?.npcId === dialogue.npcId
          ? record.storyState.narrative.dialogueSession.turnCount : 0;
        queryInFlight = true;
        compactReply = "我没有亲历最初的委托，请按你当时听到的交付条件决定，不要把我的猜测当作原话。";
        queryTurn = record.storyState.turnNumber;
        actionsTaken += 1;
        continue;
      }
      const actions = visibleTokens(view).flatMap(token => map.has(token) ? [{ token, action: map.get(token)! }] : []);
      const bundle = record.storyState.narrative.status === "ready" ? record.storyState.narrative.narrativeBundle : undefined;
      const activeMoveIds = bundle?.steps.filter(step => bundle.activeStepIds.includes(step.stepId) && step.trigger.kind === "move").map(step => step.trigger.kind === "move" ? step.trigger.locationId : null) ?? [];
      const chosen = actions.find(entry => entry.action.type === "give_item" && entry.action.npcId === record.storyState.delivery?.recipientNpcId)
        ?? actions.find(entry => entry.action.type === "move" && activeMoveIds.includes(entry.action.locationId))
        ?? actions.find(entry => entry.action.type === "talk" && entry.action.dialogueAct === (turn % 2 === 0 ? "support" : "challenge"))
        ?? actions.find(entry => entry.action.type === "talk");
      if (input.compact && !queried && dialogue !== undefined && chosen?.action.type !== "move"
        && !isStoryDeliveryComplete(record.worldState, record.storyState)
        && !input.skipTopicActs?.includes(record.storyState.currentAct)) {
        const topicIndex = NARRATIVE_P2_TOPICS.findIndex(topic => topic.act === record.storyState.currentAct && !topicIds.includes(topic.topicId));
        if (topicIndex >= 0) {
          const topic = NARRATIVE_P2_TOPICS[topicIndex]!;
          pendingTopic = { act: record.storyState.currentAct, npcId: dialogue.npcId,
            turns: record.storyState.narrative.dialogueSession?.npcId === dialogue.npcId ? record.storyState.narrative.dialogueSession.turnCount : 0 };
          const asked = await performTurn({ gameId: record.gameId, actionId: `p2_topic_${turn}`, expectedRevision: record.revision,
            choiceMap: map, interaction: { kind: "free_text", text: topic.text, targetNpcId: asNpcId(dialogue.npcId) } }, { repository, now });
          if (!asked.ok) throw new Error(`topic failed: ${JSON.stringify(asked)}`);
          topicIds.push(topic.topicId); compactReply = replies[topicIndex]!; actionsTaken += 1;
          continue;
        }
      }
      if (chosen?.action.type === "give_item") preDeliveryHistory = record.storyState.history.entries.filter(entry => entry.kind !== "shown_choice").length;
      compactReply = "乡亲约定由渡口值守人收信，我只能说明本地的安排。";
      if (chosen === undefined) throw new Error(`no legal story action: ${JSON.stringify(view.narrative)}`);
      const result = await performTurn({ gameId: record.gameId, actionId: `p2_${turn}`, interaction: { kind: "fixed_choice", choiceToken: chosen.token }, expectedRevision: record.revision, choiceMap: map }, { repository, now });
      if (!result.ok) throw new Error(`action failed: ${JSON.stringify(result)}`);
      actionsTaken += 1;
    }
    const final = await read();
    await memoryRepository.close();
    await repository.close();
    repository = open();
    memoryRepository = createSqliteNarrativeMemorySummaryRepository({ clientFactory, gameRepository: repository });
    await repository.initializeSchema();
    reloadEqual &&= JSON.stringify(await read()) === JSON.stringify(final);
    const authorAudits = memoryAudits.filter(audit => audit.purpose === "narrative_bundle_generation" && audit.memory !== undefined);
    const reviewAudits = memoryAudits.filter(audit => audit.purpose === "narrative_candidate_review");
    const npcAudits = memoryAudits.filter(audit => audit.purpose === "npc_deliberation");
    const summaryAudits = memoryAudits.filter(audit => audit.purpose === "narrative_memory_summary");
    const samePacket = (left: AiTextAuditContext, right: AiTextAuditContext) => left.jobId === right.jobId
      && left.memory?.preparedHash !== undefined && left.memory.preparedHash === right.memory?.preparedHash
      && left.memory.sourceFingerprint === right.memory?.sourceFingerprint;
    return {
      topicIds, topicsPreservedProgress, publications, preDeliveryHistory,
      recallSource: { historyId: oldQuoteId, jobId: recallAudit?.jobId, observerId: recallAudit?.memory?.observerId,
        inRecalledSourcesAndRequest: recalledSourceVerified,
        recallCount: recallAudit?.memory?.recallCount ?? 0, sourceFingerprint: recallAudit?.memory?.sourceFingerprint },
      memoryCoveragePassed: queried && oldQuoteCoveredAtQuery && oldQuoteInActualAuthorRequest && recalledSourceVerified
        && new Set(publications.filter(item => item.beforeDelivery).map(item => item.jobId)).size >= 2,
      completed: final.worldState.ending !== null && final.storyState.narrative.status === "ready",
      questionPreservedDecision,
      stateVersions: { entity: final.worldState.entityStore.version, world: final.worldState.version, story: final.storyState.version },
      unclosedQuestions: final.storyState.threads.filter(thread => thread.kind === "question" && thread.closure.length === 0 && thread.status !== "resolved").length,
      finalAct: final.storyState.currentAct, eligibleHistoryCount: final.storyState.history.entries.filter(entry => entry.kind !== "shown_choice").length,
      publishedSummaryRevisions: playerWatermarks.size, watermarks: [...playerWatermarks], summaryRequestCount,
      oldQuoteInActualAuthorRequest, oldQuoteLeakedToUninformedNpc, npcRequestCount,
      itemGivenEventCount: final.worldState.eventLedger.filter(event => event.kind === "item_given").length,
      reloadEqual, queried, actionsTaken, oldQuoteTurn: quoteTurn, queryTurn,
      oldQuoteCoveredAtQuery, oldQuoteOmittedFromOverview,
      authorReviewerShareFixedPacket: authorAudits.length > 0 && authorAudits.every(author => reviewAudits.some(review =>
        samePacket(author, review) && review.memory?.observerId === String(PLAYER_ENTITY_ID))),
      npcAuditHasPrivateObserver: npcAudits.length > 0 && npcAudits.every(npc => npc.memory?.observerId !== undefined
        && npc.memory.observerId !== String(PLAYER_ENTITY_ID) && authorAudits.some(author => samePacket(author, npc))),
      summaryAuditHasSources: summaryAudits.length > 0 && summaryAudits.every(summary => summary.memory?.observerId !== undefined
        && summary.memory.sourceFingerprint.length > 0 && Array.isArray(summary.memory.historyIds)
        && Array.isArray(summary.memory.eventIds) && summary.memory.historyIds.length > 0),
    };
  } finally {
    await memoryRepository.close();
    await repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
