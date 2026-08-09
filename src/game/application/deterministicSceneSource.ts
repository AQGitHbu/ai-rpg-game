import type { SceneSource, SceneSourceResult } from "./sceneSource";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { NarrativeSceneState, NarrativeChoiceState, NarrativeNpcLineState, NarrativeEventState } from "@/game/domain/narrative";
import { buildNpcDialoguePages } from "@/game/domain/narrative";

// ---------------------------------------------------------------------------
// 确定性 fallback 场景生成器（spec §7.6 安全降级模板）。
// 不调用 AI、不读时钟/随机数：sceneId/choiceToken 全部从 job 纯函数派生，
// 两次调用同样的 context 产出逐字节相同的场景。
// 选项从当前地点的合法行动中选取（移动、交谈、探索）。
// ---------------------------------------------------------------------------

export function createDeterministicSceneSource(): SceneSource {
  return {
    async generateScene(context: SceneGenerationContext): Promise<SceneSourceResult> {
      const { job, currentLocation, presentNpcs } = context;

      const sceneId = `scene-${job.jobId}`;
      const turn = job.turnNumber;

      const firstNpc = presentNpcs[0];

      const narration = buildNarration(context);
      const npcLine = buildNpcLineState(context);
      const event = buildEventState(context);

      const choices = buildChoices(context, sceneId);

      const scene: NarrativeSceneState = {
        sceneId,
        turn,
        narration,
        usedFactIds: [],
        npcLine,
        choices: choices as readonly [NarrativeChoiceState, NarrativeChoiceState],
        source: "fallback",
        event,
        ...(presentNpcs.length > 0
          ? {
              npcDialogues: buildNpcDialoguePages(presentNpcs, {
                focusNpcId: npcLine?.npcId,
                focusSpeech: npcLine?.text,
              }),
            }
          : {}),
      };

      return {
        scene,
        eventProposals: [],
        source: "fallback",
      };
    },
  };
}

/** 焦点 NPC：talk job 优先使用 job.focusNpcId，否则第一个在场 NPC。 */
function focusNpc(context: SceneGenerationContext): SceneGenerationContext["presentNpcs"][number] | undefined {
  const { job, presentNpcs } = context;
  const talkTarget = job.actionSummary.kind === "talk" ? job.focusNpcId : undefined;
  if (talkTarget !== undefined) {
    const match = presentNpcs.find((n) => String(n.id) === String(talkTarget));
    if (match !== undefined) return match;
  }
  return presentNpcs[0];
}

/** 玩家原话以中性口吻回显（不加工、不评判）；无原话则不适用。 */
function buildNarration(context: SceneGenerationContext): string {
  const { job, currentLocation } = context;
  const { resolvedEvent } = job;
  const locName = currentLocation.name;
  const npc = focusNpc(context);

  const isTalk = job.actionSummary.kind === "talk";
  if (isTalk && job.utterance !== undefined && npc !== undefined) {
    return `你对${npc.name}说："${job.utterance}"。${npc.name}听完，注视着你的眼睛。`;
  }

  switch (resolvedEvent.eventKind) {
    case "travel":
      return `你来到了${locName}。四周的景象映入眼帘，空气中弥漫着不同的气息。`;
    case "dialogue":
      return npc !== undefined
        ? `你与${npc.name}交谈。${npc.name}注视着你，似乎有话要说。`
        : `你在${locName}四处张望，却没看到可以交谈的人。`;
    case "investigate":
      return `你仔细调查了周围的线索，发现了一些值得注意的细节。`;
    case "item":
      return `你获得了某件物品，它或许在旅途中派上用场。`;
    case "battle":
      return resolvedEvent.status === "success"
        ? `战斗结束，你取得了胜利。`
        : `战斗的余波仍在空气中回荡。`;
    default:
      return `你身处${locName}，周围的一切静待探索。`;
  }
}

function buildNpcLineState(context: SceneGenerationContext): NarrativeNpcLineState | null {
  const { job } = context;
  const { resolvedEvent } = job;
  const npc = focusNpc(context);
  if (npc === undefined) return null;

  // talk job：原话中性回显在台词里，保持焦点 NPC 与场景对白一致。
  if (job.actionSummary.kind === "talk" && job.utterance !== undefined) {
    return {
      npcId: npc.id,
      text: `你刚才说："${job.utterance}"。${npc.name}听完点了点头。`,
      emotion: "neutral",
      usedFactIds: [],
    };
  }

  return {
    npcId: npc.id,
    text: buildNpcLine(npc.name, resolvedEvent),
    emotion: "neutral",
    usedFactIds: [],
  };
}

function buildNpcLine(npcName: string, resolvedEvent: SceneGenerationContext["job"]["resolvedEvent"]): string {
  switch (resolvedEvent.status) {
    case "success":
      return `${npcName}说道："欢迎，有什么需要帮忙的吗？"`;
    case "partial_success":
      return `${npcName}犹豫了一下："这件事……我知道一些，但不方便全说。"`;
    case "failure":
      return `${npcName}摇了摇头："恐怕这件事我帮不上忙。"`;
    case "blocked":
      return `${npcName}摇了摇头："现在还不是做这件事的时候。"`;
    default:
      return `${npcName}看了你一眼，没有说话。`;
  }
}

/** 事件状态由 job 的真实 eventKind 派生：travel→travel，talk→dialogue 焦点 NPC，investigate→首条事实。 */
export function buildEventState(context: SceneGenerationContext): NarrativeEventState {
  const { job, currentLocation } = context;
  switch (job.resolvedEvent.eventKind) {
    case "travel":
      return { kind: "travel", locationId: currentLocation.id };
    case "dialogue": {
      const focus = focusNpc(context);
      return focus !== undefined
        ? { kind: "dialogue", focusNpcId: focus.id }
        : { kind: "observe", locationId: currentLocation.id };
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

function buildChoices(
  context: SceneGenerationContext,
  sceneId: string,
): readonly [NarrativeChoiceState, NarrativeChoiceState] {
  const { presentNpcs, legalActionCandidates } = context;
  const firstNpc = presentNpcs[0];
  const firstMove = legalActionCandidates.find((c) => c.kind === "move");
  const firstReachable = firstMove !== undefined
    ? { id: firstMove.targetId ?? "", name: firstMove.label }
    : undefined;

  // 选项 A：如果有 NPC，优先交谈；否则探索
  const choiceA: NarrativeChoiceState = firstNpc !== undefined
    ? {
        choiceToken: `${sceneId}-a`,
        label: `与NPC交谈`,
        actionKey: `talk:${String(firstNpc.id)}`,
        choiceKind: "world_action",
      }
    : {
        choiceToken: `${sceneId}-a`,
        label: `探索周围`,
        actionKey: `explore`,
        choiceKind: "world_action",
      };

  // 选项 B：如果有可到达地点，移动；否则休息
  const choiceB: NarrativeChoiceState = firstReachable !== undefined
    ? {
        choiceToken: `${sceneId}-b`,
        label: `前往${firstReachable.name}`,
        actionKey: `move:${String(firstReachable.id)}`,
        choiceKind: "world_action",
      }
    : {
        choiceToken: `${sceneId}-b`,
        label: `稍作休息`,
        actionKey: `rest`,
        choiceKind: "world_action",
      };

  return [choiceA, choiceB];
}