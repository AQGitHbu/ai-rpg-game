import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { NpcId } from "@/game/domain/scenarioBlueprint";
import type { IntentParserSource } from "@/game/gameplay/rpg/intentParser/intentParserSource";
import { performTurn } from "./performTurn";

export type HandleNpcDialogueV2Command = {
  readonly npcId: NpcId;
  readonly text: string;
  readonly expectedRevision: number;
};

export type HandleNpcDialogueV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly now: () => string;
  readonly intentParserSource?: IntentParserSource;
};

export type HandleNpcDialogueV2Result =
  | { readonly ok: true; readonly kind: "chat"; readonly npcSpeech: string; readonly revision: number }
  | { readonly ok: true; readonly kind: "narrative_trigger"; readonly revision: number }
  | { readonly ok: false; readonly code: string };

// 任务 9：对话入口收敛为 performTurn 的 thin adapter —— 不再有零 CAS 闲聊旁路，
// 不再直接写 playerNpcChat pending；所有输入都形成受规则记录的回合。
// chat / narrative_trigger 只决定交互呈现方式（即时回复 vs 等待场景），不改变提交语义。

function withNpcName(record: { readonly worldState: { readonly currentLocationId: string; readonly npcs: readonly { id: NpcId; name: string; locationId: string }[] } }, npcId: NpcId): string | null {
  const npc = record.worldState.npcs.find((n) => n.id === npcId);
  if (npc === undefined) return null;
  // 在场 = 与玩家同处当前地点（与固定选项校验一致）；仅存在于世界但不在场仍拒绝。
  if (npc.locationId !== record.worldState.currentLocationId) return null;
  return npc.name;
}

export async function handleNpcDialogueV2(
  command: HandleNpcDialogueV2Command,
  deps: HandleNpcDialogueV2Deps,
): Promise<HandleNpcDialogueV2Result> {
  const current = await deps.repository.getCurrentGame();
  if (!current.ok || current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };
  const { record } = current;
  if (record.revision !== command.expectedRevision) return { ok: false, code: "STALE_GAME_REVISION" };

  // NPC 不在场：零写入拒绝（与固定选项校验一致的显式前置）
  const npcName = withNpcName(record, command.npcId);
  if (npcName === null) return { ok: false, code: "NPC_NOT_PRESENT" };

  const turn = await performTurn(
    {
      gameId: record.gameId,
      actionId: `input_${String(command.npcId)}`,
      interaction: { kind: "free_text", text: command.text, targetNpcId: command.npcId },
      expectedRevision: command.expectedRevision,
      choiceMap: new Map(),
    },
    { repository: deps.repository, now: deps.now, intentParserSource: deps.intentParserSource },
  );

  if (!turn.ok) return { ok: false, code: turn.code };

  // 交互呈现：轻量问候即时回复（chat），其余走 narrative_trigger。
  // 注意：两种 kind 的回合都已被 performTurn 单次 CAS 提交。
  if (isChatText(command.text)) {
    return {
      ok: true,
      kind: "chat",
      npcSpeech: buildCasualReply(npcName, command.text),
      revision: turn.revision,
    };
  }
  return { ok: true, kind: "narrative_trigger", revision: turn.revision };
}

// 简单闲聊关键词——命中时决定"即时回复型"呈现（不再零 CAS 旁路）。
// 关键词未命中一律走 narrative_trigger（含短文本，如"我相信你"）。
const CHAT_KEYWORDS = ["你好", "再见", "谢谢", "早上好", "晚上好", "嗨", "哈喽"];

function isChatText(text: string): boolean {
  return CHAT_KEYWORDS.some((kw) => text.includes(kw));
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
