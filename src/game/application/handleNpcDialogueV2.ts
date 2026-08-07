import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { NpcId } from "@/game/domain/scenarioBlueprint";
import type { StoryState } from "@/game/domain/storyState";
import { commitState } from "./stateCommit";

export type HandleNpcDialogueV2Command = {
  readonly npcId: NpcId;
  readonly text: string;
  readonly expectedRevision: number;
};

export type HandleNpcDialogueV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly now: () => string;
};

export type HandleNpcDialogueV2Result =
  | { readonly ok: true; readonly kind: "chat"; readonly npcSpeech: string; readonly revision: number }
  | { readonly ok: true; readonly kind: "narrative_trigger"; readonly revision: number }
  | { readonly ok: false; readonly code: string };

// 简单闲聊关键词——命中时走 chat 路径，零 CAS 写入
const CHAT_KEYWORDS = ["你好", "再见", "谢谢", "早上好", "晚上好", "嗨", "哈喽"];

function isChatText(text: string): boolean {
  return CHAT_KEYWORDS.some((kw) => text.includes(kw)) || text.length < 6;
}

export async function handleNpcDialogueV2(
  command: HandleNpcDialogueV2Command,
  deps: HandleNpcDialogueV2Deps,
): Promise<HandleNpcDialogueV2Result> {
  const current = await deps.repository.getCurrentGame();
  if (!current.ok || current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };
  if (current.record.revision !== command.expectedRevision) return { ok: false, code: "STALE_GAME_REVISION" };

  const { record } = current;
  const npc = record.worldState.npcs.find(
    (n) => n.id === command.npcId && n.locationId === record.worldState.currentLocationId,
  );
  if (npc === undefined) return { ok: false, code: "NPC_NOT_PRESENT" };

  if (isChatText(command.text)) {
    // Chat path: deterministic casual reply, zero CAS write
    const speech = buildCasualReply(npc.name, command.text);
    return { ok: true, kind: "chat", npcSpeech: speech, revision: record.revision };
  }

  // Narrative path: queue pending scene with playerNpcChat snapshot
  const nextStoryState: StoryState = {
    ...record.storyState,
    narrative: {
      ...record.storyState.narrative,
      generation: {
        status: "pending",
        requestedAt: deps.now(),
        playerNpcChat: {
          npcId: command.npcId,
          playerText: command.text,
          npcName: npc.name,
          npcRole: npc.role,
        },
      },
    },
  };

  const commit = await commitState(deps.repository, {
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextWorldState: record.worldState,
    nextStoryState,
  });

  if (!commit.ok) return { ok: false, code: commit.code };
  return { ok: true, kind: "narrative_trigger", revision: commit.record.revision };
}

function buildCasualReply(npcName: string, playerText: string): string {
  if (playerText.includes("你好") || playerText.includes("嗨") || playerText.includes("哈喽")) {
    return `${npcName}微笑着回应："你好，有什么事吗？"`;
  }
  if (playerText.includes("再见")) {
    return `${npcName}点了点头："后会有期。"`;
  }
  if (playerText.includes("谢谢")) {
    return `${npcName}摆摆手："不必客气。"`;
  }
  return `${npcName}看了你一眼，没有特别回应。`;
}
