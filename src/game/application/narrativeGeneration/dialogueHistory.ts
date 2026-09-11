import type { NarrativeJobRepository, StoredJob } from "../server/persistence/narrativeJobRepository";
import type { DialogueHistoryEntry, PlanningContext } from "./stageSource";
import { previousDialogue } from "./dialogueContext";

const MAX_HISTORY_ENTRIES = 6;
const MAX_HISTORY_JSON_CHARS = 12_000;

/** 读取并脱敏同一 NPC 的已发布旧任务；失败或旧适配器缺能力时不阻断当前生成。 */
export async function loadDialogueHistory(
  current: StoredJob,
  repository: NarrativeJobRepository,
): Promise<readonly DialogueHistoryEntry[]> {
  if (current.input.kind !== "decision" || current.gameId === null || current.baseRevision === null
    || current.input.job.focusNpcId === undefined || repository.getRecentDialogueJobs === undefined) return [];
  const fetched = await repository.getRecentDialogueJobs({
    gameId: current.gameId,
    npcId: String(current.input.job.focusNpcId),
    beforeRevision: current.baseRevision,
  });
  if (!fetched.ok) return [];

  const recentFirst: DialogueHistoryEntry[] = [];
  let usedChars = 2; // JSON 数组的 []。
  for (const candidate of fetched.value) {
    if (recentFirst.length >= MAX_HISTORY_ENTRIES || candidate.id === current.id
      || candidate.status !== "published" || candidate.scope !== "decision"
      || candidate.gameId !== current.gameId || candidate.baseRevision === null
      || candidate.baseRevision >= current.baseRevision || candidate.input.kind !== "decision"
      || candidate.input.job.focusNpcId !== current.input.job.focusNpcId) continue;
    const selected = candidate.input.job.selectedDialogue;
    const shown = previousDialogue(candidate.input as PlanningContext);
    if (selected === undefined || shown === null) continue;
    const entry: DialogueHistoryEntry = {
      previousReply: shown.reply.text,
      previousChoices: [...shown.choices],
      selectedDialogue: {
        dialogueAct: selected.dialogueAct,
        ...(selected.topic === undefined ? {} : { topic: selected.topic }),
        ...(selected.task === undefined ? {} : { task: selected.task }),
      },
    };
    const chars = JSON.stringify(entry).length + (recentFirst.length === 0 ? 0 : 1);
    if (usedChars + chars > MAX_HISTORY_JSON_CHARS) continue;
    usedChars += chars;
    recentFirst.push(entry);
  }
  return recentFirst.reverse();
}
