import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Action } from "@/game/domain/action";
import { asGameId, type GameRecord } from "@/game/application/server/persistence/gameRepository";
import { createSqliteClient } from "@/game/application/server/persistence/sqliteClient";
import { createSqliteGameRepository } from "@/game/application/server/persistence/sqliteGameRepository";
import { buildChoiceMap } from "@/game/application/buildChoiceMap";
import { createGame } from "@/game/application/createGame";
import { generatePendingNarrativeBundle } from "@/game/application/generatePendingNarrativeBundle";
import { performTurn } from "@/game/application/performTurn";
import { projectGameSessionView } from "@/game/application/gameSessionView";
import type {
  NarrativeBundleProposal,
  NarrativeBundleSource,
  NarrativeBundleSourceContext,
  NarrativeBundleSourceResult,
} from "@/game/application/narrativeBundleSource";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import type { ScenePerformanceSegment } from "@/game/domain/narrativeBundle";
import { asFactId, asNpcId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { EntityId, ItemEntityRecord, NpcEntityRecord } from "@/game/domain/entity";
import type { EventId } from "@/game/domain/events";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { WorldState } from "@/game/domain/worldState";
import { buildNarrativeBundleDescriptors } from "@/game/gameplay/rpg/narrativeBundle";

export type TempleRoute = "private" | "public" | "verify_first" | "exit_return" | "exit_keep";

export type TempleJourneyResult = Readonly<{
  ended: boolean;
  route: TempleRoute;
  snapshots: readonly GameRecord[];
  actionCount: number;
  itemOwnerAtEnd: EntityId | null;
  publicExposure: boolean;
  promiseStatus: "absent" | "open" | "fulfilled" | "broken" | "released";
}>;

export type TempleJourneyOptions = Readonly<{
  /** 在客栈路线完成后关闭并重新打开同一个 SQLite 存档。 */
  readonly reloadBeforeFinalAct?: boolean;
}>;

export type TempleDepartureProbeResult = Readonly<{
  ordinaryMoveRejected: boolean;
  ordinaryMoveEnded: boolean;
  freeformEnded: boolean;
  freeformItemOwner: EntityId | null;
  freeformWasNeutral: boolean;
}>;

const FIXED_NOW = "2026-09-12T00:00:00.000Z";
const LETTER_ITEM_ID = "item_0";
const FIRST_FACT_ID = "fact_0";

function openingCandidate(): OpeningGenerationCandidate {
  return {
    world: {
      summary: "破庙里的一封密信把三幕追索引向渡口。",
      tone: "潮湿克制的江湖悬疑",
      themes: ["信任", "核验"],
      publicFacts: [
        { key: "letter_route", text: "密信指向芦苇渡口的旧约。" },
        { key: "letter_seal", text: "信封上的蜡印属于一场未公开的盟约。" },
      ],
    },
    player: {
      name: "持信人",
      identity: "行脚客",
      backgroundSummary: "在风雨里接下了一件不该被轻易转交的委托。",
      baseStats: { hp: 100, attack: 10, defense: 5 },
    },
    prologue: "破庙漏雨，石案上只剩一只封口的信筒。",
    storyContract: {
      version: 1,
      targetActs: 3,
      centralConflict: "一封密信的归还方式决定谁来承担旧约的代价。",
      endingDirections: [
        { key: "trust", theme: "把证据交给愿意承担责任的人" },
        { key: "doubt", theme: "在核验完成前保留判断" },
      ],
      delivery: {
        itemKey: "sealed_letter",
        recipientKey: "ferry_contact",
        verificationFactKeys: ["letter_route"],
      },
    },
    opening: {
      location: {
        name: "破庙",
        description: "荒废的破庙贴着芦苇水路，雨声把脚步声压得很低。",
        buildingName: "偏殿",
        scale: "town",
      },
      npc: {
        name: "守庙人",
        role: "临时传信人",
        description: "守着破庙残灯、只肯说明亲眼见闻的老人。",
        knownFactKeys: ["letter_route"],
        privateFactKeys: ["letter_seal"],
        anchors: {
          selfConcept: "替旧约守住最后一句话的人",
          values: ["守信"],
          speechStyle: "低声而谨慎",
          capabilityBoundaries: ["只说明亲眼见过的递送路线"],
          taboos: ["不把密信内容说给无关者"],
        },
        goals: [{ horizon: "short", description: "让信筒到达真正的接应人", priority: 4, reason: "旧约的最后一环正在断裂" }],
      },
      item: {
        key: "sealed_letter",
        name: "封口信筒",
        description: "蜡封尚完整的信筒，必须由玩家亲手保管或归还。",
        kind: "quest",
        tags: ["delivery"],
      },
      quest: {
        name: "把密信送回旧约",
        description: "沿着信中留下的线索找到接应人。",
        objective: { kind: "talk_to_opening_npc" },
      },
      situation: {
        history: [],
        threads: [{
          key: "letter_route",
          questionFactKey: "letter_route",
          supportingFactKeys: ["letter_seal"],
          participantRefs: ["player", "opening_npc"],
          causeHistoryKeys: [],
        }],
        npcConnection: { familiarity: "stranger", stance: "neutral", basisHistoryKeys: [] },
        responses: [
          { key: "ask_route", dialogueAct: "ask", topic: { kind: "fact", key: "letter_route" } },
          { key: "challenge_route", dialogueAct: "challenge", topic: { kind: "thread", key: "letter_route" } },
        ],
      },
      firstScene: {
        narration: "雨水沿着破庙的裂瓦落在石案上，守庙人把信筒推到你面前。",
        npcLine: {
          text: "先别问信里写了什么。你若要接手，至少要知道它该去哪里。",
          emotion: "guarded",
          usedFactKeys: ["letter_route"],
        },
        choices: [
          { candidateId: "ask_route", label: "先问清楚信筒要送往哪里。" },
          { candidateId: "challenge_route", label: "先追问这份旧约为什么还值得冒险。" },
        ],
      },
    },
  };
}

function mandatorySegments(context: Extract<NarrativeBundleSourceContext, { kind: "decision" }>): readonly ScenePerformanceSegment[] {
  const segments = context.job.mandatoryBeats
    .filter((beat) => beat.beatId !== "atmosphere")
    .map((beat) => ({
    beatId: beat.beatId,
    text: beat.kind === "player_utterance" ? "你的选择落在雨声里。" : `节拍：${beat.kind}`,
    }));
  return [...segments, { beatId: "atmosphere", text: "雨声暂时盖住了远处的脚步。" }];
}

function npcLineForJob(
  context: Extract<NarrativeBundleSourceContext, { kind: "decision" }>,
  text: string,
): NarrativeBundleProposal["currentScene"]["npcLine"] {
  if (context.job.focusNpcId === undefined || context.job.actionSummary.kind === "abandon_quest") return null;
  const answeredBeatIds = context.job.mandatoryBeats
    .filter((beat) => beat.kind === "player_utterance")
    .map((beat) => beat.beatId);
  return {
    npcId: String(context.job.focusNpcId),
    text,
    emotion: "guarded",
    answeredBeatIds,
    usedFactIds: [],
    usedEventIds: [],
  };
}

function routeInteraction(route: TempleRoute): {
  readonly operation: "promise_confidentiality" | "share_known_fact" | "request_verification";
  readonly label: string;
} | null {
  switch (route) {
    case "private": return { operation: "promise_confidentiality", label: "私下请求引荐" };
    case "public": return { operation: "share_known_fact", label: "公开说明信筒来路" };
    case "verify_first": return { operation: "request_verification", label: "先核验信筒上的旧约" };
    case "exit_return": return null;
    case "exit_keep": return null;
  }
}

function evolutionDelta(
  context: Extract<NarrativeBundleSourceContext, { kind: "decision" }>,
  _route: TempleRoute,
): WorldDeltaProposal {
  const act = context.storyState.currentAct;
  const locationName = act === 2 ? "听雨客栈" : "芦苇渡口";
  const npcName = act === 2 ? "客栈接应人" : "渡口接应人";
  const factText = act === 2 ? "接应人认得信筒上的旧约暗记。" : "渡口石桩上留着与信筒相同的旧约暗记。";
  return {
    beatSummary: `第${act}幕：${locationName}的接应线索出现。`,
    newLocation: {
      name: locationName,
      description: act === 2 ? "临水客栈把来往口信藏在账本和茶烟之间。" : "芦苇渡口潮声很重，旧石桩旁留着一处干燥的交接台。",
      scale: "scene",
      placement: "world",
      connectFromLocationId: String(context.worldState.currentLocationId),
    },
    newNpc: {
      name: npcName,
      role: act === 2 ? "客栈接应人" : "渡口守约人",
      description: act === 2 ? "只在看见可信凭据后才接话的客栈伙计。" : "守着渡口旧石桩、等待信筒归还的人。",
      locationRef: { kind: "new_location" },
      anchors: {
        selfConcept: "替旧约看守交接边界的人",
        values: ["谨慎"],
        speechStyle: "短句而克制",
        capabilityBoundaries: ["只能核对眼前的凭据"],
        taboos: ["不替别人保证未核验的事"],
      },
      goals: [{ horizon: "short", description: "确认信筒是否来自旧约持有人", priority: 4, reason: factText }],
      relationshipSeeds: [],
    },
    newItem: null,
    newEnemy: null,
    newFact: { text: factText, visibility: "public" },
    nextMainQuest: {
      name: `${locationName}的交接核验`,
      description: `找到${npcName}并完成这一幕的正式交接。`,
      objectiveText: `前往${locationName}与${npcName}交谈`,
    },
    endingPair: null,
  };
}

function eventIdForVerification(worldState: WorldState): EventId | undefined {
  return worldState.eventLedger.find((event) => event.kind === "opening_thread_established")?.eventId
    ?? worldState.eventLedger[0]?.eventId;
}

function proposalForDecision(
  context: Extract<NarrativeBundleSourceContext, { kind: "decision" }>,
  route: TempleRoute,
): NarrativeBundleSourceResult {
  const { storyState, job } = context;
  if (job.actionSummary.kind === "abandon_quest") {
    const proposal: NarrativeBundleProposal = {
      worldDelta: null,
      currentScene: {
        segments: mandatorySegments(context),
        npcLine: npcLineForJob(context, "故事在未完成的承诺旁收束。"),
        objectiveLink: null,
        choices: [],
      },
      continuationScenes: [],
      terminal: { kind: "ending" },
    };
    return { ok: true, kind: "decision", proposal };
  }

  if (storyState.evolution.status === "needs_ending_pair" && context.worldState.endings.length >= 2) {
    const proposal: NarrativeBundleProposal = {
      worldDelta: null,
      currentScene: {
        segments: mandatorySegments(context),
        npcLine: npcLineForJob(context, "结局已经落定，最后的余波留在雨声里。"),
        objectiveLink: null,
        choices: [],
      },
      continuationScenes: [],
      terminal: { kind: "ending" },
    };
    return { ok: true, kind: "decision", proposal };
  }

  if (storyState.evolution.status === "needs_ending_pair") {
    const proposal: NarrativeBundleProposal = {
      worldDelta: {
        beatSummary: "终幕的两种走向浮现。",
        newLocation: null,
        newNpc: null,
        newItem: null,
        newEnemy: null,
        newFact: null,
        nextMainQuest: null,
        endingPair: [
          {
            name: "共同揭露真相",
            description: "你与愿意承担责任的人一起摊开已核对的证据。",
            themeKey: "trust",
          },
          {
            name: "保留判断继续追查",
            description: "你保留最后的判断，独自追查旧约背后的责任。",
            themeKey: "doubt",
          },
        ],
      },
      currentScene: {
        segments: mandatorySegments(context),
        npcLine: npcLineForJob(context, "信筒已经交接，最后的选择留给你。"),
        objectiveLink: null,
        choices: [],
      },
      continuationScenes: [],
      terminal: { kind: "ending" },
    };
    return { ok: true, kind: "decision", proposal };
  }

  if (storyState.evolution.status === "needs_next_act") {
    const delta = evolutionDelta(context, route);
    const nextLocationId = `loc_dyn_${storyState.evolution.nextLocationOrdinal}`;
    const nextNpcId = `npc_dyn_${storyState.evolution.nextNpcOrdinal}`;
    const nextStepKey = `move:${nextLocationId}`;
    const requiresDelivery = storyState.currentAct === storyState.targetActs
      && storyState.contract.delivery !== undefined;
    const deliveryStepKey = `give_item:${LETTER_ITEM_ID}:${nextNpcId}`;
    const interaction = routeInteraction(route);
    const evidenceEventId = eventIdForVerification(context.worldState);
    const interactionProposals = interaction === null || storyState.currentAct !== 2
      ? []
      : [{
          proposalKey: `route_${route}`,
          npcId: asNpcId("@new.npc"),
          operation: interaction.operation,
          condition: [],
          factIds: interaction.operation === "promise_confidentiality" ? [] : [asFactId("@new.fact")],
          goalIds: [],
          promiseId: null,
          audienceIds: [PLAYER_ENTITY_ID],
          evidenceEventIds: interaction.operation === "request_verification" && evidenceEventId !== undefined
            ? [evidenceEventId]
            : [],
        }];
    const choiceLabels = interaction === null || storyState.currentAct !== 2
      ? ["表示愿意继续核对", "质疑这份交接是否可靠"]
      : [interaction.label, "先听完接应人的完整说明"];
    const continuationScenes = requiresDelivery
      ? [
          {
            stepKey: nextStepKey,
            scene: {
              segments: [{ beatId: "arrival", text: `你抵达${delta.newLocation?.name ?? "下一处地点"}。` }],
              npcLine: {
                npcId: nextNpcId,
                text: "先把信筒放在灯下。我们可以谈，但不能跳过核对。",
                emotion: "guarded" as const,
                answeredBeatIds: [],
                usedFactIds: [],
                usedEventIds: [],
              },
              objectiveLink: null,
              choices: [],
            },
          },
          {
            stepKey: deliveryStepKey,
            scene: {
              segments: [{ beatId: "delivery", text: "信筒终于落到真正的接应人手中。" }],
              npcLine: {
                npcId: nextNpcId,
                text: "交给我。收下之后，我们再谈这份旧约要谁来承担。",
                emotion: "guarded" as const,
                answeredBeatIds: [],
                usedFactIds: [],
                usedEventIds: [],
              },
              objectiveLink: null,
              choices: [
                { candidateId: `${deliveryStepKey}_choice_1`, label: "表示愿意继续核对" },
                { candidateId: `${deliveryStepKey}_choice_2`, label: "质疑这份交接是否可靠" },
              ],
            },
          },
        ]
      : [{
          stepKey: nextStepKey,
          scene: {
            segments: [{ beatId: "arrival", text: `你抵达${delta.newLocation?.name ?? "下一处地点"}。` }],
            npcLine: {
              npcId: nextNpcId,
              text: "先把信筒放在灯下。我们可以谈，但不能跳过核对。",
              emotion: "guarded" as const,
              answeredBeatIds: [],
              usedFactIds: [],
              usedEventIds: [],
            },
            objectiveLink: null,
            choices: [
              { candidateId: `${nextStepKey}_${interaction === null || storyState.currentAct !== 2 ? "choice" : "interaction"}_1`, label: choiceLabels[0]! },
              { candidateId: `${nextStepKey}_choice_2`, label: choiceLabels[1]! },
            ],
          },
        }];
    const proposal: NarrativeBundleProposal = {
      worldDelta: delta,
      interactionProposals,
      currentScene: {
        segments: mandatorySegments(context),
        npcLine: npcLineForJob(context, "守庙人的话停在雨里，新的接应地点已经浮现。"),
        objectiveLink: null,
        choices: [],
      },
      continuationScenes,
      terminal: {
        kind: "next_decision",
        target: { kind: "continuation_step", stepKey: requiresDelivery ? deliveryStepKey : nextStepKey },
      },
    };
    return { ok: true, kind: "decision", proposal };
  }

  const after = job.objectiveTransition.after;
  const npc = after === null
    ? undefined
    : context.worldState.quests
      .find((quest) => String(quest.id) === String(after.questId))
      ?.objectives[after.objectiveIndex];
  const currentNpcId = npc?.kind === "talk_to_npc" ? String(npc.npcId) : job.focusNpcId === undefined ? undefined : String(job.focusNpcId);
  const interactions = currentNpcId === undefined
    ? []
    : context.worldState.npcs.find((entry) => String(entry.id) === currentNpcId)?.memory.interactionHistory;
  const candidates = buildNarrativeBundleDescriptors({ worldState: context.worldState, storyState, transition: job.objectiveTransition }).currentChoiceCandidates;
  const hasInstalledInteraction = candidates[0]?.action.type === "talk" && candidates[0].action.interactionId !== undefined;
  const interactionChoiceIds = candidates.map((candidate) => candidate.candidateId);
  const currentInteraction = routeInteraction(route);
  const proposal: NarrativeBundleProposal = {
    worldDelta: null,
    currentScene: {
      segments: mandatorySegments(context),
      npcLine: npcLineForJob(context, interactions === undefined ? "接应人等着你作出下一步回应。" : "接应人把刚才的核验结果留在桌面上。"),
      objectiveLink: after === null ? null : { questId: String(after.questId), objectiveIndex: after.objectiveIndex, mode: "progress" },
      choices: [
        { candidateId: interactionChoiceIds[0]!, label: hasInstalledInteraction && currentInteraction !== null ? currentInteraction.label : hasInstalledInteraction ? "继续执行已核准的互动" : "表示愿意继续核对" },
        { candidateId: interactionChoiceIds[1]!, label: "质疑这份交接是否可靠" },
      ],
    },
    continuationScenes: [],
    terminal: { kind: "next_decision", target: { kind: "current_scene" } },
  };
  return { ok: true, kind: "decision", proposal };
}

export function createTempleLetterBundleSource(route: TempleRoute = "private"): NarrativeBundleSource {
  const candidate = openingCandidate();
  return {
    async generate(context): Promise<NarrativeBundleSourceResult> {
      if (context.kind === "opening") {
        return {
          ok: true,
          kind: "opening",
          proposal: {
            opening: candidate,
            currentScene: {
              segments: [{ beatId: "opening", text: candidate.opening.firstScene!.narration }],
              npcLine: {
                npcId: "npc_0",
                text: candidate.opening.firstScene!.npcLine.text,
                emotion: candidate.opening.firstScene!.npcLine.emotion,
                answeredBeatIds: [],
                usedFactIds: [FIRST_FACT_ID],
                usedEventIds: [],
              },
              objectiveLink: null,
              choices: candidate.opening.firstScene!.choices,
            },
            continuationScenes: [],
            terminal: { kind: "next_decision", target: { kind: "current_scene" } },
          },
        };
      }
      return proposalForDecision(context, route);
    },
  };
}

type JourneyStore = ReturnType<typeof createSqliteGameRepository>;

function openJourneyRepository(dbPath: string): JourneyStore {
  return createSqliteGameRepository({ clientFactory: () => createSqliteClient(dbPath), logError: () => {} });
}

async function currentRecord(repository: JourneyStore): Promise<GameRecord> {
  const current = await repository.getCurrentGame();
  if (!current.ok || current.status !== "active") throw new Error("旅程存档不可用");
  return current.record;
}

async function settlePending(repository: JourneyStore, source: NarrativeBundleSource, snapshots: GameRecord[]): Promise<void> {
  for (;;) {
    const record = await currentRecord(repository);
    if (record.storyState.narrative.status !== "provider_pending") return;
    const generated = await generatePendingNarrativeBundle({ repository, source, now: () => FIXED_NOW });
    if (!generated.ok) {
      const failed = await currentRecord(repository);
      const detail = failed.storyState.narrative.status === "provider_failed"
        ? failed.storyState.narrative.failure.reason
        : "unknown";
      throw new Error(`叙事包生成失败：${generated.code}:${detail}`);
    }
    snapshots.push(await currentRecord(repository));
  }
}

function choiceTokenForAction(record: GameRecord, predicate: (action: Action) => boolean): string {
  const map = buildChoiceMap(record.worldState, record.storyState, record.revision);
  const match = [...map.entries()].find(([, action]) => predicate(action));
  if (match === undefined) throw new Error("找不到服务端已铸造的行动 token");
  return match[0];
}

function sceneChoiceToken(record: GameRecord, predicate: (label: string) => boolean): string {
  const view = projectGameSessionView(record.worldState, record.storyState, record.revision, "temple-letter-journey");
  const choices = [
    ...view.narrative.choices,
    ...view.narrative.npcDialogues.flatMap((dialogue) => [
      ...dialogue.choices,
      ...dialogue.giveChoices.map((entry) => entry.choice),
    ]),
  ];
  const choice = choices.find((entry) => predicate(entry.label));
  if (choice === undefined) throw new Error(`找不到场景选项：${choices.map((entry) => entry.label).join(" / ")}`);
  return choice.choiceToken;
}

async function submitChoice(
  repository: JourneyStore,
  source: NarrativeBundleSource,
  actionCount: { value: number },
  snapshots: GameRecord[],
  token: string,
): Promise<void> {
  const record = await currentRecord(repository);
  const result = await performTurn({
    gameId: record.gameId,
    actionId: `temple_${actionCount.value + 1}`,
    interaction: { kind: "fixed_choice", choiceToken: token },
    expectedRevision: record.revision,
    choiceMap: buildChoiceMap(record.worldState, record.storyState, record.revision),
  }, { repository, now: () => FIXED_NOW });
  if (!result.ok) throw new Error(`行动提交失败：${result.code}`);
  actionCount.value += 1;
    snapshots.push(await currentRecord(repository));
    await settlePending(repository, source, snapshots);
}

async function submitSceneChoice(
  repository: JourneyStore,
  source: NarrativeBundleSource,
  actionCount: { value: number },
  snapshots: GameRecord[],
  label: string,
): Promise<void> {
  const record = await currentRecord(repository);
  await submitChoice(repository, source, actionCount, snapshots, sceneChoiceToken(record, (candidate) => candidate.includes(label)));
}

async function submitFreeform(
  repository: JourneyStore,
  source: NarrativeBundleSource,
  actionCount: { value: number },
  snapshots: GameRecord[],
  text: string,
): Promise<void> {
  const record = await currentRecord(repository);
  const npc = record.worldState.npcs.find((candidate) => candidate.locationId === record.worldState.currentLocationId);
  if (npc === undefined) throw new Error("找不到自由输入的当前 NPC");
  const result = await performTurn({
    gameId: record.gameId,
    actionId: `temple_${actionCount.value + 1}`,
    interaction: { kind: "free_text", targetNpcId: npc.id, text },
    expectedRevision: record.revision,
    choiceMap: buildChoiceMap(record.worldState, record.storyState, record.revision),
  }, { repository, now: () => FIXED_NOW });
  if (!result.ok) throw new Error(`自由输入提交失败：${result.code}`);
  actionCount.value += 1;
  snapshots.push(await currentRecord(repository));
  await settlePending(repository, source, snapshots);
}

async function submitWorldAction(
  repository: JourneyStore,
  source: NarrativeBundleSource,
  actionCount: { value: number },
  snapshots: GameRecord[],
  predicate: (action: Action) => boolean,
): Promise<void> {
  const record = await currentRecord(repository);
  await submitChoice(repository, source, actionCount, snapshots, choiceTokenForAction(record, predicate));
}

async function moveToNextAct(
  repository: JourneyStore,
  source: NarrativeBundleSource,
  actionCount: { value: number },
  snapshots: GameRecord[],
): Promise<void> {
  const current = await currentRecord(repository);
  const bundle = current.storyState.narrative.status === "ready"
    ? current.storyState.narrative.narrativeBundle
    : undefined;
  const activeMoveTrigger = bundle?.activeStepIds
      .map((stepId) => bundle.steps.find((step) => step.stepId === stepId))
      .find((step) => step?.trigger.kind === "move")?.trigger;
  const activeMoveLocation = activeMoveTrigger?.kind === "move"
    ? activeMoveTrigger.locationId
    : undefined;
  await submitWorldAction(
    repository,
    source,
    actionCount,
    snapshots,
    (action) => action.type === "move" && action.locationId === activeMoveLocation,
  );
}

async function playTwoRoundDialogue(
  repository: JourneyStore,
  source: NarrativeBundleSource,
  actionCount: { value: number },
  snapshots: GameRecord[],
  firstLabel?: string,
): Promise<void> {
  if (firstLabel !== undefined) {
    await submitSceneChoice(repository, source, actionCount, snapshots, firstLabel);
  } else {
    await submitSceneChoice(repository, source, actionCount, snapshots, "表示愿意");
  }
  await submitSceneChoice(repository, source, actionCount, snapshots, "质疑");
}

function itemOwnerAtEnd(worldState: WorldState): EntityId | null {
  const item = worldState.entityStore.records.find((record): record is ItemEntityRecord =>
    record.core.kind === "item" && String(record.core.id) === LETTER_ITEM_ID);
  if (item === undefined) return null;
  const owner = item.possession.owner;
  return owner.kind === "player" ? owner.playerId : owner.kind === "npc" ? owner.npcId : null;
}

function promiseStatus(worldState: WorldState): TempleJourneyResult["promiseStatus"] {
  const statuses = worldState.entityStore.records
    .filter((record): record is NpcEntityRecord => record.core.kind === "npc")
    .flatMap((record) => record.relationships.outgoing.flatMap((edge) => edge.commitments))
    .filter((commitment) => commitment.kind === "promise")
    .map((commitment) => commitment.status);
  return statuses[0] ?? "absent";
}

export async function runTempleLetterJourney(
  route: TempleRoute,
  options: TempleJourneyOptions = {},
): Promise<TempleJourneyResult> {
  const root = mkdtempSync(join(tmpdir(), "ai-rpg-temple-letter-"));
  const dbPath = join(root, "journey.sqlite");
  let repository = openJourneyRepository(dbPath);
  const source = createTempleLetterBundleSource(route);
  const snapshots: GameRecord[] = [];
  const actionCount = { value: 0 };
  try {
    await repository.initializeSchema();
    const created = await createGame(
      { gameId: asGameId(`temple_${route}`), gameType: "wuxia", gameLength: "short", seed: `temple-${route}` },
      { repository, source, now: () => FIXED_NOW, aiEnabled: false },
    );
    if (!created.ok) throw new Error(`开局创建失败：${created.code}`);
    snapshots.push(await currentRecord(repository));

    await submitSceneChoice(repository, source, actionCount, snapshots, "先问清楚");
    await submitSceneChoice(repository, source, actionCount, snapshots, "质疑");
    await moveToNextAct(repository, source, actionCount, snapshots);

    const interaction = routeInteraction(route);
    if (interaction !== null) {
      if (route === "verify_first") {
        await submitFreeform(repository, source, actionCount, snapshots, "我走了");
      }
      await submitSceneChoice(repository, source, actionCount, snapshots, interaction.label);
      await playTwoRoundDialogue(repository, source, actionCount, snapshots, "质疑");
    } else {
      await playTwoRoundDialogue(repository, source, actionCount, snapshots);
    }

    if (options.reloadBeforeFinalAct === true) {
      await repository.close();
      repository = openJourneyRepository(dbPath);
    }
    await moveToNextAct(repository, source, actionCount, snapshots);
    if (route === "exit_keep") {
      await submitWorldAction(repository, source, actionCount, snapshots, (action) => action.type === "abandon_quest");
    } else {
      await submitWorldAction(repository, source, actionCount, snapshots, (action) => action.type === "give_item");
      if (route === "exit_return") {
        await submitWorldAction(repository, source, actionCount, snapshots, (action) => action.type === "abandon_quest");
      } else {
        await playTwoRoundDialogue(repository, source, actionCount, snapshots);
        const afterDialogue = await currentRecord(repository);
        if (afterDialogue.worldState.ending === null) {
          await submitWorldAction(repository, source, actionCount, snapshots, (action) => action.type === "talk" && action.dialogueAct === "support");
        }
      }
    }

    const final = await currentRecord(repository);
    const publicExposure = final.worldState.eventLedger.some((event) =>
      event.kind === "story_interaction_resolved"
      && event.payload.type === "story_interaction_resolved"
      && event.payload.operation === "share_known_fact");
    return {
      ended: final.worldState.ending !== null,
      route,
      snapshots,
      actionCount: actionCount.value,
      itemOwnerAtEnd: itemOwnerAtEnd(final.worldState),
      publicExposure,
      promiseStatus: promiseStatus(final.worldState),
    };
  } finally {
    await repository.close();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* test cleanup */ }
  }
}

