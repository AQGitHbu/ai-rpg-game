import { expect, it } from "vitest";
import { asNpcId } from "@/game/domain/worldEntity";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import { createStagedHarness } from "../testing/stagedNarrativeHarness.testutil";
import { loadDialogueHistory } from "./dialogueHistory";
import { runJob } from "./runJob";

function historicalJob(current: StoredJob, id: string, revision: number, reply: string): StoredJob {
  if (current.input.kind !== "decision") throw Error("decision fixture required");
  const npcId = current.input.job.focusNpcId!;
  const scene = { sceneId: `scene-${id}`, turn: revision, narration: "旧旁白", usedFactIds: [], source: "generated" as const,
    npcLine: { npcId, text: reply, emotion: "neutral" as const, usedFactIds: [], usedEventIds: [] },
    choices: [{ choiceToken: `secret-${id}`, label: "告示由哪个衙门发布？" }], npcDialogues: [] };
  const narrative = current.input.story.narrative;
  if (narrative.status !== "ready") throw Error("ready fixture required");
  return { ...current, id, status: "published", baseRevision: revision,
    input: { ...current.input, story: { ...current.input.story,
      narrative: { ...narrative, currentScene: scene } },
    job: { ...current.input.job, selectedDialogue: { dialogueAct: "support", label: `SECRET_LABEL_${id}`,
      topic: { kind: "general" }, task: { intent: "support", brief: "帮老人留意刀客行踪。",
        focusFactIds: [], contentFactIds: [], prerequisiteFactIds: [] } } } } };
}

it("历史只保留同 game/NPC 的完整脱敏条目，按 12k 预算从近到远选择后按时间输出", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  const loaded = await h.readJob();
  if (!loaded.ok) throw Error(loaded.code);
  const current = { ...loaded.value, baseRevision: 10 };
  const recent = historicalJob(current, "old-recent", 9, "最近一次回答");
  const older = historicalJob(current, "old-older", 8, "更早一次回答");
  const tooLarge = historicalJob(current, "old-large", 7, "长".repeat(12_001));
  const wrongNpc = historicalJob(current, "old-other", 6, "其他人回答");
  const wrongInput = wrongNpc.input;
  if (wrongInput.kind !== "decision") throw Error("decision");
  const repository = { ...h.jobs, getRecentDialogueJobs: async (input: unknown) => {
    expect(input).toEqual({ gameId: current.gameId, npcId: String(current.input.kind === "decision"
      ? current.input.job.focusNpcId : ""), beforeRevision: 10 });
    return { ok: true as const, value: [recent, older, tooLarge, { ...wrongNpc,
      input: { ...wrongInput, job: { ...wrongInput.job, focusNpcId: asNpcId("npc_other") } } }] };
  } };
  const history = await loadDialogueHistory(current, repository);
  expect(history.map(entry => entry.previousReply)).toEqual(["更早一次回答", "最近一次回答"]);
  expect(JSON.stringify(history)).not.toContain("secret-old");
  expect(history[0]?.selectedDialogue.label).toBe("SECRET_LABEL_old-older");
  expect(history[0]?.selectedDialogue).not.toHaveProperty("task");
});

it("runJob 只加载一次历史，planning 修复重试复用同一上下文且不写回 StoredJob", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  const loaded = await h.readJob();
  if (!loaded.ok) throw Error(loaded.code);
  const saved = await h.jobs.save({ lease: h.lease(), expectedVersion: loaded.value.version,
    job: { ...loaded.value, baseRevision: 10 } });
  if (!saved.ok) throw Error(saved.code);
  const old = historicalJob(saved.value, "old-one", 8, "我不知道告示由哪个衙门发布。");
  let reads = 0;
  const jobs = { ...h.jobs, async getRecentDialogueJobs() { reads += 1; return { ok: true as const, value: [old] }; } };
  h.source.failNext("planning");
  const result = await runJob({ id: h.jobId(), lease: h.lease() }, {
    jobs, source: h.source, now: () => h.clock.now(), signal: h.controller.signal,
  });
  expect(result.ok).toBe(true);
  expect(reads).toBe(1);
  const planning = h.requests.filter(request => request.stage === "planning");
  expect(planning).toHaveLength(2);
  expect(planning[0]!.context).toBe(planning[1]!.context);
  if (planning[0]!.context.kind === "decision") {
    expect(planning[0]!.context.dialogueHistory?.[0]?.previousReply).toContain("不知道告示");
  }
  const stored = await h.readJob();
  if (stored.ok && stored.value.input.kind === "decision") expect(stored.value.input.dialogueHistory).toBeUndefined();
});
