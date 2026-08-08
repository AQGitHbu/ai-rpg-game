import type { SceneSource, SceneSourceContext, SceneSourceResult } from "./sceneSource";
import type { NarrativeSceneState, NarrativeChoiceState, NarrativeNpcLineState, NarrativeEventState } from "@/game/domain/narrative";
import { buildNpcDialoguePages } from "@/game/domain/narrative";
import type { WorldState } from "@/game/domain/worldState";
import type { NpcId, LocationId } from "@/game/domain/scenarioBlueprint";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";

// ---------------------------------------------------------------------------
// 确定性 fallback 场景生成器（spec §7.6 安全降级模板）。
// 不调用 AI，基于 WorldState 当前状态派生叙述 + 2 个选项。
// 选项从当前地点的合法行动中选取（移动、交谈、探索）。
// ---------------------------------------------------------------------------

export function createDeterministicSceneSource(): SceneSource {
  return {
    async generateScene(context: SceneSourceContext): Promise<SceneSourceResult> {
      const { worldState: ws, storyState: ss, resolvedEvent } = context;
      const sceneId = `scene-${ws.eventLedger.length}-${Date.now()}`;
      const turn = ws.eventLedger.length;

      // 派生当前地点 NPC
      const npcsHere = ws.npcs.filter((n) => n.locationId === ws.currentLocationId);
      const firstNpc = npcsHere[0];

      // 派生 narration
      const currentLoc = ws.locations.find((l) => l.id === ws.currentLocationId);
      const locName = currentLoc?.name ?? "未知地点";
      const narration = buildNarration(resolvedEvent, locName, firstNpc?.name);

      // 派生 NPC 对白
      const npcLine: NarrativeNpcLineState | null = firstNpc !== undefined
        ? {
            npcId: firstNpc.id,
            text: buildNpcLine(firstNpc.name, resolvedEvent),
            emotion: "neutral",
            usedFactIds: [],
          }
        : null;

      // 派生 event state
      const event: NarrativeEventState | undefined = firstNpc !== undefined
        ? { kind: "dialogue", focusNpcId: firstNpc.id }
        : { kind: "observe", locationId: ws.currentLocationId };

      // 派生 2 个选项
      const choices = buildChoices(ws, sceneId, firstNpc?.id);

      const scene: NarrativeSceneState = {
        sceneId,
        turn,
        narration,
        usedFactIds: [],
        npcLine,
        choices: choices as readonly [NarrativeChoiceState, NarrativeChoiceState],
        source: "fallback",
        event,
        ...(npcsHere.length > 0
          ? {
              npcDialogues: buildNpcDialoguePages(npcsHere, {
                focusNpcId: firstNpc?.id,
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

function buildNarration(
  resolvedEvent: ResolvedEvent,
  locName: string,
  npcName: string | undefined,
): string {
  switch (resolvedEvent.eventKind) {
    case "travel":
      return `你来到了${locName}。四周的景象映入眼帘，空气中弥漫着不同的气息。`;
    case "dialogue":
      return npcName !== undefined
        ? `你与${npcName}交谈。${npcName}注视着你，似乎有话要说。`
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

function buildNpcLine(npcName: string, resolvedEvent: ResolvedEvent): string {
  switch (resolvedEvent.status) {
    case "success":
      return `${npcName}说道："欢迎，有什么需要帮忙的吗？"`;
    case "partial_success":
      return `${npcName}犹豫了一下："这件事……我知道一些，但不方便全说。"`;
    case "failure":
      return `${npcName}摇了摇头："恐怕这件事我帮不上忙。"`;
    default:
      return `${npcName}看了你一眼，没有说话。`;
  }
}

function buildChoices(
  ws: WorldState,
  sceneId: string,
  npcId: NpcId | undefined,
): readonly [NarrativeChoiceState, NarrativeChoiceState] {
  const currentLoc = ws.locations.find((l) => l.id === ws.currentLocationId);
  const connectedUnlocked = currentLoc?.connectedLocationIds
    .filter((id) => ws.unlockedLocationIds.includes(id)) ?? [];
  const firstConnected = connectedUnlocked[0];
  const connectedLoc = firstConnected !== undefined
    ? ws.locations.find((l) => l.id === firstConnected)
    : undefined;

  // 选项 A：如果有 NPC，优先交谈；否则探索
  const choiceA: NarrativeChoiceState = npcId !== undefined
    ? {
        choiceToken: `${sceneId}:a`,
        label: `与NPC交谈`,
        actionKey: `talk:${String(npcId)}`,
        choiceKind: "world_action",
      }
    : {
        choiceToken: `${sceneId}:a`,
        label: `探索周围`,
        actionKey: `explore`,
        choiceKind: "world_action",
      };

  // 选项 B：如果有连接地点，移动；否则休息
  const choiceB: NarrativeChoiceState = connectedLoc !== undefined
    ? {
        choiceToken: `${sceneId}:b`,
        label: `前往${connectedLoc.name}`,
        actionKey: `move:${String(connectedLoc.id)}`,
        choiceKind: "world_action",
      }
    : {
        choiceToken: `${sceneId}:b`,
        label: `稍作休息`,
        actionKey: `rest`,
        choiceKind: "world_action",
      };

  return [choiceA, choiceB];
}