/**
 * 负向入口也走同一组生产 API：回到旧地点没有可消费的叙事束，
 * 自由输入“我走了”只记录中性意图，不会猜测为离场或交付。
 */
export async function runTempleDepartureProbes(): Promise<TempleDepartureProbeResult> {
  const root = mkdtempSync(join(tmpdir(), "ai-rpg-temple-probe-"));
  const dbPath = join(root, "probe.sqlite");
  const repository = openJourneyRepository(dbPath);
  const source = createTempleLetterBundleSource("private");
  try {
    await repository.initializeSchema();
    const created = await createGame(
      { gameId: asGameId("temple_probe"), gameType: "wuxia", gameLength: "short", seed: "temple-probe" },
      { repository, source, now: () => FIXED_NOW, aiEnabled: false },
    );
    if (!created.ok) throw new Error(`探针开局创建失败：${created.code}`);
    const actionCount = { value: 0 };
    const snapshots: GameRecord[] = [];
    await submitSceneChoice(repository, source, actionCount, snapshots, "先问清楚");
    await submitSceneChoice(repository, source, actionCount, snapshots, "质疑");
    await moveToNextAct(repository, source, actionCount, snapshots);

    const beforeOrdinaryMove = await currentRecord(repository);
    const ordinaryMoveToken = choiceTokenForAction(
      beforeOrdinaryMove,
      (action) => action.type === "move" && String(action.locationId) === "loc_0",
    );
    const ordinaryMove = await performTurn({
      gameId: beforeOrdinaryMove.gameId,
      actionId: "temple_probe_move_back",
      interaction: { kind: "fixed_choice", choiceToken: ordinaryMoveToken },
      expectedRevision: beforeOrdinaryMove.revision,
      choiceMap: buildChoiceMap(beforeOrdinaryMove.worldState, beforeOrdinaryMove.storyState, beforeOrdinaryMove.revision),
    }, { repository, now: () => FIXED_NOW });
    const afterOrdinaryMove = await currentRecord(repository);

    const focusedNpc = afterOrdinaryMove.worldState.npcs.find(
      (npc) => npc.locationId === afterOrdinaryMove.worldState.currentLocationId,
    );
    if (focusedNpc === undefined) throw new Error("探针找不到当前 NPC");
    const freeformBase = await currentRecord(repository);
    const freeform = await performTurn({
      gameId: freeformBase.gameId,
      actionId: "temple_probe_freeform",
      interaction: { kind: "free_text", targetNpcId: focusedNpc.id, text: "我走了" },
      expectedRevision: freeformBase.revision,
      choiceMap: buildChoiceMap(freeformBase.worldState, freeformBase.storyState, freeformBase.revision),
    }, { repository, now: () => FIXED_NOW });
    if (!freeform.ok) throw new Error(`自由输入探针失败：${freeform.code}`);
    await settlePending(repository, source, snapshots);
    const final = await currentRecord(repository);
    const freeformEvent = final.worldState.eventLedger.find((event) =>
      event.kind === "npc_interaction_recorded"
      && event.payload.type === "npc_interaction_recorded"
      && event.payload.dialogueAct === "ask");
    return {
      ordinaryMoveRejected: !ordinaryMove.ok && ordinaryMove.code === "NARRATIVE_CONTINUATION_MISSING",
      ordinaryMoveEnded: afterOrdinaryMove.worldState.ending !== null,
      freeformEnded: final.worldState.ending !== null,
      freeformItemOwner: itemOwnerAtEnd(final.worldState),
      freeformWasNeutral: freeformEvent !== undefined,
    };
  } finally {
    await repository.close();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* test cleanup */ }
  }
}
