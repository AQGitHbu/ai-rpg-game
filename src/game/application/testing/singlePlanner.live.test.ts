// @vitest-environment node
import { expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServerRpgAiClient } from "../server/ai/rpgAiClient";
import { createTextAuditRecorder } from "../server/ai/textAuditRecorder";
import { createLiveStageSource } from "../server/ai/staged/liveStageSource";
import type { StageSource } from "../narrativeGeneration/stageSource";
import { createStagedHarness } from "./stagedNarrativeHarness.testutil";
import { createPendingDecisionRecord } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId } from "@/game/domain/worldEntity";

it.skipIf(process.env.RUN_REAL_AI_SINGLE_PLANNER !== "1")("柳三娘的告示问答由统一规划生成整轮，无游戏数据库写入", async () => {
  // @ts-expect-error repository scripts are plain ESM without TS declarations.
  const { readAiEnv } = await import("../../../../scripts/aiEnv.mjs");
  const values = readAiEnv(resolve(process.cwd(), ".env.local")) as Map<string, { decoded: string }>;
  const env = Object.fromEntries([...values].map(([key, value]) => [key, value.decoded]));
  const root = resolve(process.cwd(), "tmp", "single-planner-live");
  await mkdir(root, { recursive: true });
  const recorder = createTextAuditRecorder({ AI_TEXT_AUDIT: "full", AI_TEXT_AUDIT_DIR: root, AI_TEXT_AUDIT_RUN_ID: "probe" });
  const client = createServerRpgAiClient(env, undefined, recorder);
  if (client === undefined) throw Error("AI_CONFIG_UNAVAILABLE");
  const source = createLiveStageSource({ client });
  const record = createPendingDecisionRecord();
  const pending = record.storyState.narrative;
  if (pending.status !== "provider_pending") throw Error("pending");
  const facts = ["青崖镖局一夜之间满门覆灭，玩家是幸存者。", "镇口贴有缉拿身份不明刀客的告示。", "江湖各派表面平静，暗中调查镖局覆灭的真相。"]
    .map((text, i) => ({ factId: asFactId(`fact_${i}`), text, discovered: true, source: "generated" as const }));
  const world = createWorldStateFixtureWith({ generation: record.worldState.generation, base: record.worldState }, {
    worldFacts: facts, eventLedger: record.worldState.eventLedger,
    npcs: record.worldState.npcs.map(npc => ({ ...npc, name: "柳三娘", role: "客栈掌柜",
      memory: { ...npc.memory, knownFactIds: facts.map(f => f.factId), hiddenFactIds: [] } })),
  });
  const selected = { dialogueAct: "ask" as const,
    label: "三娘，镇口那张缉凶告示，你是从哪儿听来的？什么时候贴上的？上头写的那些，你信几分？",
    task: { intent: "ask" as const, focusFactIds: ["fact_1"], prerequisiteFactIds: [],
      inquiries: [{ factId: "fact_1", aspects: ["source", "time", "reliability"] as const }] } };
  const story = { ...record.storyState, narrative: { ...pending, lastPresentedScene: {
    sceneId: "previous", turn: 0, source: "generated" as const, narration: "柳三娘提起镇口的告示。", usedFactIds: [asFactId("fact_1")],
    npcLine: { npcId: pending.job.focusNpcId!, text: "镇口贴了缉拿刀客的告示，你可看过？", emotion: "neutral" as const,
      usedFactIds: [asFactId("fact_1")], usedEventIds: [] },
    choices: [{ choiceToken: "a", label: selected.label }, { choiceToken: "b", label: "这告示为何偏在此时贴出？" }],
  } } };
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok) throw Error("job");
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version, job: { ...stored.value,
    input: { kind: "decision", world, story, job: { ...pending.job, selectedDialogue: selected } }, units: [], usedRequests: 0,
  } });
  const calls: string[] = [];
  const signal = AbortSignal.timeout(180_000);
  h.source.generate = async (request, execution) => {
    calls.push(request.stage);
    return source.generate(request, { ...execution, signal: AbortSignal.any([signal, execution.signal]), timeoutMs: 45_000 });
  };
  (h.source as StageSource).reviewDisclosure = source.reviewDisclosure;
  try {
    const result = await h.run();
    const job = await h.readJob();
    await writeFile(resolve(root, "result.json"), JSON.stringify({ result, job, calls }, null, 2));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(calls.every(stage => ["planning", "narration", "character", "choices"].includes(stage))).toBe(true);
    if (result.ok) {
      const planned = result.value.units.find(unit => unit.key === "planning")?.value;
      if (planned === null || planned === undefined || !("decision" in planned)) throw Error("plan");
      const answers = planned.units.flatMap(unit => unit.task?.answers ?? []);
      expect(answers).toEqual(expect.arrayContaining(selected.task.inquiries[0]!.aspects.map(aspect => ({
        factId: "fact_1", aspect, outcome: "unknown", answerFactIds: [],
      }))));
      // 此固定样本上一组已覆盖告示来源/时间/可信度/目的；新候选应实质换题。
      expect(planned.decision?.options.flatMap(option => "task" in option ? option.task?.inquiries ?? [] : [])
        .filter(inquiry => inquiry.factId === "fact_1")).toEqual([]);
    }
  } finally { await recorder.close(); }
}, 200_000);
